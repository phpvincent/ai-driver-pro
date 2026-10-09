/**
 * 术语解释与区间问答 pipeline（SPEC-05，TECH-DESIGN §6.2/§6.3，红线 4）。
 *
 * 单次模型调用（不引入 agent loop）+ Zod Schema 校验：校验失败附错误信息重试 1 次，
 * 仍失败 throw（由问答 Tab 状态机呈现，红线 8，本模块不吞错）。
 * 模型调用经 modelFn 注入（同 OutlineModelFn 模式），无 chrome.* / 网络依赖。
 *
 * coveredByVideo=false 时 answer 由模型按 prompt 约定以"视频中未涉及，以下为
 * 公开知识补充"开头（展示侧由 ChatTab 加前缀条，pipeline 不管展示）。
 */
import { z } from 'zod';
import type { Cue, InteractionType, QaRecord } from '../../types';
import {
  compileContext,
  findSectionAt,
  formatMmSs,
  type CompileInput,
  type CompiledContext,
} from '../context/compiler';

/** TECH-DESIGN §6.2 */
export const TermSchema = z.object({
  term: z.string(),
  inVideoMeaning: z.string(),
  generalDefinition: z.string(),
  analogy: z.string(),
  relatedTerms: z.array(z.string()).max(5),
  /** v0.1 仅作提示，不触发联网 */
  needsWeb: z.boolean(),
});
export type TermPayload = z.infer<typeof TermSchema>;

/** TECH-DESIGN §6.3 */
export const SegmentAnswerSchema = z.object({
  answer: z.string(),
  keyPoints: z.array(z.string()).max(6),
  /** 秒，渲染前吸附到最近 Cue */
  referencedTimestamps: z.array(z.number().int().nonnegative()).max(6),
  followUpQuestions: z.array(z.string()).max(3),
  coveredByVideo: z.boolean(),
  /** 引用的个人知识库笔记（路径或标题；未引用时省略，见 segment-qa.md 0.2.0） */
  knowledgeSources: z.array(z.string()).max(5).optional(),
});
export type SegmentAnswerPayload = z.infer<typeof SegmentAnswerSchema>;

/** 传给模型客户端的图像（教学画面关键帧；caption 不进图像载荷） */
export interface ExplainModelImage {
  dataBase64: string;
  mime?: string;
  /** 该帧对应的时间点（毫秒）；随图像下行，仅用于日志展示 */
  timeMs?: number;
  /** 帧-字幕配对说明（随图交错发送） */
  caption?: string;
  /** 160px 缩略图（仅日志展示） */
  thumbBase64?: string;
}

/** ExplainInput 里的图像：caption 用于提示词说明该帧对应时间点（如"第 12:30 的画面"） */
export interface ExplainImage extends ExplainModelImage {
  caption?: string;
  /** 该帧对应的时间点（毫秒）；用于无 caption 时生成时间点标注 */
  timeMs?: number;
}

/** 注入式模型调用（与 OutlineModelFn 同形；images 为可选增量，旧 stub 不传也能工作） */
export type ExplainModelFn = (req: {
  systemPrompt: string;
  userPrompt: string;
  images?: ExplainModelImage[];
}) => Promise<{ content: string }>;

/** explain pipeline 的上下文输入（question/term 由各入口自行组装） */
export type ExplainInput = Omit<CompileInput, 'question' | 'term'> & {
  /**
   * 教学画面关键帧（视觉问答）。图像是独立模态，不占字幕文本预算（红线 3）；
   * 帧数由 content 侧 maxFrames（默认 6）硬限制，提示词侧只追加一行说明。
   */
  images?: ExplainImage[];
};

// 占位 system prompt：接线层（loader）应注入 src/prompts 单一事实源的真实正文
// （getTermExplainerSystemPrompt / getSegmentQaSystemPrompt，红线 6）。
const DEFAULT_TERM_SYSTEM_PROMPT =
  '你是视频学习副驾的术语解释器。结合视频语境与公开知识解释术语，只输出严格 JSON。';
const DEFAULT_SEGMENT_SYSTEM_PROMPT =
  '你是视频学习副驾的区间问答助手。基于区间字幕证据回答问题，只输出严格 JSON。';

