/**
 * B 站字幕接口错误分类（SPEC-02 子任务 2.2）。
 *
 * 权威规格：TECH-DESIGN §7.1「错误分类（按顺序判定）」表。
 * 注意（2026-09-30 实测）：空字幕列表 ≠ 无字幕——`need_login_subtitle=true`
 * 时必须优先判 need_login，否则会把"未登录"误报为"无字幕"（A4）。
 *
 * 纯函数，无网络与 chrome.* 依赖。
 */
import type { SubtitleStatus } from '../types';

export interface SubtitleErrorInput {
  /** fetch 抛错（TypeError 等）——优先级最高 */
  networkError?: unknown;
  /** HTTP 状态码（非 200 时传入）。5xx 归 network，4xx 归 api_changed（§7.1） */
  httpStatus?: number;
  /** 响应 JSON 的 code 字段（缺失时传 null） */
  apiCode?: number | null;
  /** 响应 data 里是否有 subtitle 字段（缺预期字段 = 接口变更） */
  hasSubtitleField: boolean;
  /** subtitles 数组 */
  subtitleList: unknown[];
  /** data.subtitle.need_login_subtitle */
  needLoginSubtitle?: boolean;
}

/**
 * 按序判定：network → api_changed → need_login → no_subtitle → ok。
 * 返回 'ok' 表示"有轨可取"（列表非空）；细粒度的选轨失败由调用方处理。
 */
export function classifySubtitleError(input: SubtitleErrorInput): SubtitleStatus {
  // 1. 请求失败 / 超时 / 5xx → network
  if (input.networkError !== undefined) return 'network';
  if (input.httpStatus !== undefined && input.httpStatus >= 500) return 'network';

  // 2. 4xx / code≠0 / 缺预期字段 → api_changed
  if (input.httpStatus !== undefined && input.httpStatus >= 400) return 'api_changed';
  if (input.apiCode !== undefined && input.apiCode !== null && input.apiCode !== 0) {
    return 'api_changed';
  }
  if (!input.hasSubtitleField) return 'api_changed';

  // 3. 空列表 + 需登录 → need_login（先于 no_subtitle，不可颠倒）
  if (input.subtitleList.length === 0) {
    if (input.needLoginSubtitle === true) return 'need_login';
    // 4. 空列表且未要求登录
    return 'no_subtitle';
  }

  // 5. 列表非空
  return 'ok';
}
