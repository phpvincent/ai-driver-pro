/**
 * 时间吸附（TECH-DESIGN §5.1 步骤 5，红线 2；SPEC-03 3c 扩展 bullets 吸附）：
 * - 候选章节 startSec*1000 吸附到最近的 Cue.startMs；偏差 > snapMaxDriftMs 视为幻觉，
 *   丢弃该候选章节并计数；
 * - bullets 逐条吸附：bullet.startSec*1000 吸附最近 Cue.startMs，偏差 ≤ maxDriftMs →
 *   精确吸附（approximate 缺省）；偏差 > maxDriftMs → 回落为该候选章节吸附后的 startMs
 *   并标 approximate: true。
 */
import { OUTLINE } from '../../config';
import type { Cue, SectionBullet } from '../../types';
import type { SectionCandidate } from './types';

/** 吸附后的候选章节（startMs 已替换为吸附后的 Cue.startMs，bullets 带吸附后时间） */
export interface SnappedSection {
  title: string;
  startMs: number;
  summary: string;
  bullets: SectionBullet[];
  terms: string[];
  /** 1-5，模型给出的章节重要性（原样透传） */
  importance: number;
}

export interface SnapResult {
  kept: SnappedSection[];
  /** 因偏差超阈值被丢弃的候选数（幻觉路径） */
  dropped: number;
}

/** 最近 Cue 开始时间；starts 为空返回 null（线性扫描，输入无需有序） */
export function nearestCueStartMs(starts: number[], targetMs: number): number | null {
  let best: number | null = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const s of starts) {
    const diff = Math.abs(targetMs - s);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = s;
    }
  }
  return best;
}

/**
 * bullets 逐条吸附（4.3 规则，regenerate 复用）：
 * 偏差 ≤ maxDriftMs → 精确吸附最近 Cue.startMs；否则回落 sectionStartMs + approximate。
 */
export function snapBullets(
  bullets: Array<{ text: string; startSec: number }>,
  sectionStartMs: number,
  cueStarts: number[],
  maxDriftMs: number,
): SectionBullet[] {
  return bullets.map((b) => {
    const target = b.startSec * 1000;
    const nearest = nearestCueStartMs(cueStarts, target);
    if (nearest !== null && Math.abs(nearest - target) <= maxDriftMs) {
      return { text: b.text, startMs: nearest };
    }
    // >5s：回落为章节吸附后的 startMs，标 approximate（红线 2：不使用幻觉时间戳）
    return { text: b.text, startMs: sectionStartMs, approximate: true };
  });
}

export function snapCandidates(
  candidates: SectionCandidate[],
  cues: Cue[],
  maxDriftMs: number = OUTLINE.snapMaxDriftMs,
): SnapResult {
  // Cue 理论上按时间升序；排序副本保证纯函数在乱序输入下行为确定（红线 1）
  const starts = cues.map((c) => c.startMs).sort((a, b) => a - b);
  const kept: SnappedSection[] = [];
  let dropped = 0;

  for (const cand of candidates) {
    const target = cand.startSec * 1000;
    const best = nearestCueStartMs(starts, target);
    if (best === null || Math.abs(best - target) > maxDriftMs) {
      dropped += 1; // 红线 2：距任何 Cue.startMs 都超阈值 → 幻觉，丢弃
      continue;
    }
    kept.push({
      title: cand.title,
      startMs: best,
      summary: cand.summary,
      bullets: snapBullets(cand.bullets, best, starts, maxDriftMs),
      terms: cand.terms,
      importance: cand.importance,
    });
  }
  return { kept, dropped };
}
