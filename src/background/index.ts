/**
 * background Service Worker：薄路由、tab → video 映射、侧边栏启用（TECH-DESIGN §3.2）。
 * 只做消息转发与 tab 状态维护，不承载业务与长任务；SW 空闲约 30s 会被回收，
 * tab → video 映射同步写入 chrome.storage.session，重启后恢复。
 *
 * 分层：路由决策是纯函数 routeBackgroundMessage（无 chrome.* 依赖，可单测）；
 * 副作用（storage / sidePanel / sendMessage）由执行器按 Action 顺序执行。
 */
import { MSG, type RuntimeMessage, type VideoInfoPayload } from '../messages';
import type { VideoId } from '../types';

// ===== 路由决策层（纯函数，无 chrome.* 依赖） =====

/** 执行器可执行的副作用描述 */
export type Action =
  | { kind: 'storeVideo'; tabId: number; payload: VideoInfoPayload }
  | { kind: 'clearVideo'; tabId: number }
  | { kind: 'enableSidePanel'; tabId: number }
  | { kind: 'forwardToPanel'; message: RuntimeMessage }
  | { kind: 'forwardToTab'; tabId: number; message: RuntimeMessage }
  | { kind: 'respond'; response: VideoInfoPayload | null }
  | { kind: 'captureFrames'; tabId: number; message: RuntimeMessage }
  | { kind: 'readSettings' }
  | { kind: 'writeSettings'; settings: Record<string, unknown> }
  | { kind: 'ignore'; reason: string };

/** 路由输入：sender 与 tab → video 映射的只读视图 */
export interface RouteContext {
  /** 消息来源 tab id；content script 必有，扩展页面（panel）为 null */
  senderTabId: number | null;
  /** 当前活跃 tab 的视频（executor 已解析，供 CURRENT_VIDEO_GET 使用） */
  getActiveTabVideo(): VideoInfoPayload | null;
  /** 全屏标签页等扩展页面自身成为活跃 tab 时，回退到最近检测到的视频 */
  getLastVideo(): VideoInfoPayload | null;
  getVideoByTabId(tabId: number): VideoInfoPayload | null;
  getTabIdByVideoId(videoId: VideoId): number | null;
}

