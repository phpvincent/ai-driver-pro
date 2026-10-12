/**
 * 问答 Tab（SPEC-05）：对话流 + 打字机渲染 + 常驻区间选择器 + 划词术语入口。
 *
 * props 驱动（App 接线）：模型调用经 explain 注入（loader 组装 compiler + pipeline +
 * qaHistory，父 agent 负责），本文件不 import providers / db / chrome.*。
 * props 全部可选：兼容 App.tsx 当前 <ChatTab /> 占位渲染，接线时传齐。
 * AI 回答采用"响应到达即开始打字机渲染"（~15ms/字，A5 口径：真实流式与 Zod
 * 校验冲突，列 v0.1.x）。explain 失败 throw 时以错误气泡呈现，不崩面板（红线 8）。
 *
 * 三项增强（问答 Tab 迭代）：
 * - 切换 Tab / 换视频后从 qaHistory 恢复（loadHistory 注入，未注入则保持内存行为）；
 * - 回答下方来源区三块：命中课程区间 / 个人知识库 / 公开资料（sources 由父 agent 填入）；
 * - 未配置联网检索且术语卡 needsWeb 时，给出兜底搜索链接（URL 取自 config 常量，红线 9）。
 */
import { useEffect, useRef, useState } from 'react';
import { CONTEXT, WEB_SEARCH_FALLBACK_URL } from '../config';
import { findSectionAt, formatMmSs } from '../core/context/compiler';
import type { OutlineQuote } from './explainLoader';
import {
  appendTurn as memAppendTurn,
  compactDialogue,
  DIALOGUE_MAX_TURNS as MEM_MAX_TURNS,
  getDialogue,
  setDialogue as memSetDialogue,
} from './dialogueMemory';
import type { WebSnippet } from '../core/knowledge/webSearch';
import type { SegmentAnswerPayload, TermPayload } from '../core/pipeline/explain';
import { nearestCueStartMs } from '../core/pipeline/snap';
import type { Cue, KnowledgeHit, Persona, QaRecord, Section } from '../types';
import { ModelPicker } from './ModelPicker';
import { GenerationBanner } from './GenerationBanner';
import {
  UPLOAD_ACCEPT,
  attachmentLabel,
  compressImageFile,
  validateUploadFile,
  type UploadedImage,
} from './uploadImage';
import {
  isTextUpload,
  readTextUpload,
  validateTextUpload,
  type TextUpload,
} from './uploadText';
import './chat.css';

/** 划词/提问请求（父 agent 接线 loader 时组装 compiler + pipeline） */
export interface ExplainRequest {
  term?: string;
  question: string;
  /** null = 自由提问（播放位置 ±30s，由 compiler 默认） */
  rangeMs: [number, number] | null;
  positionMs: number;
  /** 学生上传的图片（题目 / 截图）；仅当模型支持多模态时由 ChatTab 附带 */
  uploads?: UploadedImage[];
  /** 学生上传的文本附件（代码 / 笔记等）；纯文本，任何模型可用 */
  textUploads?: TextUpload[];
  /** 大纲要点引用（SPEC-14：OutlineTab「带上下文提问」注入） */
  quote?: OutlineQuote;
  /** 会话摘要（SPEC-14 记忆升级：滑窗挤出的旧轮合并摘要） */
  sessionSummary?: string;
  /** 最近问答（多轮记忆，SPEC-08 8.4b）：q=问题原文，a=回答要点摘要 */
  history?: ReadonlyArray<{ q: string; a: string }>;
}

export interface ExplainResponse {
  term?: TermPayload;
  answer?: SegmentAnswerPayload;
  record: QaRecord;
  /** 知识库命中（供回答下方展示"参考知识库"，未命中为空/缺省） */
  hits?: KnowledgeHit[];
  /** 公开资料检索命中（供回答下方展示"参考公开资料"，未检索为空/缺省） */
  sources?: WebSnippet[];
}

export interface ChatTabProps {
  videoId?: string | null;
  sections?: Section[];
  cues?: Cue[];
  positionMs?: number;
  onRequestSeek?: (ms: number) => void;
  /** 提问自动暂停 */
  onPause?: () => void;
  modelReady?: boolean;
  /** 当前模型是否支持图像输入（决定上传按钮是否可用） */
  visionReady?: boolean;
  onOpenSettings?: () => void;
  /** 注入（父 agent 接线）：loader 函数 */
  explain?: (args: ExplainRequest) => Promise<ExplainResponse>;
  /** 划词入口（SubtitleTab 触发）：收到后自动发起术语解释并 consumed() */
  pendingTerm?: { term: string; consumed: () => void };
  /** 存库入口（父 agent 接线 obsidianLoader）：未注入时按钮隐藏；返回笔记路径文本 */
  onSaveNote?: (args: { kind: 'term' | 'segment'; term?: string; payload: unknown }) => Promise<string>;
  /** 历史恢复入口（父 agent 接线 db.listQaByVideo）：未注入时保持内存行为 */
  loadHistory?: (videoId: string) => Promise<QaRecord[]>;
  /** 动态回答角色（每视频一次判定，父 agent 注入；未注入则不显示角色条） */
  persona?: Persona | null;
  /** 重判角色（父 agent 注入 personaLoader.generatePersona；未注入则按钮隐藏） */
  onRefreshPersona?: (hint?: string) => Promise<void>;
  /** 大纲要点引用（SPEC-14：OutlineTab「带上下文提问」跳转注入；变化即更新） */
  quote?: OutlineQuote | null;
  /** 移除引用（引用条 × 按钮） */
  onClearQuote?: () => void;
}

// ---------------------------------------------------------------------------
// 纯函数（导出供单测）
// ---------------------------------------------------------------------------

