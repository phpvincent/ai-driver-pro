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
  onRefreshPersona?: () => Promise<void>;
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

const DIALOGUE_MAX_TURNS = 5;

/** 等待提示（SPEC-10 10.6）：已耗时秒数 + 时长预期，缓解"死了吗"焦虑 */
function QaLoadingHint() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="chat-loading chat-loading-live">
      <span className="chat-loading-dot" aria-hidden="true" />
      助教思考中… 已等待 {elapsed} 秒（通常 3~15 秒，带题目图片可能更久，可切走稍后回来）
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
    props.onPause?.();
    // 多轮记忆：随请求发送当前记忆快照（成功后追加本轮）
    const historySnapshot = req.term ? [] : dialogue.slice(-DIALOGUE_MAX_TURNS);
    const askReq: ExplainRequest = { ...req, history: historySnapshot };
    pushMessage({
      id: nextId(),
      role: 'user',
      text: req.term ? `解释「${req.term}」` : req.question,
      attachments: (req.uploads ?? []).map((u) => `data:${u.mime};base64,${u.dataBase64}`),
    });
    try {
      const res = await props.explain(askReq);
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
        });
      } else if (res.answer) {
        const full = res.answer.answer;
        // 问答成功 → 入记忆（保持最近 N 轮；术语解释不入）
        setDialogue((prev) =>
          [...prev, { q: req.question, a: digestSegmentAnswer(res.answer!) }].slice(-DIALOGUE_MAX_TURNS),
        );
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
    setDialogue([]);
    const load = loadHistoryRef.current;
    if (!videoId || !load) {
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

  const handleSend = (): void => {
    const hasUploads = uploads.length > 0;
    // 只上传图片、不打字也能发：默认问题是"请讲解这道题"
    const q = input.trim() || (hasUploads ? '请讲解图片中的这道题' : '');
    if (!q || busy || !props.explain) return;
    setInput('');
    const sending = visionReady ? uploads : [];
    setUploads([]);
    setUploadError(null);
    void ask({ question: q, rangeMs: requestRange(), positionMs, uploads: sending });
  };

  /** 添加图片（文件选择 / 粘贴 / 拖拽共用）：逐张校验 + 压缩，失败给行内提示 */
  const addFiles = async (files: File[]): Promise<void> => {
    if (!visionReady) {
      setUploadError('当前模型不支持图片，请在设置中切换到多模态模型（如 Qwen-VL）');
      return;
    }
    setUploadError(null);
    let count = uploads.length;
    const added: UploadedImage[] = [];
    for (const file of files) {
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

  /** 重判角色：失败不弹错（角色条保持原状，红线 8） */
  const handleRefreshPersona = (): void => {
    const refresh = props.onRefreshPersona;
    if (!refresh || refreshingPersona) return;
    setRefreshingPersona(true);
    void refresh()
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
                  {m.text}
                  {m.typing && <span className="chat-caret">▍</span>}
                </div>
                {/* 来源区：仅命中时展示，未命中不打扰 */}
                {!m.typing && (rangeLine || knowledgeLine || webLine) && (
                  <div style={SOURCE_BLOCK_STYLE}>
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
                    {snapTimestamps(m.answer.referencedTimestamps, cues).length > 0 && (
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
        {busy && <QaLoadingHint />}
      </div>

      <div className="chat-range-bar">
        <label className="chat-range-option">
          <input
            type="radio"
            name="chat-range-mode"
            checked={rangeMode === 'around'}
            onChange={() => setRangeMode('around')}
          />
          播放位置±30s
        </label>
        <label className="chat-range-option">
          <input
            type="radio"
            name="chat-range-mode"
            checked={rangeMode === 'chapter'}
            onChange={() => setRangeMode('chapter')}
          />
          当前整章
        </label>
        <label className="chat-range-option">
          <input
            type="radio"
            name="chat-range-mode"
            checked={rangeMode === 'custom'}
            onChange={() => setRangeMode('custom')}
          />
          自定义
        </label>
        {rangeMode === 'custom' && (
          <span className="chat-range-custom">
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
        <span className="chat-range-current">
          当前区间 {formatMmSs(displayRange[0])}-{formatMmSs(displayRange[1])}
        </span>
      </div>

      {personaLine && (
        <div
          className="chat-persona-bar"
          style={{ ...KNOWLEDGE_HINT_STYLE, display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span>{personaLine}</span>
          {props.onRefreshPersona && (
            <button
              type="button"
              className="btn chat-persona-refresh"
              disabled={refreshingPersona}
              onClick={handleRefreshPersona}
            >
              {refreshingPersona ? '重判中…' : '重判角色'}
            </button>
          )}
        </div>
      )}

      {/* 模型选择（与设置页模型配置同源；三模块共用一套） */}
      <ModelPicker onOpenSettings={props.onOpenSettings} />
      <GenerationBanner module="qa" />

      {(uploads.length > 0 || uploadError) && (
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
          {uploads.length > 0 && <span className="chat-upload-count">{attachmentLabel(uploads.length)}</span>}
          {uploadError && <span className="chat-upload-error">{uploadError}</span>}
        </div>
      )}

      <div
        className="chat-input-bar"
        onDragOver={(e) => {
          if (visionReady) e.preventDefault();
        }}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
          if (files.length === 0) return;
          e.preventDefault();
          void addFiles(files);
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
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
          title={
            visionReady
              ? '上传题目或截图（也可直接粘贴 / 拖入）'
              : '当前模型不支持图片：请在设置中切换到多模态模型'
          }
          onClick={() => {
            if (!visionReady) {
              setUploadError('当前模型不支持图片，请在设置中切换到多模态模型（如 Qwen-VL）');
              return;
            }
            fileInputRef.current?.click();
          }}
        >
          图片
        </button>
        <textarea
          className="chat-input"
          rows={2}
          placeholder={visionReady ? '输入问题，或粘贴 / 拖入题目截图…' : '输入问题…'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handlePaste}
        />
        <button
          type="button"
          className="btn btn-primary chat-send"
          disabled={busy || (!input.trim() && uploads.length === 0) || !props.explain}
          onClick={handleSend}
        >
          发送
        </button>
        {!props.explain && <span className="chat-pending">待接线</span>}
      </div>
    </div>
  );
}
