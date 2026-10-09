/**
 * 概念图接线层（SPEC-04 四次迭代：阶段流）：
 * 缓存（outlines store，键 `concept::{videoId}::{promptVersion}::{model}`，
 * 红线 7 定向失效——promptVersion 升 0.2.0 自动失效旧域树缓存）+ 生成
 * （buildConceptMap，system prompt 用 src/prompts/concept-map.md 单一事实源，
 * 红线 6）+ 本地术语降级包装。
 * 红线 2 消费侧：锚点只来自章节 startMs（大纲管线吸附产物）。
 */
import { chatCompletion } from '../core/harness/modelClient';
import {
  buildConceptMap,
  buildTermIndexMap,
} from '../core/pipeline/conceptMap';
import type { ConceptModelFn } from '../core/pipeline/types';
import { DB } from '../config';
import { MSG } from '../messages';
import { getConceptMapSystemPrompt, PROMPT_VERSIONS } from '../prompts';
import { frameBudgetFor, isDenseSections } from '../core/vision/framePlanner';
import { planFrames, requestFrames, toPipelineImage } from './framesClient';
import { captionFrame } from '../core/vision/structuralCandidates';
import { resolveModel, visionActiveFor } from './settings/modelForm';
import { setGenerationSource } from './generationTrace';
import type { Settings } from '../types';
import { createSubtitleDb, getSubtitle } from '../storage/db';
import type { ConceptFlow, ConceptMapData, ModelConfig, Section } from '../types';

/** 模块级单例 DB（惰性 open 由 db 层内部保证幂等） */
const db = createSubtitleDb();

/** 概念图缓存键：与大纲键（videoId::pv::model）用 `concept::` 前缀隔离，防碰撞 */
export function conceptMapCacheKey(videoId: string, promptVersion: string, model: string): string {
  return `concept::${videoId}::${promptVersion}::${model}`;
}

/**
 * 读概念图缓存（outlines store 同库共存），未命中返回 null。
 * DB 异常不向上抛（缓存降级，红线 8 精神）。
 */
export async function getConceptMapCached(
  videoId: string,
  model: ModelConfig,
): Promise<ConceptMapData | null> {
  try {
    await db.open();
    const rec = await db.get<ConceptMapData>(
      DB.stores.outlines,
      conceptMapCacheKey(videoId, PROMPT_VERSIONS.conceptMap, model.model),
    );
    return rec ?? null;
  } catch {
    return null;
  }
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
  return resolveModel(settings);
}

/**
 * 生成概念图（模型路径）：读设置 → buildConceptMap（确定性单调用，红线 1）
 * → 落缓存。模型未配置或两次解析失败 throw（调用方降级到术语关联图）。
 */
export async function generateConceptMap(
  videoId: string,
  sections: Section[],
  videoTitle: string,
): Promise<ConceptMapData> {
  const model = await fetchModelConfig();
  if (!model?.apiKey) {
    setGenerationSource('mindmap', { kind: 'fallback', reason: '模型未配置' });
    throw new Error('模型未配置：请先在设置页配置模型');
  }
  setGenerationSource('mindmap', { kind: 'model', model: model.model });
  if (sections.length === 0) {
    throw new Error('无章节可用：请先生成大纲');
  }

  // 抽帧（可选）：预算随时长增长（分段递减）、每章至少首尾两帧，上限 FRAME_PLAN.mindmap.hardMax
  const settings = (await fetchSettings()) as Settings;
  const useVision = visionActiveFor({ settings, module: 'mindmap' });
  // 单模型口径：图片与文本一起发给同一个模型
  let images: ReturnType<typeof toPipelineImage>[] = [];
  if (useVision) {
    const rec = await getSubtitle(db, videoId).catch(() => null);
    const cues = rec?.cues ?? [];
    // 模型优先（判断如何抽最能还原完整性），失败/未配置则回退确定性公式
    const durationMs = rec?.meta?.durationMs ?? cues[cues.length - 1]?.endMs ?? 0;
    const targets = await planFrames({
      videoId,
      module: 'mindmap',
      cues,
      sections,
      durationMs,
      budget: frameBudgetFor('mindmap', durationMs, isDenseSections(sections, durationMs), sections.length),
      meta: { title: videoTitle || rec?.meta?.title, page: rec?.meta?.page },
    });
    const frames = (await requestFrames({ videoId, targetsMs: targets })).map(toPipelineImage);
    // 帧-字幕配对：每张图前紧贴"第几章 · 章节开头/知识点/结尾 · 此刻字幕"
    images = frames.map((f, i) => ({
      ...f,
      caption: captionFrame(f.timeMs, i, frames.length, sections, cues),
    }));
  }

  const modelFn: ConceptModelFn = ({ systemPrompt, userPrompt, images: imgs }) => {
    const cfg = model;
    return chatCompletion({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: cfg.temperature.qa,
      maxTokens: cfg.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      responseFormatJson: true,
      // 结构化任务禁用思考：推理会消耗输出 token 预算（用户可在设置中开启）
      thinking: settings.disableThinking === false ? { type: 'enabled' } : { type: 'disabled' },
      images: imgs?.map((i) => ({ dataBase64: i.dataBase64, mime: i.mime ?? 'image/jpeg', timeMs: i.timeMs, caption: i.caption, thumbBase64: i.thumbBase64 })),
      label: 'mindmap',
    }).then((res) => ({ content: res.content }));
  };

  const { stages, flows } = await buildConceptMap({
    sections,
    videoTitle,
    modelFn,
    // 红线 6：system prompt 单一事实源
    getSystemPrompt: getConceptMapSystemPrompt,
    images,
  });

  const data: ConceptMapData = {
    videoId,
    promptVersion: PROMPT_VERSIONS.conceptMap,
    model: model.model,
    stages,
    flows,
    generatedAt: new Date().toISOString(),
  };

  // 结果落缓存（写失败不阻断返回）
  try {
    await db.open();
    await db.put(DB.stores.outlines, conceptMapCacheKey(videoId, data.promptVersion, data.model), data);
  } catch {
    /* 缓存写失败忽略 */
  }
  return data;
}