/** 术语解释 prompt 构造（user 复用 compiler 的素材包裹格式，system 由注入源替换） */
export function buildTermPrompts(
  term: string,
  compiled: CompiledContext,
  getSystemPrompt: () => string = () => DEFAULT_TERM_SYSTEM_PROMPT,
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: getSystemPrompt(),
    userPrompt: `${compiled.userPrompt}\n请解释术语「${term}」，区分视频语境含义与通用定义，只输出严格 JSON。`,
  };
}

/** 区间问答 prompt 构造（system 由注入源替换） */
export function buildSegmentPrompts(
  question: string,
  compiled: CompiledContext,
  getSystemPrompt: () => string = () => DEFAULT_SEGMENT_SYSTEM_PROMPT,
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: getSystemPrompt(),
    userPrompt: `${compiled.userPrompt}\n请回答问题：${question}，只输出严格 JSON。`,
  };
}

/** 帧时间点落在哪条字幕上（用于把画面标注吸附到字幕起点） */
function snapToCueStart(ms: number, cues: Cue[]): number {
  for (const cue of cues) {
    if (cue.startMs <= ms && ms < cue.endMs) return cue.startMs;
  }
  return ms;
}

/** 单张图像的标注：caption 优先，其次时间点（可吸附字幕起点），最后按序号 */
function describeImageLabel(image: ExplainImage, index: number, cues?: Cue[]): string {
  const caption = image.caption?.trim();
  if (caption) return caption;
  if (typeof image.timeMs === 'number' && Number.isFinite(image.timeMs)) {
    const at = cues && cues.length > 0 ? snapToCueStart(image.timeMs, cues) : image.timeMs;
    return `第 ${formatMmSs(at)} 的画面`;
  }
  return `第 ${index + 1} 张`;
}

/**
 * 生成"本次附带 N 张教学画面"的一行说明（红线 3：图像是独立模态，不占字幕文本预算，
 * 提示词侧只追加一行）。无图 → ''。
 */
export function describeImages(images?: ExplainImage[] | null, cues?: Cue[]): string {
  if (!images || images.length === 0) return '';
  const labels = images.map((image, i) => describeImageLabel(image, i, cues));
  return `以下附 ${images.length} 张教学画面（按顺序对应时间点：${labels.join('、')}）`;
}

/** userPrompt 追加图像说明行（无图时原样返回，旧行为不变） */
function appendImageNote(userPrompt: string, images?: ExplainImage[] | null, cues?: Cue[]): string {
  const note = describeImages(images, cues);
  return note ? `${userPrompt}\n${note}` : userPrompt;
}

/**
 * system prompt 追加动态角色设定（问答动态角色判定，注入点）。
 * 角色设定拼在既有 system prompt **之后**：只补充"以谁的身份讲"，
 * 不改变、不覆盖任何防编造 / 引用 / coveredByVideo 规则；为空时原样返回（旧行为）。
 */
export function composeSystemPrompt(base: string, personaInstruction?: string): string {
  const instruction = personaInstruction?.trim();
  return instruction ? `${base}\n\n${instruction}` : base;
}

