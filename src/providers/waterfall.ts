/**
 * 字幕获取瀑布编排（SPEC-02 子任务 2.3，TECH-DESIGN §7.1 有序瀑布）。
 *
 * 级别顺序：手动粘贴（manualText 有值时直达，跳过缓存与 B 站）→
 * 字幕层缓存（manual_pasted 记录照常命中）→ B 站一级通道
 * （2.2 返回原始解析 cues，此处统一再过 normalizeCues 去重 / 合并）。
 *
 * 红线 8：任何一级失败——包括 deps 抛异常（网络抛错 / DB 损坏）——都不
 * 向上抛，降级下一级；失败或空结果不落缓存（避免用户卡死在错误状态），
 * 手动粘贴成功结果落缓存。纯函数式依赖注入：无模块级状态、无 URL（红线 9）。
 */
import type { FetchResult, SubtitleRecord, VideoMeta } from '../types';
import { normalizeCues } from '../core/subtitle/normalize';
import { manualPaste } from './manual-paste';

export interface WaterfallDeps {
  fetchBili: (opts: { bvid: string; page: number }) => Promise<FetchResult>;
  /** 缺省用 manual-paste 的 manualPaste */
  manualPasteFn?: (raw: string) => FetchResult;
  getSubtitle: (videoId: string) => Promise<SubtitleRecord | null>;
  saveSubtitle: (rec: SubtitleRecord) => Promise<void>;
}

export interface WaterfallRequest {
  videoId: string;
  bvid: string;
  page: number;
  /** 标题 / 时长等（panel 已知，直接传入） */
  meta: VideoMeta;
  /** 用户粘贴内容（有值时跳过前两级直接进手动通道） */
  manualText?: string;
  /** 跳过缓存 */
  forceRefresh?: boolean;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** deps.getSubtitle 异常 → 视为缓存未命中（DB 坏了直接走网络 / 手动） */
async function getCached(deps: WaterfallDeps, videoId: string): Promise<SubtitleRecord | null> {
  try {
    return await deps.getSubtitle(videoId);
  } catch {
    return null;
  }
}

/** deps.saveSubtitle 异常 → 吞掉（缓存写失败不影响本次结果） */
async function saveQuietly(deps: WaterfallDeps, rec: SubtitleRecord): Promise<void> {
  try {
    await deps.saveSubtitle(rec);
  } catch {
    /* 红线 8：降级，不上抛 */
  }
}

function toRecord(req: WaterfallRequest, result: FetchResult): SubtitleRecord {
  return {
    videoId: req.videoId,
    meta: req.meta,
    source: result.source ?? null,
    lang: result.lang ?? null,
    status: result.status,
    cues: result.cues,
    // 生产路径由 db.saveSubtitle 以注入时钟统一盖章，此值仅作直连 DbLike 时的兜底
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 瀑布入口。永不 throw（红线 8）：任何一级失败降级下一级，
 * 全部失败返回对应 status 的 FetchResult。
 */
export async function runSubtitleWaterfall(
  req: WaterfallRequest,
  deps: WaterfallDeps,
): Promise<FetchResult> {
  const paste = deps.manualPasteFn ?? manualPaste;

  // 1. 手动通道：manualText 有值 → 直达解析，不查缓存、不访问 B 站
  if (req.manualText !== undefined && req.manualText !== '') {
    let result: FetchResult;
    try {
      result = paste(req.manualText);
    } catch (err) {
      return { cues: [], status: 'no_subtitle', error: `manual paste failed: ${errText(err)}` };
    }
    if (result.cues.length === 0) {
      return { cues: [], status: 'no_subtitle', error: result.error ?? '无法解析粘贴内容' };
    }
    await saveQuietly(deps, toRecord(req, result));
    return result;
  }

  // 2. 缓存（status='manual_pasted' 的记录照常命中返回）
  if (!req.forceRefresh) {
    const cached = await getCached(deps, req.videoId);
    if (cached !== null && cached.cues.length > 0) {
      return {
        cues: cached.cues,
        status: cached.status,
        source: cached.source ?? undefined,
        lang: cached.lang ?? undefined,
      };
    }
  }

  // 3. B 站一级通道
  let bili: FetchResult;
  try {
    bili = await deps.fetchBili({ bvid: req.bvid, page: req.page });
  } catch (err) {
    return { cues: [], status: 'network', error: `fetchBili failed: ${errText(err)}` };
  }
  if (bili.cues.length === 0) {
    // 4. 失败 / 空 → status 透传，不落缓存（失败的请求缓存会让用户卡死在错误状态）
    return bili;
  }

  const cues = normalizeCues(bili.cues);
  if (cues.length === 0) {
    return {
      cues: [],
      status: 'no_subtitle',
      source: bili.source,
      lang: bili.lang,
      error: 'all cues dropped by normalize',
    };
  }
  const result: FetchResult = { ...bili, cues };
  await saveQuietly(deps, toRecord(req, result));
  return result;
}