/** 回答要点 → 多轮记忆摘要（纯函数，导出供单测）：前 3 条要点、每条截 40 字 */
export function digestSegmentAnswer(answer: { keyPoints?: string[]; answer?: string }): string {
  const points = (answer.keyPoints ?? []).filter((k) => (k ?? '').trim().length > 0).slice(0, 3);
  if (points.length > 0) {
    return points.map((k) => cut(k.trim(), 40)).join('；');
  }
  return cut((answer.answer ?? '').replace(/\s+/g, ' ').trim(), 80);
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export type RangeMode = 'around' | 'chapter' | 'custom';

/**
 * 区间选择器解析：around = 播放位置 ±30s；chapter = positionMs 命中整章；
 * custom = 调用方解析好的区间。查不到章节 / 自定义非法时回落 around。
 */
export function resolveRange(
  mode: RangeMode,
  positionMs: number,
  sections: Section[],
  customRange?: [number, number],
): [number, number] {
  if (mode === 'chapter') {
    const sec = findSectionAt(sections, positionMs);
    if (sec) return [sec.startMs, sec.endMs];
  }
  if (mode === 'custom' && customRange && customRange[0] <= customRange[1]) {
    return customRange;
  }
  const pad = CONTEXT.defaultRangePadMs;
  return [Math.max(0, positionMs - pad), positionMs + pad];
}

/** "mm:ss" → 毫秒；非法返回 null */
export function parseMmSs(text: string): number | null {
  const m = text.trim().match(/^(\d{1,3}):(\d{1,2})$/);
  if (!m) return null;
  const ss = Number(m[2]);
  if (ss > 59) return null;
  return (Number(m[1]) * 60 + ss) * 1000;
}

/** 打字机分片：每片 1-3 字（确定性循环），join 后还原原文 */
export function chunkTypewriter(text: string): string[] {
  const chunks: string[] = [];
  const sizes = [1, 2, 3];
  let i = 0;
  let k = 0;
  while (i < text.length) {
    const n = Math.min(sizes[k % sizes.length], text.length - i);
    chunks.push(text.slice(i, i + n));
    i += n;
    k += 1;
  }
  return chunks;
}

/**
 * referencedTimestamps（秒）吸附到最近 Cue 开始时间（A3：渲染前吸附，越界丢弃）。
 * 越界 = 早于首句前 5s 或晚于末句结束后 5s；吸附结果去重并升序。
 */
export function snapTimestamps(seconds: number[], cues: Cue[]): number[] {
  if (cues.length === 0 || seconds.length === 0) return [];
  const starts = cues.map((c) => c.startMs);
  const first = cues[0].startMs;
  const last = cues[cues.length - 1].endMs;
  const out: number[] = [];
  for (const sec of seconds) {
    const target = sec * 1000;
    if (!Number.isFinite(target) || target < first - 5_000 || target > last + 5_000) continue;
    const nearest = nearestCueStartMs(starts, target);
    if (nearest !== null && !out.includes(nearest)) out.push(nearest);
  }
  return out.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 时间戳内嵌标记（SPEC-15 九轮）：answer 正文中依据句句尾的 [mm:ss] 直接转成
// 可点 chip，与所佐证的句子出现在一起——替代"底部悬空一排时间戳对不上"的旧布局。
// 校验兜底：标记秒数走与 referencedTimestamps 相同的吸附逻辑（越界丢弃、吸附到
// 最近 Cue 起点）；吸不到 cue（越界/无字幕）→ 按普通文本渲染，防编造时间戳可点。
// ---------------------------------------------------------------------------

/** [mm:ss] 标记正则（mm 1~3 位防误配大数字；s 1~2 位） */
const INLINE_TS_RE = /\[(\d{1,3}):([0-5]\d)\]/g;

export interface InlineTsSegment {
  /** 普通文本段；chip 段为空串 */
  text: string;
  /** chip 段的吸附后毫秒（普通文本段为 null） */
  ms: number | null;
  /** chip 段的原始标记文本（吸附失败回退渲染用） */
  raw?: string;
}

/**
 * 把含 [mm:ss] 内嵌标记的正文切分为 文本/chip 交替的段（纯函数，导出供单测）。
 * 吸附失败（越界/无字幕/吸不到 cue）的标记按普通文本处理（不可点，防编造可点时间）。
 */
export function splitInlineTimestamps(text: string, cues: Cue[]): InlineTsSegment[] {
  const out: InlineTsSegment[] = [];
  const starts = cues.map((c) => c.startMs);
  const first = cues[0]?.startMs ?? 0;
  const last = cues[cues.length - 1]?.endMs ?? 0;
  let cursor = 0;
  INLINE_TS_RE.lastIndex = 0;
  for (const match of text.matchAll(INLINE_TS_RE)) {
    const raw = match[0];
    const idx = match.index ?? 0;
    if (idx > cursor) out.push({ text: text.slice(cursor, idx), ms: null });
    const sec = Number(match[1]) * 60 + Number(match[2]);
    const target = sec * 1000;
    const inRange =
      cues.length > 0 && target >= first - 5_000 && target <= last + 5_000;
    const nearest = inRange ? nearestCueStartMs(starts, target) : null;
    if (nearest !== null) out.push({ text: '', ms: nearest });
    else out.push({ text: `${raw} `, ms: null, raw });
    cursor = idx + raw.length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), ms: null });
  return out;
}

/** 正文中是否存在至少一个**有效**（可点）的内嵌时间戳 chip */
export function hasInlineTimestamps(text: string, cues: Cue[]): boolean {
  return splitInlineTimestamps(text, cues).some((s) => s.ms !== null);
}

/** payload 类型守卫（历史记录恢复时 payload 为 unknown，按形状安全收窄） */
function isTermPayload(p: unknown): p is TermPayload {
  if (!p || typeof p !== 'object') return false;
  const raw = p as Record<string, unknown>;
  return typeof raw.term === 'string' && typeof raw.inVideoMeaning === 'string';
}

