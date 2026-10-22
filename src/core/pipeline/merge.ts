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
 * 章节要点确定性归一（SPEC-18 18.1 / SPEC-19 19.2）：
 * 大纲 bullets 由模型分块产出，拼接后会出现乱序 / 重复 / 越界（落在所属章节区间外），
 * 直接渲染会让"章节语义分割"失去可信度。这里用纯函数一次性根除，**不重切章节**：
 *
 * 1. 过滤：text 非空、startMs 有限非负；
 * 2. **越界回落**（必须在排序之前）：startMs 落在 [sectionStartMs, sectionEndMs] 之外 →
 *    回落到章节起点并标 `approximate: true`（与 snapBullets 语义一致，红线 2）；
 * 3. 稳定排序：按 startMs 升序（同刻保持原相对顺序）；
 * 4. **滑动窗近重复去重**（SPEC-19）：与前一条时间差 ≤ `NEAR_DUP_WINDOW_MS` 且
 *    文本重叠度 ≥ `NEAR_DUP_OVERLAP` → 视为同一条要点的两种措辞，保留较长的一条。
 *    覆盖两种重复：同 ts 语义重复（措辞差异大）与跨秒近重复（分块边界拼接）。
 *
 * 幂等：对已归一的输入再跑一遍结果不变。
 */
export function normalizeBullets(
  bullets: readonly SectionBullet[],
  sectionStartMs: number,
  sectionEndMs: number,
): SectionBullet[] {
  // ① 过滤非法 + ② 越界回落（**必须在排序之前**：回落后 startMs 变为章节起点，
  //    若放在排序后会让回落条目留在末尾，形成新的乱序——2026-10-22 真机核验发现）
  const clamped: SectionBullet[] = [];
  for (const b of bullets) {
    if (!b || typeof b.text !== 'string' || b.text.trim().length === 0) continue;
    if (!Number.isFinite(b.startMs) || b.startMs < 0) continue;
    if (b.startMs < sectionStartMs || b.startMs > sectionEndMs) {
      clamped.push({ text: b.text, startMs: sectionStartMs, approximate: true });
    } else {
      clamped.push(b);
    }
  }
  // ③ 稳定排序
  const sorted = [...clamped].sort((a, b) => a.startMs - b.startMs);

  // ④ 滑动窗近重复去重：与已保留序列的最后一条比对，**两类**才合并（都必须时间相邻）：
  //    A. 包含关系——短句规范化后是长句子串（分块拼接把一句拆两条的主形态）；
  //    B. 强改写——字符二元组 Dice ≥ 0.6（`…是单一变量原则` vs `…就是单一变量原则`）。
  //    **不能**只用字符集重叠：中文并列概念句（加强论据/加强论点）重叠 0.83 虚高，会误吞。
  const kept: SectionBullet[] = [];
  for (const b of sorted) {
    const prev = kept[kept.length - 1];
    if (
      prev &&
      Math.abs(b.startMs - prev.startMs) <= NEAR_DUP_WINDOW_MS &&
      isNearDup(prev.text, b.text)
    ) {
      // 近重复：保留较长的一条（信息更全）
      if (b.text.trim().length > prev.text.trim().length) kept[kept.length - 1] = b;
      continue;
    }
    kept.push(b);
  }
  return kept;
}

/** 近重复判定窗口（毫秒）：时间相邻的条目才参与去重（避免误合并相隔较远的相似表述） */
const NEAR_DUP_WINDOW_MS = 5_000;

/** 近重复判定阈值（字符二元组 Dice；强改写路径） */
const NEAR_DUP_SIMILARITY = 0.6;

/** 规范化比较文本：去空白（包含判定对空格/换行不敏感） */
function normText(s: string): string {
  return s.replace(/\s+/g, '');
}

/**
 * 近重复判定（SPEC-19 N-4 修订）：
 * - **包含关系**：短句是长句子串 → 合并（分块拼接的重复主形态，直接 `includes` 判定最准）；
 * - **强改写**：字符二元组 Dice ≥ 0.6 → 合并（保序，措辞不同即错位）；
 * - 其余保留——尤其**并列概念句**（`加强论据是对论据加强` vs `加强论点是对论点支持`）：
 *   字符集重叠虽 0.83，但既非子串、二元组 Dice 仅 ≈0.44，不得合并。
 */
export function isNearDup(a: string, b: string): boolean {
  const na = normText(a);
  const nb = normText(b);
  if (na.length === 0 || nb.length === 0) return false;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.includes(short)) return true;
  return textSimilarity(a, b) >= NEAR_DUP_SIMILARITY;
}

/**
 * 文本相似度（近重复判据）：字符二元组（bigram）Dice 系数 = 2|A∩B| / (|A|+|B|)，
 * 多重集语义（重复出现的 bigram 按次数计入）。保序、对措辞敏感：
 * - 真近重复（`…是单一变量原则` vs `…就是单一变量原则`）→ ≈0.9，合并；
 * - 并列概念句（`加强论据是对论据加强` vs `加强论点是对论点支持`）→ ≈0.44，保留。
 */
export function textSimilarity(a: string, b: string): number {
  const ba = bigrams(a);
  const bb = bigrams(b);
  const total = ba.size + bb.size;
  if (total === 0) return 0;
  let inter = 0;
  const [small, large] = ba.size <= bb.size ? [ba, bb] : [bb, ba];
  for (const [g, n] of small) inter += Math.min(n, large.get(g) ?? 0);
  return (2 * inter) / total;
}

function bigrams(s: string): Map<string, number> {
  const flat = normText(s);
  const m = new Map<string, number>();
  for (let i = 0; i + 1 < flat.length; i += 1) {
    const g = flat.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  // 单字符退化：无 bigram 时用单字符集当一元组，避免短文本恒 0 相似
  if (m.size === 0 && flat.length > 0) {
    for (const ch of flat) m.set(ch, (m.get(ch) ?? 0) + 1);
  }
  return m;
}

/**
 * 文本重叠度（SPEC-18）：字符集合交集 / 较小集合的大小。
 * 对"包含关系"敏感（长句涵盖短句），适合判 containment；**不适合**做同窗近重复判据
 * （中文常用字共享会让并列概念句虚高，见 `textSimilarity` 注释）。
 */
export function textOverlap(a: string, b: string): number {
  const sa = new Set(a.replace(/\s+/g, ''));
  const sb = new Set(b.replace(/\s+/g, ''));
  const minSize = Math.min(sa.size, sb.size);
  if (minSize === 0) return 0;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter += 1;
  return inter / minSize;
}

/**
 * 全局校正：排序 → 剔除重叠（同 startMs 只保留先确认者）→ 首章回补到第一条 Cue（补齐覆盖）
 * → 最短章节强制（末尾后处理，末章时长按末条 Cue.endMs）→ endMs 链（下一章 startMs - 1，
 * 末章 = 末条 Cue.endMs）→ cueRange → bullets 归一（SPEC-18）→ 重编 id → 覆盖校验 →
 * 密度打分（返回完整 Section[]）。
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
      // SPEC-18：bullets 确定性归一（排序/去重/越界回落），章节区间此时已知
      bullets: normalizeBullets(sec.bullets, sec.startMs, endMs),
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
