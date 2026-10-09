/**
 * B 站字幕一级通道（SPEC-02 子任务 2.2，TECH-DESIGN §7.1）。
 *
 * 请求序列（全部走 BILI_ENDPOINTS，红线 9）：
 * 1. view?bvid= → data.pages[] 按 page 取 cid / duration / part
 * 2. nav → data.wbi_img 提取 imgKey/subKey → mixinKey（按日缓存）
 * 3. playerWbiV2?bvid=&cid=&wts=&w_rid= → data.subtitle.subtitles[]
 * 4. 选轨：UP 主字幕（非 ai- 前缀）优先于 AI 字幕；同级中文（zh 开头）优先
 * 5. 拉取字幕 JSON（协议相对地址补 https:）→ body[] → Cue[]（红线 5：from/to 完整转 startMs/endMs）
 *
 * 红线 8：任何失败路径返回 FetchResult，永不 throw。
 * 网络经 fetchFn 注入、时间经 now 注入，单测不碰网络。
 */
import type { Cue, FetchResult, SubtitleStatus } from '../types';
import { BILI_ENDPOINTS, BILI_AI_SUBTITLE_PREFIX } from '../config';
import { signWbiParams, getMixinKey } from './wbi';
import { classifySubtitleError } from './errors';

/** 与全局 fetch 同形的可注入请求函数 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchBiliSubtitlesOptions {
  bvid: string;
  page: number;
  /** 缺省用全局 fetch（携带 B 站登录态需 credentials: include） */
  fetchFn?: FetchLike;
  /** 时钟注入（mixinKey 按日缓存与 wts 用） */
  now?: () => number;
  /**
   * 字幕 JSON → Cue[] 解析器。默认实现动态加载
   * `core/subtitle/parsers#parseBiliSubtitle`（子任务 2.1 产物，于 2.3 正式接线）。
   * 默认值在调用时 resolve，本文件对 parsers 无静态依赖。
   */
  parseCues?: (json: unknown) => Cue[];
}

// ---------------------------------------------------------------------------
// mixin key 按日缓存（模块级，UTC 日界失效）
// ---------------------------------------------------------------------------

let mixinKeyCache: { key: string; date: string } | null = null;

/** 仅测试用：清空 mixin key 缓存 */
export function _resetMixinKeyCacheForTests(): void {
  mixinKeyCache = null;
}

const utcDateKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

/** 从 `.../<key>.png` 形式的 URL 尾段提取 key */
function extractKeyFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('.')[0];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

interface FetchedJson {
  httpStatus: number;
  /** null = 响应不是合法 JSON（视为接口变更） */
  json: unknown;
}

async function getJson(fetchFn: FetchLike, url: string): Promise<FetchedJson> {
  const res = await fetchFn(url, { credentials: 'include' });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { httpStatus: res.status, json };
}

/** view / nav / 字幕 JSON 等前置步骤的失败判定（与 §7.1 表同风格） */
function stepStatus(httpStatus: number, code: number | null, fieldOk: boolean): SubtitleStatus {
  if (httpStatus >= 500) return 'network';
  if (httpStatus >= 400 || (code !== null && code !== 0) || !fieldOk) return 'api_changed';
  return 'ok';
}

const fail = (status: SubtitleStatus, error: string): FetchResult => ({ cues: [], status, error });

