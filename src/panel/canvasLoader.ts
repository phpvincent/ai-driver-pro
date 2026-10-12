/**
 * 自由画布接线层（SPEC-13）：缓存 + 模型调用 + Mermaid 语法校验。
 *
 * 缓存键 `canvas::{kind}::{videoId}::{promptVersion}::{model}`（红线 7：prompt 升版自动失效）。
 * 与旧概念图缓存（concept::）完全隔离——旧数据保留，概念图视图仍可用。
 */
import { chatCompletion } from '../core/harness/modelClient';
import {
  buildCanvasUserPrompt,
  generateCanvas,
  type CanvasKind,
} from '../core/pipeline/freeCanvas';
import { DB } from '../config';
import { MSG } from '../messages';
import {
  getCanvasFlowchartSystemPrompt,
  getCanvasMindmapSystemPrompt,
  PROMPT_VERSIONS,
} from '../prompts';
import { createSubtitleDb } from '../storage/db';
import type { ModelConfig, Section, Settings } from '../types';
import { publishProgress } from './progressBus';
import { resolveModel } from './settings/modelForm';

const db = createSubtitleDb();

/** 画布缓存记录 */
export interface CanvasRecord {
  kind: CanvasKind;
  videoId: string;
  promptVersion: string;
  model: string;
  /** mindmap = 层级 Markdown；flowchart = Mermaid 代码 */
  code: string;
  generatedAt: string;
}

function promptVersionOf(kind: CanvasKind): string {
  return kind === 'mindmap' ? PROMPT_VERSIONS.canvasMindmap : PROMPT_VERSIONS.canvasFlowchart;
}

export function canvasCacheKey(kind: CanvasKind, videoId: string, promptVersion: string, model: string): string {
  return `canvas::${kind}::${videoId}::${promptVersion}::${model}`;
}

async function fetchSettings(): Promise<Settings> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS })) as Settings | null;
    return res && typeof res === 'object' ? res : {};
  } catch {
    return {};
  }
}

/** 读当前模型（未配置返回 null） */
export async function fetchCanvasModel(): Promise<ModelConfig | null> {
  return resolveModel(await fetchSettings());
}

/** 读缓存；未命中/DB 异常返回 null（缓存降级） */
export async function getCanvasCached(kind: CanvasKind, videoId: string): Promise<CanvasRecord | null> {
  if (!videoId) return null;
  const model = await fetchCanvasModel();
  if (!model) return null;
  try {
    await db.open();
    const rec = await db.get<CanvasRecord>(
      DB.stores.outlines,
      canvasCacheKey(kind, videoId, promptVersionOf(kind), model.model),
    );
    return rec && typeof rec.code === 'string' && rec.code.length > 0 ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Mermaid 语法校验（渲染器级）：mermaid.parse 失败抛出带行号的错误信息，
 * 由 generateCanvas 回灌给模型重试一次。动态 import——不开流程图不加载 mermaid。
 */
export async function validateMermaid(code: string): Promise<void> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  await mermaid.parse(code);
}

/** 生成画布（模型路径）：成功落缓存；模型未配置 / 无章节 / 两次校验失败 throw 可读错误 */
export async function generateCanvasFor(
  kind: CanvasKind,
  videoId: string,
  sections: Section[],
  videoTitle: string,
): Promise<CanvasRecord> {
  const settings = await fetchSettings();
  const model = resolveModel(settings);
  if (!model?.apiKey) throw new Error('模型未配置：请先在设置页配置模型');
  if (sections.length === 0) throw new Error('无章节可用：请先生成大纲');

  const progress = (pct: number, label: string): void =>
    publishProgress({ videoId, stage: 'mindmap', done: 1, total: 100, pct, label });

  progress(10, kind === 'mindmap' ? '模型梳理知识结构中' : '模型绘制流程图中');
  const systemPrompt = kind === 'mindmap' ? getCanvasMindmapSystemPrompt() : getCanvasFlowchartSystemPrompt();

  const code = await generateCanvas({
    kind,
    systemPrompt,
    userPrompt: buildCanvasUserPrompt(sections, videoTitle),
    videoTitle,
    validate: kind === 'flowchart' ? validateMermaid : undefined,
    onRetry: () => progress(60, '语法校验未通过，模型修正中'),
    modelFn: ({ systemPrompt: sys, userPrompt }) =>
      chatCompletion({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
        temperature: model.temperature.qa,
        maxTokens: model.maxTokens,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userPrompt },
        ],
        thinking: settings.disableThinking === false ? { type: 'enabled' } : { type: 'disabled' },
        label: kind === 'mindmap' ? 'canvas-mindmap' : 'canvas-flowchart',
      }).then((res) => ({ content: res.content })),
  });
  progress(95, '渲染中');

  const rec: CanvasRecord = {
    kind,
    videoId,
    promptVersion: promptVersionOf(kind),
    model: model.model,
    code,
    generatedAt: new Date().toISOString(),
  };
  try {
    await db.open();
    await db.put(DB.stores.outlines, canvasCacheKey(kind, videoId, rec.promptVersion, rec.model), rec);
  } catch {
    /* 缓存写失败不阻断 */
  }
  progress(100, '完成');
  return rec;
}
