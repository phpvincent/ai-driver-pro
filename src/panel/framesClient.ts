/**
 * 抽帧客户端（父 agent 接线）：panel → background → content 请求关键帧。
 *
 * 只在用户开启"结合画面"且配置了视觉模型时由 loader 调用；任何失败（content
 * 未就绪 / videoId 不符 / 抽帧异常）都降级为空数组，主流程不受影响（红线 8 精神）。
 */
import { VISION } from '../config';
import { MSG } from '../messages';
import type { CapturedFrame } from '../messages';
import { chatCompletion } from '../core/harness/modelClient';
import { getFramePlanSystemPrompt } from '../prompts';
import {
  cueWindows,
  dedupeFrames,
  planFrameTargets,
  sectionMetaOf,
  sectionWindows,
} from '../core/vision/framePlanner';
import { mergeFrameTargets, requestFramePlan, suggestFrameRange } from '../core/vision/llmFramePlan';
import {
  buildStructuralCandidates,
  ensureChapterCoverage,
  pickCandidatesByPriority,
  type FrameCandidate,
} from '../core/vision/structuralCandidates';
import { resolveModel } from './settings/modelForm';
import type { Cue, ModelConfig, Section } from '../types';

export interface FrameRequestOptions {
  videoId: string;
  /** 目标时间点（毫秒），由调用方按模块预算决定数量 */
  targetsMs: number[];
}

export interface FramePlanArgs {
  videoId: string;
  module: 'outline' | 'mindmap' | 'qa';
  cues: Cue[];
  sections: Section[];
  /** 视频总时长（毫秒） */
  durationMs: number;
  budget: number;
  /** 视频元信息（给模型充足的参考上下文） */
  meta?: { title?: string; page?: number };
}

/**
 * 统一抽帧规划：**模型优先，公式回退**。
 *
 * 1. 模型可用（已配置且能返回合法时间点）→ 用它判断"抽哪几帧最能还原内容完整性"
 * 2. 模型未配置 / 调用失败 / 输出不合法 → 回退确定性公式规划（framePlanner）
 * 3. 两者都给不出结果 → 空数组（不抽帧，不浪费 token）
 *
 * 模型只负责"看什么"，最终时间点仍由代码吸附到真实字幕时刻并做间隔/预算裁剪。
 */
/** 最近一次抽帧规划的诊断信息（验证结构推断命中率用） */
export interface FramePlanDiag {
  module: 'outline' | 'mindmap' | 'qa';
  /** model=模型规划成功；formula=回退公式；none=未抽帧 */
  source: 'model' | 'formula' | 'none';
  frames: number;
  /** 模型自报覆盖率 0~1（仅 source=model 且有自检时） */
  coverage?: number;
  /** 每帧覆盖的知识块（模型自报，可能为空） */
  covers: string[];
  targets: number[];
}

let lastFramePlan: FramePlanDiag | null = null;

/** 读取最近一次抽帧规划诊断（供埋点与验证期报告） */
export function getLastFramePlan(): FramePlanDiag | null {
  return lastFramePlan;
}

function recordDiag(diag: FramePlanDiag): void {
  lastFramePlan = diag;
  // 诊断日志：真实使用时可据此判断"结构推断"是否优于均匀抽样
  console.debug(
    `[vsc] frame plan: module=${diag.module} source=${diag.source} frames=${diag.frames}` +
      (typeof diag.coverage === 'number' ? ` coverage=${diag.coverage}` : ''),
  );
}

export async function planFrames(args: FramePlanArgs): Promise<number[]> {
  const { cues, sections, budget } = args;
  if (cues.length === 0 || budget <= 0) {
    recordDiag({ module: args.module, source: 'none', frames: 0, covers: [], targets: [] });
    return [];
  }

  const model = (await readModuleModel(args.module)) ?? null;
  const suggested = suggestFrameRange(args.durationMs, budget);
  // 结构化候选：章节开头 / 知识点 / 章节结尾（无章节时按时段）。模型从中挑，代码不替它猜
  const candidates = buildStructuralCandidates(sections, cues, {
    minGapMs: VISION.minGapMs,
    windowMs: Math.max(20_000, Math.ceil(args.durationMs / Math.max(4, budget * 2))),
    maxCandidates: Math.max(24, budget * 3),
  });
  const req = {
    sections,
    cues,
    durationMs: args.durationMs,
    budget,
    minGapMs: VISION.minGapMs,
    meta: args.meta,
    suggested,
    candidates,
  };
  const guard = (targets: number[]): number[] =>
    ensureChapterCoverage(targets, sections, candidates, { max: suggested.max, minGapMs: VISION.minGapMs });

  // ① 模型规划（可选）
  if (model?.apiKey) {
    const plan = await requestFramePlan(
      req,
      ({ systemPrompt, userPrompt }) =>
        chatCompletion({
          baseUrl: model.baseUrl,
          apiKey: model.apiKey,
          model: model.model,
          temperature: model.temperature.outline,
          // 每个 target（id+covers+why）约 50~70 token：40 帧需要 ~3k。
          // 旧值写死 1024，帧数一多 JSON 就被截断 → 整份规划失效、静默回退公式
          maxTokens: Math.min(Math.max(model.maxTokens, 1024), Math.max(1024, 400 + budget * 80)),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          responseFormatJson: true,
          // 规划任务禁用思考：只要时间点，思考会吃掉输出预算
          thinking: { type: 'disabled' },
          label: 'frame-plan',
        }).then((res) => ({ content: res.content })),
      getFramePlanSystemPrompt,
    ).catch(() => null);

    if (plan && plan.targets.length > 0) {
      let targets = plan.targets;
      if (targets.length < suggested.min) {
        targets = mergeFrameTargets(plan.targets, fallbackTargets(args, candidates, suggested), {
          ...suggested,
          minGapMs: VISION.minGapMs,
        });
      }
      // 模型可自由决定每章看几帧，但不允许某章一帧都不看（导图会直接漏掉一个阶段）
      targets = guard(targets);
      const blocks = plan.coverage?.knowledgeBlocks ?? 0;
      const covered = plan.coverage?.covered ?? 0;
      recordDiag({
        module: args.module,
        source: 'model',
        frames: targets.length,
        coverage: blocks > 0 ? covered / blocks : undefined,
        covers: plan.items.map((i) => i.covers ?? '').filter((c) => c.length > 0),
        targets,
      });
      return targets;
    }
  }

  // ② 确定性回退：结构候选优先（章节首尾 → 知识点），不足再用打分公式补
  const targets = guard(
    mergeFrameTargets([], fallbackTargets(args, candidates, suggested), {
      ...suggested,
      minGapMs: VISION.minGapMs,
    }),
  );
  recordDiag({ module: args.module, source: 'formula', frames: targets.length, covers: [], targets });
  return targets;
}

