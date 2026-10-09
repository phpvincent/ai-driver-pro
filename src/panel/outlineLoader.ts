/**
 * 大纲 pipeline 接线层（SPEC-03 3.4 + 父 agent 收尾接线）：
 * harness chatCompletion + pipeline runOutline + 正式 prompt（src/prompts/outline.md
 * 单一事实源，红线 6）+ 字幕缓存读取 + 大纲缓存（outlines store，键
 * [videoId, promptVersion, model]，红线 7 定向失效）+ 进度钩子透传。
 * 红线 2 消费侧：UI 跳播只用吸附后的 section.startMs。
 */
import { chatCompletion } from '../core/harness/modelClient';
import {
  buildOutlinePrompts,
  buildOutlineRegeneratePrompts,
  regenerateSection,
  rescoreOutline,
  runOutline,
  type OutlineModelFn,
  type OutlineResult,
} from '../core/pipeline/outline';
import type { SnappedSection } from '../core/pipeline/snap';
import { MSG } from '../messages';
import {
  getOutlineRegenerateSystemPrompt,
  getOutlineSystemPrompt,
  PROMPT_VERSIONS,
} from '../prompts';
import { chunkCues } from '../core/pipeline/chunk';
import { frameBudgetFor } from '../core/vision/framePlanner';
import { captionFrame } from '../core/vision/structuralCandidates';
import { planFrames, requestFrames, toPipelineImage } from './framesClient';
import { resolveModel, visionActiveFor } from './settings/modelForm';
import { setGenerationSource } from './generationTrace';
import type { Settings } from '../types';
import { createSubtitleDb, getOutline, getSubtitle, saveOutline } from '../storage/db';
import { DB } from '../config';
import type { Cue, ModelConfig, OutlineRecord, Section } from '../types';

/** 模块级单例 DB（惰性 open 由 db 层内部保证幂等） */
const db = createSubtitleDb();

/** 进行中的大纲生成（videoId → Promise）：同一视频去重 + 跨挂载续等 */
const inflight = new Map<string, Promise<OutlineResult>>();

export interface LoadOutlineOptions {
  /** 跳过大纲缓存强制重生成 */
  forceRefresh?: boolean;
  /** 进度回调（流式渲染）：confirmed 为未 finalize 的章节快照（已吸附，无 density/id） */
  onProgress?: (confirmed: SnappedSection[], doneChunks: number, totalChunks: number) => void;
}

/**
 * panel 侧完整入口：读设置拿模型配置 → 大纲缓存命中直接返回（红线 7 键含
 * promptVersion+model）→ 未命中读字幕缓存跑 pipeline → 结果落缓存（含 chunkState 断点）。
 * 模型未配置 throw（OutlineTab 状态机呈现）；DB 异常不阻断生成（缓存降级）。
 */
