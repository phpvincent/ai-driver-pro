/**
 * 结构化候选帧 + 帧-字幕配对说明（纯函数，确定性，红线 1）。
 *
 * 分工原则（agent 设计）：**代码负责"有哪些值得看的时刻"，模型负责"挑哪些、为什么"**。
 * - 代码知道课程结构：章节开头、知识点（bullets.startMs）、章节结尾——这些时刻的画面
 *   往往就是该章的"标题页 / 关键演示 / 收尾结论"，首尾对照即可看出本章的演进；
 * - 模型看得懂内容：每个候选都附上那一刻的字幕，模型据此判断哪些画面承载新信息。
 *
 * 旧做法让模型凭章节摘要"报一个秒数"，它既不知道结构也不知道那一刻在讲什么，只能猜。
 */
import type { Cue, Section } from '../../types';

export type CandidateKind = 'chapter-start' | 'point' | 'chapter-end' | 'window';

export interface FrameCandidate {
  /** 候选编号（C1、C2…），模型按编号挑选 */
  id: string;
  /** 取帧时间（毫秒，恒为某条 Cue.startMs） */
  tMs: number;
  kind: CandidateKind;
  /** 所属章节下标（0-based；无章节时为 -1） */
  sectionIndex: number;
  /** 该时刻的字幕（当前句 + 下一句，已截断） */
  text: string;
  /** kind=point 时对应的知识点文本 */
  point?: string;
}

/** 候选优先级（间隔冲突时保留优先级高者） */
const KIND_PRIORITY: Record<CandidateKind, number> = {
  'chapter-start': 0,
  point: 1,
  'chapter-end': 2,
  window: 3,
};

/** 章节开头/结尾向内偏移：避开转场与片头动画，取"内容已展开"的画面 */
const EDGE_INSET_MS = 3_000;
/**
 * "章节开头 / 结尾"的判定窗口：候选生成与配对说明共用同一口径。
 * 取 15 秒——字幕稀疏（10 秒一句）时，开头候选落在 +10s，也必须被说明识别为"开头"。
 */
const EDGE_WINDOW_MS = 15_000;
/** 候选字幕最长字符数 */
const CANDIDATE_TEXT_MAX = 60;

export const KIND_LABEL: Record<CandidateKind, string> = {
  'chapter-start': '章节开头',
  point: '知识点',
  'chapter-end': '章节结尾',
  window: '时段',
};

/**
 * 生成结构化候选帧。
 * - 有章节：每章 开头 + 各知识点 + 结尾；
 * - 无章节（大纲生成阶段 / 问答区间）：按 windowMs 切时段，每段取首句。
 * 候选间距 < minGapMs 时按优先级去重；超过 maxCandidates 时保留全部章节开头，其余均匀抽样。
 */
export function buildStructuralCandidates(
  sections: Section[],
  cues: Cue[],
  opts: { minGapMs: number; maxCandidates?: number; windowMs?: number },
): FrameCandidate[] {
  const sorted = [...cues].filter((c) => Number.isFinite(c.startMs)).sort((a, b) => a.startMs - b.startMs);
  if (sorted.length === 0) return [];
  const raw: Array<Omit<FrameCandidate, 'id' | 'text'>> = [];

  if (sections.length > 0) {
    sections.forEach((s, si) => {
      const inSec = sorted.filter((c) => c.startMs >= s.startMs && c.startMs < Math.max(s.endMs, s.startMs + 1));
      if (inSec.length === 0) return;
      const startCue = inSec.find((c) => c.startMs >= s.startMs + EDGE_INSET_MS) ?? inSec[0]!;
      raw.push({ tMs: startCue.startMs, kind: 'chapter-start', sectionIndex: si });
      for (const b of s.bullets ?? []) {
        if (!Number.isFinite(b.startMs)) continue;
        const cue = nearestCue(inSec, b.startMs);
        if (cue) raw.push({ tMs: cue.startMs, kind: 'point', sectionIndex: si, point: b.text });
      }
      const endCue = [...inSec].reverse().find((c) => c.startMs <= s.endMs - EDGE_INSET_MS) ?? inSec[inSec.length - 1]!;
      raw.push({ tMs: endCue.startMs, kind: 'chapter-end', sectionIndex: si });
    });
  } else {
    const windowMs = Math.max(10_000, opts.windowMs ?? 30_000);
    let nextAt = -Infinity;
    for (const c of sorted) {
      if (c.startMs >= nextAt) {
        raw.push({ tMs: c.startMs, kind: 'window', sectionIndex: -1 });
        nextAt = c.startMs + windowMs;
      }
    }
  }

  // 间隔去重：先按优先级排，高优先级先占位
  const byPriority = [...raw].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.tMs - b.tMs,
  );
  const kept: typeof raw = [];
  for (const c of byPriority) {
    if (kept.some((k) => Math.abs(k.tMs - c.tMs) < opts.minGapMs)) continue;
    kept.push(c);
  }
  kept.sort((a, b) => a.tMs - b.tMs);

  const limited = limitCandidates(kept, opts.maxCandidates ?? 48);
  return limited.map((c, i) => ({
    ...c,
    id: `C${i + 1}`,
    text: truncate(cueTextAround(sorted, c.tMs), CANDIDATE_TEXT_MAX),
  }));
}

