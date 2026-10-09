/**
 * SPEC-07 使用统计埋点（子任务 7.1）。
 *
 * 全部数据只落本机 IndexedDB（SPEC-07 §1 明确不做远程上报）。埋点层只提供
 * 纯函数：输入（旧记录 + 事件 + 注入时钟）→ 新记录，不改原对象（红线 1
 * 确定性：同一输入恒定同一输出，不读全局 Date.now、不产生随机数）。
 *
 * 上层（父 agent 接线）负责在跳播 / 字幕瀑布成功 / 大纲生成 / 概念图生成
 * 处调用 applyUsageEvent 并经 storage/db 的 saveUsage 落库。
 */

/** 埋点事件种类：与 UsageRecord 的四个计数器/布尔位一一对应 */
export type UsageEventKind = 'seek' | 'subtitle' | 'outline' | 'conceptMap' | 'vision' | 'save';

export interface VisionEventMeta {
  /** 本次送出的帧数 */
  frames: number;
  /** 本次是否为模型规划成功（否则为公式回退） */
  byModel: boolean;
  /** 模型自报覆盖率 0~1（无自检时缺省） */
  coverage?: number;
}

export interface UsageEvent {
  kind: UsageEventKind;
  /** kind='vision' 时的诊断数据 */
  vision?: VisionEventMeta;
}

/** 回顾问卷单选答案（SPEC-07 7.2 / SPEC-08 8.8：入库持久化） */
export type SubjectiveChoice = 'fewer' | 'same' | 'more';

export interface UsageRecord {
  videoId: string;
  /** 大纲/导图/字幕的跳转（seek）次数 */
  seeks: number;
  /** 存入 Obsidian 的次数（SPEC-07 §1 要求统计，SPEC-08 8.8 补齐） */
  saves?: number;
  /** 回顾问卷答案（每视频一份，最后一次为准；未答缺省） */
  subjective?: SubjectiveChoice;
  /** 是否成功加载字幕（瀑布 ok/manual_pasted） */
  subtitleLoaded: boolean;
  /** 是否生成过大纲 */
  outlineGenerated: boolean;
  /** 是否生成过概念图 */
  conceptMapGenerated: boolean;
  /**
   * 抽帧诊断累计（验证"结构推断"命中率）：
   * frames=累计送出帧数，modelPlans=模型规划成功次数，
   * coverageSum/coverageCount 用于算平均覆盖率。
   */
  vision?: { frames: number; modelPlans: number; coverageSum: number; coverageCount: number };
  /** 首次/最近使用时间 ISO */
  firstUsedAt: string;
  lastUsedAt: string;
}

/** 空记录：四个计数位归零，首末次时间同为注入时钟 */
export function createEmptyUsage(videoId: string, now: () => number): UsageRecord {
  const at = new Date(now()).toISOString();
  return {
    videoId,
    seeks: 0,
    saves: 0,
    subtitleLoaded: false,
    outlineGenerated: false,
    conceptMapGenerated: false,
    firstUsedAt: at,
    lastUsedAt: at,
  };
}

/**
 * 合并一次事件，返回新记录（原对象不被修改）。
 * lastUsedAt 每次事件都刷新；firstUsedAt 仅在已有值为空时补齐（兼容旧数据）。
 */
export function applyUsageEvent(
  rec: UsageRecord,
  event: UsageEvent,
  now: () => number,
): UsageRecord {
  const at = new Date(now()).toISOString();
  const base: UsageRecord = {
    ...rec,
    firstUsedAt: rec.firstUsedAt || at,
    lastUsedAt: at,
  };
  switch (event.kind) {
    case 'seek':
      return { ...base, seeks: rec.seeks + 1 };
    case 'save':
      return { ...base, saves: (rec.saves ?? 0) + 1 };
    case 'subtitle':
      return { ...base, subtitleLoaded: true };
    case 'outline':
      return { ...base, outlineGenerated: true };
    case 'conceptMap':
      return { ...base, conceptMapGenerated: true };
    case 'vision': {
      const v = event.vision ?? { frames: 0, byModel: false };
      const prev = rec.vision ?? { frames: 0, modelPlans: 0, coverageSum: 0, coverageCount: 0 };
      return {
        ...base,
        vision: {
          frames: prev.frames + Math.max(0, v.frames),
          modelPlans: prev.modelPlans + (v.byModel ? 1 : 0),
          coverageSum: prev.coverageSum + (typeof v.coverage === 'number' ? v.coverage : 0),
          coverageCount: prev.coverageCount + (typeof v.coverage === 'number' ? 1 : 0),
        },
      };
    }
    default:
      return base;
  }
}

/**
 * 写入回顾问卷答案（每视频一份，重复作答以最后一次为准）。
 * 纯函数：不改原对象。
 */
export function applySubjective(
  rec: UsageRecord,
  choice: SubjectiveChoice,
  now: () => number,
): UsageRecord {
  const at = new Date(now()).toISOString();
  return { ...rec, subjective: choice, firstUsedAt: rec.firstUsedAt || at, lastUsedAt: at };
}