/**
 * 本地术语关联图（零模型确定性降级，红线 1）：
 * 供组件在未接线模型路径时直接计算（stages 形状，与模型路径同构）。
 * 降级标记约定（types.ts 的 ConceptMapData 无 degraded 字段）：
 * model='term-index'，MindmapTab 以 isTermIndexData 识别并渲染降级横幅。
 */
export function termIndexFallback(sections: Section[]): ConceptMapData {
  const { stages } = buildTermIndexMap(sections);
  return {
    videoId: '',
    promptVersion: PROMPT_VERSIONS.conceptMap,
    model: 'term-index',
    stages,
    generatedAt: '',
  };
}

/** 兜底文案：错误对象没带 message 时（接口异常/超时/反序列化失败常见）给出排查方向 */
export const CONCEPT_FAILURE_NO_DETAIL =
  '概念图生成失败（未提供错误详情）：请打开 DevTools 控制台查看以 [vsc] 开头的日志。' +
  '常见原因：模型输出不符合格式、接口鉴权失败、网络/代理拦截，或生成超时。';

/** 失败后可操作的排查建议（模型输出类失败才追加；配置类失败原文已含指引） */
const CONCEPT_FAILURE_HINT =
  '可尝试：调大 maxTokens（输出若被截断，日志里会标 finish_reason=length）、'
  + '关闭「结合画面（抽帧）」减少干扰，或更换更稳定的模型。';

/**
 * 概念图失败原因可读化（导出供单测）：降级横幅不能只说"模型生成失败"——
 * 要告诉用户是哪一步失败（未配置 / 无章节 / 模型输出未过校验），以及能做什么。
 *
 * 纯函数：输入错误对象，输出可直接展示的文案；配置类失败（模型未配置、无章节）
 * 原样返回其已有指引，其余追加排查建议。
 */
export function describeConceptMapFailure(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message.trim()
      : typeof err === 'string'
        ? err.trim()
        : '';
  if (raw.length === 0) return CONCEPT_FAILURE_NO_DETAIL;
  if (raw.includes('模型未配置') || raw.includes('无章节可用')) return raw;
  return `${raw}。${CONCEPT_FAILURE_HINT}`;
}

// ---------------------------------------------------------------------------
// 概念关系边独立生成（冒烟 3b 二轮：与概念图分开调用，看流程图才花这份 token）
// ---------------------------------------------------------------------------

import { parseConceptFlows, resolveFlows } from '../core/pipeline/conceptMap';
import { getConceptFlowsSystemPrompt } from '../prompts';

/**
 * 生成概念间关系边并写回缓存：输入是已有概念图的编号概念清单（很小），
 * 输出 3~15 条有向边。成功后 flows 持久化，流程视图立即可用。
 */
export async function generateConceptFlows(videoId: string): Promise<ConceptFlow[]> {
  const settings = (await fetchSettings()) as Settings;
  const model = resolveModel(settings);
  if (!model?.apiKey) throw new Error('模型未配置：请先在设置页配置模型');
  const rec = await getConceptMapCached(videoId, model).catch(() => null);
  if (!rec) throw new Error('请先生成概念图，再生成关系边');
  if (rec.flows && rec.flows.length > 0) return rec.flows;

  // 紧凑清单：按阶段分组编号（S1-1 / S1-2 …），输入只有 label，成本极低
  const lines: string[] = ['概念清单（label 必须一字不差引用）：'];
  rec.stages.forEach((s, si) => {
    lines.push(`S${si + 1} ${s.label}`);
    s.concepts.forEach((c, ci) => lines.push(`  S${si + 1}-${ci + 1} ${c.label}`));
  });
  const { content } = await chatCompletion({
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    model: model.model,
    temperature: 0.1,
    maxTokens: Math.min(model.maxTokens, 2_048),
    messages: [
      { role: 'system', content: getConceptFlowsSystemPrompt() },
      { role: 'user', content: lines.join('\n') },
    ],
    responseFormatJson: true,
    thinking: { type: 'disabled' },
    label: 'concept-flows',
  });
  const flows = resolveFlows(parseConceptFlows(content), rec.stages);
  if (!flows || flows.length === 0) {
    throw new Error('模型未输出有效关系边（引用的概念不在清单中）——可重试一次');
  }
  // 写回缓存（同 key 覆盖，flows 随记录持久化）
  await db.put(DB.stores.outlines, conceptMapCacheKey(videoId, rec.promptVersion, rec.model), {
    ...rec,
    flows,
  });
  return flows;
}
