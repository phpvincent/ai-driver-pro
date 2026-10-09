/**
 * 消息协议契约 —— 仅父 agent 可修改（CONSTITUTION §4）。
 * content ↔ background ↔ panel 三方通信的唯一消息形状。
 */

import type { VideoId } from './types';

export const MSG = {
  /** content -> background：检测到 / SPA 切换到某视频 */
  VIDEO_DETECTED: 'video/detected',
  /** content -> background：离开视频页 */
  VIDEO_LEFT: 'video/left',
  /** content -> background：播放进度（节流 500ms） */
  PLAYBACK_PROGRESS: 'playback/progress',
  /** background -> panel：当前 tab 的视频变化 */
  VIDEO_CHANGED: 'video/changed',
  /** background -> panel：播放进度变化 */
  PLAYBACK_CHANGED: 'playback/changed',
  /** panel -> background -> content：跳播 */
  SEEK: 'player/seek',
  /** panel -> background -> content：暂停（提问自动暂停用） */
  PAUSE: 'player/pause',
  /** panel -> background -> content：恢复播放 */
  RESUME: 'player/resume',
  /** panel -> background -> content：抽取关键帧（视觉问答，返回 JPEG base64 数组） */
  CAPTURE_FRAMES: 'video/capture-frames',
  /** panel -> background：拉取当前 tab 的视频信息（panel 打开时） */
  CURRENT_VIDEO_GET: 'video/current-get',
  /** panel <-> background：设置读写 */
  GET_SETTINGS: 'settings/get',
  SET_SETTINGS: 'settings/set',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

export interface VideoInfoPayload {
  videoId: VideoId;
  bvid: string;
  page: number;
  /** 分 P 标题 */
  title: string;
  durationMs: number;
  /**
   * 视频页 URL（content 上报，用于笔记回链；缺省时由 bvid+page 兜底拼接）。
   * SPEC-08 8.2：此前恒为空串，Obsidian 时间戳链接全部不可点。
   */
  url?: string;
  /** 分 P 的 cid（content 从页面初态读取；拿不到为 0，不参与链接生成） */
  cid?: number;
}

export interface PlaybackPayload {
  videoId: VideoId;
  positionMs: number;
  playing: boolean;
  /** 视频播放到结尾（content 的 ended 事件；触发回顾问卷，SPEC-08 8.8） */
  ended?: boolean;
}

export interface SeekPayload {
  videoId: VideoId;
  targetMs: number;
}

export interface CaptureFramesPayload {
  videoId: VideoId;
  /** 目标时间点（毫秒），最多取前 N 个 */
  targetsMs: number[];
  /** 最长边像素（panel 传 VISION.maxSize） */
  maxSize?: number;
}

export interface CapturedFrame {
  targetMs: number;
  /** 已吸附到的真实帧时间（毫秒） */
  actualMs: number;
  /** JPEG base64（不含 data: 前缀） */
  dataBase64: string;
  /** 感知哈希（dHash，16 位十六进制 = 64 bit）：用于"同一页 PPT"去重 */
  dhash?: string;
  /** 160px 缩略图 base64（仅日志展示用，不发给模型） */
  thumbBase64?: string;
}

export interface VideoIdPayload {
  videoId: VideoId;
}

export type RuntimeMessage =
  | { type: typeof MSG.VIDEO_DETECTED; payload: VideoInfoPayload }
  | { type: typeof MSG.VIDEO_LEFT; payload: VideoIdPayload }
  | { type: typeof MSG.PLAYBACK_PROGRESS; payload: PlaybackPayload }
  | { type: typeof MSG.VIDEO_CHANGED; payload: VideoInfoPayload | null }
  | { type: typeof MSG.PLAYBACK_CHANGED; payload: PlaybackPayload }
  | { type: typeof MSG.SEEK; payload: SeekPayload }
  | { type: typeof MSG.CAPTURE_FRAMES; payload: CaptureFramesPayload }
  | { type: typeof MSG.PAUSE; payload: VideoIdPayload }
  | { type: typeof MSG.RESUME; payload: VideoIdPayload }
  | { type: typeof MSG.CURRENT_VIDEO_GET }
  | { type: typeof MSG.GET_SETTINGS }
  | { type: typeof MSG.SET_SETTINGS; payload: Record<string, unknown> };
