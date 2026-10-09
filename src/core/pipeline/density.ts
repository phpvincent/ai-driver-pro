/**
 * 章节信息密度打分（TECH-DESIGN §4.3；SPEC-03 3c 范围变更：0-100 打分制）。
 * 纯确定性计算（红线 1）：模型只提供 terms 与 importance，score 与 density 分档
 * 完全由代码推导，无模型调用、无随机源、无时间依赖。
 *
 * score = round(100 * (0.45*newTermRateNorm + 0.25*termRateNorm + 0.3*importanceNorm))
 * - newTermRate：每分钟新术语（与既有逻辑一致，跨章去重、分钟数下限 0.1），全片 min-max 归一；
 * - termRate：术语总数/分钟（章内归一化去重），全片 min-max 归一；
 * - importance：(importance-1)/4，天然 0-1，不再归一；
 * - 零跨度（max==min）分量取 0.5。
 * 退化：单章 / 全零（无任何术语且 importance 全同，无区分信号）→ score 50（中位）。
 */
import type { Density, Section } from '../../types';

/** score 分档阈值：≥70 high，≤30 low，否则 mid */
export const DENSITY_HIGH_SCORE = 70;
export const DENSITY_LOW_SCORE = 30;

/** score 综合权重（SPEC-03 3c：新知识率 45% + 术语密度 25% + importance 30%） */
const WEIGHTS = { newTermRate: 0.45, termRate: 0.25, importance: 0.3 } as const;

/** 术语归一化：trim + 小写（大小写/首尾空白不敏感去重） */
function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

/** 章节分钟数：(endMs-startMs)/60000；< 0.1 按 0.1 计（短章防除零放大） */
function minutesOf(s: { startMs: number; endMs: number }): number {
  return Math.max((s.endMs - s.startMs) / 60_000, 0.1);
}

/** min-max 归一：零跨度（max==min）时全取 0.5（无区分信号 → 中位） */
function minMaxNorm(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * 对全片章节计算 0-100 综合分数（顺序与输入一一对应）。
 * 退化：空输入 → []；单章 / 无任何术语且 importance 全同 → [50...]（中位，无区分信号）。
 */
export function computeScores(sections: Array<Omit<Section, 'density'>>): number[] {
  const n = sections.length;
  if (n === 0) return [];

  // 按章节顺序统计每章新术语数/术语总数，维护已见术语集合（跨章去重）
  const seen = new Set<string>();
  const newRates: number[] = [];
  const termRates: number[] = [];
  const importances: number[] = [];
  for (const s of sections) {
    const uniqInSec: string[] = [];
    const seenInSec = new Set<string>();
    for (const term of s.terms) {
      const key = normalizeTerm(term);
      if (seenInSec.has(key)) continue;
      seenInSec.add(key);
      uniqInSec.push(key);
    }
    let newTerms = 0;
    for (const key of uniqInSec) {
      if (!seen.has(key)) {
        newTerms += 1;
        seen.add(key);
      }
    }
    const mins = minutesOf(s);
    newRates.push(newTerms / mins);
    termRates.push(uniqInSec.length / mins);
    importances.push(s.importance);
  }

  // 退化：单章 / 全零（无任何术语且 importance 全同）→ 全 50
  const allZeroTerms =
    newRates.every((r) => r === 0) && termRates.every((r) => r === 0);
  if (n === 1 || (allZeroTerms && importances.every((i) => i === importances[0]))) {
    return sections.map(() => 50);
  }

  const newNorm = minMaxNorm(newRates);
  const termNorm = minMaxNorm(termRates);
  return sections.map(
    (_, i) =>
      Math.round(
        100 *
          (WEIGHTS.newTermRate * newNorm[i] +
            WEIGHTS.termRate * termNorm[i] +
            WEIGHTS.importance * ((importances[i] - 1) / 4)),
      ),
  );
}

/** score → density 分档：≥70 high，≤30 low，否则 mid */
export function densityFromScore(score: number): Density {
  if (score >= DENSITY_HIGH_SCORE) return 'high';
  if (score <= DENSITY_LOW_SCORE) return 'low';
  return 'mid';
}

/** computeScores + 按分数分档，返回补全 score 与 density 的完整 Section[]（原字段浅拷贝不变） */
export function attachDensity(sections: Array<Omit<Section, 'density'>>): Section[] {
  const scores = computeScores(sections);
  return sections.map((s, i) => ({
    ...s,
    score: scores[i],
    density: densityFromScore(scores[i]),
  }));
}