/** 超上限：章节开头全保留，其余均匀抽样（保持时间分布） */
function limitCandidates<T extends { kind: CandidateKind; tMs: number }>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const must = list.filter((c) => c.kind === 'chapter-start').slice(0, max);
  const rest = list.filter((c) => c.kind !== 'chapter-start');
  const room = Math.max(0, max - must.length);
  const picked: T[] = [];
  for (let k = 0; k < room; k++) {
    const idx = Math.floor(((k + 0.5) * rest.length) / room);
    const item = rest[idx];
    if (item && !picked.includes(item)) picked.push(item);
  }
  return [...must, ...picked].sort((a, b) => a.tMs - b.tMs);
}

/**
 * 确定性兜底选帧（模型不可用 / 给得不够时）：
 * 章节开头 → 章节结尾 → 知识点 → 时段，按此优先级填到 budget。
 */
export function pickCandidatesByPriority(candidates: FrameCandidate[], budget: number): number[] {
  const order: CandidateKind[] = ['chapter-start', 'chapter-end', 'point', 'window'];
  const out: number[] = [];
  for (const kind of order) {
    const group = candidates.filter((c) => c.kind === kind);
    for (const c of spread(group, Math.max(0, budget - out.length))) out.push(c.tMs);
    if (out.length >= budget) break;
  }
  return out.slice(0, Math.max(0, budget)).sort((a, b) => a - b);
}

/** 从 list 中均匀取 n 个 */
function spread<T>(list: T[], n: number): T[] {
  if (n <= 0) return [];
  if (list.length <= n) return list;
  const out: T[] = [];
  for (let k = 0; k < n; k++) out.push(list[Math.floor(((k + 0.5) * list.length) / n)]!);
  return out;
}

/**
 * 章节覆盖护栏：任何一章都不能一帧都没有（在不超上限的前提下补该章开头）。
 * 模型可以自由取舍"每章看几帧"，但"某章完全不看"会让导图直接漏掉一个阶段。
 */
export function ensureChapterCoverage(
  targets: number[],
  sections: Section[],
  candidates: FrameCandidate[],
  opts: { max: number; minGapMs: number },
): number[] {
  const out = [...targets];
  sections.forEach((s, si) => {
    if (out.length >= opts.max) return;
    const covered = out.some((t) => t >= s.startMs && t < Math.max(s.endMs, s.startMs + 1));
    if (covered) return;
    const start = candidates.find((c) => c.sectionIndex === si && c.kind === 'chapter-start');
    if (!start) return;
    if (out.some((t) => Math.abs(t - start.tMs) < opts.minGapMs)) return;
    out.push(start.tMs);
  });
  return out.sort((a, b) => a - b);
}

/**
 * 帧-字幕配对说明（发给模型时紧贴在每张图前面）。
 * 例：`【画面 3/12 · 05:32 · 第 2 章「事件机制」· 知识点：回调处理】此刻字幕：……`
 * 这让模型不必再去"猜第几张图对应哪段话"。
 */
export function captionFrame(
  tMs: number,
  index: number,
  total: number,
  sections: Section[],
  cues: Cue[],
): string {
  const head = [`画面 ${index + 1}/${total}`, mmss(tMs)];
  const si = sections.findIndex((s) => tMs >= s.startMs && tMs < Math.max(s.endMs, s.startMs + 1));
  if (si >= 0) {
    const s = sections[si]!;
    head.push(`第 ${si + 1} 章「${s.title}」`);
    const role = roleInSection(tMs, s);
    if (role) head.push(role);
  }
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs);
  const text = truncate(cueTextAround(sorted, tMs, 2), 120);
  return `【${head.join(' · ')}】${text ? `此刻字幕：${text}` : ''}`;
}

function roleInSection(tMs: number, s: Section): string {
  if (tMs - s.startMs <= EDGE_WINDOW_MS) return '章节开头';
  if (s.endMs - tMs <= EDGE_WINDOW_MS) return '章节结尾';
  const bullet = (s.bullets ?? []).find((b) => Number.isFinite(b.startMs) && Math.abs(b.startMs - tMs) <= 8_000);
  return bullet ? `知识点：${truncate(bullet.text, 30)}` : '';
}

/** 候选列表 → prompt 文本（每行一个候选） */
export function formatCandidates(candidates: FrameCandidate[], sections: Section[]): string {
  if (candidates.length === 0) return '（无候选）';
  return candidates
    .map((c) => {
      const chapter = c.sectionIndex >= 0 ? `第${c.sectionIndex + 1}章` : '';
      const kind = c.kind === 'point' && c.point ? `知识点「${truncate(c.point, 24)}」` : KIND_LABEL[c.kind];
      const title = c.sectionIndex >= 0 && c.kind === 'chapter-start' ? `「${sections[c.sectionIndex]?.title ?? ''}」` : '';
      return `${c.id} [${mmss(c.tMs)}] ${[chapter + title, kind].filter(Boolean).join('·')} | ${c.text}`;
    })
    .join('\n');
}

function nearestCue(list: Cue[], tMs: number): Cue | null {
  let best: Cue | null = null;
  for (const c of list) if (!best || Math.abs(c.startMs - tMs) < Math.abs(best.startMs - tMs)) best = c;
  return best;
}

/** tMs 所在字幕句 + 其后 extra-1 句 */
function cueTextAround(sorted: Cue[], tMs: number, count = 2): string {
  let idx = sorted.findIndex((c) => c.startMs >= tMs - 500);
  if (idx < 0) idx = sorted.length - 1;
  // 取 tMs 所在的句子（startMs ≤ tMs 的最后一句）
  if (idx > 0 && sorted[idx]!.startMs > tMs + 500) idx -= 1;
  return sorted
    .slice(idx, idx + count)
    .map((c) => c.text.trim())
    .filter(Boolean)
    .join(' ');
}

function truncate(s: string, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
