/**
 * 预读大纲 pipeline 内部类型与 Schema（SPEC-03 子任务 3.2+3.3）。
 * 密度计算（density）属子任务 3.5，本模块不产出。
 */
import { z } from 'zod';
import type { ChunkState, Cue, Section } from '../../types';
import type { SnappedSection } from './snap';

/** 候选章节（模型单块输出，TECH-DESIGN §6.1；SPEC-03 3c：bullets 带 startSec、新增 importance） */
export const SectionCandidateSchema = z.object({
  title: z.string().min(4).max(40),
  startSec: z.number().int().nonnegative(),
  summary: z.string().max(120),
  bullets: z
    .array(
      z.object({
        text: z.string().min(1),
        startSec: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(5),
  terms: z.array(z.string()).max(15),
  /** 1-5：本章在整片中的重要性（模型判断） */
  importance: z.number().int().min(1).max(5),
});
export type SectionCandidate = z.infer<typeof SectionCandidateSchema>;

/** 单块模型输出整体（TECH-DESIGN §6.1） */
export const OutlineChunkSchema = z.object({
  sections: z.array(SectionCandidateSchema),
});

/**
 * 传给模型客户端的教学画面（抽帧产物，pipeline 侧统一形状）。
 * 与 explain 层的 ExplainImage 结构等价（dataBase64/mime/timeMs/caption），
 * 两处可互相赋值；pipeline 只做透传与提示词说明，不自行抓帧。
 */
export interface PipelineImage {
  dataBase64: string;
  mime?: string;
  /** 该帧对应的时间点（毫秒），用于提示词里生成 mm:ss 标注 */
  timeMs?: number;
  /** 帧-字幕配对说明：随图交错发送（见 modelClient.buildUserContent） */
  caption?: string;
  /** 160px 缩略图（仅日志展示） */
  thumbBase64?: string;
}

/**
 * 模型调用注入接口：content 应为 JSON 字符串 {sections: [...]}。
 * 后续接线时由调用方适配到 core/harness/modelClient，本模块不直接依赖 harness。
 * images 为可选增量（与 ExplainModelFn 同形），旧 stub 不传也能工作。
 */
export type OutlineModelFn = (req: {
  systemPrompt: string;
  userPrompt: string;
  images?: PipelineImage[];
}) => Promise<{ content: string }>;

/** finalize 后的章节：density/score 由 density.ts 填充（importance 来自模型） */
export type OutlineSection = Omit<Section, 'density'>;

/** 分块状态：在共享 ChunkState 上扩展预算熔断跳过标记 */
export interface OutlineChunkState extends ChunkState {
  /** 预算熔断时未启动的块（status 保持 pending，续跑时可重新执行） */
  skipped?: boolean;
}

export interface OutlineResult {
  /** finalize + attachDensity 后的完整章节（3.5 起 Section 含 density） */
  sections: Section[];
  chunkState: OutlineChunkState[];
  /** 吸附阶段因偏差超阈值丢弃的候选章节数（红线 2：幻觉路径） */
  droppedBySnap: number;
  /** 是否触发预算熔断 */
  budgetHit: boolean;
  failedChunks: number;
}

export interface RunOutlineOptions {
  /** prompt 构造器（默认基线实现见 prompts.ts） */
  buildPrompts?: (chunk: Cue[]) => { systemPrompt: string; userPrompt: string };
  /** 单视频大纲 token 预算（粗估：prompt 字符数 / 2）；不传则不设限 */
  tokenBudget?: number;
  concurrency?: number;
  chunkTimeoutMs?: number;
  maxRetries?: number;
  snapMaxDriftMs?: number;
  /** 增量合并：标题相似度阈值（字符重合率），默认 0.5 */
  mergeTitleThreshold?: number;
  /** 增量合并：时间相邻窗口（毫秒），默认 60_000 */
  mergeAdjacentMs?: number;
  /** 最短章节时长（毫秒），默认 OUTLINE.minSectionDurationMs（90s）；finalize 后不足者并入相邻较长章节 */
  minSectionDurationMs?: number;
  targetChars?: number;
  overlapChars?: number;
  /**
   * 每个分块的教学画面（抽帧产物，由调用方注入；pipeline 不自行抓帧）。
   * 返回空数组视为无图；不传则该块的 req.images 为 undefined（旧行为）。
   */
  imagesForChunk?: (chunk: Cue[], chunkIndex: number) => PipelineImage[];
  /**
   * 进度钩子：每确认完一个块的章节后回调（增量合并阶段，按块下标顺序）。
   * confirmed 为当前已合并章节快照（已吸附到真实 Cue 边界，但未 finalize，
   * 无 density/endMs 终值与 id）；回调异常被吞掉（进度提示非关键路径）。
   */
  onProgress?: (
    confirmed: SnappedSection[],
    doneChunks: number,
    totalChunks: number,
  ) => void;
}

// ---------------------------------------------------------------------------
// 概念知识图（SPEC-04 四次迭代：阶段流）：模型输出原始结构（zod Schema 定义在
// conceptMap.ts，此处只放与 OutlineModelFn 同构的注入接口与原始形状）。
// ---------------------------------------------------------------------------

/**
 * 概念图模型调用注入接口：content 应为阶段流 JSON 字符串。
 * 与 OutlineModelFn 同构，由调用方适配到 core/harness/modelClient。
 */
export type ConceptModelFn = (req: {
  systemPrompt: string;
  userPrompt: string;
  /** 全片抽样的关键帧（可选增量，与 OutlineModelFn 同形） */
  images?: PipelineImage[];
}) => Promise<{ content: string }>;

/** 模型输出的单个概念（原始形状，Schema 校验后） */
export interface ConceptRaw {
  label: string;
  importance: number;
  anchorSections: number[];
  details: string[];
}

/** 模型输出的单个阶段（原始形状，Schema 校验后） */
export interface ConceptStageRaw {
  label: string;
  concepts: ConceptRaw[];
}

/** 模型输出的关系边（label 引用概念） */
export interface ConceptFlowRaw {
  from: string;
  to: string;
  label?: string;
}

/** 模型输出整体（原始形状，Schema 校验后）：阶段流 */
export interface ConceptStagesRaw {
  stages: ConceptStageRaw[];
  flows?: ConceptFlowRaw[];
}
