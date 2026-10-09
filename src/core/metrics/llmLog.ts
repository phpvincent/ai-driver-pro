/**
 * LLM 交互日志（验证期报告 → LLM 交互日志子模块的数据层）。
 *
 * 目的：把与大模型交互的**报文**留痕，尤其是错误信息——侧边栏里看不到网络面板时，
 * 这是唯一的诊断入口（401 / 超时 / 输出为空 / Schema 之外的异常都在这里有据可查）。
 *
 * 设计约束：
 * - 纯函数 + 注入式订阅，无 chrome.* 依赖，可单测；
 * - **绝不落 API Key**：请求头不记录，报文中出现的 Key 一律脱敏为 `***`；
 * - 报文按字符上限截断（字幕很长，全量入库会撑爆 IndexedDB）；
 * - 只保留最近 N 条（config DB.logKeep），超限从头部丢弃；
 * - 同时镜像一份到 console（`[vsc][llm]` 前缀），DevTools 里可直接搜。
 */
/** 仅类型引用（避免与 harness/modelClient 形成运行时循环依赖） */
import type { ChatRequest } from '../harness/modelClient';

/** 单条交互日志 */
export interface LlmLogEntry {
  id: string;
  /** ISO 8601 */
  at: string;
  /** 调用方标注：outline / mindmap / qa / persona / frame-plan / other */
  label: string;
  ok: boolean;
  model: string;
  /** 只存主机名，不落完整接口地址（与红线 9 同口径） */
  endpointHost: string;
  durationMs: number;
  /** HTTP 状态码（网络层失败时缺省） */
  status?: number;
  /** 请求报文字符数（截断前） */
  inputChars: number;
  /** 响应正文字符数（截断前；失败时为已读到的响应体长度） */
  outputChars: number;
  inputTokens?: number;
  outputTokens?: number;
  /** 停止原因（OpenAI 兼容）：`length` = 撞到 maxTokens 被截断，`stop` = 正常结束 */
  finishReason?: string;
  /** 本次附带的图像帧数 */
  images?: number;
  /**
   * 每帧的元信息（**不含图像数据**）：时间点与字节数。
   * 用于排查"抽帧太少 / 抽的点不对"这类问题——概念图输出偏薄的第一嫌疑就是帧数。
   */
  frames?: Array<{ tMs: number; bytes: number; caption?: string }>;
  /**
   * 帧缩略图（data URI，最多 THUMB_MAX 张且单张不超过 THUMB_MAX_BYTES）。
   * 体积大，仅在用户显式开启「保存图像缩略图」时才写入。
   */
  thumbnails?: string[];
  /** 截断后的请求报文预览 */
  requestPreview: string;
  /** 截断后的响应报文预览（失败时为响应体摘要） */
  responsePreview: string;
  /** 失败原因（ok=false 时必有） */
  error?: string;
}

/** 请求报文预览上限（字幕很长，超长部分截断） */
export const REQUEST_PREVIEW_MAX = 1_500;
/** 响应报文预览上限 */
export const RESPONSE_PREVIEW_MAX = 3_000;
/** 内存环形缓冲保留条数（与 config DB.logKeep 同口径） */
export const LLM_LOG_KEEP = 200;
/**
 * 控制台镜像开关。测试环境默认静音（失败路径用例会大量触发，刷屏淹没断言输出），
 * 验证镜像行为的单测显式打开。
 */
let consoleMirrorEnabled = !(
  typeof import.meta !== 'undefined' &&
  (import.meta as { env?: { MODE?: string } }).env?.MODE === 'test'
);
export function setConsoleMirrorEnabled(v: boolean): void {
  consoleMirrorEnabled = v;
}

/** 是否保存帧缩略图（默认开：160px 小图单张几 KB；可在日志工具栏关闭） */
let thumbnailsEnabled = true;
export function setThumbnailsEnabled(v: boolean): void {
  thumbnailsEnabled = v;
}
export function isThumbnailsEnabled(): boolean {
  return thumbnailsEnabled;
}

/** 缩略图最多保存张数（160px 小图单张约 4~8KB，可覆盖全部帧） */
export const THUMB_MAX = 24;
/** 单张缩略图的字节上限（超过则不保存该张） */
export const THUMB_MAX_BYTES = 30_000;

/** 脱敏占位符 */
export const REDACTED = '***';

/**
 * 文本截断：超过 max 保留头部并追加标记（头部含 system/角色等定位信息，比尾部有用）。
 */
