/**
 * 共享配置层 —— content script 唯一允许 import 的配置入口（宪法红线 10）。
 * 本文件只放与模型/密钥/端点无关的通用阈值与正则；
 * 模型、密钥、接口端点一律在 ./index.ts（panel / background 专用）。
 */

/** B 站视频页匹配（content script 注入条件同此） */
export const BILI_URL_PATTERN = /^https:\/\/www\.bilibili\.com\/video\//;

/** 从 URL 提取 bvid 的候选正则（按顺序） */
export const BVID_REGEXES = [/\/video\/(BV[0-9A-Za-z]{10})/];

export const PLAYBACK = {
  /** timeupdate 上报节流 */
  progressThrottleMs: 500,
} as const;