function isSegmentPayload(p: unknown): p is SegmentAnswerPayload {
  if (!p || typeof p !== 'object') return false;
  const raw = p as Record<string, unknown>;
  return typeof raw.answer === 'string' && Array.isArray(raw.keyPoints);
}

/**
 * qaHistory 记录 → 消息列表（切换 Tab / 换视频后恢复会话）。
 *
 * 每条记录生成「用户提问 + AI 回答」一对；term 类提问显示为「解释「术语」」；
 * payload 形状匹配时回填 term / answer（用于要点、时间戳、相关术语等区块），
 * 不匹配则只渲染正文。恢复的消息不带打字机（typing=false）。
 */
export function recordsToMessages(records: QaRecord[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let id = 0;
  for (const rec of records ?? []) {
    if (!rec) continue;
    const isTerm = rec.interactionType === 'term';
    id += 1;
    out.push({
      id,
      role: 'user',
      text: isTerm ? `解释「${rec.question}」` : rec.question,
    });
    id += 1;
    out.push({
      id,
      role: 'assistant',
      kind: rec.interactionType,
      text: rec.answer ?? '',
      fullText: rec.answer ?? '',
      typing: false,
      term: isTermPayload(rec.payload) ? rec.payload : undefined,
      answer: isSegmentPayload(rec.payload) ? rec.payload : undefined,
      rangeMs: rec.rangeMs ?? null,
    });
  }
  return out;
}

/**
 * 兜底搜索链接：未配置联网检索时用（红线 9：URL 前缀只能来自 src/config 常量）。
 */
export function buildSearchUrl(query: string): string {
  return `${WEB_SEARCH_FALLBACK_URL}${encodeURIComponent(query ?? '')}`;
}

// ---------------------------------------------------------------------------
// 组件内消息模型
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  /** user：原文；assistant：当前已渲染文本（打字机推进） */
  text: string;
  /** assistant 目标全文 */
  fullText?: string;
  /** 打字机分片与游标 */
  chunks?: string[];
  chunkIdx?: number;
  typing?: boolean;
  /** free = 自由提问（历史恢复时来自 QaRecord.interactionType） */
  kind?: 'term' | 'segment' | 'free' | 'error';
  term?: TermPayload;
  answer?: SegmentAnswerPayload;
  /** 本轮命中的知识库笔记（未命中不展示） */
  hits?: KnowledgeHit[];
  /** 公开资料检索结果（父 agent 接线后填入；未检索时为空） */
  sources?: WebSnippet[];
  /** 提问区间（历史恢复时来自 QaRecord.rangeMs） */
  rangeMs?: [number, number] | null;
  /** 用户消息附带的上传图（只存缩略用的 data URI，不进历史库） */
  attachments?: string[];
  /** 思考过程简报（SPEC-15：回答完成后可展开回看；历史恢复无） */
  steps?: string[];
  /** 存库（存入 Obsidian）状态与行内结果（红线 8：失败不打断面板） */
  saving?: boolean;
  savedText?: string;
  saveError?: string;
}

/** 知识库来源行样式（复用面板次级文字色，不新增 CSS 文件） */
const KNOWLEDGE_HINT_STYLE = {
  marginTop: 6,
  color: 'var(--text-secondary, #888)',
  fontSize: 12,
} as const;

/** 来源区容器（三块来源的公共外框，不新增 CSS 文件） */
const SOURCE_BLOCK_STYLE = {
  marginTop: 4,
  paddingTop: 4,
  borderTop: '1px solid var(--border, #eee)',
} as const;

/** 知识库来源文案：取自命中的笔记标题（无标题回落路径）；无命中返回 null（不展示） */
export function formatKnowledgeSources(hits?: KnowledgeHit[]): string | null {
  if (!hits || hits.length === 0) return null;
  const names = hits.map((h) => h.entry.title || h.entry.path).filter((t) => t.length > 0);
  if (names.length === 0) return null;
  return `参考知识库：${names.join('、')}`;
}

/**
 * 公开资料来源文案：取自检索结果标题（无标题回落 url）；无结果返回 null（不展示）。
 * 与知识库、区间命中同属回答下方的"来源区"。
 */
export function formatSources(snippets?: WebSnippet[]): string | null {
  if (!snippets || snippets.length === 0) return null;
  const names = snippets.map((s) => s.title || s.url).filter((t) => t.length > 0);
  if (names.length === 0) return null;
  return `公开资料：${names.join('、')}`;
}

/**
 * 角色条文案（动态回答角色）：`以「{role}」身份回答 · 领域：{…}`；
 * fallback 角色（模型判定失败后的默认角色）额外标注「（默认角色）」。
 * 未注入 / role 为空返回 null（不显示，旧行为兼容）。
 */
export function formatPersonaLine(persona?: Persona | null): string | null {
  const role = persona?.role?.trim();
  if (!role) return null;
  const expertise = (persona?.expertise ?? []).filter((e) => e.trim().length > 0).join('、');
  const line = `以「${role}」身份回答 · 领域：${expertise}`;
  return persona?.fallback ? `${line}（默认角色）` : line;
}

/** 命中课程区间文案（历史恢复消息无 referencedTimestamps 时给出区间；否则省略） */
export function formatRangeSource(
  rangeMs?: [number, number] | null,
  hasTimestamps?: boolean,
): string | null {
  if (hasTimestamps) return null;
  if (!rangeMs || rangeMs.length !== 2) return null;
  return `命中课程区间 ${formatMmSs(rangeMs[0])}-${formatMmSs(rangeMs[1])}`;
}

