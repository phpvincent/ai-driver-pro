/**
 * 大纲 Tab（SPEC-03 子任务 3.4 + 3c 范围变更）：
 * 挂载自动加载缓存（Tab 切回秒显）/ 全局生成与重新生成 / 章节列表
 * （mm:ss-mm:ss 范围 + 可点跳播的要点时间戳 + 分数徽标）/ 单章内联反馈重生成 /
 * 播放跟随高亮滚动 / 模型未配置跳设置 / 失败重试。
 * 数据经 props 注入（loadOutlineCached / generateOutline / regenerateOne），
 * 组装见 outlineLoader（subtitleLoader 模式）。
 *
 * 红线 2 消费侧：跳播只用吸附后的 section.startMs 与 bullet.startMs。
 * TODO(进度)：runOutline 无块级进度钩子，loading 态暂无块级进度与流式渲染
 * （generateOutline 已透传 onProgress，接 UI 渲染需 pipeline 确认快照结构）。
 */
import { useEffect, useRef, useState } from 'react';
import type { OutlineResult } from '../core/pipeline/outline';
import { rescoreOutline } from '../core/pipeline/outline';
import type { Density, NoteAnchor, Section, VideoMeta } from '../types';
import { formatTimestamp } from './SubtitleTab';
import { getInflightOutline } from './outlineLoader';
import { ModelPicker } from './ModelPicker';
import { GenerationBanner } from './GenerationBanner';
import { bulletIdOf } from '../core/notes/reanchor';
import { parseOutlineImport, type VscOutlineFile } from '../core/exchange/vscOutline';
import { useNotes } from './notes/notesLoader';
import {
  buildLocalBackup,
  exportOutlineFile,
  mapImportedNotes,
  saveImportedNotes,
  saveImportedOutline,
  type NotesState,
} from './notes/notesLoader';
import { NoteModal, SectionNotes, UnanchoredNotes, type NoteEditorRequest } from './notes/NotesUi';
import { downloadTextFile, readTextFileViaInput } from '../platform/files';

export interface OutlineTabProps {
  videoId: string | null;
  /** 来自 App 现有 videoInfo（与 SubtitleTab 同风格） */
  meta: VideoMeta | null;
  positionMs: number;
  /** App 传：发 MSG.SEEK */
  onRequestSeek: (targetMs: number) => void;
  /** 只读缓存（挂载自动加载；未命中 throw 'NO_CACHE' → 回到生成按钮态） */
  loadOutlineCached: (videoId: string) => Promise<OutlineResult>;
  /** 全量生成（forceRefresh；生成 / 全局"重新生成"按钮） */
  generateOutline: (videoId: string, opts?: { onProgress?: () => void }) => Promise<OutlineResult>;
  /** 单章重生成（SPEC-03 3c） */
  regenerateOne: (videoId: string, section: Section, feedback?: string) => Promise<OutlineResult>;
  /** 大纲章节变化时通知 App（导图/问答消费；可选） */
  onSectionsChanged?: (sections: Section[]) => void;
  /** App 传：settings 已配置 apiKey */
  modelReady: boolean;
  /** 跳设置页（modelReady=false 时显示入口按钮） */
  onOpenSettings?: () => void;
  /** 存库入口（父 agent 接线 obsidianLoader.saveVideoNoteToObsidian）：未注入时按钮隐藏 */
  onSaveVideoNote?: () => Promise<string>;
}

type Phase = 'idle' | 'loading' | 'ready' | 'degraded' | 'empty';

/** 各状态主文案（ready 无文案，正文即章节列表） */
export const OUTLINE_PHASE_TEXT: Record<Phase, string> = {
  idle: '基于字幕生成章节大纲，点击开始',
  loading: '大纲生成中…',
  ready: '',
  degraded: '大纲生成失败，请重试',
  empty: '暂无可展示内容：请先到字幕 Tab 确认已加载字幕，再回到本页生成大纲',
};

/** 模型未配置提示文案（SPEC-10 10.1 冷启动：给步骤而不是一句话） */
export const OUTLINE_MODEL_NOT_READY_TEXT =
  '还没配置模型（只需一次）：① 到 DeepSeek 或阿里云百炼注册充值并创建 API Key；' +
  '② 在设置页粘贴 Key 并测试连接。点右上角「？」可看完整使用帮助';

