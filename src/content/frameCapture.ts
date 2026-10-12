/**
 * 关键帧抽取（视觉问答的内容侧实现）：定位 <video> 到目标时间 → 画到 canvas → JPEG base64。
 *
 * 用户洞察：视频的画面 / 页面才是精华，要和字幕一起喂给模型。本模块只负责"取帧"，
 * 不做任何模型调用（红线 10：content script 禁入模型配置 / 密钥 / 模型调用模块）。
 *
 * 纯函数（computeCanvasSize / toBase64）可脱离浏览器测试；drawToDataUrl 可注入，
 * 单测用假 video + 假绘制函数驱动，无需 jsdom。
 */
import { MSG, type CapturedFrame, type RuntimeMessage, type ScannedSample } from '../messages';
import type { VideoId } from '../types';
import { DHASH_H, DHASH_W, dhashFromGray, grayFromRgba } from '../core/vision/dhash';
import { sharpnessFromGray } from '../core/vision/pageCluster';

/**
 * 默认最长边像素（panel 会通过 payload.maxSize 传 VISION.maxSize 覆盖）。
 * content 禁止 import config（红线 10），故这里保留同值兜底。
 */
const DEFAULT_MAX_SIZE = 896;
/** 默认 JPEG 质量 */
const DEFAULT_QUALITY = 0.75;
/** 日志缩略图最长边（只给人看，不发给模型） */
const THUMB_SIZE = 160;
/** 默认单帧 seek 超时 */
const DEFAULT_TIMEOUT_MS = 3_000;
/**
 * 默认最多抽帧数（红线 3 的成本护栏）。
 * 早期写死 6 帧，导致「规划 16 帧」在 content 侧被截断成 6 帧——规划与执行脱节。
 * 现在跟随调用方规划的帧数（见 registerFrameCaptureHandler），此处只做兜底上限。
 */
// 必须 ≥ FRAME_PLAN.mindmap.hardMax（content 禁 import config，由单测守住两者一致）
export const DEFAULT_MAX_FRAMES = 48;
/** 画布尺寸下限：防退化（0 宽 / 极端宽高比抽帧得到空白图） */
const MIN_CANVAS_SIZE = 16;

export interface FrameCaptureOptions {
  /** 最长边像素，默认 896 */
  maxSize?: number;
  /** JPEG 质量，默认 0.75 */
  quality?: number;
  /** 单帧超时（毫秒），默认 3000 */
  timeoutMs?: number;
}

/**
 * 最小 video 接口（便于单测用假对象）：只取抽帧必需的字段与 seeked 监听。
 */
export interface HTMLVideoElementLike {
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  paused: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  /** 抽帧结束时用于恢复播放状态（浏览器环境提供） */
  pause?: () => void;
  play?: () => Promise<void> | void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

/** 绘制到 canvas 并转 dataURL（浏览器默认实现走 document；单测注入假实现） */
export type DrawToDataUrl = (
  video: HTMLVideoElementLike,
  width: number,
  height: number,
  quality: number,
) => string;

/**
 * 抽取画面附加信息（dHash + 缩略图）。浏览器默认实现走 canvas；单测注入或省略。
 * 返回 null 表示取不到（不影响主帧）。
 */
export type DescribeFrame = (
  video: HTMLVideoElementLike,
) => { dhash: string; thumbBase64: string } | null;

/** 内部扩展选项：drawToDataUrl 仅用于注入，不属对外契约 */
interface CaptureRuntimeOptions extends FrameCaptureOptions {
  drawToDataUrl?: DrawToDataUrl;
  /** 注入 dHash/缩略图提取（缺省：浏览器环境用 canvas，非浏览器环境跳过） */
  describeFrame?: DescribeFrame;
}

/**
 * 按视频原始宽高算缩放后的画布尺寸：保持比例，最长边 ≤ maxSize，最小 16。
 * 极端宽高比缩到最长边后仍有边 < 16 时，该边兜底补到 16（比例让步于非退化）。
 */
export function computeCanvasSize(
  width: number,
  height: number,
  maxSize: number,
): { width: number; height: number } {
  const limit = Number.isFinite(maxSize) && maxSize > 0 ? maxSize : DEFAULT_MAX_SIZE;
  const w0 = Number.isFinite(width) && width > 0 ? width : 0;
  const h0 = Number.isFinite(height) && height > 0 ? height : 0;
  if (w0 === 0 || h0 === 0) {
    return { width: MIN_CANVAS_SIZE, height: MIN_CANVAS_SIZE };
  }
  let w = w0;
  let h = h0;
  // 源本身过小（<16）：按较小边补到 16，保持比例
  if (Math.min(w, h) < MIN_CANVAS_SIZE) {
    const f = MIN_CANVAS_SIZE / Math.min(w, h);
    w = Math.round(w * f);
    h = Math.round(h * f);
  }
  const longest = Math.max(w, h);
  if (longest > limit) {
    const f = limit / longest;
    w = Math.max(1, Math.round(w * f));
    h = Math.max(1, Math.round(h * f));
  }
  if (w < MIN_CANVAS_SIZE) w = MIN_CANVAS_SIZE;
  if (h < MIN_CANVAS_SIZE) h = MIN_CANVAS_SIZE;
  return { width: w, height: h };
}

/** dataURL → base64 部分（去掉 `data:image/...;base64,` 前缀）；空 / 非法 → '' */
export function toBase64(dataUrl: string): string {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) return '';
  const marker = ';base64,';
  const idx = dataUrl.indexOf(marker);
  if (idx >= 0) return dataUrl.slice(idx + marker.length);
  // 带 data: 但缺 base64 段 → 非法
  if (dataUrl.startsWith('data:')) return '';
  // 已是裸 base64（无前缀）→ 原样返回；其余视为非法
  return /^[A-Za-z0-9+/=\s]+$/.test(dataUrl) ? dataUrl : '';
}

