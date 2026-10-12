/**
 * 页聚类精修（SPEC-11）：本地稠密扫描 + dHash 页聚类 + 簇内清晰度选帧。
 *
 * 设计约束（宪法红线）：
 * - 红线 1：本文件全部纯函数，确定性——聚类与精修不调用模型、无随机
 * - 红线 3：不产生任何模型 token（扫描只算哈希与清晰度，不发图）
 * - 红线 10：content 层只消费本文件的纯函数（不含 chrome.*）
 *
 * 动机：现有"先规划后采集"的两个盲区——取帧点可能落在 PPT 翻页动画中间
 * （运动模糊帧）；代码演示类视频"画面换了字幕没提"。大厂用镜头边界检测 +
 * 清晰度评分解决（GPU 服务端），此处为浏览器约束内的轻量等价：
 * **本地采集免费、token 才贵**——把"选帧"从付费侧挪到免费侧。
 */
import type { ScannedSample } from '../../messages';
import { hammingDistance } from './dhash';

// ---------------------------------------------------------------------------
// 扫描点生成
// ---------------------------------------------------------------------------

export interface ScanTargetOptions {
  /** 每个目标两侧的扫描半径（毫秒） */
  windowMs: number;
  /** 扫描步长（毫秒） */
  stepMs: number;
  /** 采样点总量上限（去重后） */
  maxSamples: number;
}

/**
 * 每个规划目标 ±window 的采样点（纯函数，确定性）：
 * 步长覆盖窗口、去重（间距 < 步长视为同点）、升序、封顶 maxSamples
 * （超限时均匀抽稀——保留首尾、等距抽取，保证时间轴覆盖不塌缩到前段）。
 */
export function buildScanTargets(targetsMs: readonly number[], opts: ScanTargetOptions): number[] {
  const { windowMs, stepMs, maxSamples } = opts;
  if (targetsMs.length === 0 || windowMs <= 0 || stepMs <= 0 || maxSamples <= 0) return [];
  const set = new Set<number>();
  for (const t of targetsMs) {
    if (!Number.isFinite(t) || t < 0) continue;
    for (let offset = -windowMs; offset <= windowMs; offset += stepMs) {
      const ms = Math.round(t + offset);
      if (ms >= 0) set.add(ms);
    }
  }
  const sorted = [...set].sort((a, b) => a - b);
  if (sorted.length <= maxSamples) return sorted;
  // 均匀抽稀：等距下标，恒含首尾
  const step = (sorted.length - 1) / (maxSamples - 1);
  const picked = new Set<number>();
  for (let i = 0; i < maxSamples; i++) {
    picked.add(sorted[Math.round(i * step)]!);
  }
  return [...picked].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// 清晰度（拉普拉斯方差）
// ---------------------------------------------------------------------------

/**
 * 拉普拉斯算子方差（纯函数）：灰度网格的能量度量，越高越清晰。
 * 常量图（纯色/严重运动模糊）→ 0；锐利边缘多 → 高分。
 * 非法输入（尺寸 < 3×3）返回 0（调用方视为"未知"，不参与选优）。
 */
export function sharpnessFromGray(gray: ArrayLike<number>, width: number, height: number): number {
  if (!gray || width < 3 || height < 3 || gray.length < width * height) return 0;
  // 拉普拉斯响应：L(y,x) = 4*g - 上 - 下 - 左 - 右
  const responses: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const lap =
        4 * gray[idx]! - gray[idx - 1]! - gray[idx + 1]! - gray[idx - width]! - gray[idx + width]!;
      responses.push(lap);
    }
  }
  if (responses.length === 0) return 0;
  const mean = responses.reduce((a, b) => a + b, 0) / responses.length;
  const variance = responses.reduce((a, b) => a + (b - mean) * (b - mean), 0) / responses.length;
  return variance;
}

// ---------------------------------------------------------------------------
// 页聚类
// ---------------------------------------------------------------------------

