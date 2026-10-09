/**
 * 关键帧抽取（视觉问答的内容侧实现）：定位 <video> 到目标时间 → 画到 canvas → JPEG base64。
 *
 * 用户洞察：视频的画面 / 页面才是精华，要和字幕一起喂给模型。本模块只负责"取帧"，
 * 不做任何模型调用（红线 10：content script 禁入模型配置 / 密钥 / 模型调用模块）。
 *
 * 纯函数（computeCanvasSize / toBase64）可脱离浏览器测试；drawToDataUrl 可注入，
 * 单测用假 video + 假绘制函数驱动，无需 jsdom。
 */
import { MSG, type CapturedFrame, type RuntimeMessage } from '../messages';
import type { VideoId } from '../types';
import { DHASH_H, DHASH_W, dhashFromGray, grayFromRgba } from '../core/vision/dhash';

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