/**
 * 当前章节查找（二分，sections 按 startMs 严格递增）：
 * 命中 startMs<=pos<endMs 的章；间隙取最后 startMs<=pos 的章；
 * pos 早于首章或空数组返回 null。
 */
export function findActiveSection(
  sections: Section[],
  positionMs: number,
): Section | null {
  if (sections.length === 0) return null;
  let lo = 0;
  let hi = sections.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans < 0 ? null : sections[ans];
}

/** density 徽标文案（score 缺失时的回退显示） */
export function densityLabel(density: Density | undefined): string {
  switch (density) {
    case 'high':
      return '高密';
    case 'mid':
      return '中密';
    case 'low':
      return '低密';
    default:
      return '-';
  }
}

/** 章节时间范围展示：`mm:ss - mm:ss`（formatTimestamp 复用，等宽字体） */
export function formatRange(startMs: number, endMs: number): string {
  return `${formatTimestamp(startMs)} - ${formatTimestamp(endMs)}`;
}

/**
 * 徽标文案（SPEC-03 3c）：score 存在 → `{score} 分`；
 * 缺失回退旧 density 文字（兼容无 score 的旧缓存/旧数据）。
 */
export function badgeLabel(section: Section): string {
  return section.score != null ? `${section.score} 分` : densityLabel(section.density);
}

/** 单章重生成内联反馈输入框 placeholder */
export const OUTLINE_REGEN_PLACEHOLDER =
  "可选：想往哪个方向重新生成？如'更聚焦代码演示'";