/** JSON.parse + Schema 校验（红线 4）；失败 throw，由重试逻辑捕获 */
function parseJsonWithSchema<T>(content: string, schema: z.ZodType<T>, label: string): T {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`模型输出不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`模型输出未通过 ${label} 校验：${issues}`);
  }
  return parsed.data;
}

export function parseTermPayload(content: string): TermPayload {
  return parseJsonWithSchema(content, TermSchema, 'TermSchema');
}

export function parseSegmentAnswerPayload(content: string): SegmentAnswerPayload {
  return parseJsonWithSchema(content, SegmentAnswerSchema, 'SegmentAnswerSchema');
}

/**
 * 单次调用 + 校验失败附错误重试 1 次（红线 4，同 outline 的重试口径：
 * 仅解析/校验失败重试；modelFn 本身异常直接向上传播）。
 */
async function callModelWithRetry<T>(
  modelFn: ExplainModelFn,
  prompts: { systemPrompt: string; userPrompt: string; images?: ExplainModelImage[] },
  parse: (content: string) => T,
): Promise<T> {
  let lastError = '';
  for (let attempt = 0; attempt <= 1; attempt++) {
    const userPrompt =
      attempt === 0
        ? prompts.userPrompt
        : `${prompts.userPrompt}\n\n[重试] 上一次输出未通过校验：${lastError}\n请重新输出严格符合要求的 JSON，不要包含任何其他文字。`;
    const res = await modelFn({
      systemPrompt: prompts.systemPrompt,
      userPrompt,
      images: prompts.images,
    });
    try {
      return parse(res.content);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`模型输出两次未通过校验：${lastError}`);
}

export interface ExplainTermArgs {
  term: string;
  input: ExplainInput;
  modelFn: ExplainModelFn;
  /** system prompt 单一事实源注入（缺省为占位，接线层传 prompts/index getter） */
  getSystemPrompt?: () => string;
  /** 动态角色设定（追加在 system prompt 之后；不传则行为不变） */
  personaInstruction?: string;
  rangePadMs?: number;
  maxChars?: number;
}

/** 术语解释：编译上下文 → 构造 prompt → 单次调用 + Schema 校验（含 1 次重试） */
export async function explainTerm(args: ExplainTermArgs): Promise<TermPayload> {
  const compiled = compileContext(
    { ...args.input, question: `解释术语「${args.term}」`, term: args.term },
    { rangePadMs: args.rangePadMs, maxChars: args.maxChars },
  );
  const base = buildTermPrompts(args.term, compiled, args.getSystemPrompt);
  const prompts = {
    ...base,
    systemPrompt: composeSystemPrompt(base.systemPrompt, args.personaInstruction),
    userPrompt: appendImageNote(base.userPrompt, args.input.images, args.input.cues),
    images: args.input.images,
  };
  return callModelWithRetry(args.modelFn, prompts, parseTermPayload);
}

export interface AnswerSegmentArgs {
  question: string;
  input: ExplainInput;
  modelFn: ExplainModelFn;
  /** system prompt 单一事实源注入（缺省为占位，接线层传 prompts/index getter） */
  getSystemPrompt?: () => string;
  /** 动态角色设定（追加在 system prompt 之后；不传则行为不变） */
  personaInstruction?: string;
  rangePadMs?: number;
  maxChars?: number;
}

/** 区间问答：编译上下文 → 构造 prompt → 单次调用 + Schema 校验（含 1 次重试） */
export async function answerSegment(args: AnswerSegmentArgs): Promise<SegmentAnswerPayload> {
  const compiled = compileContext(
    { ...args.input, question: args.question },
    { rangePadMs: args.rangePadMs, maxChars: args.maxChars },
  );
  const base = buildSegmentPrompts(args.question, compiled, args.getSystemPrompt);
  const prompts = {
    ...base,
    systemPrompt: composeSystemPrompt(base.systemPrompt, args.personaInstruction),
    userPrompt: appendImageNote(base.userPrompt, args.input.images, args.input.cues),
    images: args.input.images,
  };
  return callModelWithRetry(args.modelFn, prompts, parseSegmentAnswerPayload);
}

/**
 * QaRecord 聚合（TECH-DESIGN §4.4）：sectionId 由 positionMs 命中章节得出，
 * createdAt / id 由本层盖章（时钟与 id 生成均可注入，供确定性单测）。
 */
export function buildQaRecord(args: {
  videoId: string;
  interactionType: InteractionType;
  input: ExplainInput;
  question: string;
  /** 渲染后的回答正文 */
  answer: string;
  /** 结构化输出（TermSchema / SegmentAnswerSchema 校验结果） */
  payload: unknown;
  now?: () => number;
  genId?: () => string;
}): QaRecord {
  const section = findSectionAt(args.input.sections, args.input.positionMs);
  const now = args.now ?? Date.now;
  const genId =
    args.genId ??
    (() =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `qa_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  return {
    id: genId(),
    videoId: args.videoId,
    interactionType: args.interactionType,
    sectionId: section?.id ?? null,
    timestampMs: args.input.positionMs,
    rangeMs: args.input.rangeMs,
    question: args.question,
    answer: args.answer,
    payload: args.payload,
    createdAt: new Date(now()).toISOString(),
  };
}
