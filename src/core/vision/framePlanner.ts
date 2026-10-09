/**
 * 结构感知抽帧规划（SPEC-05 范围变更）：用**现成数据**（章节重要性/密度分/术语、
 * 字幕文本中的画面提示词）给每段打「画面价值分」，按分数分配帧预算，
 * 避免均匀抽样"为了抽而抽"浪费 token。
 *
 * 设计约束（宪法红线）：
 * - 红线 1：全程确定性计算，不调用模型、无随机；同输入必得同输出
 * - 红线 3：帧数受预算约束（FRAME_PLAN，按时长与密度自适应），不因打分而膨胀
 * - 红线 9：无 URL / 密钥
 */
import { DENSITY, FRAME_DENSE_BOOST, FRAME_PLAN } from '../../config';
import type { Cue, Section } from '../../types';
import { hammingDistance } from './dhash';

/** 画面提示词：字幕里出现这些词，说明这段大概率有值得看的画面（代码/演示/界面/图示） */
export const VISUAL_HINTS: readonly string[] = [
  '代码',
  '函数',
  '参数',
  '报错',
  '示例',
  '演示',
  '界面',
  '页面',
  '屏幕',
  '这里',
  '看一下',
  '如圖',
  '如图',
  '图上',
  '图中',
  '表格',
  '流程',
  '架构',
  '结构',
  '配置',
  '命令',
  '终端',
  '输出',
  '结果',
  '安装',
  '运行',
];

/** 打分权重（合计 1.0），全部来自已有数据，零额外成本 */
const WEIGHTS = {
  /** 章节重要性 importance(1-5) 归一 */
  importance: 0.3,
  /** 信息密度 score(0-100) 归一 */
  density: 0.25,
  /** 术语数量（相对全片最多者） */
  terms: 0.2,
  /** 字幕中的画面提示词命中（相对全片最多者） */
  hints: 0.25,
} as const;

export interface FrameWindow {
  /** 窗口起点（毫秒） */
  startMs: number;
  /** 窗口终点（毫秒，开区间语义） */
  endMs: number;
  /** 该窗口建议取帧的时间点（毫秒） */
  targetMs: number;
  /** 画面价值分 0~100（确定性） */
  score: number;
  /** 打分依据（供调试/验证命中率，勿展示给模型） */
  reasons: string[];
}

export interface PlanOptions {
  /** 帧预算（最多取几个时间点） */
  budget: number;
  /** 两个取帧点之间的最小间隔（毫秒）：过近的帧大概率是同一页 PPT */
  minGapMs?: number;
  /** 低于此分数的窗口直接不取（避免为抽而抽） */
  minScore?: number;
}

/**
 * 帧预算（纯函数，确定性）：随时长分段递减增长 + 章节数兜底 + 密集加成，夹在 [min, hardMax]。
 *
 * @param module       模块（outline / mindmap / qa）
 * @param durationMs   待覆盖时长（大纲/导图 = 全片；问答 = 区间）
 * @param dense        知识密集（各段 secPerFrame ÷ FRAME_DENSE_BOOST）
 * @param sectionCount 章节数（导图每章至少 perSection 帧，保证首尾对照）
 *
 * 导图示例（非密集 / 密集）：10 分钟 14 / 20；30 分钟 27 / 40；60 分钟及以上 40。
 */
export function frameBudgetFor(
  module: FrameBudgetModule,
  durationMs: number,
  dense = false,
  sectionCount = 0,
): number {
  const rule = FRAME_PLAN[module];
  const seconds = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 0;
  const boost = dense ? FRAME_DENSE_BOOST : 1;
  let byTime = 0;
  let prev = 0;
  for (const tier of rule.tiers) {
    if (seconds <= prev) break;
    const span = Math.min(seconds, tier.uptoSec) - prev;
    byTime += (span * boost) / tier.secPerFrame;
    prev = tier.uptoSec;
  }
  const bySections = Math.max(0, Math.floor(sectionCount)) * rule.perSection;
  const raw = seconds > 0 ? Math.max(Math.ceil(byTime), bySections) : rule.min;
  return Math.max(rule.min, Math.min(rule.hardMax, raw));
}

/** frameBudgetFor 的模块参数 */
export type FrameBudgetModule = keyof typeof FRAME_PLAN;

/**
 * 知识密度判定（纯函数）：每章平均术语数换算成"每分钟术语数"，
 * 阈值复用 DENSITY.highNewTermsPerMin（与章节密度档位同口径）。
 * 无章节数据（大纲阶段）时按章节时间密度兜底：平均每分钟 ≥0.5 章视为密集。
 */
export function isDenseSections(sections: Section[], durationMs: number): boolean {
  if (!Array.isArray(sections) || sections.length === 0) return false;
  const minutes = Math.max(1, (Number.isFinite(durationMs) ? durationMs : 0) / 60_000);
  const terms = sections.reduce((n, s) => n + (s.terms?.length ?? 0), 0);
  const termsPerMinute = terms / minutes;
  if (terms > 0) return termsPerMinute >= DENSITY.highNewTermsPerMin;
  return sections.length / minutes >= 0.5;
}

