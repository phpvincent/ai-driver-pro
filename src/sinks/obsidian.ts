/**
 * Obsidian Local REST API sink（SPEC-06 子任务 6.1，TECH-DESIGN §7.3）。
 *
 * - 写入：`PUT {baseUrl}/vault/{path}`，Bearer 鉴权，Content-Type text/markdown；
 *   路径逐段 encodeURIComponent（'/' 保留为路径分隔符）。
 * - 请求经 `ObsidianFetch` 注入：本模块不引用全局 fetch，单测用假实现覆盖全部错误分支。
 * - 错误分类：连接拒绝 → 引导确认 Obsidian 已启动且开启 HTTP 模式；401 → 引导检查
 *   API Key；其余非 2xx → 带状态码与响应摘要 throw（调用方决定展示，本模块不吞错）。
 *
 * 红线 9：本文件不出现任何端点字面量，baseUrl 一律来自运行时配置（src/config OBSIDIAN）。
 */
import type { ObsidianConfig } from '../types';

export type { ObsidianConfig };

/** 注入式请求实现（签名同 fetch，便于测试与未来加超时） */
export type ObsidianFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** 响应摘要长度上限（错误信息不吞掉整页 HTML） */
const SUMMARY_MAX = 160;

/** 拼 vault 资源 URL：baseUrl 去尾斜杠 + /vault/ + 逐段编码 */
export function obsidianUrl(baseUrl: string, vaultPath: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const segments = vaultPath
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s));
  return segments.length === 0 ? `${base}/vault/` : `${base}/vault/${segments.join('/')}`;
}

/** 请求头：Bearer 鉴权 + markdown 内容类型（apiKey 只进 header，不进任何日志/提示） */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'text/markdown;charset=utf-8',
  };
}

/** 响应体摘要（读取失败时回落空串，避免二次抛错掩盖原始错误） */
async function readSummary(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX)}…` : flat;
  } catch {
    return '';
  }
}

/** 非 2xx 的统一错误文案（按状态码给操作指引） */
function httpError(status: number, summary: string): Error {
  const detail = summary ? `: ${summary}` : '';
  if (status === 401 || status === 403) {
    return new Error(`Obsidian HTTP ${status}${detail}（鉴权失败：请检查 API Key 是否正确）`);
  }
  if (status === 404) {
    return new Error(`Obsidian HTTP ${status}${detail}（路径不可写：请检查笔记根目录是否存在）`);
  }
  if (status >= 500) {
    return new Error(`Obsidian HTTP ${status}${detail}（服务端错误：请确认 Obsidian 与 Local REST API 插件正常）`);
  }
  return new Error(`Obsidian HTTP ${status}${detail}`);
}

/** 网络层失败（Obsidian 未启动 / 未开启 HTTP 模式 / 证书失败） */
function networkError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  return new Error(`无法连接 Obsidian${raw ? `：${raw}` : ''}（请确认 Obsidian 已启动，且 Local REST API 插件已开启 HTTP 模式）`);
}

/**
 * 写入（或覆盖）一篇笔记。非 2xx 与网络失败均 throw，调用方负责展示。
 */
export async function putNote(
  cfg: ObsidianConfig,
  fetchFn: ObsidianFetch,
  vaultPath: string,
  markdown: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(obsidianUrl(cfg.baseUrl, vaultPath), {
      method: 'PUT',
      headers: authHeaders(cfg.apiKey),
      body: markdown,
    });
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok) throw httpError(res.status, await readSummary(res));
}

/**
 * 读取一篇笔记正文（索引文件 `_meta/index.json` 也走这里）。
 * 404 与其余非 2xx 均 throw（调用方 readIndex 自行决定降级为空索引）。
 */
export async function getNote(
  cfg: ObsidianConfig,
  fetchFn: ObsidianFetch,
  vaultPath: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(obsidianUrl(cfg.baseUrl, vaultPath), {
      method: 'GET',
      headers: { ...authHeaders(cfg.apiKey), Accept: '*/*' },
    });
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok) throw httpError(res.status, await readSummary(res));
  return await res.text();
}

/**
 * 连通性自检：列根目录。成功返回根目录条目数（供设置页"连接成功（根目录 N 项）"）；
 * 失败 throw（文案区分未启动 / Key 错误 / 其他）。
 */
export async function testConnection(
  cfg: ObsidianConfig,
  fetchFn: ObsidianFetch,
): Promise<{ ok: true; rootEntries: string[] }> {
  let res: Response;
  try {
    res = await fetchFn(obsidianUrl(cfg.baseUrl, ''), {
      method: 'GET',
      headers: { ...authHeaders(cfg.apiKey), Accept: 'application/json' },
    });
  } catch (err) {
    throw networkError(err);
  }
  if (!res.ok) throw httpError(res.status, await readSummary(res));
  const rootEntries = await readRootEntries(res);
  return { ok: true, rootEntries };
}

/** 根目录条目：Local REST API 返回 `{ files: [...] }`；解析失败回落空数组（不影响连通结论） */
async function readRootEntries(res: Response): Promise<string[]> {
  try {
    const data = (await res.json()) as { files?: unknown };
    return Array.isArray(data?.files) ? data.files.filter((f): f is string => typeof f === 'string') : [];
  } catch {
    return [];
  }
}