export function routeBackgroundMessage(msg: RuntimeMessage, ctx: RouteContext): Action[] {
  switch (msg.type) {
    case MSG.VIDEO_DETECTED: {
      const tabId = ctx.senderTabId;
      if (tabId === null) {
        return [{ kind: 'ignore', reason: 'VIDEO_DETECTED 需要 content script 来源 tab' }];
      }
      // per-tab 启用必须保留：历史版本的禁用状态会残留，检测到视频时是唯一的重启用时机
      return [
        { kind: 'storeVideo', tabId, payload: msg.payload },
        { kind: 'enableSidePanel', tabId },
        { kind: 'forwardToPanel', message: { type: MSG.VIDEO_CHANGED, payload: msg.payload } },
      ];
    }
    case MSG.VIDEO_LEFT: {
      const tabId = ctx.senderTabId;
      if (tabId === null) {
        return [{ kind: 'ignore', reason: 'VIDEO_LEFT 需要 content script 来源 tab' }];
      }
      // SPA 快速切换分 P 时可能收到过期的 VIDEO_LEFT（新视频已写入映射），仅清除仍匹配的
      const current = ctx.getVideoByTabId(tabId);
      if (!current || current.videoId !== msg.payload.videoId) {
        return [{ kind: 'ignore', reason: '映射不存在或已更新，跳过过期 VIDEO_LEFT' }];
      }
      // 不禁用该 tab 的侧边栏：Chrome 的 per-tab 禁用状态会残留，导致后续
      // open()/点击行为报 "No active side panel"。面板对无视频状态自行展示。
      return [
        { kind: 'clearVideo', tabId },
        { kind: 'forwardToPanel', message: { type: MSG.VIDEO_CHANGED, payload: null } },
      ];
    }
    case MSG.PLAYBACK_PROGRESS: {
      if (ctx.senderTabId === null) {
        return [{ kind: 'ignore', reason: 'PLAYBACK_PROGRESS 需要 content script 来源 tab' }];
      }
      return [{ kind: 'forwardToPanel', message: { type: MSG.PLAYBACK_CHANGED, payload: msg.payload } }];
    }
    case MSG.SEEK:
    case MSG.PAUSE:
    case MSG.RESUME: {
      const tabId = ctx.getTabIdByVideoId(msg.payload.videoId);
      if (tabId === null) {
        return [{ kind: 'ignore', reason: `videoId ${msg.payload.videoId} 无对应 tab` }];
      }
      return [{ kind: 'forwardToTab', tabId, message: msg }];
    }
    case MSG.CAPTURE_FRAMES: {
      // 抽帧需回传结果：按 videoId 反查 tab，向 content 请求并把结果 respond 给 panel
      const tabId = ctx.getTabIdByVideoId(msg.payload.videoId);
      if (tabId === null) {
        return [{ kind: 'respond', response: { frames: [] } as unknown as VideoInfoPayload }];
      }
      return [{ kind: 'captureFrames', tabId, message: msg }];
    }
    case MSG.CURRENT_VIDEO_GET: {
      // 全屏单视图（panel.html?view=xxx）自身是活跃 tab，映射里查不到；
      // 回退最近检测到的视频（播放进度走 PLAYBACK_CHANGED 广播自动跟上）
      const active = ctx.getActiveTabVideo();
      return [{ kind: 'respond', response: active ?? ctx.getLastVideo() }];
    }
    case MSG.GET_SETTINGS:
      return [{ kind: 'readSettings' }];
    case MSG.SET_SETTINGS:
      return [{ kind: 'writeSettings', settings: msg.payload }];
    default:
      return [{ kind: 'ignore', reason: 'background 不处理该消息类型' }];
  }
}

// ===== 副作用执行层（依赖 chrome.*；Node 单测环境不执行） =====

const TAB_VIDEO_MAP_KEY = 'tabVideoMap';
const SETTINGS_KEY = 'settings';

/** 内存映射：tabId → VideoInfoPayload；SW 重启由 restoreTabVideoMap 恢复 */
const tabVideoMap = new Map<number, VideoInfoPayload>();
/** 最近一次检测到的视频（全屏单视图等无 tab 上下文页面的回退来源） */
let lastVideoPayload: VideoInfoPayload | null = null;

async function persistTabVideoMap(): Promise<void> {
  await chrome.storage.session.set({ [TAB_VIDEO_MAP_KEY]: Object.fromEntries(tabVideoMap) });
}

async function restoreTabVideoMap(): Promise<void> {
  const stored = await chrome.storage.session.get<Record<string, VideoInfoPayload>>(TAB_VIDEO_MAP_KEY);
  const raw = stored[TAB_VIDEO_MAP_KEY];
  if (raw && typeof raw === 'object') {
    for (const [tabId, payload] of Object.entries(raw)) {
      if (payload && typeof payload === 'object' && typeof payload.videoId === 'string') {
        tabVideoMap.set(Number(tabId), payload);
        lastVideoPayload = payload;
      }
    }
  }
}

async function buildRouteContext(senderTabId: number | null): Promise<RouteContext> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTabId = typeof activeTab?.id === 'number' ? activeTab.id : null;
  return {
    senderTabId,
    getActiveTabVideo: () => (activeTabId !== null ? (tabVideoMap.get(activeTabId) ?? null) : null),
    getLastVideo: () => lastVideoPayload,
    getVideoByTabId: (tabId) => tabVideoMap.get(tabId) ?? null,
    getTabIdByVideoId: (videoId) => {
      for (const [tabId, payload] of tabVideoMap) {
        if (payload.videoId === videoId) return tabId;
      }
      return null;
    },
  };
}

