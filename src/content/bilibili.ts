/**
 * B 站 content script 入口：videoId 识别、SPA 路由与 <video> 生命周期监听、进度上报。
 * 纯函数（parseVideoId / toVideoId）可脱离浏览器测试；副作用编排仅在浏览器环境启动。
 * 红线 10：本文件禁止 import 模型配置 / 密钥 / 模型调用模块（types/messages 契约与播放阈值可以）。
 */
import { BILI_URL_PATTERN, BVID_REGEXES, PLAYBACK } from '../config/shared';
import { MSG, type PlaybackPayload, type RuntimeMessage, type VideoIdPayload, type VideoInfoPayload } from '../messages';
import { initPlayer } from './player';
import { isCaptureInProgress, registerFrameCaptureHandler } from './frameCapture';

// ---------- 纯函数（单测覆盖） ----------

/** 从 B 站视频页 URL 提取 bvid 与分 P 号；非 B 站域名或无 bvid 返回 null */
export function parseVideoId(url: string): { bvid: string; page: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== 'bilibili.com' && !parsed.hostname.endsWith('.bilibili.com')) {
    return null;
  }
  let bvid: string | null = null;
  for (const regex of BVID_REGEXES) {
    const match = parsed.pathname.match(regex);
    if (match) {
      bvid = match[1];
      break;
    }
  }
  if (!bvid) return null;
  // p 参数：正整数；缺失或非法默认 1
  let page = 1;
  const pRaw = parsed.searchParams.get('p');
  if (pRaw !== null && /^\d+$/.test(pRaw)) {
    const n = Number(pRaw);
    if (n >= 1) page = n;
  }
  return { bvid, page };
}

/** videoId = `{bvid}_p{page}`（TECH-DESIGN §2.2） */
export function toVideoId(bvid: string, page: number): string {
  return `${bvid}_p${page}`;
}

// ---------- B 站页面初态（window.__INITIAL_STATE__ 的最小形状） ----------

interface BiliPageInfo {
  page: number;
  /** 分 P 标题 */
  part: string;
  /** 秒 */
  duration: number;
  /** 分 P 的 cid（页面初态里有；拿不到由调用方兜底 0） */
  cid?: number;
}

interface BiliInitialState {
  videoData?: {
    title?: string;
    /** 秒 */
    duration?: number;
    /** 单 P 视频时 cid 在 videoData 顶层 */
    cid?: number;
    pages?: BiliPageInfo[];
  };
}

function getInitialState(): BiliInitialState | undefined {
  return (window as unknown as { __INITIAL_STATE__?: BiliInitialState }).__INITIAL_STATE__;
}

// ---------- 运行时状态 ----------

let currentVideoId: string | null = null;
let currentVideo: HTMLVideoElement | null = null;
let lastProgressAt = 0;

function post(message: RuntimeMessage): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      // 扩展上下文失效（更新 / 重载）时静默
    });
  } catch {
    // 同上
  }
}

// ---------- 视频信息组装 ----------

function collectVideoInfo({ bvid, page }: { bvid: string; page: number }): VideoInfoPayload {
  const videoData = getInitialState()?.videoData;
  const pageEntry = videoData?.pages?.find((p) => p.page === page);
  const title =
    pageEntry?.part || videoData?.title || document.title || '';
  let durationMs =
    (pageEntry?.duration ?? videoData?.duration ?? 0) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    const video = document.querySelector('video');
    if (video && Number.isFinite(video.duration)) {
      durationMs = Math.round(video.duration * 1000);
    }
  }
  return {
    videoId: toVideoId(bvid, page),
    bvid,
    page,
    title,
    durationMs: Math.round(durationMs),
    // SPEC-08 8.2：笔记回链的数据源。url 只保留 origin+path（+p 参数），
    // 去掉分享追踪参数；cid 供后续弹幕/字幕直连接口用，链接生成不依赖它
    url: `${location.origin}${location.pathname}${page > 1 ? `?p=${page}` : ''}`,
    cid: pageEntry?.cid ?? videoData?.cid ?? 0,
  };
}

