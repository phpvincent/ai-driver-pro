/**
 * 帧预算自适应单测：验证"10 分钟密集视频"这类场景能拿到足够多的帧。
 *
 * 回归背景：早期用固定预算（导图 4 帧），10 分钟知识密集视频只有几张图，
 * 模型基本只能靠字幕猜，概念图输出明显偏薄。
 */
import { describe, expect, it } from 'vitest';
import { FRAME_PLAN } from '../../../src/config';
import {
  frameBudgetFor,
  isDenseSections,
  cueWindows,
} from '../../../src/core/vision/framePlanner';
import type { Section } from '../../../src/types';

const MIN = 60_000;

function section(startMs: number, terms: string[]): Section {
  return {
    id: `s-${startMs}`,
    title: '章节',
    startMs,
    endMs: startMs + 60_000,
    summary: '摘要',
    bullets: [],
    terms,
    importance: 3,
    density: 'mid',
    cueRange: [0, 1],
  };
}

describe('frameBudgetFor（随时长增长 · 分段递减 · 章节兜底）', () => {
  const HARD = FRAME_PLAN.mindmap.hardMax;

  it('导图帧数随时长单调增长：10 / 30 / 60 分钟', () => {
    expect(frameBudgetFor('mindmap', 10 * MIN)).toBe(14); // 600/45
    expect(frameBudgetFor('mindmap', 30 * MIN)).toBe(27); // 600/45 + 1200/90 = 13.3 + 13.3 → 27
    expect(frameBudgetFor('mindmap', 60 * MIN)).toBe(47); // 14 + 33 = 47（护栏 48 内不再夹断）
    const series = [5, 10, 20, 30, 45, 60, 120].map((m) => frameBudgetFor('mindmap', m * MIN));
    for (let i = 1; i < series.length; i++) expect(series[i]).toBeGreaterThanOrEqual(series[i - 1]!);
  });

  it('回归：长视频不再被卡在 16 帧（用户：很长的视频理应获得很多帧）', () => {
    expect(frameBudgetFor('mindmap', 30 * MIN)).toBeGreaterThan(16);
    expect(frameBudgetFor('mindmap', 45 * MIN)).toBeGreaterThan(30);
  });

  it('知识密集加成：10 分钟密集 = 20 帧，30 分钟密集接近上限（护栏 48）', () => {
    expect(frameBudgetFor('mindmap', 10 * MIN, true)).toBe(20);
    expect(frameBudgetFor('mindmap', 30 * MIN, true)).toBe(40); // 20 + 20（护栏内不打满）
    for (const module of ['outline', 'mindmap', 'qa'] as const) {
      expect(frameBudgetFor(module, 12 * MIN, true)).toBeGreaterThanOrEqual(frameBudgetFor(module, 12 * MIN));
    }
  });

  it('章节兜底：章节多时每章至少首尾两帧（按时长只算 7 帧的 5 分钟视频，8 章 → 16 帧）', () => {
    expect(frameBudgetFor('mindmap', 5 * MIN)).toBe(7);
    expect(frameBudgetFor('mindmap', 5 * MIN, false, 8)).toBe(16);
    // 章节兜底同样受硬上限约束
    expect(frameBudgetFor('mindmap', 5 * MIN, false, 100)).toBe(HARD);
  });

  it('下限保护与非法时长', () => {
    expect(frameBudgetFor('mindmap', 30_000)).toBe(FRAME_PLAN.mindmap.min);
    expect(frameBudgetFor('qa', 5_000)).toBe(FRAME_PLAN.qa.min);
    for (const bad of [0, Number.NaN, -1000]) expect(frameBudgetFor('mindmap', bad)).toBe(FRAME_PLAN.mindmap.min);
  });

  it('超长视频：只受硬上限（成本护栏）约束', () => {
    expect(frameBudgetFor('mindmap', 180 * MIN)).toBe(HARD);
    expect(frameBudgetFor('outline', 180 * MIN)).toBe(FRAME_PLAN.outline.hardMax);
  });
});

describe('长视频的下游链路不会再次吞帧', () => {
  it('抽帧规划 Schema 容得下硬上限帧数', async () => {
    const { FramePlanSchema } = await import('../../../src/core/vision/llmFramePlan');
    const many = { targets: Array.from({ length: FRAME_PLAN.mindmap.hardMax }, (_, i) => ({ tSec: i * 60 })) };
    expect(FramePlanSchema.safeParse(many).success).toBe(true);
  });

  it('规划输出被截断时仍能解析出已完整的帧', async () => {
    const { validateFramePlan } = await import('../../../src/core/vision/llmFramePlan');
    const cues = Array.from({ length: 100 }, (_, i) => ({ index: i, startMs: i * 30_000, endMs: i * 30_000 + 29_000, text: `句${i}` }));
    const truncated = '{"targets":[{"tSec":0},{"tSec":60},{"tSec":120},{"tSec":180,"cov';
    const out = validateFramePlan(truncated, { sections: [], cues, durationMs: 3_000_000, budget: 40, minGapMs: 15_000 });
    expect(out.targets).toEqual([0, 60_000, 120_000]);
  });
});

describe('isDenseSections（知识密度判定）', () => {
  it('术语密度 ≥3 个/分钟 → 密集', () => {
    // 10 分钟、30 个术语 → 3 个/分钟
    const sections = Array.from({ length: 10 }, (_, i) =>
      section(i * MIN, ['a', 'b', 'c']),
    );
    expect(isDenseSections(sections, 10 * MIN)).toBe(true);
  });

  it('术语稀疏 → 非密集', () => {
    const sections = Array.from({ length: 10 }, (_, i) => section(i * MIN, ['a']));
    expect(isDenseSections(sections, 10 * MIN)).toBe(false);
  });

  it('无术语数据时按章节时间密度兜底（≥0.5 章/分钟）', () => {
    const many = Array.from({ length: 10 }, (_, i) => section(i * MIN, []));
    expect(isDenseSections(many, 10 * MIN)).toBe(true); // 1 章/分钟
    const few = Array.from({ length: 2 }, (_, i) => section(i * 5 * MIN, []));
    expect(isDenseSections(few, 10 * MIN)).toBe(false); // 0.2 章/分钟
  });

  it('无章节 → 非密集（大纲阶段走非密集口径）', () => {
    expect(isDenseSections([], 10 * MIN)).toBe(false);
  });
});

describe('候选窗口密度（预算要能选得出来）', () => {
  it('10 分钟视频的窗口数 ≥ 导图预算（否则预算再高也选不出）', () => {
    const durationMs = 10 * MIN;
    const cues = Array.from({ length: 60 }, (_, i) => ({
      index: i,
      startMs: i * 10_000,
      endMs: i * 10_000 + 9_000,
      text: `第 ${i} 句`,
    }));
    // framesClient 的口径：max(30s, durationMs/24)
    const windows = cueWindows(cues, Math.max(30_000, Math.ceil(durationMs / 24)));
    expect(windows.length).toBeGreaterThanOrEqual(frameBudgetFor('mindmap', durationMs, true));
  });
});