function formatTermText(term: TermPayload): string {
  return [
    `【视频语境】${term.inVideoMeaning}`,
    `【通用定义】${term.generalDefinition}`,
    `【类比】${term.analogy}`,
  ].join('\n\n');
}


/** 等待提示（SPEC-10 10.6）：已耗时秒数 + 时长预期，缓解"死了吗"焦虑 */
/** 思考过程简报（SPEC-15 二轮）：生成期间的步骤时间线；随秒数推进 */
function QaLoadingHint({ steps }: { steps?: string[] }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const list = steps ?? [];
  return (
    <div className="chat-loading chat-loading-live">
      <span className="chat-loading-dot" aria-hidden="true" />
      <div className="chat-steps">
        {list.map((t, i) => (
          <div key={i} className="chat-step">
            <span className="chat-step-dot" aria-hidden="true" />
            {t}
          </div>
        ))}
        <div className="chat-step-meta">
          已等待 {elapsed} 秒（通常 3~15 秒，可切走稍后回来）
        </div>
      </div>
    </div>
  );
}

export function ChatTab(props: ChatTabProps) {
  const videoId = props.videoId ?? null;
  const sections = props.sections ?? [];
  const cues = props.cues ?? [];
  const positionMs = props.positionMs ?? 0;
  const modelReady = props.modelReady ?? false;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** 多轮记忆（最近 5 轮；术语解释不入记忆，换视频清空） */
  /** 多轮记忆视图镜像（真身在 dialogueMemory 模块级 store——切 Tab 不失忆） */
  const [dialogue, setDialogue] = useState<Array<{ q: string; a: string }>>([]);
  const [input, setInput] = useState('');
  /** 待发送的上传图 */
  const [uploads, setUploads] = useState<UploadedImage[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const visionReady = props.visionReady ?? false;
  const [busy, setBusy] = useState(false);
  const [rangeMode, setRangeMode] = useState<RangeMode>('around');
  const [customStartText, setCustomStartText] = useState('00:00');
  const [customEndText, setCustomEndText] = useState('01:00');
  /** 重判角色进行中（按钮禁用，避免重复触发模型调用） */
  const [refreshingPersona, setRefreshingPersona] = useState(false);
  /** 重判角色的用户补充输入（结合视频内容与用户说明综合判定） */
  const [personaHintOpen, setPersonaHintOpen] = useState(false);
  const [personaHintText, setPersonaHintText] = useState('');
  /** 文本附件（代码 / 笔记；不需要多模态模型） */
  const [textUploads, setTextUploads] = useState<TextUpload[]>([]);
  /** 工具行浮层（SPEC-14 UI 瘦身）：时间窗口 / 角色，互斥展开 */
  const [windowOpen, setWindowOpen] = useState(false);
  const [personaOpen, setPersonaOpen] = useState(false);
  /** 思考过程简报（SPEC-15 二轮）：生成期间的步骤时间线，完成后随回答收起 */
  const [steps, setSteps] = useState<string[]>([]);

  const nextIdRef = useRef(1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** busy 的最新引用（pendingTerm effect 里避免过期闭包） */
  const busyRef = useRef(false);
  busyRef.current = busy;

  const nextId = (): number => {
    nextIdRef.current += 1;
    return nextIdRef.current;
  };

  /** 追加消息；此前若有打字机进行中的消息则瞬间补完 */
  const pushMessage = (m: ChatMessage): void => {
    setMessages((prev) => [
      ...prev.map((x) =>
        x.typing
          ? { ...x, chunkIdx: x.chunks?.length ?? 0, text: x.fullText ?? x.text, typing: false }
          : x,
      ),
      m,
    ]);
  };

  const customRange = (): [number, number] | undefined => {
    const s = parseMmSs(customStartText);
    const e = parseMmSs(customEndText);
    return s !== null && e !== null ? [s, e] : undefined;
  };

  /** 请求用区间：around 传 null（compiler 默认 ±30s），其余显式 */
  const requestRange = (): [number, number] | null =>
    rangeMode === 'around' ? null : resolveRange(rangeMode, positionMs, sections, customRange());

  const ask = async (req: ExplainRequest): Promise<void> => {
    if (!props.explain || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setSteps(['正在读取课程上下文（字幕 / 章节 / 课程背景）']);
    props.onPause?.();
    // 多轮记忆（SPEC-14 store 化）：随请求发送窗口内轮次 + 会话摘要
    const mem = videoId ? getDialogue(videoId) : { summary: '', turns: [] };
    const askReq: ExplainRequest = {
      ...req,
      history: req.term ? [] : mem.turns.slice(-MEM_MAX_TURNS),
      sessionSummary: req.term ? undefined : mem.summary || undefined,
      quote: req.quote ?? (props.quote ?? undefined),
    };
    pushMessage({
      id: nextId(),
      role: 'user',
      text: req.term ? `解释「${req.term}」` : req.question,
      attachments: (req.uploads ?? []).map((u) => `data:${u.mime};base64,${u.dataBase64}`),
    });
    try {
      // 过程简报：真实耗时后逐步推进（explain 内部各阶段我们拿不到回调，
      // 按典型耗时披露节奏——诚实标注为"正在"，不虚构已完成）
      setSteps((prev) => [...prev, '正在检索课内知识与公开资料']);
      const res = await props.explain(askReq);
      setSteps((prev) => [...prev, '正在组织回答']);
      if (res.term) {
        const full = formatTermText(res.term);
        pushMessage({
          id: nextId(),
          role: 'assistant',
          kind: 'term',
          text: '',
          fullText: full,
          chunks: chunkTypewriter(full),
          chunkIdx: 0,
          typing: full.length > 0,
          term: res.term,
          hits: res.hits,
          steps: [...steps],
        });
      } else if (res.answer) {
        const full = res.answer.answer;
        // 问答成功 → 入记忆（store；术语解释不入）。溢出滚动压缩（SPEC-14）
        if (videoId) {
          const turn = { q: req.question, a: digestSegmentAnswer(res.answer!) };
          const { evicted, summary } = memAppendTurn(videoId, turn);
          setDialogue(getDialogue(videoId).turns);
          if (evicted) void compactDialogue(videoId, summary, evicted);
        }
        pushMessage({
          id: nextId(),
          role: 'assistant',
          kind: 'segment',
          text: '',
          fullText: full,
          chunks: chunkTypewriter(full),
          chunkIdx: 0,
          typing: full.length > 0,
          answer: res.answer,
          hits: res.hits,
          steps: [...steps],
        });
      } else {
        const full = res.record?.answer ?? '（空回答）';
        pushMessage({
          id: nextId(),
          role: 'assistant',
          kind: 'segment',
          text: '',
          fullText: full,
          chunks: chunkTypewriter(full),
          chunkIdx: 0,
          typing: full.length > 0,
          hits: res.hits,
          steps: [...steps],
        });
      }
    } catch (err) {
      // 红线 8：失败以错误气泡呈现，不崩面板
      pushMessage({
        id: nextId(),
        role: 'assistant',
        kind: 'error',
        text: `回答失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const askRef = useRef(ask);
  askRef.current = ask;

  /** loadHistory 的最新引用（恢复 effect 只依赖 videoId，避免父级重渲染反复重置） */
  const loadHistoryRef = useRef(props.loadHistory);
  loadHistoryRef.current = props.loadHistory;

  // 历史恢复：videoId 变化时先清空，再按注入的 loadHistory 重建消息列表
  // （未注入 → 保持内存行为，不报错；读取失败同样静默，红线 8）
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    if (!videoId) {
      setDialogue([]);
      return () => {
        cancelled = true;
      };
    }
    // SPEC-14 记忆恢复：模块级 store 优先（切 Tab 回来不失忆）；
    // store 空（面板重载后）则从 qaHistory 重建最近窗口
    const existing = getDialogue(videoId);
    if (existing.turns.length > 0) {
      setDialogue(existing.turns);
    }
    const load = loadHistoryRef.current;
    if (!load) {
      return () => {
        cancelled = true;
      };
    }
    load(videoId)
      .then((records) => {
        if (cancelled) return;
        const restored = recordsToMessages(records ?? []);
        setMessages(restored);
        const maxId = restored.reduce((max, m) => (m.id > max ? m.id : max), 0);
        if (maxId >= nextIdRef.current) nextIdRef.current = maxId + 1;
        // store 为空时从历史重建记忆（问答记录 → 窗口内轮次）
        if (getDialogue(videoId).turns.length === 0 && records && records.length > 0) {
          const turns = (records ?? [])
            .filter((r) => r.interactionType !== 'term')
            .slice(-MEM_MAX_TURNS)
            .map((r) => ({ q: r.question, a: digestSegmentAnswer({ answer: r.answer }) }));
          if (turns.length > 0) {
            memSetDialogue(videoId, turns);
            setDialogue(turns);
          }
        }
      })
      .catch(() => {
        /* 读取失败不打断面板 */
      });
    return () => {
      cancelled = true;
    };
  }, [videoId]);

  /** 按 id 更新单条消息的存库状态 */
  const patchSave = (id: number, patch: Partial<ChatMessage>): void => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  };

  /**
   * 单条 AI 回答存入 Obsidian：术语走 term 卡（带术语名），区间问答走 segment。
   * 重复术语 throw（"已存在相似术语…"）时行内展示，不弹窗不打断。
   */
  const handleSaveNote = (m: ChatMessage): void => {
    const save = props.onSaveNote;
    if (!save || (m.kind !== 'term' && m.kind !== 'segment')) return;
    patchSave(m.id, { saving: true, savedText: undefined, saveError: undefined });
    save({
      kind: m.kind,
      term: m.kind === 'term' ? m.term?.term : undefined,
      payload: m.kind === 'term' ? m.term : m.answer,
    })
      .then((path) => patchSave(m.id, { saving: false, savedText: path ? `已存入：${path}` : '已存入 Obsidian' }))
      .catch((err: unknown) =>
        patchSave(m.id, {
          saving: false,
          saveError: err instanceof Error ? err.message : String(err),
        }),
      );
  };

  // 划词入口：SubtitleTab 触发 pendingTerm → 自动发起术语解释并 consumed()
  useEffect(() => {
    const pt = props.pendingTerm;
    if (pt?.term) {
      void askRef.current({
        term: pt.term,
        question: `解释术语「${pt.term}」`,
        rangeMs: requestRange(),
        positionMs,
      });
      pt.consumed();
    }
  }, [props.pendingTerm]);

  // 打字机：每 30ms 推进 1 片（1-3 字，均值 ~15ms/字）；卸载 / 重渲染时清理定时器
  useEffect(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (!messages.some((m) => m.typing)) return;
    timerRef.current = setInterval(() => {
      setMessages((prev) =>
        prev.map((m) => {
          if (!m.typing) return m;
          const chunks = m.chunks ?? [];
          const nextIdx = Math.min(chunks.length, (m.chunkIdx ?? 0) + 1);
          return {
            ...m,
            chunkIdx: nextIdx,
            text: chunks.slice(0, nextIdx).join(''),
            typing: nextIdx < chunks.length,
          };
        }),
      );
    }, 30);
    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [messages]);

  if (!videoId) {
    return (
      <div className="tab-placeholder">
        <p>打开 B 站视频后即可提问</p>
      </div>
    );
  }

  if (!modelReady) {
    return (
      <div className="tab-placeholder">
        <h3>问答</h3>
        <p>模型未配置，请先在设置页配置模型</p>
        {props.onOpenSettings && (
          <button type="button" className="btn" onClick={props.onOpenSettings}>
            去设置
          </button>
        )}
      </div>
    );
  }

  const displayRange = resolveRange(rangeMode, positionMs, sections, customRange());
  /** 角色条文案（未注入 persona 时为 null，不渲染，旧行为兼容） */
  const personaLine = formatPersonaLine(props.persona);

  /** 时间胶囊文案（SPEC-14）：只显示当前窗口，细节收进浮层 */
  const windowLabel = (): string => {
    if (rangeMode === 'around') return '播放位置±30s';
    if (rangeMode === 'chapter') return '当前整章';
    return `${formatMmSs(displayRange[0])}-${formatMmSs(displayRange[1])}`;
  };

  const handleSend = (): void => {
    const hasUploads = uploads.length > 0 || textUploads.length > 0;
    // 只传附件、不打字也能发：默认问题是"请讲解这道题"
    const q =
      input.trim() ||
      (hasUploads ? (uploads.length > 0 ? '请讲解图片中的这道题' : '请结合参考资料讲解') : '');
    if (!q || busy || !props.explain) return;
    setInput('');
    const sending = visionReady ? uploads : [];
    const sendingText = textUploads;
    setUploads([]);
    setTextUploads([]);
    setUploadError(null);
    void ask({
      question: q,
      rangeMs: requestRange(),
      positionMs,
      uploads: sending,
      textUploads: sendingText,
    });
  };

  /** 添加附件（文件选择 / 粘贴 / 拖拽共用）：图片走多模态管线，文本文件作为参考资料 */
  const addFiles = async (files: File[]): Promise<void> => {
    setUploadError(null);
    const images = files.filter((f) => !isTextUpload(f));
    const texts = files.filter((f) => isTextUpload(f));
    if (images.length > 0 && !visionReady) {
      setUploadError('当前模型不支持图片，请在设置中切换到多模态模型（如 Qwen-VL）');
      if (texts.length === 0) return;
    }
    let count = uploads.length;
    const added: UploadedImage[] = [];
    for (const file of images) {
      if (!visionReady) continue; // 文本继续，图片跳过（上方已提示）
      const err = validateUploadFile(file, count);
      if (err) {
        setUploadError(err);
        continue;
      }
      try {
        added.push(await compressImageFile(file, `up-${Date.now()}-${count}`));
        count += 1;
      } catch {
        setUploadError(`图片读取失败：${file.name}`);
      }
    }
    if (added.length > 0) setUploads((prev) => [...prev, ...added]);
    // 文本附件：任何模型可用
    let textCount = textUploads.length;
    const addedText: TextUpload[] = [];
    for (const file of texts) {
      const err = validateTextUpload(file, textCount);
      if (err) {
        setUploadError(err);
        continue;
      }
      try {
        addedText.push(await readTextUpload(file, `txt-${Date.now()}-${textCount}`));
        textCount += 1;
      } catch {
        setUploadError(`文件读取失败：${file.name}`);
      }
    }
    if (addedText.length > 0) setTextUploads((prev) => [...prev, ...addedText]);
  };

  /** 粘贴截图（Cmd/Ctrl+V）：学生最常见的用法是截图后直接粘贴 */
  const handlePaste = (e: { clipboardData: DataTransfer | null; preventDefault: () => void }): void => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files = items
      .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  // 引用到达（SPEC-14）：时间窗口自动切到引用章节区间（用户仍可手动改）
  useEffect(() => {
    if (!props.quote) return;
    setRangeMode('custom');
    setCustomStartText(formatMmSs(props.quote.rangeMs[0]));
    setCustomEndText(formatMmSs(props.quote.rangeMs[1]));
    setWindowOpen(false);
    setPersonaOpen(false);
  }, [props.quote]);

  /** 重判角色（可带用户补充说明；失败不弹错，角色条保持原状，红线 8） */
  const handleRefreshPersona = (hint?: string): void => {
    const refresh = props.onRefreshPersona;
    if (!refresh || refreshingPersona) return;
    setRefreshingPersona(true);
    setPersonaHintOpen(false);
    void refresh(hint && hint.trim().length > 0 ? hint.trim() : undefined)
      .catch(() => undefined)
      .then(() => setRefreshingPersona(false));
  };

  return (
    <div className="chat-tab">
      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">针对区间提问，或在字幕 Tab 划词解释术语</div>
        )}
        {messages.map((m) => {
          // 来源区三块：命中课程区间 / 个人知识库 / 公开资料（各自有才显示）
          const rangeLine = formatRangeSource(
            m.rangeMs,
            (m.answer?.referencedTimestamps?.length ?? 0) > 0,
          );
          const knowledgeLine = formatKnowledgeSources(m.hits);
          const webLine = formatSources(m.sources);
          return (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.role === 'user' ? (
              <div className="chat-bubble user">
                {m.text}
                {m.attachments && m.attachments.length > 0 && (
                  <div className="chat-attachments">
                    {m.attachments.map((src, i) => (
                      <img key={i} className="chat-attachment" src={src} alt={`上传图片 ${i + 1}`} />
                    ))}
                  </div>
                )}
              </div>
            ) : m.kind === 'error' ? (
              <div className="chat-error">{m.text}</div>
            ) : (
              <div className="chat-bubble ai">
                {m.answer && m.answer.coveredByVideo === false && !m.typing && (
                  <div className="chat-covered-bar">视频中未涉及，以下为公开知识补充</div>
                )}
                <div className="chat-answer-text">
                  {m.typing
                    ? m.text
                    : splitInlineTimestamps(m.text, cues).map((seg, i) =>
                        seg.ms !== null ? (
                          <button
                            key={i}
                            type="button"
                            className="chat-ts chat-ts-inline"
                            onClick={() => props.onRequestSeek?.(seg.ms!)}
                          >
                            [{formatMmSs(seg.ms)}]
                          </button>
                        ) : (
                          <span key={i}>{seg.text}</span>
                        ),
                      )}
                  {m.typing && <span className="chat-caret">▍</span>}
                </div>
                {/* 来源区：仅命中时展示，未命中不打扰 */}
                {!m.typing && (rangeLine || knowledgeLine || webLine) && (
                  <div style={SOURCE_BLOCK_STYLE}>
                    {m.steps && m.steps.length > 0 && !m.typing && (
                      <details className="chat-steps-details">
                        <summary>思考过程</summary>
                        {m.steps.map((t, i) => (
                          <div key={i} className="chat-step">
                            <span className="chat-step-dot done" aria-hidden="true" />
                            {t}
                          </div>
                        ))}
                      </details>
                    )}
                    {m.steps && m.steps.length > 0 && !m.typing && (
                      <details className="chat-steps-details">
                        <summary>思考过程</summary>
                        {m.steps.map((t, i) => (
                          <div key={i} className="chat-step">
                            <span className="chat-step-dot done" aria-hidden="true" />
                            {t}
                          </div>
                        ))}
                      </details>
                    )}
                    {rangeLine && <div style={KNOWLEDGE_HINT_STYLE}>{rangeLine}</div>}
                    {knowledgeLine && <div style={KNOWLEDGE_HINT_STYLE}>{knowledgeLine}</div>}
                    {webLine && <div style={KNOWLEDGE_HINT_STYLE}>{webLine}</div>}
                  </div>
                )}
                {!m.typing && m.answer && (
                  <>
                    {m.answer.keyPoints.length > 0 && (
                      <ul className="chat-keypoints">
                        {m.answer.keyPoints.map((k, i) => (
                          <li key={i}>{k}</li>
                        ))}
                      </ul>
                    )}
                    {/* 底部时间戳块：仅当正文没有有效内嵌 chip 时降级展示
                        （历史消息/旧模型输出无内嵌标记的兼容路径；有内嵌 chip 时
                        referencedTimestamps 与正文标记同源，重复展示反而冗余） */}
                    {!hasInlineTimestamps(m.text, cues) &&
                      snapTimestamps(m.answer.referencedTimestamps, cues).length > 0 && (
                        <div className="chat-timestamps">
                          {snapTimestamps(m.answer.referencedTimestamps, cues).map((ms) => (
                            <button
                              key={ms}
                              type="button"
                              className="chat-ts"
                              onClick={() => props.onRequestSeek?.(ms)}
                            >
                              [{formatMmSs(ms)}]
                            </button>
                          ))}
                        </div>
                      )}
                    {m.answer.followUpQuestions.length > 0 && (
                      <div className="chat-followups">
                        {m.answer.followUpQuestions.map((q, i) => (
                          <button
                            key={i}
                            type="button"
                            className="chat-followup"
                            onClick={() =>
                              void askRef.current({ question: q, rangeMs: requestRange(), positionMs })
                            }
                          >
                            {q}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {!m.typing && m.term && (
                  <div className="chat-term-extra">
                    {m.term.relatedTerms.length > 0 && (
                      <div className="chat-related">
                        {m.term.relatedTerms.map((t) => (
                          <span key={t} className="chat-related-chip">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.term.needsWeb && <span className="chat-needs-web">需要联网核实</span>}
                  </div>
                )}
                {/* 模型自报需联网核实：给人工查证入口（URL 取自 config 常量，红线 9） */}
                {!m.typing && m.term?.needsWeb && (
                  <div style={KNOWLEDGE_HINT_STYLE}>
                    这节课外的内容建议再查证一次：
                    <a href={buildSearchUrl(m.term.term)} target="_blank" rel="noreferrer">
                      {m.term.term}
                    </a>
                  </div>
                )}
                {!m.typing &&
                  props.onSaveNote &&
                  (m.kind === 'term' || m.kind === 'segment') && (
                    <div className="chat-save">
                      <button
                        type="button"
                        className="btn chat-save-btn"
                        disabled={m.saving}
                        onClick={() => handleSaveNote(m)}
                      >
                        {m.saving ? '存入中…' : '存入 Obsidian'}
                      </button>
                      {m.savedText && <span className="chat-save-ok">{m.savedText}</span>}
                      {m.saveError && <span className="chat-save-error">{m.saveError}</span>}
                    </div>
                  )}
              </div>
            )}
          </div>
          );
        })}
        {busy && <QaLoadingHint steps={steps} />}
      </div>

      {/* 输入区（composer 卡片）：附件条 → 输入行 → 工具行（区间 / 角色 / 模型） */}
      <div className="chat-composer">
        {props.quote && (
          <div className="chat-quote-chip" title={`${props.quote.sectionTitle} · ${props.quote.bulletText ?? '整章'}`}>
            <span className="chat-quote-icon">📎</span>
            <span className="chat-quote-text">
              引用 · {props.quote.sectionTitle}
              {props.quote.bulletText ? ` ·「${props.quote.bulletText.slice(0, 24)}${props.quote.bulletText.length > 24 ? '…' : ''}」` : ''}
            </span>
            {props.onClearQuote && (
              <button
                type="button"
                className="chat-upload-remove"
                aria-label="移除引用"
                onClick={props.onClearQuote}
              >
                ×
              </button>
            )}
          </div>
        )}

        {(uploads.length > 0 || textUploads.length > 0 || uploadError) && (
          <div className="chat-upload-strip">
            {uploads.map((u) => (
              <div key={u.id} className="chat-upload-item" title={u.name}>
                <img src={`data:${u.mime};base64,${u.dataBase64}`} alt={u.name} />
                <button
                  type="button"
                  className="chat-upload-remove"
                  aria-label={`移除 ${u.name}`}
                  onClick={() => setUploads((prev) => prev.filter((x) => x.id !== u.id))}
                >
                  ×
                </button>
              </div>
            ))}
            {textUploads.map((t) => (
              <div key={t.id} className="chat-upload-item chat-upload-text" title={t.name}>
                <span className="chat-upload-text-icon">📄</span>
                <span className="chat-upload-text-name">{t.name}</span>
                <button
                  type="button"
                  className="chat-upload-remove"
                  aria-label={`移除 ${t.name}`}
                  onClick={() => setTextUploads((prev) => prev.filter((x) => x.id !== t.id))}
                >
                  ×
                </button>
              </div>
            ))}
            {(uploads.length > 0 || textUploads.length > 0) && (
              <span className="chat-upload-count">
                {attachmentLabel(uploads.length + textUploads.length)}
              </span>
            )}
            {uploadError && <span className="chat-upload-error">{uploadError}</span>}
          </div>
        )}

        <div
          className="chat-input-bar"
          onDragOver={(e) => {
            e.preventDefault();
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer?.files ?? []).filter(
              (f) => f.type.startsWith('image/') || isTextUpload(f),
            );
            if (files.length === 0) return;
            e.preventDefault();
            void addFiles(files);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={`${UPLOAD_ACCEPT},.txt,.md,.markdown,.csv,.log,.json,.js,.ts,.tsx,.jsx,.py,.java,.c,.cpp,.h,.go,.rs,.sql,.sh,.html,.css,.xml,.yml,.yaml`}
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void addFiles(files);
            }}
          />
          <button
            type="button"
            className="btn chat-upload-btn"
            disabled={busy || !props.explain}
            title="上传题目截图（需多模态模型）或代码 / 笔记等文本文件（任何模型可用）；也可直接粘贴 / 拖入"
            onClick={() => {
              fileInputRef.current?.click();
            }}
          >
            附件
          </button>
          <textarea
            className="chat-input"
            rows={2}
            placeholder={visionReady ? '输入问题，可粘贴截图或拖入代码文件…' : '输入问题，可拖入代码 / 笔记文件…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
          />
          <button
            type="button"
            className="btn btn-primary chat-send"
            disabled={busy || (!input.trim() && uploads.length === 0 && textUploads.length === 0) || !props.explain}
            onClick={handleSend}
          >
            发送
          </button>
          {!props.explain && <span className="chat-pending">待接线</span>}
        </div>

        <div className="chat-toolbar">
          {/* 时间窗口胶囊：平时只显示当前窗口，点击浮层重选（SPEC-14 UI 瘦身） */}
          <div className="chat-pill-wrap">
            <button
              type="button"
              className="chat-pill"
              onClick={() => {
                setWindowOpen((v) => !v);
                setPersonaOpen(false);
              }}
              title="点击重选提问的时间窗口"
            >
              ⏱ {windowLabel()}
            </button>
            {windowOpen && (
              <div className="chat-pill-popover">
                <button type="button" className={rangeMode === 'around' ? 'active' : ''} onClick={() => { setRangeMode('around'); setWindowOpen(false); }}>
                  播放位置±30s
                </button>
                <button type="button" className={rangeMode === 'chapter' ? 'active' : ''} onClick={() => { setRangeMode('chapter'); setWindowOpen(false); }}>
                  当前整章
                </button>
                <button type="button" className={rangeMode === 'custom' ? 'active' : ''} onClick={() => setRangeMode('custom')}>
                  自定义区间
                </button>
                {props.quote && (
                  <button
                    type="button"
                    onClick={() => {
                      setRangeMode('custom');
                      setCustomStartText(formatMmSs(props.quote!.rangeMs[0]));
                      setCustomEndText(formatMmSs(props.quote!.rangeMs[1]));
                      setWindowOpen(false);
                    }}
                  >
                    引用章节区间
                  </button>
                )}
                {rangeMode === 'custom' && (
                  <span className="chat-range-custom chat-range-custom-pop">
                    <input
                      className="chat-range-input"
                      value={customStartText}
                      placeholder="mm:ss"
                      onChange={(e) => setCustomStartText(e.target.value)}
                    />
                    <span>–</span>
                    <input
                      className="chat-range-input"
                      value={customEndText}
                      placeholder="mm:ss"
                      onChange={(e) => setCustomEndText(e.target.value)}
                    />
                  </span>
                )}
                <span className="chat-pill-current">当前 {formatMmSs(displayRange[0])}-{formatMmSs(displayRange[1])}</span>
              </div>
            )}
          </div>

          {/* 角色胶囊：点击浮层展开完整角色 + 重判（含补充输入） */}
          {personaLine && (
            <div className="chat-pill-wrap">
              <button
                type="button"
                className="chat-pill"
                onClick={() => {
                  setPersonaOpen((v) => !v);
                  setWindowOpen(false);
                }}
                title={personaLine}
              >
                👤 {props.persona?.role ?? '助教'}
              </button>
              {personaOpen && (
                <div className="chat-pill-popover chat-persona-popover">
                  <span className="chat-persona-line">{personaLine}</span>
                  {props.onRefreshPersona && (
                    <div className="chat-persona-rejudge">
                      <input
                        className="chat-persona-hint-input"
                        value={personaHintText}
                        placeholder="补充期望角色（可留空直接重判）…"
                        onChange={(e) => setPersonaHintText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRefreshPersona(personaHintText);
                        }}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={refreshingPersona}
                        onClick={() => handleRefreshPersona(personaHintText)}
                      >
                        {refreshingPersona ? '重判中…' : '重判角色'}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="chat-toolbar-right">
            <ModelPicker onOpenSettings={props.onOpenSettings} />
          </div>
        </div>

        <GenerationBanner module="qa" />
      </div>
    </div>
  );
}
