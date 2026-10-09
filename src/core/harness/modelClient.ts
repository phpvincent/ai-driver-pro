/**
 * OpenAI 兼容模型客户端（SPEC-03 3.1，契约见 TECH-DESIGN §7.4）。
 * 只做单次请求与解析：重试 / 熔断 / 超时由调用方（pipeline）负责——
 * 本模块对异常一律 throw，红线 8 约束的是面向用户的结果，内部分层允许抛。
 *
 * baseUrl 为运行时值（来自 ModelConfig），代码中不含任何接口 URL / 密钥字面量。
 */
import {
  REQUEST_PREVIEW_MAX,
  RESPONSE_PREVIEW_MAX,
  buildRequestPreview,
  buildThumbnails,
  describeFrames,
  emitLlmLog,
  isThumbnailsEnabled,
  hostOfUrl,
  newLogId,
  redactSecrets,
  truncateText,
  type LlmLogEntry,
} from '../metrics/llmLog';

/** 附带的图像（关键帧）；dataBase64 不含 data: 前缀，mime 缺省 image/jpeg */
export interface ChatImage {
  dataBase64: string;
  mime?: string;
  /** 该帧对应的时间点（毫秒）；仅用于日志展示，不进请求体 */
  timeMs?: number;
  /**
   * 帧-字幕配对说明（例：`【画面 3/12 · 05:32 · 第 2 章「事件机制」· 章节开头】此刻字幕：…`）。
   * 有值时会作为 text 分片**紧贴在该图前面**发送，模型不必再猜"第几张图对应哪段话"。
   */
  caption?: string;
  /** 160px 缩略图（仅日志展示；不进请求体） */
  thumbBase64?: string;
}

/** OpenAI 兼容多模态 content 分片 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessageContent = string | ChatContentPart[];

export interface ChatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: ChatMessageContent }>;
  /** true 时请求体带 response_format: {type:'json_object'} */
  responseFormatJson?: boolean;
  /**
   * 思考过程控制（OpenAI 兼容扩展，DeepSeek/Qwen 兼容端点均支持）。
   * 结构化任务（大纲/概念图/问答 JSON）建议 disabled：推理模型的思考会
   * 消耗输出 token 预算，极端时把 max_tokens 吃光导致正文为空。
   */
  thinking?: { type: 'enabled' | 'disabled' };
  /**
   * 随本次请求附带的图像（教学画面关键帧）。非空时 user 消息的 content 变为
   * OpenAI 兼容的多模态数组（text + image_url data URI）。
   *
   * 注意：需模型本身支持图像输入（如 deepseek-chat 不支持视觉，需在设置中换成
   * 多模态模型）；不支持视觉的模型收到数组 content 会报错，由调用方/设置页提示用户。
   */
  images?: ChatImage[];
  /**
   * 调用方标注（进 LLM 交互日志）：outline / mindmap / qa / persona / frame-plan。
   * 仅用于日志归类，不参与请求体。
   */
  label?: string;
}

export interface ChatResponse {
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** 停止原因：`length` = 撞到 maxTokens 被截断；`stop` = 正常结束 */
  finishReason?: string;
}

/** 可注入的 fetch（单测 / 调用方定制），默认全局 fetch */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** 错误摘要最大长度：防超长 body 污染 trace 与 UI */
const ERROR_SUMMARY_MAX_CHARS = 200;

/**
 * 认证类错误的诊断提示：401/403 绝大多数是「Key 与端点不匹配」或「Key 复制带了空白」，
 * 直接告诉用户排查方向，避免只看到一个状态码。
 */
function authHint(status: number): string {
  if (status === 401 || status === 403) {
    return ' — 请检查：①API Key 是否完整且未带空格；②Key 所属平台是否与接口地址匹配（如百炼官方 Key 不能打到 maas 网关，反之亦然）';
  }
  return '';
}