/**
 * 统计文本区间内的画面提示词命中数（确定性、大小写不敏感）。
 */
export function countVisualHints(text: string): number {
  if (!text) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const hint of VISUAL_HINTS) {
    if (lower.includes(hint.toLowerCase())) hits += 1;
  }
  return hits;
}

/**
 * 给一组时间窗口打分并选出取帧点（纯函数，确定性）。
 *
 * @param windows 时间窗口（章节或分块），至少含 startMs/endMs
 * @param cues 全片字幕（用于寻找窗口内提示词命中的具体时刻）
 * @param sectionMeta 与 windows 一一对应的章节元数据（importance/score/terms）；
 *                    无章节时（大纲生成阶段）传 undefined，仅用字幕提示词与时长打分
 */
export function planFrameTargets(
  windows: Array<{ startMs: number; endMs: number }>,
  cues: Cue[],
  opts: PlanOptions,
  sectionMeta?: Array<{ importance?: number; score?: number; terms?: string[] }>,
): FrameWindow[] {
  const budget = Math.max(0, Math.floor(opts.budget));
  if (budget === 0 || windows.length === 0) return [];
  // 无字幕时不抽帧：没有可对照的上下文，画面单独送模型既费 token 又无从定位
  if (cues.length === 0) return [];

  // 1) 逐窗口打分（先算原始分量，再做全片归一，保证相对可比）
  const raw = windows.map((w, i) => {
    const inWindow = cues.filter((c) => c.startMs >= w.startMs && c.startMs < Math.max(w.endMs, w.startMs + 1));
    const text = inWindow.map((c) => c.text).join(' ');
    const hints = countVisualHints(text);
    const meta = sectionMeta?.[i];
    const importance = typeof meta?.importance === 'number' ? meta.importance : 3;
    const density = typeof meta?.score === 'number' ? meta.score : 50;
    const termCount = meta?.terms?.length ?? 0;
    return { window: w, inWindow, hints, importance, density, termCount };
  });

  const maxHints = Math.max(1, ...raw.map((r) => r.hints));
  const maxTerms = Math.max(1, ...raw.map((r) => r.termCount));
  const maxDuration = Math.max(1, ...raw.map((r) => Math.max(1, r.window.endMs - r.window.startMs)));

  const scored: FrameWindow[] = raw.map((r) => {
    const importanceNorm = clamp01((r.importance - 1) / 4);
    const densityNorm = clamp01(r.density / 100);
    const termsNorm = clamp01(r.termCount / maxTerms);
    const hintsNorm = clamp01(r.hints / maxHints);
    const score =
      100 *
      (WEIGHTS.importance * importanceNorm +
        WEIGHTS.density * densityNorm +
        WEIGHTS.terms * termsNorm +
        WEIGHTS.hints * hintsNorm);

    const reasons: string[] = [];
    if (r.hints > 0) reasons.push(`画面提示词×${r.hints}`);
    if (r.termCount > 0) reasons.push(`术语×${r.termCount}`);
    if (r.density >= 70) reasons.push('高密度');
    if (r.importance >= 4) reasons.push('高重要性');

    return {
      startMs: r.window.startMs,
      endMs: r.window.endMs,
      // 取帧点：优先落在提示词命中的第一条字幕（那里最可能有画面），否则窗口 25% 处
      targetMs: pickTargetMs(r.window, r.inWindow, r.hints > 0),
      score: Math.round(score * 10) / 10,
      reasons,
    };
  });

  // 2) 按分数降序取预算内的窗口；同分按时间升序（确定性）
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.startMs - b.startMs);
  const minScore = opts.minScore ?? 0;
  const picked: FrameWindow[] = [];
  const minGap = opts.minGapMs ?? 0;
  for (const w of ranked) {
    if (w.score < minScore) continue;
    if (picked.length >= budget) break;
    // 时间去重：与已选点过近的窗口跳过（同一页 PPT 不重复送）
    if (picked.some((p) => Math.abs(p.targetMs - w.targetMs) < minGap)) continue;
    picked.push(w);
  }

  // 3) 输出按时间升序（与视频顺序一致，便于 prompt 里描述时间点）
  return picked.sort((a, b) => a.targetMs - b.targetMs);
}

/** 章节 → 时间窗口（末章终点取最后一条字幕时间） */
export function sectionWindows(sections: Section[], cues: Cue[]): Array<{ startMs: number; endMs: number }> {
  const lastCueEnd = cues.length > 0 ? cues[cues.length - 1]!.endMs : 0;
  return sections.map((s, i) => {
    const next = sections[i + 1];
    const endMs = next ? Math.max(next.startMs, s.endMs || next.startMs) : Math.max(s.endMs || lastCueEnd, s.startMs + 1);
    return { startMs: s.startMs, endMs };
  });
}