export async function loadOutlineForVideo(
  videoId: string,
  opts: LoadOutlineOptions = {},
): Promise<OutlineResult> {
  const model = await fetchModelConfig();
  if (!model?.apiKey) {
    throw new Error('模型未配置：请先在设置页配置模型');
  }
  const promptVersion = PROMPT_VERSIONS.outline;

  if (!opts.forceRefresh) {
    try {
      const cached = await getOutline(db, videoId, promptVersion, model.model);
      if (cached && cached.sections.length > 0) {
        return {
          sections: cached.sections,
          chunkState: cached.chunkState,
          droppedBySnap: 0,
          budgetHit: false,
          failedChunks: 0,
        };
      }
    } catch {
      /* 缓存读失败降级为重新生成（红线 8 精神） */
    }
  }

  const rec = await getSubtitle(db, videoId);
  const cues = rec?.cues ?? [];
  if (cues.length === 0) {
    return { sections: [], chunkState: [], droppedBySnap: 0, budgetHit: false, failedChunks: 0 };
  }

  // 抽帧（可选）：每个分块取 VISION.outlineFramesPerChunk 帧；失败降级为空
  const settings = await fetchSettings();
  const useVision = visionActiveFor({ settings, module: 'outline' });
  // 单模型口径：图片与文本一起发给同一个模型（模型不支持图像时抽帧会被门控关闭）
  /** 预抽到的帧（按时间升序），按块下标顺序分配给各分块 */
  let orderedFrames: Array<ReturnType<typeof toPipelineImage>> = [];
  if (useVision) {
    // 结构感知抽帧：大纲生成时还没有章节，按固定窗口切分后用字幕画面提示词打分，
    // 按分数分配帧预算（预算内取分最高的窗口，命中提示词的字幕时刻优先）
    // 模型优先（判断如何抽最能还原完整性），失败/未配置则回退确定性公式
    const subRec = await getSubtitle(db, videoId).catch(() => null);
    const targets = await planFrames({
      videoId,
      module: 'outline',
      cues,
      sections: [],
      durationMs: subRec?.meta?.durationMs ?? cues[cues.length - 1]?.endMs ?? 0,
      budget: frameBudgetFor(
        'outline',
        subRec?.meta?.durationMs ?? cues[cues.length - 1]?.endMs ?? 0,
      ),
      meta: { title: subRec?.meta?.title, page: subRec?.meta?.page },
    });
    const frames = await requestFrames({ videoId, targetsMs: targets });
    orderedFrames = frames.map(toPipelineImage);
  }

  const modelFn: OutlineModelFn = ({ systemPrompt, userPrompt, images }) => {
    // 带图的请求走视觉模型，不带图的仍走文本模型（用户可分别配置）
    const cfg = model;
    return chatCompletion({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: cfg.temperature.outline,
      maxTokens: cfg.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      responseFormatJson: true,
      // 结构化任务禁用思考：推理会消耗输出 token 预算（用户可在设置中开启）
      thinking: settings.disableThinking === false ? { type: 'enabled' } : { type: 'disabled' },
      images: images?.map((i) => ({ dataBase64: i.dataBase64, mime: i.mime ?? 'image/jpeg', timeMs: i.timeMs, caption: i.caption, thumbBase64: i.thumbBase64 })),
      label: 'outline',
    }).then((res) => ({ content: res.content }));
  };

  const result = await runOutline(cues, modelFn, {
    tokenBudget: model.outlineTokenBudget,
    // 红线 6：system prompt 用正式单一事实源，user 复用 pipeline 的字幕包裹格式
    // （重试时 pipeline 会在 userPrompt 上附加错误信息，system 不变）。
    buildPrompts: (chunk) => ({
      systemPrompt: getOutlineSystemPrompt(),
      userPrompt: buildOutlinePrompts(chunk).userPrompt,
    }),
    onProgress: opts.onProgress,
    /**
     * 每块的帧：**按时间落在块内**分配（一块可有多帧，也可没有），并附帧-字幕配对说明。
     * 历史：①按 targetMs 精确相等匹配 → 几乎全落空；②按下标顺序分配 → 第 i 帧未必属于第 i 块，
     * 帧与字幕错位。按时间归属是唯一正确的口径。
     */
    imagesForChunk: (chunk, index) => framesForChunk(orderedFrames, chunk, index, cues),
  });

  // 结果落缓存（含 chunkState 断点供续跑；写失败不阻断返回）
  if (result.sections.length > 0) {
    try {
      await saveOutline(db, {
        videoId,
        promptVersion,
        model: model.model,
        sections: result.sections,
        chunkState: result.chunkState,
        tokenUsage: {
          input: result.chunkState.reduce((s, c) => s + (c.inputTokens ?? 0), 0),
          output: result.chunkState.reduce((s, c) => s + (c.outputTokens ?? 0), 0),
        },
        createdAt: '',
      });
    } catch {
      /* 缓存写失败忽略 */
    }
  }
  return result;
}

/** chrome.runtime.sendMessage 的安全包装：上下文失效时返回 null */
function sendRuntimeMessage(message: unknown): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve(null);
  }
}

/** 读设置中的 ModelConfig；未配置返回 null */
async function fetchSettings(): Promise<Settings> {
  const response = await sendRuntimeMessage({ type: MSG.GET_SETTINGS });
  const stored = (response ?? {}) as Settings;
  return stored && typeof stored === 'object' ? stored : {};
}

/** 读设置取当前生效模型（三模块共用一套） */
async function fetchModelConfig(): Promise<ModelConfig | null> {
  const settings = await fetchSettings();
  const model = resolveModel(settings);
  setGenerationSource(
    'outline',
    model?.apiKey ? { kind: 'model', model: model.model } : { kind: 'fallback', reason: '模型未配置' },
  );
  return model;
}

/**
 * 只读大纲缓存（挂载自动加载用，SPEC-03 3c 范围变更）：
 * 标准键未命中 → 回退读 imported 记录（SPEC-09 9.6 导入的大纲，键
 * `videoId::imported::{model}`，不被本地 promptVersion 升级误失效）。
 * 两处都未命中 / 模型未配置 / DB 异常一律 throw 'NO_CACHE'，由 UI 回到生成按钮态。
 */
export async function loadOutlineCached(videoId: string): Promise<OutlineResult> {
  const model = await fetchModelConfig();
  if (model?.apiKey) {
    try {
      const cached = await getOutline(db, videoId, PROMPT_VERSIONS.outline, model.model);
      if (cached && cached.sections.length > 0) {
        return {
          sections: cached.sections,
          chunkState: cached.chunkState,
          droppedBySnap: 0,
          budgetHit: false,
          failedChunks: 0,
        };
      }
    } catch {
      /* 缓存读失败视作无缓存 */
    }
  }
  // SPEC-09：导入的大纲（outlines store 里该视频的非标准键记录，取最新）
  try {
    const all = await db.getAll<OutlineRecord>(DB.stores.outlines);
    const imported = all
      .filter((r) => r && typeof r === 'object' && r.videoId === videoId && Array.isArray(r.sections))
      .filter((r) => r.sections.length > 0)
      .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1));
    if (imported.length > 0) {
      return {
        sections: imported[0]!.sections,
        chunkState: imported[0]!.chunkState ?? [],
        droppedBySnap: 0,
        budgetHit: false,
        failedChunks: 0,
      };
    }
  } catch {
    /* imported 回退读失败视作无缓存 */
  }
  throw new Error('NO_CACHE');
}

