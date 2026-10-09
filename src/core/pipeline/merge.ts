/**
 * 增量合并与全局校正（TECH-DESIGN §5.1 步骤 6/7；SPEC-03 3c 增加最短章节强制）：
 * - IncrementalMerger：按块顺序处理，每块候选只与"已确认章节尾部"尝试合并
 *   （标题相似 + 时间相邻 → 追加要点/术语），非尾部章节不再变动；
 * - enforceMinDuration：时长不足 minMs 的章节并入相邻较长章节（确定性后处理）；
 * - finalizeOutline：按 startMs 排序、剔除重叠、补齐覆盖、最短章节强制、
 *   计算 endMs/cueRange、重编 id；
 * - validateOutline：覆盖校验（startMs 严格递增且 ∈ Cue.startMs 集合，红线 2）。
 */
import { OUTLINE } from '../../config';
import type { Cue, Section, SectionBullet } from '../../types';
import { attachDensity } from './density';
import type { SnappedSection } from './snap';
import type { OutlineSection } from './types';

export interface MergeOptions {
  /** 标题相似度阈值（字符重合率），默认 0.5 */
  titleThreshold?: number;
  /** 时间相邻窗口（毫秒），默认 60_000 */
  adjacentMs?: number;
}

/** 标题字符重合率：字符集合的 Jaccard 相似度 */
export function titleSimilarity(a: string, b: string): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items)];
}

/** bullets 按 text 去重（保留首次出现者及其时间戳） */
function dedupeBullets(items: SectionBullet[]): SectionBullet[] {
  const seen = new Set<string>();
  const out: SectionBullet[] = [];
  for (const b of items) {
    if (seen.has(b.text)) continue;
    seen.add(b.text);
    out.push(b);
  }
  return out;
}

/** 增量合并器：块内候选先按 startMs 排序，再逐条与尾部尝试合并 */
export class IncrementalMerger {
  private readonly sections: SnappedSection[] = [];
  private readonly titleThreshold: number;
  private readonly adjacentMs: number;

  constructor(opts: MergeOptions = {}) {
    this.titleThreshold = opts.titleThreshold ?? 0.5;
    this.adjacentMs = opts.adjacentMs ?? 60_000;
  }

  addChunk(cands: SnappedSection[]): void {
    const sorted = [...cands].sort((a, b) => a.startMs - b.startMs);
    for (const c of sorted) {
      const tail = this.sections[this.sections.length - 1];
      if (
        tail &&
        titleSimilarity(tail.title, c.title) >= this.titleThreshold &&
        Math.abs(c.startMs - tail.startMs) <= this.adjacentMs
      ) {
        // 合并进尾部：标题/起始时间/重要性不变（已确认部分不跳动），追加要点与术语
        tail.bullets = dedupeBullets([...tail.bullets, ...c.bullets]);
        tail.terms = dedupeStrings([...tail.terms, ...c.terms]);
      } else {
        this.sections.push({ ...c, bullets: [...c.bullets], terms: [...c.terms] });
      }
    }
  }

  /** 已确认章节（返回副本，避免外部改动内部状态） */
  getSections(): SnappedSection[] {
    return this.sections.map((s) => ({ ...s, bullets: [...s.bullets], terms: [...s.terms] }));
  }
}

/**
 * 最短章节强制（SPEC-03 3c，确定性后处理，红线 1）：
 * 时长 < minMs 的章节并入相邻的较长章节（前后邻取时长更大者，并列取后邻；
 * 首章只能并入后邻、末章只能并入前邻），标题/要点/术语合并（保留目标章节的
 * 标题/摘要/重要性，bullets 与 terms 追加并去重），从最短的开始迭代处理
 * 直至全部达标（或只剩一章）。
 *
 * 时长按相邻章节 startMs 差计算；末章时长 = videoEndMs - 末章 startMs
 * （不传 videoEndMs 时末章视为达标——finalize 内部调用时总会传入）。
 * 纯函数：返回新数组，不改入参。
 */