/** 浏览器默认绘制：canvas 缩放绘制 + JPEG 导出 */
function defaultDrawToDataUrl(
  video: HTMLVideoElementLike,
  width: number,
  height: number,
  quality: number,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context 不可用');
  ctx.drawImage(video as unknown as CanvasImageSource, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', quality);
}

/** 浏览器默认：9×8 采样算 dHash + 160px 缩略图（失败返回 null） */
function defaultDescribeFrame(video: HTMLVideoElementLike): { dhash: string; thumbBase64: string } | null {
  if (typeof document === 'undefined') return null;
  try {
    const src = video as unknown as CanvasImageSource;
    const tiny = document.createElement('canvas');
    tiny.width = DHASH_W;
    tiny.height = DHASH_H;
    const tctx = tiny.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!tctx) return null;
    tctx.drawImage(src, 0, 0, DHASH_W, DHASH_H);
    const dhash = dhashFromGray(grayFromRgba(tctx.getImageData(0, 0, DHASH_W, DHASH_H).data));
    const size = computeCanvasSize(video.videoWidth, video.videoHeight, THUMB_SIZE);
    const thumb = document.createElement('canvas');
    thumb.width = size.width;
    thumb.height = size.height;
    const thctx = thumb.getContext('2d');
    if (!thctx) return { dhash, thumbBase64: '' };
    thctx.drawImage(src, 0, 0, size.width, size.height);
    return { dhash, thumbBase64: toBase64(thumb.toDataURL('image/jpeg', 0.6)) };
  } catch {
    return null;
  }
}

/**
 * 定位到 seconds 并等待 seeked；超时 / 无监听能力时立即返回（超时仍尝试抽帧）。
 */
function seekTo(video: HTMLVideoElementLike, seconds: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (video.removeEventListener && listener) video.removeEventListener('seeked', listener);
      resolve();
    };
    const listener = () => done();
    if (video.addEventListener) video.addEventListener('seeked', listener);
    try {
      video.currentTime = seconds;
    } catch {
      done();
      return;
    }
    if (!video.addEventListener) {
      done();
      return;
    }
    if (timeoutMs > 0) {
      setTimeout(done, timeoutMs);
    } else {
      done();
    }
  });
}

/**
 * 抽单帧：seek → 画到 canvas → JPEG base64。
 * 任何异常一律 throw（由调用方决定降级：丢该帧）。
 */
export async function captureFrameAt(
  video: HTMLVideoElementLike,
  targetMs: number,
  opts: CaptureRuntimeOptions = {},
): Promise<CapturedFrame> {
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  const quality = opts.quality ?? DEFAULT_QUALITY;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const draw = opts.drawToDataUrl ?? defaultDrawToDataUrl;

  const seconds = Number.isFinite(targetMs) ? targetMs / 1000 : 0;
  await seekTo(video, seconds, timeoutMs);
  const { width, height } = computeCanvasSize(video.videoWidth, video.videoHeight, maxSize);
  const dataUrl = draw(video, width, height, quality);
  // 注入了 drawToDataUrl（单测）但没注入 describeFrame 时不走浏览器 canvas
  const describe = opts.describeFrame ?? (opts.drawToDataUrl ? undefined : defaultDescribeFrame);
  const extra = describe ? describe(video) : null;
  return {
    targetMs,
    actualMs: Math.round((Number.isFinite(video.currentTime) ? video.currentTime : 0) * 1000),
    dataBase64: toBase64(dataUrl),
    ...(extra?.dhash ? { dhash: extra.dhash } : {}),
    ...(extra?.thumbBase64 ? { thumbBase64: extra.thumbBase64 } : {}),
  };
}