/** 强制重生成全片大纲（生成 / 全局"重新生成"按钮；forceRefresh 跳过大纲缓存） */
export async function generateOutline(
  videoId: string,
  opts: { onProgress?: LoadOutlineOptions['onProgress'] } = {},
): Promise<OutlineResult> {
  const running = inflight.get(videoId);
  if (running) return running;
  const task = loadOutlineForVideo(videoId, { forceRefresh: true, onProgress: opts.onProgress }).finally(
    () => {
      inflight.delete(videoId);
    },
  );
  inflight.set(videoId, task);
  return task;
}

/**
 * 获取正在进行的生成（用于 Tab 切回后继续等待，避免"又变回生成按钮"）。
 * 无进行中任务返回 null。
 */
export function getInflightOutline(videoId: string): Promise<OutlineResult> | null {
  return inflight.get(videoId) ?? null;
}

/**
 * 单章替换 + 全片重算（纯函数）：
 * 同 id 的章节替换为 newSection，随后 rescoreOutline 对全片重算 score/density
 * （min-max 归一基准随章节内容变化，必须整体重算）。
 */
export function applyRegenerated(sections: Section[], newSection: Section): Section[] {
  return rescoreOutline(sections.map((s) => (s.id === newSection.id ? newSection : s)));
}

/**
 * 单章重生成（SPEC-03 3c 范围变更 2.3 接线）：
 * 读大纲缓存取基准章节列表 → 字幕缓存取全片 cues → regenerateSection
 * （system prompt 用 outline-regenerate.md 单一事实源，红线 6）→
 * applyRegenerated 替换并全片重算 → saveOutline 更新缓存 → 返回新 OutlineResult。
 */
export async function regenerateOne(
  videoId: string,
  section: Section,
  feedback?: string,
): Promise<OutlineResult> {
  const model = await fetchModelConfig();
  if (!model?.apiKey) {
    throw new Error('模型未配置：请先在设置页配置模型');
  }
  const cached = await getOutline(db, videoId, PROMPT_VERSIONS.outline, model.model);
  if (!cached || cached.sections.length === 0) {
    throw new Error('NO_CACHE');
  }
  const rec = await getSubtitle(db, videoId);
  const cues = rec?.cues ?? [];
  if (cues.length === 0) {
    throw new Error('没有可用字幕，无法重新生成本章');
  }
  const settings = await fetchSettings();

  const modelFn: OutlineModelFn = ({ systemPrompt, userPrompt }) =>
    chatCompletion({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.model,
      temperature: model.temperature.outline,
      maxTokens: model.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      responseFormatJson: true,
      // 结构化任务禁用思考：推理会消耗输出 token 预算（用户可在设置中开启）
      thinking: settings.disableThinking === false ? { type: 'enabled' } : { type: 'disabled' },
      label: 'outline',
    }).then((res) => ({ content: res.content }));

  // 反馈仅方向性引导：空白视为未填写
  const trimmedFeedback = feedback && feedback.trim() ? feedback.trim() : undefined;

  const newSection = await regenerateSection({
    section,
    cues,
    feedback: trimmedFeedback,
    modelFn,
    // 红线 6：system prompt 用正式单一事实源，user 复用 pipeline 的字幕包裹格式
    buildRegenPrompts: ({ section: sec, chunkCues, feedback: fb }) => ({
      systemPrompt: getOutlineRegenerateSystemPrompt(),
      userPrompt: buildOutlineRegeneratePrompts({ section: sec, chunkCues, feedback: fb }).userPrompt,
    }),
  });

  const sections = applyRegenerated(cached.sections, newSection);

  // 更新缓存（保留 promptVersion/model/chunkState/tokenUsage；写失败不阻断返回）
  try {
    await saveOutline(db, { ...cached, sections });
  } catch {
    /* 缓存写失败忽略 */
  }
  return {
    sections,
    chunkState: cached.chunkState,
    droppedBySnap: 0,
    budgetHit: false,
    failedChunks: 0,
  };
}

/**
 * 把预抽帧按时间归属到分块（纯函数，导出供单测）：帧时间 ∈ [块首句, 下一块首句)。
 * 返回的帧带配对说明（本块内的第几张 + 此刻字幕）；大纲阶段尚无章节，说明里不含章节名。
 */
export function framesForChunk(
  frames: Array<{ dataBase64: string; mime: string; timeMs: number; caption?: string }>,
  chunk: Cue[],
  _index: number,
  allCues: Cue[],
): Array<{ dataBase64: string; mime: string; timeMs: number; caption?: string }> {
  if (chunk.length === 0) return [];
  const start = chunk[0]!.startMs;
  const last = chunk[chunk.length - 1]!;
  const next = allCues.find((c) => c.startMs > last.startMs);
  const end = next ? next.startMs : Number.POSITIVE_INFINITY;
  const mine = frames.filter((f) => f.timeMs >= start && f.timeMs < end);
  return mine.map((f, i) => ({ ...f, caption: captionFrame(f.timeMs, i, mine.length, [], chunk) }));
}