export function truncateText(text: string, max: number): string {
  const raw = typeof text === 'string' ? text : '';
  if (max <= 0) return '';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…（已截断，原长 ${raw.length} 字符）`;
}

/**
 * 密钥脱敏：把出现的任何已知密钥整体替换为 `***`。
 * 长度过短（≤4）的值不参与替换，避免误伤正常文本。
 */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = typeof text === 'string' ? text : '';
  for (const secret of secrets) {
    const key = (secret ?? '').trim();
    if (key.length <= 4) continue;
    if (out.includes(key)) out = out.split(key).join(REDACTED);
  }
  return out;
}

/** 只取主机名（非法 URL → '无效地址'）；日志不落完整端点地址 */
export function hostOfUrl(baseUrl: string): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) return '无效地址';
  try {
    return new URL(raw).hostname;
  } catch {
    return '无效地址';
  }
}

/**
 * 请求报文预览：只保留模型参数与消息正文（**不含 Authorization 头**）。
 * 多模态的 image_url 只保留前缀，避免 base64 进日志。
 */
export function buildRequestPreview(req: ChatRequest): string {
  const messages = (req.messages ?? []).map((m) => {
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .map((part) =>
              part.type === 'text'
                ? part.text
                : `[image ${part.image_url.url.slice(0, 24)}…]`,
            )
            .join('\n');
    return `<${m.role}>\n${content}`;
  });
  return JSON.stringify(
    {
      model: req.model,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      responseFormatJson: req.responseFormatJson === true,
      thinking: req.thinking?.type,
      images: req.images?.length ?? 0,
      messages,
    },
    null,
    2,
  );
}

/**
 * 从本次请求的图像生成帧元信息（时间点 + 字节数）。
 * dataBase64 长度 × 3/4 约为字节数；时间点缺失记 -1。
 */
export function describeFrames(
  images: Array<{ dataBase64: string; timeMs?: number; caption?: string }> | undefined,
): Array<{ tMs: number; bytes: number; caption?: string }> {
  if (!Array.isArray(images) || images.length === 0) return [];
  return images.map((img) => ({
    tMs: typeof img.timeMs === 'number' && Number.isFinite(img.timeMs) ? img.timeMs : -1,
    bytes: Math.round(((img.dataBase64 ?? '').length * 3) / 4),
    ...(img.caption ? { caption: truncateText(img.caption, 160) } : {}),
  }));
}

/**
 * 生成缩略图（**与帧一一对位**：第 i 项对应第 i 帧，取不到的位置为空串）。
 * 优先用 content 侧单独生成的 160px 小图 `thumbBase64`（几 KB）；
 * 没有小图时才回退原图，且原图须 ≤ THUMB_MAX_BYTES。
 * 旧实现：只拿原图 + 跳过超限项 → ①896px 原图几乎全被 30KB 门槛挡掉；
 * ②跳过导致下标错位，第 2 张缩略图显示在第 1 帧下面。
 */
export function buildThumbnails(
  images: Array<{ dataBase64: string; thumbBase64?: string }> | undefined,
  enabled: boolean,
): string[] {
  if (!enabled || !Array.isArray(images) || images.length === 0) return [];
  const out = images.slice(0, THUMB_MAX).map((img) => {
    const thumb = img?.thumbBase64 ?? '';
    if (thumb.length > 0 && thumb.length <= THUMB_MAX_BYTES) return `data:image/jpeg;base64,${thumb}`;
    const data = img?.dataBase64 ?? '';
    if (data.length > 0 && data.length <= THUMB_MAX_BYTES) return `data:image/jpeg;base64,${data}`;
    return '';
  });
  return out.some((u) => u.length > 0) ? out : [];
}

// ---------------------------------------------------------------------------
// 环形缓冲 + 订阅（进程内）
// ---------------------------------------------------------------------------

const buffer: LlmLogEntry[] = [];
/** 订阅者收到新写入的条目；清空时收到 null */
const listeners = new Set<(entry: LlmLogEntry | null) => void>();

/** 订阅日志变更（落库 / UI 刷新用）；返回退订函数 */
export function subscribeLlmLog(fn: (entry: LlmLogEntry | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 当前内存日志（新→旧；返回副本） */
export function getLlmLogs(): LlmLogEntry[] {
  return [...buffer].reverse();
}

/** 清空内存日志（不负责清库，清库由调用方走 storage） */
export function clearLlmLogs(): void {
  buffer.length = 0;
  for (const fn of listeners) fn(null);
}

/** 生成日志 id（crypto.randomUUID 不可用时回落时间戳 + 随机串） */
export function newLogId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `llm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 记一条日志：入环形缓冲 → 通知订阅者 → 镜像到 console。
 * 失败条目用 console.error（便于 DevTools 用级别筛选），成功用 console.debug。
 */
export function emitLlmLog(entry: LlmLogEntry): void {
  buffer.push(entry);
  while (buffer.length > LLM_LOG_KEEP) buffer.shift();
  for (const fn of listeners) fn(entry);
  const head = `[vsc][llm] ${entry.label} ${entry.ok ? 'ok' : 'FAIL'} ${entry.model}@${entry.endpointHost} ${entry.durationMs}ms`;
  if (!consoleMirrorEnabled) return;
  if (entry.ok) console.debug(head);
  else console.error(head, entry.error ?? '', entry.responsePreview);
}