export interface PageCluster {
  /** 页的起止（首末样本时间） */
  startMs: number;
  endMs: number;
  /** 该页的全部样本（时间升序） */
  samples: ScannedSample[];
  /** 与上一页的分界样本下标（无上一页 = 0） */
  boundaryIndex: number;
}

/**
 * 顺序 dHash 聚类（纯函数，确定性）：**相邻**样本汉明距离 ≤ maxDistance 归同一页。
 * 只看相邻关系（不是全对全）——翻页是时序事件，隔页回到相同画面不应合并
 * （与 dedupeFrames 的"隔 3 分钟同一页也算重复"口径相反：那是去重，这是分段）。
 * dhash 为空串的样本自成单例页（不与任何邻接）。
 */
export function clusterPages(
  samples: readonly ScannedSample[],
  maxDistance: number,
): PageCluster[] {
  const pages: PageCluster[] = [];
  let current: PageCluster | null = null;
  samples.forEach((s, i) => {
    const prev = i > 0 ? samples[i - 1] : null;
    const samePage =
      current !== null &&
      prev !== null &&
      prev.dhash.length > 0 &&
      s.dhash.length > 0 &&
      hammingDistance(prev.dhash, s.dhash) <= maxDistance;
    if (samePage && current) {
      current.samples.push(s);
      current.endMs = s.tMs;
    } else {
      current = { startMs: s.tMs, endMs: s.tMs, samples: [s], boundaryIndex: i };
      pages.push(current);
    }
  });
  return pages;
}

// ---------------------------------------------------------------------------
// 目标精修
// ---------------------------------------------------------------------------

export interface RefineOptions {
  /** 目标邻域半径（毫秒）：只考虑落在此窗口内的样本 */
  windowMs: number;
  /** dHash 汉明距离 ≤ 此值视为同一页 */
  maxDistance: number;
}

/**
 * 精修规划目标（纯函数，确定性）：每个目标在 ±window 内找**最近的样本**，
 * 以它所在页为"目标页"，页内选清晰度最高的样本时刻替换原目标。
 *
 * 设计依据：翻页动画中段的帧与翻页后的稳定帧 dHash 距离大于阈值 → 被切进
 * 小页或边界页；稳定页样本多、清晰度高 → 天然选中"翻完页停稳"的时刻。
 * 降级：窗口内无样本 / 无有效 dHash / 全部清晰度为 0 → 保持原目标不变。
 * 精修结果可能与相邻目标过近——由调用方的 minGap 闸门兜底（本函数不重复管）。
 */
export function refineTargets(
  samples: readonly ScannedSample[],
  targetsMs: readonly number[],
  opts: RefineOptions,
): number[] {
  if (samples.length === 0 || targetsMs.length === 0) return [...targetsMs];
  const pages = clusterPages(samples, opts.maxDistance);
  // 页内最优样本（清晰度并列取最早——确定性）
  const bestOfPage = pages.map((p) => {
    let best = p.samples[0]!;
    for (const s of p.samples) {
      if (s.sharpness > best.sharpness) best = s;
    }
    return best;
  });
  const bestByPage = pages.map((p, i) => ({ page: p, best: bestOfPage[i]! }));

  return targetsMs.map((t) => {
    // 窗口内样本
    const inWindow = samples.filter((s) => Math.abs(s.tMs - t) <= opts.windowMs);
    if (inWindow.length === 0) return t;
    // 距目标最近的样本 → 它所在页即目标页
    let nearest = inWindow[0]!;
    for (const s of inWindow) {
      if (Math.abs(s.tMs - t) < Math.abs(nearest.tMs - t)) nearest = s;
    }
    const page = bestByPage.find(({ page: p }) => p.samples.includes(nearest));
    if (!page) return t;
    const { best } = page;
    if (best.sharpness <= 0) return t;
    return best.tMs;
  });
}
