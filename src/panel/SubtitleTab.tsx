/**
 * 字幕 Tab（SPEC-02 子任务 2.4）：
 * 全文字幕列表 / 当前句跟随高亮并自动滚动 / 点句跳播 / 降级提示 / 手动粘贴入口。
 * 数据经 props 注入（loadSubtitles / onManualPaste），由父 agent 接线瀑布与解析（TODO）。
 */
import { useEffect, useRef, useState } from 'react';
import type { Cue, FetchResult, SubtitleSource, SubtitleStatus, VideoMeta } from '../types';
import { toPlainText, toSrt } from '../core/subtitle/serialize';

export interface SubtitleTabProps {
  videoId: string | null;
  /** 来自 App 现有 videoInfo（url/cid 已由 content 上报，SPEC-08 8.2） */
  meta: VideoMeta | null;
  /** 来自 App 现有 playback 状态 */
  positionMs: number;
  /** App 传：发 MSG.SEEK */
  onRequestSeek: (targetMs: number) => void;
  /** 数据源注入（父 agent 接线 runSubtitleWaterfall；本文件不 import providers，避免并行冲突） */
  loadSubtitles: (videoId: string) => Promise<FetchResult>;
  /** 字幕加载成功后向父级上报（App 存给 ChatTab 吸附时间戳，SPEC-08 8.4a） */
  onCues?: (cues: Cue[]) => void;
  /** AI 字幕顺句（SPEC-08 8.5；仅 bili_ai 来源时按钮可见） */
  punctuate?: (videoId: string) => Promise<{ cues: Cue[]; chunks: number; fallbackChunks: number }>;
  /** 切回 ASR 原文 */
  restoreRaw?: (videoId: string) => Promise<Cue[]>;
  /** 手动粘贴解析回调（接线前缺省，按钮禁用并显示"待接线"） */
  onManualPaste?: (text: string) => void;
  /** 划词解释回调（SPEC-05 追加：选区确认后触发；接线前 sticky 条显示"待接线"） */
  onExplainTerm?: (text: string) => void;
}

type Phase = 'idle' | 'loading' | 'ready' | 'degraded' | 'empty';

/**
 * 当前 Cue 查找（二分，cues 按 startMs 升序）：
 * 返回 startMs<=positionMs 的最后一条；间隙时停留上一条；positionMs 早于首条或空数组返回 null。
 */
export function findActiveCue(cues: Cue[], positionMs: number): Cue | null {
  if (cues.length === 0) return null;
  let lo = 0;
  let hi = cues.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans < 0 ? null : cues[ans];
}

/** ms → "[mm:ss]" 前的 "mm:ss"（分钟累计，不进位到小时） */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** 降级状态 → 提示文案（ok / manual_pasted 非降级，返回空串） */
export function degradedText(status: SubtitleStatus): string {
  switch (status) {
    case 'need_login':
      return '获取字幕需要登录 B 站，请登录后点击重试';
    case 'no_subtitle':
      return '本视频没有可用字幕';
    case 'api_changed':
      return 'B 站接口变更，字幕暂时无法获取，可点击重试或手动粘贴';
    case 'network':
      return '网络异常，字幕获取失败，请检查网络后重试';
    default:
      return '';
  }
}

/** 来源 → 标签文案 */
export function sourceLabel(source: SubtitleSource): string {
  switch (source) {
    case 'bili_uploader':
      return 'UP 主字幕';
    case 'bili_ai':
      return 'AI 字幕';
    case 'manual':
      return '手动粘贴';
  }
}

/**
 * 选区文本提取（SPEC-05 划词集成，纯函数）：trim、纯空白返回 null、限长 40 字（超出截断）。
 */
export function extractSelectionText(selection: string): string | null {
  const trimmed = selection.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 40);
}