async function executeActions(actions: Action[], sendResponse: (response?: unknown) => void): Promise<void> {
  let responded = false;
  for (const action of actions) {
    switch (action.kind) {
      case 'storeVideo':
        tabVideoMap.set(action.tabId, action.payload);
        lastVideoPayload = action.payload;
        await persistTabVideoMap();
        break;
      case 'clearVideo':
        tabVideoMap.delete(action.tabId);
        await persistTabVideoMap();
        break;
      case 'enableSidePanel':
        await chrome.sidePanel.setOptions({ tabId: action.tabId, path: 'panel.html', enabled: true });
        console.info('[vsc] side panel enabled for tab', action.tabId);
        break;
      case 'forwardToPanel':
        // panel 可能未打开（无接收方会 reject），静默吞掉
        chrome.runtime.sendMessage(action.message).catch(() => {});
        break;
      case 'forwardToTab':
        chrome.tabs.sendMessage(action.tabId, action.message).catch(() => {});
        break;
      case 'respond':
        sendResponse(action.response);
        responded = true;
        break;
      case 'captureFrames': {
        // content 返回 { frames }；失败/超时按空帧降级，不阻断问答
        const result = await chrome.tabs
          .sendMessage(action.tabId, action.message)
          .catch(() => ({ frames: [] }));
        sendResponse(result ?? { frames: [] });
        responded = true;
        break;
      }
      case 'readSettings': {
        const stored = await chrome.storage.local.get<Record<string, Record<string, unknown>>>(SETTINGS_KEY);
        sendResponse(stored[SETTINGS_KEY] ?? {});
        responded = true;
        break;
      }
      case 'writeSettings':
        await chrome.storage.local.set({ [SETTINGS_KEY]: action.settings });
        sendResponse({ ok: true });
        responded = true;
        break;
      case 'ignore':
        break;
    }
  }
  // 未产生响应时也关闭消息通道，避免发送方 Promise 悬挂
  if (!responded) sendResponse(undefined);
}

function bootstrap(): void {
  console.info('[vsc] background boot');

  // 点击工具栏图标打开侧边栏——首选路径。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .then(() => console.info('[vsc] openPanelOnActionClick enabled'))
    .catch((err: unknown) => console.error('[vsc] setPanelBehavior failed:', err));

  // 兜底：behavior 未生效时（onClicked 触发即为信号）。两个调用背靠背同步发出、
  // 都不 await：setOptions 先启用（清残留禁用），open 紧随其后保持在手势栈内。
  // open 前任何 await 都会丢手势（报 "may only be called in response to a user gesture"）。
  chrome.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (typeof tabId !== 'number') return;
    console.info('[vsc] action clicked (behavior miss), enabling + opening for tab', tabId);
    // path 必须显式绑定：关闭面板后 per-tab "active" 条目被清空，
    // 不带 path 的 setOptions 无法重建，open 会报 "No active side panel for tab"
    void chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled: true });
    chrome.sidePanel
      .open({ tabId })
      .catch((err: unknown) => {
        console.error('[vsc] sidePanel.open failed, falling back to tab:', err);
        return chrome.tabs.create({ url: 'panel.html' });
      })
      .catch((err2: unknown) => console.error('[vsc] tab fallback failed:', err2));
  });

  // SW 重启恢复 tab → video 映射
  void restoreTabVideoMap();

  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || typeof (msg as RuntimeMessage).type !== 'string') {
      return false;
    }
    void (async () => {
      const ctx = await buildRouteContext(sender.tab?.id ?? null);
      const actions = routeBackgroundMessage(msg as RuntimeMessage, ctx);
      await executeActions(actions, sendResponse);
    })();
    return true; // sendResponse 将异步调用
  });
}

// Node（vitest）环境无 chrome 全局，跳过副作用装配，仅暴露纯函数
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  bootstrap();
}