/** 章节卡片：时间范围 + 分数徽标 + 可点跳播的要点时间戳 + 单章重生成入口 + 笔记（SPEC-09） */
function SectionCard({
  section,
  active,
  onSeek,
  regenerating,
  errorText,
  onSubmitRegen,
  notesState,
  onOpenEditor,
}: {
  section: Section;
  active: boolean;
  onSeek: (targetMs: number) => void;
  /** 本章正在重新生成（按钮禁用 + 骨架闪烁） */
  regenerating: boolean;
  /** 本章重新生成的失败信息（null 表示无） */
  errorText: string | null;
  /** 确认单章重生成（feedback 可空） */
  onSubmitRegen: (section: Section, feedback?: string) => void;
  /** 笔记状态（SPEC-09 9.3） */
  notesState: NotesState;
  /** 打开笔记弹窗（二轮反馈：输入与展示走弹窗） */
  onOpenEditor: (req: NoteEditorRequest) => void;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  /** 最近一次提交的反馈（失败重试时复用） */
  const lastFeedbackRef = useRef<string | undefined>(undefined);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /** 重生成开始：平滑滚动并保持本章为视觉焦点（选中效果切换到该模块） */
  useEffect(() => {
    if (regenerating) {
      cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [regenerating]);

  const submit = (fb: string | undefined) => {
    lastFeedbackRef.current = fb;
    onSubmitRegen(section, fb);
  };

  const sectionNotes = notesState.notesBySection(section.id);

  return (
    <div
      ref={cardRef}
      data-section-id={section.id}
      className={
        'outline-section' +
        (active || regenerating ? ' active' : '') +
        (regenerating ? ' regenerating' : '')
      }
    >
      <div className="outline-section-head" onClick={() => onSeek(section.startMs)}>
        <span className="outline-time">{formatRange(section.startMs, section.endMs)}</span>
        <span className="outline-title">{section.title}</span>
        <span className={`outline-density ${section.density ?? 'none'}`}>
          {badgeLabel(section)}
        </span>
        <button
          type="button"
          className="outline-regen-btn"
          disabled={regenerating}
          title="重新生成本章"
          onClick={(e) => {
            e.stopPropagation();
            setFeedbackOpen((v) => !v);
          }}
        >
          ↻
        </button>
      </div>
      <p className="outline-summary">{section.summary}</p>
      <ul className="outline-bullets">
        {section.bullets.map((bullet, i) => (
          <li key={i} className="outline-bullet">
            {/* 红线 2：跳播用吸附后的 bullet.startMs；approximate 弱化精度提示 */}
            <button
              type="button"
              className={`outline-bullet-time${bullet.approximate ? ' approx' : ''}`}
              title={bullet.approximate ? '时间近似' : '跳转到此处'}
              onClick={(e) => {
                e.stopPropagation();
                onSeek(bullet.startMs);
              }}
            >
              {`[${formatTimestamp(bullet.startMs)}${bullet.approximate ? '~' : ''}]`}
            </button>
            <span className="outline-bullet-text">{bullet.text}</span>
            {/* 要点笔记入口（SPEC-09：锚点粒度 = 某条要点；弹窗输入） */}
            <button
              type="button"
              className="outline-regen-btn"
              title="给这条要点记笔记（弹窗输入）"
              onClick={(e) => {
                e.stopPropagation();
                onOpenEditor({
                  mode: 'create',
                  anchor: {
                    kind: 'bullet',
                    sectionId: section.id,
                    bulletId: bulletIdOf(section.id, i),
                    tMs: bullet.startMs,
                  },
                  contextLabel: `要点 · ${bullet.text}`,
                });
              }}
            >
              记
            </button>
          </li>
        ))}
      </ul>
      {section.terms.length > 0 && (
        <div className="outline-terms">{section.terms.join(' · ')}</div>
      )}
      {/* 章节笔记区块（整章锚点 + 已归位到本章的 bullet/time 笔记） */}
      <SectionNotes
        section={section}
        notes={sectionNotes}
        pendingIds={notesState.pendingIds}
        state={notesState}
        onSeek={onSeek}
        onOpenEditor={onOpenEditor}
      />
      {/* 反馈表单常驻渲染，grid 0fr/1fr 过渡实现丝滑展开收起（避免条件渲染的硬切） */}
      <div className={'outline-regen-collapse' + (feedbackOpen && !regenerating ? ' open' : '')}>
        <div className="outline-regen-form">
          <textarea
            className="outline-regen-input"
            rows={2}
            value={feedback}
            placeholder={OUTLINE_REGEN_PLACEHOLDER}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <button
            type="button"
            className="btn"
            onClick={() => submit(feedback.trim() || undefined)}
          >
            重新生成本章
          </button>
        </div>
      </div>
      {/* 重生成提示同样走 collapse 过渡 */}
      <div className={'outline-regen-collapse' + (regenerating ? ' open' : '')}>
        <div className="outline-regen-loading">本章重新生成中…</div>
      </div>
      {errorText && !regenerating && (
        <div className="outline-regen-error">
          <span className="outline-regen-error-text">{errorText}</span>
          <button
            type="button"
            className="btn"
            onClick={() => submit(lastFeedbackRef.current)}
          >
            重试
          </button>
        </div>
      )}
    </div>
  );
}

/** ready 态主体：章节列表 + 跟随高亮滚动 + 单章重生成状态分发 */
export function OutlineSectionList({
  sections,
  activeId,
  onSeek,
  regeneratingId,
  regenError,
  onSubmitRegen,
  notesState,
  onOpenEditor,
}: {
  sections: Section[];
  /** 当前高亮章节 id；null 表示无 */
  activeId: string | null;
  onSeek: (targetMs: number) => void;
  /** 正在单独重生成的章节 id；null 表示无 */
  regeneratingId: string | null;
  /** 单章重生成失败信息；null 表示无 */
  regenError: { sectionId: string; text: string } | null;
  /** 单章重生成确认（SectionCard 内联表单触发） */
  onSubmitRegen: (section: Section, feedback?: string) => void;
  /** 笔记状态（SPEC-09 9.3；不传时隐藏笔记 UI——单测向后兼容） */
  notesState?: NotesState;
  /** 打开笔记弹窗（二轮反馈） */
  onOpenEditor?: (req: NoteEditorRequest) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 上一次滚动到的目标，防止每次 positionMs 更新都触发滚动抖动 */
  const lastScrolledRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeId || lastScrolledRef.current === activeId) return;
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-section-id="${activeId}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      lastScrolledRef.current = activeId;
    }
  }, [activeId]);

  return (
    <div className="outline-list-wrap" ref={wrapRef}>
      <div className="outline-list">
        {sections.map((section) => (
          <SectionCard
            key={section.id}
            section={section}
            active={section.id === activeId}
            onSeek={onSeek}
            regenerating={section.id === regeneratingId}
            errorText={regenError?.sectionId === section.id ? regenError.text : null}
            onSubmitRegen={onSubmitRegen}
            notesState={
              notesState ?? {
                notes: [],
                notesBySection: () => [],
                unanchored: [],
                pendingIds: null,
                busyId: null,
                reload: async () => {},
                addNote: async () => {},
                updateBody: async () => {},
                remove: async () => {},
                reply: async () => {},
                askAssistant: async () => {},
                reanchor: async () => {},
              }
            }
            onOpenEditor={
              onOpenEditor ??
              (() => {
                /* 未注入弹窗回调（单测）时空操作 */
              })
            }
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 结果阶段判定（导出供测试）：
 * - 有分块失败 → degraded（真实原因是模型输出未通过校验，不是缺少字幕）
 * - 有章节 → ready；无章节且无失败 → empty（需先加载字幕再生成）
 */
/**
 * 失败原因可读化（导出供测试）：degraded 态不能只说"请重试"——
 * 要告诉用户是哪一步失败（模型输出未过校验 / 预算熔断 / 无章节），以及能做什么。
 */
export function describeOutlineFailure(r: OutlineResult): string {
  const total = r.chunkState?.length ?? 0;
  const failed = r.failedChunks ?? 0;
  const firstError = (r.chunkState ?? []).find((c) => c.error)?.error;
  if (total > 0 && failed > 0) {
    const hint = r.budgetHit ? '；本次触发了 token 预算熔断' : '';
    const detail = firstError ? `（首个错误：${firstError.slice(0, 80)}）` : '';
    return (
      `大纲生成失败：${failed}/${total} 个分块的模型输出未通过格式校验${hint}${detail}。` +
      '可尝试：更换更稳定的模型、关闭"结合画面（抽帧）"后重试，或在设置中调高 maxTokens。'
    );
  }
  if (total > 0) {
    return '大纲生成失败：模型未返回可解析的章节；可尝试更换模型或关闭抽帧后重试。';
  }
  return OUTLINE_FAILURE_NO_DETAIL;
}

/**
 * 兜底文案：任何失败都必须给出可读原因——
 * 错误对象没带 message 时（接口异常/超时/反序列化失败常见），明确告诉用户去哪里看详情。
 */
export const OUTLINE_FAILURE_NO_DETAIL =
  '大纲生成失败（未提供错误详情）：请打开 DevTools 控制台查看以 [vsc] 开头的日志。' +
  '常见原因：模型输出不符合格式、接口鉴权失败、网络/代理拦截，或生成超时（120 秒）。';

export function pickPhase(r: OutlineResult): Phase {
  if (r.sections.length > 0) return 'ready';
  if (r.failedChunks > 0 || (r.chunkState?.length ?? 0) > 0) return 'degraded';
  return 'empty';
}

/** 带超时的 Promise 包装：避免 DB 卡住或请求悬挂导致"一直生成中" */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function OutlineTab(props: OutlineTabProps) {
  const {
    videoId,
    meta,
    positionMs,
    onRequestSeek,
    loadOutlineCached,
    generateOutline,
    regenerateOne,
  onSectionsChanged,
    modelReady,
    onOpenSettings,
  } = props;
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<OutlineResult | null>(null);
  const sections = result?.sections ?? [];
  /** 笔记状态（SPEC-09 9.3）：videoId 变化自动重载 */
  const notesState = useNotes(videoId, sections);

  /** 大纲结果变化 → 通知 App（导图与问答 Tab 消费 sections） */
  useEffect(() => {
    if (result?.sections) onSectionsChanged?.(result.sections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  /** loadOutline 抛错摘要（degraded 兜底文案之外的具体原因） */
  const [errorText, setErrorText] = useState('');
  /** 单章重生成：进行中的章节 id / 失败信息 */
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<{ sectionId: string; text: string } | null>(null);
  /** 存库（存入 Obsidian）：进行中标记与行内结果文本（红线 8：失败不崩面板） */
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** 导入/导出（SPEC-09 9.6）：进行中 / 结果文案 / 待冲突三选一的导入文件 */
  const [exchanging, setExchanging] = useState(false);
  const [pendingImport, setPendingImport] = useState<VscOutlineFile | null>(null);
  /** 笔记弹窗（SPEC-09 9.3 二轮反馈：输入与展示走居中大弹窗） */
  const [noteModal, setNoteModal] = useState<NoteEditorRequest | null>(null);
  /** 请求序号：videoId 切换 / 重新生成后，旧请求结果作废 */
  const reqIdRef = useRef(0);
  /** 已尝试自动加载的 videoId（同一挂载周期只试一次；手动生成后不被覆盖） */
  const autoTriedRef = useRef<string | null>(null);

  // 最新 ref：父组件每次渲染重建注入函数时不影响已发起的请求
  const loadCachedRef = useRef(loadOutlineCached);
  const generateRef = useRef(generateOutline);
  const regenRef = useRef(regenerateOne);
  loadCachedRef.current = loadOutlineCached;
  generateRef.current = generateOutline;
  regenRef.current = regenerateOne;

  // videoId / modelReady 变化：重置状态；有视频且模型就绪时自动尝试缓存
  // （Tab 切走再回来秒显已生成的大纲；未命中 NO_CACHE → 回到生成按钮态）
  useEffect(() => {
    reqIdRef.current += 1;
    setPhase('idle');
    setResult(null);
    setErrorText('');
    setRegeneratingId(null);
    setRegenError(null);
    if (!videoId || !modelReady || autoTriedRef.current === videoId) return;
    autoTriedRef.current = videoId;
    const reqId = reqIdRef.current;
    setPhase('loading');
    withTimeout(loadCachedRef.current(videoId), 8_000, '读取大纲缓存')
      .then((r) => {
        if (reqId !== reqIdRef.current) return;
        setResult(r);
        setPhase(pickPhase(r));
        if (pickPhase(r) === 'degraded') setErrorText(describeOutlineFailure(r));
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        // NO_CACHE / 读缓存异常 / 超时：先看是否有进行中的生成可续等
        const pending = getInflightOutline(videoId);
        if (pending) {
          withTimeout(pending, 120_000, '生成大纲')
            .then((r) => {
              if (reqId !== reqIdRef.current) return;
              setResult(r);
              setPhase(pickPhase(r));
              if (pickPhase(r) === 'degraded') setErrorText(describeOutlineFailure(r));
            })
            .catch(() => {
              if (reqId !== reqIdRef.current) return;
              setPhase('idle');
            });
          return;
        }
        setPhase('idle');
      });
  }, [videoId, modelReady]);

  const handleGenerate = () => {
    if (!videoId) return;
    // SPEC-09 9.3 A4：有笔记时重生成前先确认（笔记不删，但可能需要手动归位）
    if (notesState.notes.length > 0) {
      const ok = window.confirm(
        `已有 ${notesState.notes.length} 条笔记。重新生成后笔记会按时间自动归位，` +
          '对不上的进入「未归位」（不会删除），可能需要手动确认。继续？',
      );
      if (!ok) return;
    }
    const oldSections = sections;
    const reqId = ++reqIdRef.current;
    setPhase('loading');
    setResult(null);
    setErrorText('');
    setRegenError(null);
    withTimeout(generateRef.current(videoId), 120_000, '生成大纲')
      .then((r) => {
        if (reqId !== reqIdRef.current) return;
        setResult(r);
        setPhase(pickPhase(r));
        // 笔记重新归位（SPEC-09 9.2 接线；旧大纲 → 新大纲）
        void notesState
          .reanchor(oldSections, r.sections, meta?.durationMs ?? videoDurationOf(r.sections))
          .catch((err: unknown) => console.error('[vsc] notes reanchor failed', err));
      })
      .catch((err: unknown) => {
        if (reqId !== reqIdRef.current) return;
        // 失败一律留痕：界面没有详情时，控制台是唯一的诊断入口
        console.error('[vsc] outline generate failed', err);
        const text =
          err instanceof Error
            ? err.message.trim()
            : typeof err === 'string'
              ? err.trim()
              : '';
        setErrorText(text.length > 0 ? text : OUTLINE_FAILURE_NO_DETAIL);
        setPhase('degraded');
      });
  };

  /** 单章重生成：期间该章显示生成中；完成用返回的章节列表替换；失败显示可重试 */
  const handleRegenerateSection = (section: Section, feedback?: string) => {
    if (!videoId) return;
    const reqId = reqIdRef.current;
    const oldSections = sections;
    setRegenError(null);
    setRegeneratingId(section.id);
    regenRef
      .current(videoId, section, feedback)
      .then((r) => {
        if (reqId !== reqIdRef.current) {
          // 全局重新生成/视频切换已使本请求过期，仅复位单章状态
          setRegeneratingId(null);
          return;
        }
        setRegeneratingId(null);
        setResult(r);
        if (r.sections.length > 0) setPhase('ready');
        // 单章重生成同样归位（该章的笔记可能需要重新对上）
        void notesState
          .reanchor(oldSections, r.sections, meta?.durationMs ?? videoDurationOf(r.sections))
          .catch((err: unknown) => console.error('[vsc] notes reanchor failed', err));
      })
      .catch((err: unknown) => {
        setRegeneratingId(null);
        if (reqId !== reqIdRef.current) return;
        setRegenError({
          sectionId: section.id,
          text: err instanceof Error ? err.message : String(err),
        });
      });
  };

  /** 一键存入 Obsidian：成功显示返回的笔记路径，失败显示错误摘要 */
  const handleSaveVideoNote = () => {
    const save = props.onSaveVideoNote;
    if (!save) return;
    setSaving(true);
    setSaveResult(null);
    save()
      .then((path) => setSaveResult({ ok: true, text: path ? `已存入：${path}` : '已存入 Obsidian' }))
      .catch((err: unknown) =>
        setSaveResult({ ok: false, text: err instanceof Error ? err.message : String(err) }),
      )
      .finally(() => setSaving(false));
  };

  // -------------------------------------------------------------------------
  // 导入 / 导出（SPEC-09 9.6）
  // -------------------------------------------------------------------------

  /** 导出：大纲 + 笔记 → vsc-outline 文件（平台层下载；失败行内提示） */
  const handleExport = async () => {
    if (!videoId || !meta || sections.length === 0) return;
    setExchanging(true);
    setSaveResult(null);
    try {
      const { json, filename } = await exportOutlineFile({
        videoId,
        meta,
        sections,
        includeNotes: true,
      });
      downloadTextFile(filename, json);
      setSaveResult({ ok: true, text: `已导出：${filename}（含笔记 ${notesState.notes.length} 条）` });
    } catch (err: unknown) {
      console.error('[vsc] outline export failed', err);
      setSaveResult({
        ok: false,
        text: `导出失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setExchanging(false);
    }
  };

  /** 导入入口：选文件 → 校验（9.5 校验器）→ 有本地大纲进冲突三选一，无则直接替换式导入 */
  const handleImportPick = async () => {
    if (!videoId || !meta) return;
    setSaveResult(null);
    let picked: { name: string; text: string } | null = null;
    try {
      picked = await readTextFileViaInput();
    } catch (err: unknown) {
      setSaveResult({
        ok: false,
        text: `读取文件失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (!picked) return;
    let verdict = await parseOutlineImport(picked.text, {
      bvid: meta.bvid,
      page: meta.page,
      title: meta.title,
    });
    // 二轮冒烟：视频不一致 → 用户确认后才继续（覆盖导入）
    if (!verdict.ok && verdict.stage === 'video-mismatch') {
      const ok = window.confirm(
        `${verdict.message}。\n这不是当前视频的大纲（可能是同课程的另一集或重新上传的视频）。\n` +
          '仍要导入吗？超出现频时长的章节与笔记会被自动忽略。',
      );
      if (!ok) return;
      verdict = await parseOutlineImport(
        picked.text,
        { bvid: meta.bvid, page: meta.page, title: meta.title },
        { allowVideoMismatch: true },
      );
    }
    if (!verdict.ok) {
      setSaveResult({ ok: false, text: `导入失败：${verdict.message}` });
      return;
    }
    if (verdict.warnings.length > 0) {
      setSaveResult({ ok: true, text: `注意：${verdict.warnings.join('；')}` });
    }
    if (sections.length > 0) {
      // 本地已有大纲：冲突三选一（spec §3.4）
      setPendingImport(verdict.file);
    } else {
      await applyImport(verdict.file, 'replace');
    }
  };

  /** 执行导入：replace=替换本地大纲（先备份）+导入笔记；merge=只合并笔记 */
  const applyImport = async (file: VscOutlineFile, mode: 'replace' | 'merge') => {
    if (!videoId) return;
    setPendingImport(null);
    setExchanging(true);
    try {
      const durationMs = meta?.durationMs ?? file.video.durationMs;
      // 二轮冒烟：超出现频时长的导入内容自动忽略（章节按 startMs 截断、笔记按 tMs 丢弃）
      if (mode === 'replace') {
        // 替换前自动备份本地大纲（spec §3.4）
        const backup = await buildLocalBackup({ videoId, meta: meta!, sections });
        if (backup) downloadTextFile(backup.filename, backup.json);
        const imported = await saveImportedOutline(videoId, file);
        const inRange = imported.filter((s) => s.startMs < durationMs);
        const droppedSections = imported.length - inRange.length;
        // 派生字段重算（score/density；cueRange 留空由后续字幕流程回填）
        const rescored = rescoreOutline(inRange);
        if (rescored.length === 0) {
          setSaveResult({ ok: false, text: '导入失败：文件中所有章节都超出了当前视频时长，没有可导入的内容' });
          return;
        }
        setResult({ sections: rescored, chunkState: [], droppedBySnap: 0, budgetHit: false, failedChunks: 0 });
        setPhase('ready');
        const localIds = new Set(notesState.notes.map((n) => n.id));
        const { notes: mapped, droppedOutOfRange } = mapImportedNotes(file, rescored, durationMs, localIds, true);
        await saveImportedNotes(mapped);
        await notesState.reload();
        setSaveResult({
          ok: true,
          text:
            `已导入大纲（${rescored.length} 章）与 ${mapped.length} 条笔记` +
            `${droppedSections > 0 ? `；忽略超长章节 ${droppedSections} 个` : ''}` +
            `${droppedOutOfRange > 0 ? `；忽略超长笔记 ${droppedOutOfRange} 条` : ''}` +
            `${backup ? '；本地原大纲已备份下载' : ''}`,
        });
      } else {
        const localIds = new Set(notesState.notes.map((n) => n.id));
        const { notes: mapped, droppedOutOfRange } = mapImportedNotes(file, sections, durationMs, localIds, true);
        await saveImportedNotes(mapped);
        await notesState.reload();
        setSaveResult({
          ok: true,
          text:
            `已合并 ${mapped.length} 条笔记到本地大纲` +
            `${droppedOutOfRange > 0 ? `；忽略超出现频时长的笔记 ${droppedOutOfRange} 条` : ''}`,
        });
      }
    } catch (err: unknown) {
      console.error('[vsc] outline import failed', err);
      setSaveResult({
        ok: false,
        text: `导入失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setExchanging(false);
    }
  };

  // 无视频 / 模型未配置：占位（与 SubtitleTab idle 同结构）
  if (!videoId || !modelReady) {
    return (
      <div className="tab-placeholder">
        <p>{!videoId ? '打开 B 站视频后可生成章节大纲' : OUTLINE_MODEL_NOT_READY_TEXT}</p>
        {!videoId ? null : onOpenSettings ? (
          <button type="button" className="btn" onClick={onOpenSettings}>
            去设置
          </button>
        ) : null}
      </div>
    );
  }

  // 模型选择在所有状态下可见（生成前也要能选用哪个模型）
  // 顶栏常驻：模型选择 + 生成来源横幅（所有状态可见）
  const pickerRow = (
    <div className="outline-picker-row">
      <ModelPicker onOpenSettings={onOpenSettings} />
      <GenerationBanner module="outline" />
    </div>
  );

  if (phase === 'loading') {
    return (
      <div className="outline-tab">
        {pickerRow}
        <div className="tab-placeholder">
          <p>{OUTLINE_PHASE_TEXT.loading}</p>
        </div>
      </div>
    );
  }

  if (phase === 'degraded') {
    return (
      <div className="outline-tab">
        {pickerRow}
        <div className="outline-degraded">
          <p className="outline-degraded-text">
            {errorText && errorText.trim().length > 0 ? errorText : OUTLINE_FAILURE_NO_DETAIL}
          </p>
          <button type="button" className="btn" onClick={handleGenerate}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'empty') {
    return (
      <div className="outline-tab">
        {pickerRow}
        <div className="outline-empty">{OUTLINE_PHASE_TEXT.empty}</div>
      </div>
    );
  }

  if (phase === 'idle') {
    return (
      <div className="outline-tab">
        {pickerRow}
        <div className="tab-placeholder">
          <p>{OUTLINE_PHASE_TEXT.idle}</p>
          <button type="button" className="btn btn-primary" onClick={handleGenerate}>
            生成大纲
          </button>
        </div>
      </div>
    );
  }

  // ready：章节列表 + 头部统计与全局重新生成入口（单章重生成进行中禁用全局按钮）
  const active = findActiveSection(sections, positionMs);
  /** 时间点笔记的锚：当前播放位置所在章节（无章节时 sectionId=null → 未归位区可见） */
  const timeNoteAnchor = (): NoteAnchor | null => {
    if (!videoId) return null;
    const tMs = Math.max(0, Math.floor(positionMs));
    return {
      kind: 'time',
      sectionId: active ? active.id : null,
      tMs,
    };
  };
  return (
    <div className="outline-tab">
      {pickerRow}
      <div className="outline-header">
        <span className="outline-count">共 {sections.length} 章</span>
        {props.onSaveVideoNote && (
          <button
            type="button"
            className="btn"
            onClick={handleSaveVideoNote}
            disabled={saving}
          >
            {saving ? '存入中…' : '存入 Obsidian'}
          </button>
        )}
        <button
          type="button"
          className="btn"
          title={`在当前播放位置（${formatTimestamp(positionMs)}）记一条时间点笔记`}
          onClick={() => {
            const anchor = timeNoteAnchor();
            if (!anchor) return;
            setNoteModal({
              mode: 'create',
              anchor,
              contextLabel: `时间点 · ${formatTimestamp(anchor.tMs)}${active ? ` · ${active.title}` : ''}`,
            });
          }}
        >
          ⏱ 笔记
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void handleExport()}
          disabled={exchanging}
          title="导出大纲与笔记为 vsc-outline 交换文件（可分享他人导入）"
        >
          {exchanging ? '处理中…' : '导出'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void handleImportPick()}
          disabled={exchanging}
          title="导入他人分享的 vsc-outline 文件"
        >
          导入
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleGenerate}
          disabled={regeneratingId !== null}
        >
          重新生成
        </button>
      </div>
      {saveResult && (
        <p className={saveResult.ok ? 'outline-save-hint' : 'outline-save-hint outline-save-error'}>
          {saveResult.text}
        </p>
      )}
      <OutlineSectionList
        sections={sections}
        activeId={active ? active.id : null}
        onSeek={onRequestSeek}
        regeneratingId={regeneratingId}
        regenError={regenError}
        onSubmitRegen={handleRegenerateSection}
        notesState={notesState}
        onOpenEditor={setNoteModal}
      />
      {/* 未归位笔记（重生成后对不上的集中展示，永不丢弃） */}
      <UnanchoredNotes
        notes={notesState.unanchored}
        state={notesState}
        onSeek={onRequestSeek}
        onOpenEditor={setNoteModal}
      />
      {/* 笔记弹窗（输入与展示统一入口，二轮反馈） */}
      {noteModal && (
        <NoteModal
          req={noteModal}
          busyId={notesState.busyId}
          state={notesState}
          onSeek={onRequestSeek}
          onClose={() => setNoteModal(null)}
        />
      )}
      {/* 导入冲突三选一（spec §3.4：本地已有大纲时） */}
      {pendingImport && (
        <div className="vnote-import-dialog" role="dialog">
          <p className="vnote-import-title">
            本地已有大纲。导入《{pendingImport.video.title}》P{pendingImport.video.page} 的大纲
            （{pendingImport.outline.sections.length} 章、{pendingImport.notes.length} 条笔记）：
          </p>
          <div className="vnote-import-btns">
            <button type="button" className="btn btn-primary" onClick={() => void applyImport(pendingImport, 'replace')}>
              替换本地大纲（先自动备份）
            </button>
            <button type="button" className="btn" onClick={() => void applyImport(pendingImport, 'merge')}>
              只合并笔记
            </button>
            <button type="button" className="btn" onClick={() => setPendingImport(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 视频时长兜底：meta 缺失时取末章 endMs（归位越界判定用） */
function videoDurationOf(sections: Section[]): number {
  return sections.length > 0 ? sections[sections.length - 1].endMs : 0;
}