export function enforceMinDuration(
  sections: SnappedSection[],
  minMs: number,
  videoEndMs?: number,
): SnappedSection[] {
  const list: SnappedSection[] = sections.map((s) => ({
    ...s,
    bullets: [...s.bullets],
    terms: [...s.terms],
  }));
  if (list.length <= 1) return list;

  const durations = (): number[] =>
    list.map((s, i) =>
      i + 1 < list.length
        ? list[i + 1].startMs - s.startMs
        : videoEndMs === undefined
          ? Number.POSITIVE_INFINITY
          : videoEndMs - s.startMs,
    );

  for (;;) {
    if (list.length <= 1) break; // 只剩一章：不再合并
    const durs = durations();
    // 找出未达标章节中最短者（并列取先出现者）
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
      if (durs[i] < minMs && (idx < 0 || durs[i] < durs[idx])) idx = i;
    }
    if (idx < 0) break; // 全部达标

    const hasPrev = idx > 0;
    const hasNext = idx + 1 < list.length;
    // 并入相邻较长章节：前后邻取时长更大者（并列取后邻）
    const into = hasPrev && hasNext
      ? durs[idx - 1] > durs[idx + 1]
        ? idx - 1
        : idx + 1
      : hasPrev
        ? idx - 1
        : idx + 1;

    const short = list[idx];
    const target = list[into];
    if (into === idx - 1) {
      // 并入前邻：前邻保持原起点/标题，追加 bullets/terms
      target.bullets = dedupeBullets([...target.bullets, ...short.bullets]);
      target.terms = dedupeStrings([...target.terms, ...short.terms]);
    } else {
      // 并入后邻：后邻采用被并章节的起点（覆盖连续），bullets 在前
      list[into] = {
        ...target,
        startMs: short.startMs,
        bullets: dedupeBullets([...short.bullets, ...target.bullets]),
        terms: dedupeStrings([...short.terms, ...target.terms]),
      };
    }
    list.splice(idx, 1);
  }
  return list;
}

/**
 * 全局校正：排序 → 剔除重叠（同 startMs 只保留先确认者）→ 首章回补到第一条 Cue（补齐覆盖）
 * → 最短章节强制（末尾后处理，末章时长按末条 Cue.endMs）→ endMs 链（下一章 startMs - 1，
 * 末章 = 末条 Cue.endMs）→ cueRange → 重编 id → 覆盖校验 → 密度打分（返回完整 Section[]）。
 */
export function finalizeOutline(
  sections: SnappedSection[],
  cues: Cue[],
  minSectionDurationMs: number = OUTLINE.minSectionDurationMs,
): Section[] {
  if (sections.length === 0 || cues.length === 0) return [];
  const sortedCues = [...cues].sort((a, b) => a.startMs - b.startMs);
  const lastCueEndMs = sortedCues[sortedCues.length - 1].endMs;

  const sorted = [...sections].sort((a, b) => a.startMs - b.startMs);
  const uniq: SnappedSection[] = [];
  for (const s of sorted) {
    if (uniq.length > 0 && uniq[uniq.length - 1].startMs === s.startMs) continue;
    uniq.push(s);
  }
  // 补齐覆盖：首章回补到第一条 Cue，保证章节覆盖全片开头
  if (uniq[0].startMs > sortedCues[0].startMs) {
    uniq[0] = { ...uniq[0], startMs: sortedCues[0].startMs };
  }

  // 最短章节强制（末尾确定性后处理）
  const enforced = enforceMinDuration(uniq, minSectionDurationMs, lastCueEndMs);

  const out: OutlineSection[] = [];
  for (let i = 0; i < enforced.length; i++) {
    const sec = enforced[i];
    const nextStart = i + 1 < enforced.length ? enforced[i + 1].startMs : null;
    const endMs =
      nextStart === null ? lastCueEndMs : nextStart - 1;

    // startMs ∈ Cue.startMs 集合，findIndex 必命中
    const startIdx = sortedCues.findIndex((c) => c.startMs >= sec.startMs);
    let endIdx = sortedCues.length - 1;
    if (nextStart !== null) {
      endIdx = startIdx;
      while (endIdx + 1 < sortedCues.length && sortedCues[endIdx + 1].startMs < nextStart) {
        endIdx += 1;
      }
    }

    out.push({
      id: `sec_${String(i + 1).padStart(4, '0')}`,
      title: sec.title,
      startMs: sec.startMs,
      endMs,
      summary: sec.summary,
      bullets: sec.bullets,
      terms: sec.terms,
      importance: sec.importance,
      cueRange: [startIdx, endIdx],
    });
  }

  validateOutline(out, sortedCues);
  return attachDensity(out);
}

/** 覆盖校验：不满足内部不变量时 throw（构造逻辑保证不应触发，触发即 bug） */
export function validateOutline(sections: OutlineSection[], cues: Cue[]): void {
  if (sections.length === 0) return;
  const cueStarts = new Set(cues.map((c) => c.startMs));
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (!cueStarts.has(s.startMs)) {
      throw new Error(`章节 ${s.id} startMs=${s.startMs} 不落在任何 Cue.startMs 上（红线 2）`);
    }
    if (i > 0 && s.startMs <= sections[i - 1].startMs) {
      throw new Error(`章节 ${s.id} startMs 未严格递增`);
    }
    if (s.endMs < s.startMs) throw new Error(`章节 ${s.id} endMs < startMs`);
    if (s.cueRange[0] > s.cueRange[1]) throw new Error(`章节 ${s.id} cueRange 为空区间`);
  }
  if (sections[0].startMs > cues[0].startMs) throw new Error('首章未覆盖视频开头');
  if (sections[sections.length - 1].endMs < cues[cues.length - 1].endMs) {
    throw new Error('末章未覆盖视频结尾');
  }
}