/** ready 态主体：字幕列表 + approximate 一次性提示条 + 跟随高亮滚动 + 点句跳播 + 划词 sticky 条（SPEC-05 追加） */
export function SubtitleList({
  cues,
  activeIndex,
  onSeek,
  onExplainTerm,
}: {
  cues: Cue[];
  /** 当前高亮 Cue.index；-1 表示无 */
  activeIndex: number;
  onSeek: (targetMs: number) => void;
  /** 划词解释回调（可选，接线前 sticky 条显示"待接线"） */
  onExplainTerm?: (text: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  /** 上一次滚动到的目标，防止每次 positionMs 更新都触发滚动抖动 */
  const lastScrolledRef = useRef<number>(-1);
  const [bannerHidden, setBannerHidden] = useState(false);
  /** 划词选中的术语（选区清空后归 null，sticky 条消失） */
  const [selectedTerm, setSelectedTerm] = useState<string | null>(null);
  const approximate = cues.some((c) => c.approximate);

  useEffect(() => {
    if (activeIndex < 0 || lastScrolledRef.current === activeIndex) return;
    const el = wrapRef.current?.querySelector<HTMLElement>(`[data-cue-index="${activeIndex}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      lastScrolledRef.current = activeIndex;
    }
  }, [activeIndex]);

  /** 划词捕获：选区非空且锚点在字幕列表内 → sticky 条；否则清空 */
  const handleMouseUp = (): void => {
    const sel = typeof window !== 'undefined' ? window.getSelection() : null;
    const text = sel ? extractSelectionText(sel.toString()) : null;
    const node = sel?.anchorNode ?? null;
    const inside = text !== null && node !== null && !!wrapRef.current && wrapRef.current.contains(node);
    setSelectedTerm(inside ? text : null);
  };

  const clearSelection = (): void => {
    setSelectedTerm(null);
    if (typeof window !== 'undefined') {
      window.getSelection()?.removeAllRanges();
    }
  };

  return (
    <div className="subtitle-list-wrap" ref={wrapRef} onMouseUp={handleMouseUp}>
      {approximate && !bannerHidden && (
        <div className="subtitle-banner">
          <span>字幕时间为估算</span>
          <button
            type="button"
            className="subtitle-banner-close"
            aria-label="关闭提示"
            onClick={() => setBannerHidden(true)}
          >
            ×
          </button>
        </div>
      )}
      {selectedTerm && (
        <div
          className="subtitle-select-bar"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            background: '#f0f7ff',
            borderBottom: '1px solid #cfe3f7',
          }}
        >
          <span
            className="subtitle-select-text"
            style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            解释「{selectedTerm}」
          </span>
          {onExplainTerm ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                onExplainTerm(selectedTerm);
                clearSelection();
              }}
            >
              解释
            </button>
          ) : (
            <span style={{ color: '#888', fontSize: 12 }}>待接线</span>
          )}
          <button
            type="button"
            className="subtitle-select-close"
            aria-label="取消划词"
            onClick={clearSelection}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14 }}
          >
            ×
          </button>
        </div>
      )}
      <div className="subtitle-list">
        {cues.map((cue) => (
          <div
            key={cue.index}
            data-cue-index={cue.index}
            className={cue.index === activeIndex ? 'subtitle-row active' : 'subtitle-row'}
            onClick={() => onSeek(cue.startMs)}
          >
            <span className="subtitle-time">[{formatTimestamp(cue.startMs)}]</span>
            <span className="subtitle-text">{cue.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 浏览器下载壳（SPEC-04 三次迭代：字幕下载）：内容生成是纯函数
 * （core/subtitle/serialize.ts 的 toSrt/toPlainText，单测覆盖），此处仅触发下载。
 */
function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SubtitleTab(props: SubtitleTabProps) {
  const { videoId, positionMs, onRequestSeek, onManualPaste, onExplainTerm, onCues, punctuate, restoreRaw } = props;
  const [phase, setPhase] = useState<Phase>('idle');
  const [result, setResult] = useState<FetchResult | null>(null);
  /** loadSubtitles 抛异常（瀑布约定不抛，占位/接线期兜底） */
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [pasteText, setPasteText] = useState('');
  /** 顺句进行中 / 结果反馈（SPEC-08 8.5） */
  const [punctuating, setPunctuating] = useState(false);
  const [punctuateNote, setPunctuateNote] = useState<string | null>(null);
  const [isPunctuated, setIsPunctuated] = useState(false);

  // 最新 ref：父组件每次渲染重建 loadSubtitles 时不重触发加载
  const loadRef = useRef(props.loadSubtitles);
  loadRef.current = props.loadSubtitles;

  useEffect(() => {
    if (!videoId) {
      setPhase('idle');
      setResult(null);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setPhase('loading');
    setResult(null);
    setLoadFailed(false);
    loadRef
      .current(videoId)
      .then((r) => {
        if (cancelled) return;
        setResult(r);
        setIsPunctuated(false);
        if (r.cues.length > 0) onCues?.(r.cues);
        // 有 cues 即渲染（manual_pasted 也算）；无 cues 且无降级信息 → empty
        setPhase(
          r.cues.length > 0
            ? 'ready'
            : r.status === 'ok' || r.status === 'manual_pasted'
              ? 'empty'
              : 'degraded',
        );
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
        setPhase('degraded');
      });
    return () => {
      cancelled = true;
    };
  }, [videoId, retryTick]);

  if (phase === 'idle') {
    return (
      <div className="tab-placeholder">
        <p>打开 B 站视频后自动加载字幕</p>
      </div>
    );
  }

  if (phase === 'loading') {
    return (
      <div className="tab-placeholder">
        <p>字幕加载中…</p>
      </div>
    );
  }

  if (phase !== 'ready' || !result) {
    const needLogin = !loadFailed && result?.status === 'need_login';
    const text = loadFailed
      ? '加载失败，点击重试'
      : phase === 'empty'
        ? '本视频无字幕'
        : degradedText(result?.status ?? 'no_subtitle');
    return (
      <div className="subtitle-tab">
        {phase === 'degraded' ? (
          <div className={needLogin ? 'subtitle-degraded need-login' : 'subtitle-degraded'}>
            <p className="subtitle-degraded-text">{text}</p>
            <button type="button" className="btn" onClick={() => setRetryTick((t) => t + 1)}>
              重试
            </button>
          </div>
        ) : (
          <div className="subtitle-empty">{text}</div>
        )}
        <details className="subtitle-paste">
          <summary>手动粘贴字幕</summary>
          <p className="subtitle-paste-hint">支持 SRT / WebVTT / 纯文本；纯文本的时间将按语速估算</p>
          <textarea
            className="subtitle-paste-input"
            rows={6}
            placeholder="粘贴字幕内容…"
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
          />
          <div className="subtitle-paste-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!onManualPaste || pasteText.trim().length === 0}
              onClick={() => onManualPaste?.(pasteText)}
            >
              解析
            </button>
            {!onManualPaste && <span className="subtitle-paste-pending">待接线</span>}
          </div>
        </details>
      </div>
    );
  }

  // ready
  const source = result.source ?? (result.status === 'manual_pasted' ? 'manual' : null);
  const activeCue = findActiveCue(result.cues, positionMs);
  return (
    <div className="subtitle-tab">
      <div className="subtitle-header">
        {source && <span className="subtitle-source-tag">{sourceLabel(source)}</span>}
        {result.lang && <span className="subtitle-lang">{result.lang}</span>}
      </div>
      <SubtitleList
        cues={result.cues}
        activeIndex={activeCue ? activeCue.index : -1}
        onSeek={onRequestSeek}
        onExplainTerm={onExplainTerm}
      />
      <div
        className="subtitle-download"
        style={{
          display: 'flex',
          gap: 8,
          padding: '8px 10px',
          borderTop: '1px solid #e5e6eb',
        }}
      >
        {source === 'bili_ai' && punctuate && !isPunctuated && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={punctuating}
            onClick={() => {
              if (!videoId) return;
              setPunctuating(true);
              setPunctuateNote(null);
              punctuate(videoId)
                .then((r) => {
                  setIsPunctuated(true);
                  setResult((prev) => (prev ? { ...prev, cues: r.cues } : prev));
                  onCues?.(r.cues);
                  setPunctuateNote(
                    r.fallbackChunks > 0
                      ? `已整理（${r.chunks - r.fallbackChunks}/${r.chunks} 块生效，其余保留原文）`
                      : '已整理：加标点并修正同音字',
                  );
                })
                .catch((err) => {
                  setPunctuateNote(err instanceof Error ? err.message : `整理失败：${String(err)}`);
                })
                .finally(() => setPunctuating(false));
            }}
          >
            {punctuating ? '整理中…' : '整理字幕（加标点）'}
          </button>
        )}
        {source === 'bili_ai' && restoreRaw && isPunctuated && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!videoId) return;
              restoreRaw(videoId)
                .then((cues) => {
                  setIsPunctuated(false);
                  setResult((prev) => (prev ? { ...prev, cues } : prev));
                  onCues?.(cues);
                  setPunctuateNote('已切回 ASR 原文');
                })
                .catch((err) => {
                  setPunctuateNote(err instanceof Error ? err.message : String(err));
                });
            }}
          >
            切回原文
          </button>
        )}
        {punctuateNote && <span className="subtitle-punctuate-note">{punctuateNote}</span>}
        <button
          type="button"
          className="btn"
          onClick={() => downloadTextFile(toSrt(result.cues), `${videoId}.srt`)}
        >
          下载 SRT
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => downloadTextFile(toPlainText(result.cues), `${videoId}.txt`)}
        >
          下载 TXT
        </button>
      </div>
    </div>
  );
}