/** 章节元数据（重要性/密度/术语）——与 planFrameTargets 的 sectionMeta 同序 */
export function sectionMetaOf(sections: Section[]): Array<{ importance?: number; score?: number; terms?: string[] }> {
  return sections.map((s) => ({ importance: s.importance, score: s.score, terms: s.terms }));
}

/** 按固定间距切出时间窗口（无章节时使用，如大纲生成阶段） */
export function cueWindows(cues: Cue[], windowMs: number): Array<{ startMs: number; endMs: number }> {
  if (cues.length === 0 || windowMs <= 0) return [];
  const first = cues[0]!.startMs;
  const last = cues[cues.length - 1]!.endMs;
  const windows: Array<{ startMs: number; endMs: number }> = [];
  for (let start = first; start < last; start += windowMs) {
    windows.push({ startMs: start, endMs: Math.min(start + windowMs, last) });
  }
  return windows;
}

/**
 * 命中率/有效性评估（确定性）：用于验证"结构推断"是否真的比均匀抽样更值。
 *
 * - coverage：选中的帧覆盖了百分之多少的高价值窗口（分数 ≥ minScore）
 * - redundancy：被去重规则剔除的候选占比（越高说明原方案浪费越多）
 * - avgScore：选中窗口的平均画面价值分
 */
export function evaluatePlan(
  all: FrameWindow[],
  picked: FrameWindow[],
  opts: { minScore?: number } = {},
): { coverage: number; redundancy: number; avgScore: number; hitRate: number } {
  const minScore = opts.minScore ?? 0;
  const valuable = all.filter((w) => w.score >= minScore);
  const pickedSet = new Set(picked.map((w) => `${w.startMs}-${w.targetMs}`));
  const covered = valuable.filter((w) => pickedSet.has(`${w.startMs}-${w.targetMs}`)).length;
  const avgScore = picked.length > 0 ? picked.reduce((sum, w) => sum + w.score, 0) / picked.length : 0;
  return {
    coverage: valuable.length > 0 ? covered / valuable.length : 0,
    redundancy: all.length > 0 ? (all.length - picked.length) / all.length : 0,
    avgScore: Math.round(avgScore * 10) / 10,
    /** 命中率 = 选中的窗口里有打分依据（reasons 非空）的比例——衡量"抽在点子上" */
    hitRate: picked.length > 0 ? picked.filter((w) => w.reasons.length > 0).length / picked.length : 0,
  };
}

/**
 * 抽到的帧去重：时间过近或画面几乎未变（JPEG 体积差 < 阈值）的帧丢弃。
 * 纯函数、确定性——防止同一页 PPT 连抽多帧浪费 token。
 */
export function dedupeFrames<F extends { targetMs: number; actualMs: number; dataBase64: string; dhash?: string }>(
  frames: F[],
  opts: { minGapMs?: number; maxLengthDeltaRatio?: number; dhashMaxDistance?: number; minKeep?: number } = {},
): F[] {
  const minGap = opts.minGapMs ?? 0;
  const ratio = opts.maxLengthDeltaRatio ?? 0.02;
  const maxDist = opts.dhashMaxDistance ?? 5;
  // 保底：去重不允许把帧砍到规划数的一半以下。dHash 对"版式相同、内容不同"的
  // PPT 页（冒烟 3c：16 帧被砍到 1 帧）区分度不足——保多样性优先于省 token。
  const minKeep = Math.max(1, opts.minKeep ?? Number.POSITIVE_INFINITY);
  const kept: F[] = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.dataBase64.length === 0) continue;
    const dup = kept.some((k) => {
      // ① 双方都有 dHash：只看画面是否相同（与时间无关——隔了 3 分钟回到同一页 PPT 也算重复）
      if (k.dhash && f.dhash) return hammingDistance(k.dhash, f.dhash) <= maxDist;
      // ② 回退：时间过近且 base64 长度几乎相同（旧口径）
      return (
        Math.abs(k.actualMs - f.actualMs) < minGap &&
        Math.abs(k.dataBase64.length - f.dataBase64.length) / Math.max(1, k.dataBase64.length) < ratio
      );
    });
    // 保底：若把这条重复帧也丢掉、剩下的帧全去重也凑不满 minKeep，则保留它。
    // minKeep 未传（Infinity）时不启用保底——否则恒真，重复帧全被保留。
    if (dup) {
      if (minKeep < Number.POSITIVE_INFINITY) {
        const remainingAfter = frames.length - i - 1;
        if (kept.length + remainingAfter < minKeep) kept.push(f);
      }
      continue;
    }
    kept.push(f);
  }
  return kept;
}

function pickTargetMs(
  window: { startMs: number; endMs: number },
  inWindow: Cue[],
  hasHints: boolean,
): number {
  if (hasHints) {
    for (const cue of inWindow) {
      if (countVisualHints(cue.text) > 0) return cue.startMs;
    }
  }
  // 无提示词时取窗口 25% 处（避开转场与片头黑帧）
  return Math.round(window.startMs + (window.endMs - window.startMs) * 0.25);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