/**
 * 抽帧进行中标志（content 内共享）：抽帧要连续 seek <video>，每次 seek 都会触发
 * timeupdate → 面板的播放位置/字幕高亮跟着跳（冒烟 1b/5 的根因）。播放进度上报方
 * （bilibili.ts）据此跳过抽帧期间的 timeupdate。
 */
let captureInProgress = false;
export function isCaptureInProgress(): boolean {
  return captureInProgress;
}

/**
 * 批量抽帧：取前 maxFrames（默认 48）个目标；单帧失败跳过继续（不整体失败）。
 */
export async function captureFrames(
  video: HTMLVideoElementLike,
  targetsMs: number[],
  opts: CaptureRuntimeOptions & { maxFrames?: number } = {},
): Promise<CapturedFrame[]> {
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const targets = Array.isArray(targetsMs) ? targetsMs.slice(0, Math.max(0, maxFrames)) : [];
  // 抽帧要连续 seek，会让用户看到画面来回跳；记录起点，抽完恢复位置与播放状态
  const originMs = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const wasPlaying = !video.paused;
  // 抽帧要连续 seek：若此时正在播放，画面会一路乱跳。先暂停，抽完再恢复原状态。
  // 帧数越多越明显（10 分钟密集视频可取到十几帧），这一步不能省。
  if (wasPlaying) video.pause?.();
  captureInProgress = true;
  const frames: CapturedFrame[] = [];
  try {
    for (const targetMs of targets) {
      try {
        frames.push(await captureFrameAt(video, targetMs, opts));
      } catch {
        // 单帧失败（seek 失败 / canvas 被污染 / 编码失败）跳过该帧
      }
    }
  } finally {
    captureInProgress = false;
  }
  await restorePlayback(video, originMs, wasPlaying);
  return frames;
}

/** 抽帧结束：回到起点，并恢复原来的播放/暂停状态（失败也不影响主流程） */
async function restorePlayback(
  video: HTMLVideoElementLike,
  originMs: number,
  wasPlaying: boolean,
): Promise<void> {
  try {
    if (!wasPlaying) video.pause?.();
    video.currentTime = originMs;
    if (wasPlaying) await video.play?.();
  } catch {
    /* 恢复失败不影响已抽到的帧 */
  }
}

/**
 * 注册 CAPTURE_FRAMES 消息监听（panel → background → content）。
 * 校验 videoId 与当前一致；无 video / 不一致 / 抛错 → 回 { frames: [] }（不 throw）。
 */
export function registerFrameCaptureHandler(
  getVideoId: () => VideoId | null,
  getVideo: () => HTMLVideoElementLike | null,
): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as RuntimeMessage;
    if (msg.type !== MSG.CAPTURE_FRAMES) return;
    void (async () => {
      const video = getVideo();
      const videoId = getVideoId();
      const payload = msg.payload;
      if (!video || (videoId !== null && payload?.videoId !== videoId)) {
        sendResponse({ frames: [] });
        return;
      }
      try {
        const wanted = Array.isArray(payload?.targetsMs) ? payload.targetsMs : [];
        const frames = await captureFrames(video, wanted, {
          maxSize: payload?.maxSize,
          // 规划多少就抽多少（受 DEFAULT_MAX_FRAMES 兜底上限约束）
          maxFrames: wanted.length,
        });
        sendResponse({ frames });
      } catch {
        sendResponse({ frames: [] });
      }
    })();
    return true;
  });
}

// ---------------------------------------------------------------------------
// 轻量扫描（SPEC-11 页聚类精修）：只算 dHash + 清晰度，不导 JPEG
// ---------------------------------------------------------------------------

/** 清晰度网格尺寸（拉普拉斯方差用；32×18 足够分辨"翻页模糊 vs 停稳"） */
const SCAN_W = 32;
const SCAN_H = 18;

/**
 * 单点轻量描述（纯像素计算，无模型）：9×8 灰度 → dHash；32×18 灰度 → 清晰度。
 * 任何异常返回 dhash='' + sharpness=0（调用方视为该点失败，不影响其余点）。
 */