function summarize(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > ERROR_SUMMARY_MAX_CHARS
    ? `${compact.slice(0, ERROR_SUMMARY_MAX_CHARS)}…`
    : compact;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function toTokens(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 构造 user 消息的 content：无图时保持纯字符串（旧行为完全一致）；
 * 有图时返回 [text, ...image_url] 数组（OpenAI 兼容多模态格式）。
 * 纯函数，供单测直接断言。
 */
export function buildUserContent(userPrompt: string, images?: ChatImage[]): ChatMessageContent {
  if (!images || images.length === 0) return userPrompt;
  const parts: ChatContentPart[] = [{ type: 'text', text: userPrompt }];
  for (const image of images) {
    // 交错排布：说明 → 图。视觉模型对"紧邻的文字"关联最强，远胜于在开头列一串时间点
    if (image.caption) parts.push({ type: 'text', text: image.caption });
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mime ?? 'image/jpeg'};base64,${image.dataBase64}` },
    });
  }
  return parts;
}

/** 把 images 合并进 user 消息（仅当 images 非空，保持无图路径零改动） */
function applyImages(
  messages: ChatRequest['messages'],
  images?: ChatImage[],
): ChatRequest['messages'] {
  if (!images || images.length === 0) return messages;
  return messages.map((m) =>
    m.role === 'user' && typeof m.content === 'string'
      ? { role: m.role, content: buildUserContent(m.content, images) }
      : m,
  );
}

/**
 * 单次 chat completion 调用。非 2xx / 响应非 JSON / 结构缺 choices 时 throw。
 * usage 缺失时 tokens 记 0，不视为错误（部分网关不回 usage）。
 *
 * 每次调用（成功或失败）都会写一条 LLM 交互日志（见 core/metrics/llmLog），
 * 供验证期报告的「LLM 交互日志」子模块展示——失败报文是线上排查的主要依据。
 * 日志不含 Authorization 头，且对报文中出现的 API Key 做脱敏。
 */
export async function chatCompletion(req: ChatRequest, fetchFn: FetchLike = fetch): Promise<ChatResponse> {
  const url = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const startedAt = Date.now();
  const requestPreview = redactSecrets(
    truncateText(buildRequestPreview(req), REQUEST_PREVIEW_MAX),
    [req.apiKey],
  );
  /** 已读到的响应体（失败时用于日志摘要） */
  let rawResponse = '';
  /** 脱敏：任何进入日志 / 异常文案的文本都要过一遍（上游错误可能回显 Key） */
  const safe = (text: string): string => redactSecrets(text, [req.apiKey]);
  /** 记一条日志：公共字段 + 本次结果 */
  const log = (patch: Omit<Partial<LlmLogEntry>, 'id' | 'at' | 'label' | 'model' | 'endpointHost'>): void => {
    emitLlmLog({
      id: newLogId(),
      at: new Date().toISOString(),
      label: req.label ?? 'other',
      model: req.model,
      endpointHost: hostOfUrl(req.baseUrl),
      images: req.images?.length ?? 0,
      frames: describeFrames(req.images),
      thumbnails: buildThumbnails(req.images, isThumbnailsEnabled()),
      requestPreview,
      responsePreview: '',
      inputChars: requestPreview.length,
      outputChars: rawResponse.length,
      durationMs: Date.now() - startedAt,
      ...patch,
      ok: patch.ok === true,
    });
  };

  const body: Record<string, unknown> = {
    model: req.model,
    messages: applyImages(req.messages, req.images),
    temperature: req.temperature,
    max_tokens: req.maxTokens,
  };
  if (req.responseFormatJson) {
    body.response_format = { type: 'json_object' };
  }
  if (req.thinking) {
    body.thinking = req.thinking;
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // 网络层失败（请求根本没到达服务器）：与 HTTP 4xx/5xx 是完全不同的问题域
    const reason = err instanceof Error ? err.message : String(err);
    const message = `模型网络请求失败（未收到服务器响应）：${reason} — 请检查网络/代理是否拦截了该接口域名，以及 baseUrl 是否拼写正确`;
    log({ ok: false, error: safe(message) });
    throw new Error(message);
  }

  const text = await res.text();
  rawResponse = text;

  if (!res.ok) {
    const message = `model http ${res.status}: ${summarize(text)}${authHint(res.status)}`;
    log({
      ok: false,
      status: res.status,
      error: safe(message),
      responsePreview: redactSecrets(truncateText(text, RESPONSE_PREVIEW_MAX), [req.apiKey]),
    });
    throw new Error(safe(message));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const message = `model response is not json: ${summarize(text)}`;
    log({
      ok: false,
      status: res.status,
      error: message,
      responsePreview: redactSecrets(truncateText(text, RESPONSE_PREVIEW_MAX), [req.apiKey]),
    });
    throw new Error(safe(message));
  }

  const root = asRecord(parsed);
  const choices = root?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    const message = 'model response missing choices';
    log({
      ok: false,
      status: res.status,
      error: message,
      responsePreview: redactSecrets(truncateText(text, RESPONSE_PREVIEW_MAX), [req.apiKey]),
    });
    throw new Error(safe(message));
  }
  const message = asRecord(asRecord(choices[0])?.message);
  const content = message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : '';
    const burned = reasoning.length > 0;
    const errText = burned
      ? '模型正文为空：思考过程耗尽了输出 token（可在设置中勾选「禁用思考过程」或调大 maxTokens）'
      : 'model response missing choices[0].message.content';
    log({
      ok: false,
      status: res.status,
      error: safe(errText),
      responsePreview: redactSecrets(truncateText(text, RESPONSE_PREVIEW_MAX), [req.apiKey]),
    });
    throw new Error(safe(errText));
  }

  const usage = asRecord(root?.usage);
  // 两种命名都收（冒烟 10-09）：OpenAI 系 prompt_tokens/completion_tokens；
  // DashScope 原生系 input_tokens/output_tokens（maas 网关用它，此前 token 全记 0）
  const inputTokens = toTokens(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = toTokens(usage?.completion_tokens ?? usage?.output_tokens);
  const finishReason =
    typeof (asRecord(choices[0])?.finish_reason) === 'string'
      ? String(asRecord(choices[0])?.finish_reason)
      : undefined;
  log({
    ok: true,
    status: res.status,
    outputChars: content.length,
    inputTokens,
    outputTokens,
    finishReason,
    responsePreview: redactSecrets(truncateText(content, RESPONSE_PREVIEW_MAX), [req.apiKey]),
  });
  return {
    content,
    inputTokens,
    outputTokens,
    finishReason,
  };
}