function apiCodeOf(json: unknown): number | null {
  if (typeof json !== 'object' || json === null) return null;
  const code = (json as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function dataOf(json: unknown): Record<string, unknown> | null {
  if (typeof json !== 'object' || json === null) return null;
  const data = (json as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  return data as Record<string, unknown>;
}

interface BiliPage {
  page: number;
  cid: number;
  duration: number;
  part: string;
}

interface SubtitleTrack {
  lan?: unknown;
  subtitle_url?: unknown;
}

function asTracks(list: unknown[]): SubtitleTrack[] {
  return list.filter((t): t is SubtitleTrack => typeof t === 'object' && t !== null);
}

/** 选轨评分：非 AI > AI；同级中文（lan 以 zh 开头）优先；取首个最高分 */
function pickTrack(tracks: SubtitleTrack[]): SubtitleTrack & { url: string; lan: string } {
  let best: { track: SubtitleTrack; url: string; lan: string; score: number } | null = null;
  for (const track of tracks) {
    const url = track.subtitle_url;
    if (typeof url !== 'string' || url === '') continue;
    const lan = typeof track.lan === 'string' ? track.lan : '';
    const isAi = lan.startsWith(BILI_AI_SUBTITLE_PREFIX);
    const isZh = lan.startsWith('zh');
    const score = (isAi ? 0 : 2) + (isZh ? 1 : 0);
    if (best === null || score > best.score) best = { track, url, lan, score };
  }
  // 调用方保证 tracks 至少含一条有 url 的轨
  const picked = best as { track: SubtitleTrack; url: string; lan: string };
  return { ...picked.track, url: picked.url, lan: picked.lan };
}

// 默认 parseCues：动态加载，避免对并行产物（子任务 2.1）的静态依赖
let defaultParseCues: ((json: unknown) => Cue[]) | null | undefined;

async function loadDefaultParseCues(): Promise<((json: unknown) => Cue[]) | null> {
  if (defaultParseCues === undefined) {
    try {
      const mod = await import('../core/subtitle/parsers');
      defaultParseCues = mod.parseBiliSubtitle;
    } catch {
      defaultParseCues = null;
    }
  }
  return defaultParseCues;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function fetchSubtitleChain(
  opts: FetchBiliSubtitlesOptions,
  fetchFn: FetchLike,
  now: () => number,
  parseCues: (json: unknown) => Cue[],
): Promise<FetchResult> {
  const { bvid, page } = opts;

  // --- 1. view → cid ---
  const view = await getJson(fetchFn, `${BILI_ENDPOINTS.view}?bvid=${encodeURIComponent(bvid)}`);
  const viewData = view.json !== null ? dataOf(view.json) : null;
  const pages = Array.isArray(viewData?.pages) ? (viewData?.pages as unknown[]) : [];
  const viewStatus = stepStatus(view.httpStatus, apiCodeOf(view.json), pages.length > 0);
  if (viewStatus !== 'ok') return fail(viewStatus, `view api failed (http ${view.httpStatus}, code ${apiCodeOf(view.json)})`);

  const matched = asPages(pages).find((p) => p.page === page);
  if (!matched) {
    const available = asPages(pages).map((p) => p.page).join(', ');
    return fail('api_changed', `page not found: page=${page}, available=[${available}]`);
  }
  const { cid, duration, part } = matched; // duration/part 供 2.3 接线 VideoMeta 用（FetchResult 契约暂不携带）
  void duration;
  void part;

  // --- 2. mixin key（按日缓存）---
  const today = utcDateKey(now());
  let mixinKey = mixinKeyCache && mixinKeyCache.date === today ? mixinKeyCache.key : null;
  if (mixinKey === null) {
    const nav = await getJson(fetchFn, BILI_ENDPOINTS.nav);
    const navData = nav.json !== null ? dataOf(nav.json) : null;
    const wbiImg = navData && typeof navData.wbi_img === 'object' && navData.wbi_img !== null
      ? (navData.wbi_img as { img_url?: unknown; sub_url?: unknown })
      : null;
    const imgUrl = wbiImg?.img_url;
    const subUrlKey = wbiImg?.sub_url;
    const fieldOk = typeof imgUrl === 'string' && typeof subUrlKey === 'string';
    const navStatus = stepStatus(nav.httpStatus, apiCodeOf(nav.json), fieldOk);
    if (navStatus !== 'ok') return fail(navStatus, `nav api failed (http ${nav.httpStatus}, code ${apiCodeOf(nav.json)})`);

    mixinKey = getMixinKey(
      extractKeyFromUrl(imgUrl as string),
      extractKeyFromUrl(subUrlKey as string),
    );
    mixinKeyCache = { key: mixinKey, date: today };
  }

  // --- 3. playerWbiV2 → 字幕轨列表 ---
  const wts = Math.floor(now() / 1000);
  const signedQuery = signWbiParams({ bvid, cid }, mixinKey, wts);
  const player = await getJson(fetchFn, `${BILI_ENDPOINTS.playerWbiV2}?${signedQuery}`);
  const playerData = player.json !== null ? dataOf(player.json) : null;
  const subtitle = playerData && typeof playerData.subtitle === 'object' && playerData.subtitle !== null
    ? (playerData.subtitle as { subtitles?: unknown; need_login_subtitle?: unknown })
    : null;
  const subtitleList = subtitle && Array.isArray(subtitle.subtitles) ? subtitle.subtitles : [];
  const status = classifySubtitleError({
    httpStatus: player.httpStatus,
    apiCode: apiCodeOf(player.json),
    hasSubtitleField: subtitle !== null && Array.isArray(subtitle.subtitles),
    subtitleList,
    needLoginSubtitle: subtitle?.need_login_subtitle === true,
  });
  if (status !== 'ok') return fail(status, `player api: ${status} (http ${player.httpStatus}, code ${apiCodeOf(player.json)})`);

  // --- 4. 选轨 ---
  const withUrl = asTracks(subtitleList).filter(
    (t) => typeof t.subtitle_url === 'string' && t.subtitle_url !== '',
  );
  if (withUrl.length === 0) return fail('no_subtitle', 'no track with subtitle_url');

  const best = pickTrack(withUrl);
  const isAi = best.lan.startsWith(BILI_AI_SUBTITLE_PREFIX);

  // --- 5. 拉取字幕 JSON → Cue[] ---
  let subUrl: string = best.url;
  if (subUrl.startsWith('//')) subUrl = `https:${subUrl}`;
  const sub = await getJson(fetchFn, subUrl);
  const subStatus = stepStatus(sub.httpStatus, null, sub.json !== null);
  if (subStatus !== 'ok') return fail(subStatus, `subtitle json fetch failed (http ${sub.httpStatus})`);

  const cues = parseCues(sub.json);
  if (!Array.isArray(cues) || cues.length === 0) {
    return fail('api_changed', 'subtitle body empty');
  }
  return {
    cues,
    status: 'ok',
    source: isAi ? 'bili_ai' : 'bili_uploader',
    lang: best.lan,
  };
}

/** view 响应 pages[] 的宽松解析 */
function asPages(list: unknown[]): BiliPage[] {
  return list.filter(
    (p): p is BiliPage =>
      typeof p === 'object' && p !== null &&
      typeof (p as BiliPage).page === 'number' &&
      typeof (p as BiliPage).cid === 'number',
  );
}

/**
 * B 站字幕一级通道入口。
 *
 * 永不 throw（红线 8）：任何一步失败按 §7.1 分类表返回对应 status 的 FetchResult。
 */
export async function fetchBiliSubtitles(opts: FetchBiliSubtitlesOptions): Promise<FetchResult> {
  const fetchFn: FetchLike = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const now = opts.now ?? Date.now;

  let parseCues = opts.parseCues;
  if (!parseCues) {
    const loaded = await loadDefaultParseCues();
    if (!loaded) {
      return fail('api_changed', 'parseCues unavailable (default parser not loaded)');
    }
    parseCues = loaded;
  }

  try {
    return await fetchSubtitleChain(opts, fetchFn, now, parseCues);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail('network', `unexpected: ${message}`);
  }
}