function describeScanPoint(video: HTMLVideoElementLike): { dhash: string; sharpness: number } {
  try {
    if (typeof document === 'undefined') return { dhash: '', sharpness: 0 };
    const src = video as unknown as CanvasImageSource;
    // dHash 画布（9×8）
    const tiny = document.createElement('canvas');
    tiny.width = DHASH_W;
    tiny.height = DHASH_H;
    const tctx = tiny.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!tctx) return { dhash: '', sharpness: 0 };
    tctx.drawImage(src, 0, 0, DHASH_W, DHASH_H);
    const dhash = dhashFromGray(grayFromRgba(tctx.getImageData(0, 0, DHASH_W, DHASH_H).data));
    // 清晰度画布（32×18）——亮度通道近似（RGBA 灰度化的同一口径）
    const scan = document.createElement('canvas');
    scan.width = SCAN_W;
    scan.height = SCAN_H;
    const sctx = scan.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!sctx) return { dhash, sharpness: 0 };
    sctx.drawImage(src, 0, 0, SCAN_W, SCAN_H);
    const sharpness = sharpnessFromGray(
      grayFromRgba(sctx.getImageData(0, 0, SCAN_W, SCAN_H).data),
      SCAN_W,
      SCAN_H,
    );
    return { dhash, sharpness };
  } catch {
    return { dhash: '', sharpness: 0 };
  }
}

/**
 * 扫描采样点（轻量）：顺序 seek，每点只算哈希与清晰度（不导 JPEG，成本约为
 * 全帧采集的百分之一）。总时间预算超时即返回已扫部分（graceful partial，
 * 不阻塞主流程——panel 侧对缺失点直接保持原目标）。
 * 播放状态保护与 captureFrames 同一口径（暂停 → 恢复）。
 */
/** 扫描点描述注入（单测用；缺省走浏览器 canvas 实现） */
export type DescribeScanPoint = (video: HTMLVideoElementLike) => { dhash: string; sharpness: number };

export async function scanFrames(
  video: HTMLVideoElementLike,
  pointsMs: readonly number[],
  opts: {
    budgetMs?: number;
    timeoutMs?: number;
    describeScan?: DescribeScanPoint;
    /** 进度回调（每 5 点节流；SPEC-12）：done/total 与最终 samples 无耦合 */
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<ScannedSample[]> {
  const budgetMs = opts.budgetMs ?? 25_000;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const points = Array.isArray(pointsMs) ? pointsMs.filter((t) => Number.isFinite(t) && t >= 0) : [];
  if (points.length === 0) return [];
  const originMs = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const wasPlaying = !video.paused;
  if (wasPlaying) video.pause?.();
  captureInProgress = true;
  const startedAt = Date.now();
  const samples: ScannedSample[] = [];
  try {
    for (const tMs of points) {
      // 时间预算：超了就停（已扫部分有效）
      if (Date.now() - startedAt > budgetMs) break;
      await seekTo(video, tMs / 1000, timeoutMs);
      const describe = opts.describeScan ?? describeScanPoint;
      const { dhash, sharpness } = describe(video);
      samples.push({ tMs, dhash, sharpness });
      // 进度节流：每 5 点报一次 + 最后一点必报（SPEC-12）
      if (opts.onProgress && (samples.length % 5 === 0 || samples.length === points.length)) {
        try {
          opts.onProgress(samples.length, points.length);
        } catch {
          /* 进度非关键路径 */
        }
      }
    }
  } finally {
    captureInProgress = false;
  }
  await restorePlayback(video, originMs, wasPlaying);
  return samples;
}

/**
 * 注册 SCAN_FRAMES 消息监听（panel → background → content，SPEC-11）。
 * 校验与降级口径同 CAPTURE_FRAMES：videoId 不一致 / 无 video / 抛错 → { samples: [] }。
 */
export function registerScanFramesHandler(
  getVideoId: () => VideoId | null,
  getVideo: () => HTMLVideoElementLike | null,
): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as RuntimeMessage;
    if (msg.type !== MSG.SCAN_FRAMES) return;
    void (async () => {
      const video = getVideo();
      const videoId = getVideoId();
      const payload = msg.payload;
      if (!video || (videoId !== null && payload?.videoId !== videoId)) {
        sendResponse({ samples: [] });
        return;
      }
      try {
        const points = Array.isArray(payload?.pointsMs) ? payload.pointsMs : [];
        const samples = await scanFrames(video, points, {
          budgetMs: payload?.budgetMs,
          // 进度广播（SPEC-12）：content → background → panel；失败静默（非关键路径）
          onProgress: (done, total) => {
            try {
              void chrome.runtime.sendMessage({
                type: MSG.SCAN_PROGRESS,
                payload: { videoId: payload.videoId, scanned: done, total },
              });
            } catch {
              /* 广播失败不影响扫描 */
            }
          },
        });
        sendResponse({ samples });
      } catch {
        sendResponse({ samples: [] });
      }
    })();
    return true;
  });
}