/** 确定性回退：结构候选按优先级取满预算，候选不够时追加打分公式帧 */
function fallbackTargets(
  args: FramePlanArgs,
  candidates: FrameCandidate[],
  suggested: { min: number; max: number },
): number[] {
  const structural = pickCandidatesByPriority(candidates, suggested.max);
  if (structural.length >= suggested.max) return structural;
  return [...structural, ...formulaTargets(args, args.sections, args.cues, suggested)];
}

/** 公式规划（章节存在时按章节打分，否则按固定窗口） */
function formulaTargets(
  args: FramePlanArgs,
  sections: typeof args.sections,
  cues: typeof args.cues,
  suggested: { min: number; max: number },
): number[] {
  const windows =
    sections.length > 0
      ? sectionWindows(sections, cues)
      // 窗口要够密：早期按 durationMs/8（10 分钟仅 8 个窗口），预算提到 16 帧也选不出来
      : cueWindows(cues, Math.max(30_000, Math.ceil(args.durationMs / 24)));
  return planFrameTargets(windows, cues, {
    budget: suggested.max,
    minGapMs: VISION.minGapMs,
    minScore: VISION.minScore,
  }, sections.length > 0 ? sectionMetaOf(sections) : undefined).map((w) => w.targetMs);
}

/** 读取模块模型（与 loader 同一解析口径） */
async function readModuleModel(module: 'outline' | 'mindmap' | 'qa'): Promise<ModelConfig | null> {
  try {
    const settings = (await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS })) as {
      model?: ModelConfig;
    } | null;
    return resolveModel((settings ?? {}) as never);
  } catch {
    return null;
  }
}

/** 向 content 请求关键帧；失败返回空数组 */
export async function requestFrames(args: FrameRequestOptions): Promise<CapturedFrame[]> {
  if (args.targetsMs.length === 0) return [];
  try {
    const response = (await chrome.runtime.sendMessage({
      type: MSG.CAPTURE_FRAMES,
      // maxSize 由 panel 决定（VISION.maxSize）：此前 content 一直用自己写死的 512，常量从未接线
      payload: { videoId: args.videoId, targetsMs: args.targetsMs, maxSize: VISION.maxSize },
    })) as { frames?: CapturedFrame[] } | null;
    const rawFrames = Array.isArray(response?.frames) ? (response?.frames as CapturedFrame[]) : [];
    // 结构感知抽帧第二道闸门：画面几乎未变（同一页 PPT）的帧丢弃；
    // minKeep 保底——dHash 对版式相同、内容不同的 PPT 页区分度不足，
    // 不允许把规划的一半以下砍掉（冒烟 3c：16 帧被砍到 1 帧）
    return dedupeFrames(rawFrames, {
      minGapMs: VISION.minGapMs,
      dhashMaxDistance: VISION.dhashMaxDistance,
      minKeep: Math.ceil(args.targetsMs.length / 2),
    });
  } catch {
    return [];
  }
}

/** 帧 → pipeline 图像入参（时间点写入 timeMs，供提示词生成"第 mm:ss 的画面"） */
export function toPipelineImage(frame: CapturedFrame): {
  dataBase64: string;
  mime: string;
  timeMs: number;
  thumbBase64?: string;
} {
  return {
    dataBase64: frame.dataBase64,
    mime: 'image/jpeg',
    timeMs: frame.actualMs,
    ...(frame.thumbBase64 ? { thumbBase64: frame.thumbBase64 } : {}),
  };
}
