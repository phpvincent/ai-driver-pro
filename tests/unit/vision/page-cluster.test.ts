/**
 * 页聚类精修单测（SPEC-11 A1~A4）：全部纯函数，无浏览器依赖。
 */
import { describe, expect, it } from 'vitest';
import type { ScannedSample } from '../../../src/messages';
import {
  buildScanTargets,
  clusterPages,
  refineTargets,
  sharpnessFromGray,
} from '../../../src/core/vision/pageCluster';

// ---------------------------------------------------------------------------
// A1 buildScanTargets
// ---------------------------------------------------------------------------

describe('buildScanTargets（扫描点生成，SPEC-11 A1）', () => {
  it('单目标 ±6s 步长 2s → 7 个点（-6,-4,-2,0,+2,+4,+6），升序去负', () => {
    const pts = buildScanTargets([10_000], { windowMs: 6_000, stepMs: 2_000, maxSamples: 100 });
    expect(pts).toEqual([4_000, 6_000, 8_000, 10_000, 12_000, 14_000, 16_000]);
  });

  it('目标过近时窗口重叠自动去重', () => {
    const pts = buildScanTargets([10_000, 11_000], { windowMs: 4_000, stepMs: 2_000, maxSamples: 100 });
    expect(new Set(pts).size).toBe(pts.length);
    // 10s 的 +2 与 11s 的 +1… 步长对齐后无重复
    expect(pts).toContain(10_000);
    expect(pts).toContain(11_000);
  });

  it('目标在窗口边缘（<window）时负侧点截到 0', () => {
    const pts = buildScanTargets([3_000], { windowMs: 6_000, stepMs: 2_000, maxSamples: 100 });
    expect(pts[0]).toBeGreaterThanOrEqual(0);
    expect(pts.every((p) => p >= 0)).toBe(true);
  });

  it('超 maxSamples 均匀抽稀：恒含首尾且不超上限', () => {
    const targets = Array.from({ length: 40 }, (_, i) => i * 30_000);
    const all = buildScanTargets(targets, { windowMs: 6_000, stepMs: 2_000, maxSamples: 1e6 });
    const capped = buildScanTargets(targets, { windowMs: 6_000, stepMs: 2_000, maxSamples: 50 });
    expect(all.length).toBeGreaterThan(50);
    expect(capped).toHaveLength(50);
    expect(capped[0]).toBe(all[0]);
    expect(capped[capped.length - 1]).toBe(all[all.length - 1]);
  });

  it('空目标 / 非法目标（负数、NaN）→ 空', () => {
    expect(buildScanTargets([], { windowMs: 1, stepMs: 1, maxSamples: 10 })).toEqual([]);
    expect(buildScanTargets([-1, NaN], { windowMs: 1, stepMs: 1, maxSamples: 10 })).toEqual([]);
  });

  it('非法参数（window/step/max ≤ 0）→ 空', () => {
    expect(buildScanTargets([1000], { windowMs: 0, stepMs: 1000, maxSamples: 10 })).toEqual([]);
    expect(buildScanTargets([1000], { windowMs: 1000, stepMs: 0, maxSamples: 10 })).toEqual([]);
    expect(buildScanTargets([1000], { windowMs: 1000, stepMs: 1000, maxSamples: 0 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A3 sharpnessFromGray
// ---------------------------------------------------------------------------

describe('sharpnessFromGray（拉普拉斯方差，SPEC-11 A3）', () => {
  it('常量图（纯色）→ 0', () => {
    const gray = new Array(32 * 18).fill(128);
    expect(sharpnessFromGray(gray, 32, 18)).toBe(0);
  });

  it('锐利边缘图 > 平滑渐变图（模糊近似）', () => {
    // 锐利：左半黑右半白（强边缘）
    const sharp: number[] = [];
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 32; x++) sharp.push(x < 16 ? 0 : 255);
    }
    // 模糊：横向渐变
    const blur: number[] = [];
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 32; x++) blur.push(Math.round((x / 31) * 255));
    }
    expect(sharpnessFromGray(sharp, 32, 18)).toBeGreaterThan(sharpnessFromGray(blur, 32, 18));
    expect(sharpnessFromGray(blur, 32, 18)).toBeGreaterThan(0);
  });

  it('尺寸 < 3×3 或长度不符 → 0（视为未知）', () => {
    expect(sharpnessFromGray([1, 2, 3, 4], 2, 2)).toBe(0);
    expect(sharpnessFromGray(new Array(10), 32, 18)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A2 clusterPages
// ---------------------------------------------------------------------------

/** 相同样本工厂：同一 dHash 串 = 同一页 */
const s = (tMs: number, dhash: string, sharpness = 0): ScannedSample => ({ tMs, dhash, sharpness });
const A = '0000000000000000';
const B = 'ffffffffffffffff';

describe('clusterPages（顺序 dHash 聚类，SPEC-11 A2）', () => {
  it('相邻距离 ≤ 阈值归同一页；换页切出新页', () => {
    const pages = clusterPages(
      [s(0, A), s(2000, A), s(4000, A), s(6000, B), s(8000, B)],
      5,
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]!.samples).toHaveLength(3);
    expect(pages[1]!.samples).toHaveLength(2);
    expect(pages[1]!.boundaryIndex).toBe(3);
  });

  it('隔页回到相同画面不合并（时序聚类，非全对全）', () => {
    const pages = clusterPages(
      [s(0, A), s(2000, A), s(4000, B), s(6000, B), s(8000, A)],
      5,
    );
    expect(pages).toHaveLength(3);
    expect(pages[2]!.samples[0]!.tMs).toBe(8000);
  });

  it('空 dhash 样本自成单例页', () => {
    const pages = clusterPages([s(0, A), s(2000, ''), s(4000, A)], 5);
    expect(pages).toHaveLength(3);
  });

  it('空输入 → 空数组', () => {
    expect(clusterPages([], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A4 refineTargets
// ---------------------------------------------------------------------------

describe('refineTargets（簇内清晰度选帧，SPEC-11 A4）', () => {
  it('目标页内选清晰度最高的样本时刻（翻页中段 → 停稳帧）', () => {
    // 时间轴：0~4000 是旧页（A），6000~10000 是新页（B，清晰度在 8000 最高）
    const samples = [
      s(0, A, 10), s(2000, A, 12), s(4000, A, 8),
      s(6000, B, 5), s(8000, B, 40), s(10_000, B, 20),
    ];
    // 目标 6000（新页开头，可能正翻页中）：窗口内最近样本在 B 页 → 选页内最清晰的 8000
    const [refined] = refineTargets(samples, [6_000], { windowMs: 6_000, maxDistance: 5 });
    expect(refined).toBe(8_000);
  });

  it('窗口内无样本 → 保持原目标（降级）', () => {
    const [kept] = refineTargets([s(100_000, A, 99)], [5_000], { windowMs: 6_000, maxDistance: 5 });
    expect(kept).toBe(5_000);
  });

  it('页内全部清晰度为 0 → 保持原目标（不瞎选）', () => {
    const samples = [s(0, A), s(2000, A), s(4000, A)];
    const [kept] = refineTargets(samples, [2_000], { windowMs: 6_000, maxDistance: 5 });
    expect(kept).toBe(2_000);
  });

  it('空样本 → 恒等返回', () => {
    expect(refineTargets([], [1_000, 2_000], { windowMs: 6_000, maxDistance: 5 })).toEqual([1_000, 2_000]);
  });

  it('多目标互不干扰（各自在各自窗口选优）', () => {
    const samples = [
      s(0, A, 50), s(2000, A, 10), // 页1：0 最清晰
      s(10_000, B, 5), s(12_000, B, 60), // 页2：12000 最清晰
    ];
    const refined = refineTargets(samples, [1_000, 11_000], { windowMs: 6_000, maxDistance: 5 });
    expect(refined).toEqual([0, 12_000]);
  });

  it('清晰度并列取最早（确定性）', () => {
    const samples = [s(0, A, 30), s(2000, A, 30), s(4000, A, 30)];
    const [refined] = refineTargets(samples, [2_000], { windowMs: 6_000, maxDistance: 5 });
    expect(refined).toBe(0);
  });
});