// ---------- SPA 路由监听 ----------

function patchHistory(onChange: () => void): void {
  const wrap = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    fn(...args);
    onChange();
  };
  history.pushState = wrap(history.pushState.bind(history));
  history.replaceState = wrap(history.replaceState.bind(history));
}

function watchNavigation(onChange: () => void): void {
  patchHistory(onChange);
  window.addEventListener('popstate', onChange);
  // 兜底轮询：B 站切分 P 改 query 可能不触发上述任何事件
  let lastHref = location.href;
  window.setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      onChange();
    }
  }, 800);
}

function handleUrlChange(): void {
  const parsed = BILI_URL_PATTERN.test(location.href) ? parseVideoId(location.href) : null;
  if (parsed) {
    const videoId = toVideoId(parsed.bvid, parsed.page);
    if (videoId === currentVideoId) return;
    currentVideoId = videoId;
    console.info('[vsc] content: video detected ->', videoId);
    post({ type: MSG.VIDEO_DETECTED, payload: collectVideoInfo(parsed) });
  } else if (currentVideoId) {
    const leftPayload: VideoIdPayload = { videoId: currentVideoId };
    currentVideoId = null;
    post({ type: MSG.VIDEO_LEFT, payload: leftPayload });
  }
}

// ---------- <video> 元素生命周期与进度上报 ----------

function onTimeUpdate(): void {
  const video = currentVideo;
  if (!video || !currentVideoId) return;
  // 抽帧期间连续 seek 会触发一串 timeupdate：上报会让面板的播放位置/字幕高亮
  // 在真实位置和抽帧目标之间来回跳（冒烟 1b/5）。跳过；恢复后由 restore 补发一次。
  if (isCaptureInProgress()) return;
  const now = Date.now();
  if (now - lastProgressAt < PLAYBACK.progressThrottleMs) return;
  lastProgressAt = now;
  const payload: PlaybackPayload = {
    videoId: currentVideoId,
    positionMs: Math.round(video.currentTime * 1000),
    playing: !video.paused,
  };
  post({ type: MSG.PLAYBACK_PROGRESS, payload });
}

function bindVideo(video: HTMLVideoElement): void {
  if (currentVideo === video) return;
  if (currentVideo) {
    currentVideo.removeEventListener('timeupdate', onTimeUpdate);
    currentVideo.removeEventListener('ended', onEnded);
  }
  currentVideo = video;
  video.addEventListener('timeupdate', onTimeUpdate);
  // 播放到结尾：触发面板的回顾问卷（每视频一次；SPEC-07 7.2 / SPEC-08 8.8）
  video.addEventListener('ended', onEnded);
}

function onEnded(): void {
  const video = currentVideo;
  if (!video || !currentVideoId) return;
  post({
    type: MSG.PLAYBACK_PROGRESS,
    payload: {
      videoId: currentVideoId,
      positionMs: Math.round(video.currentTime * 1000),
      playing: false,
      ended: true,
    },
  });
}

function observeVideos(): void {
  const scan = () => {
    if (currentVideo && !currentVideo.isConnected) {
      currentVideo.removeEventListener('timeupdate', onTimeUpdate);
      currentVideo = null;
    }
    const video = document.querySelector('video');
    if (video) bindVideo(video);
  };
  scan();
  const observer = new MutationObserver(scan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ---------- 启动 ----------

function initContentScript(): void {
  watchNavigation(handleUrlChange);
  observeVideos();
  initPlayer(() => currentVideoId, () => currentVideo);
  // 关键帧抽取（视觉问答）：CAPTURE_FRAMES 消息监听
  registerFrameCaptureHandler(() => currentVideoId, () => currentVideo);
  handleUrlChange();
}

// 浏览器环境自动启动；Node 单测环境仅使用纯函数
if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
  initContentScript();
}
