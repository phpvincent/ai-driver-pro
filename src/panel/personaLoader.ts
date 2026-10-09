/**
 * 问答动态角色接线层（用户洞察：问答前判定"以什么类别的老师/专家回答"）：
 * 缓存（outlines store，键 `persona::{videoId}::{promptVersion}::{model}`，
 * 红线 7 定向失效——promptVersion / 模型变更自动失效）+ 生成（judgePersona，
 * system prompt 用 src/prompts/persona.md 单一事实源，红线 6）。
 *
 * 频次口径：**每视频一次判定**（生成后落库，问答时只读缓存），不在问答链路上
 * 逐题调用模型。判定失败一律降级为默认角色（fallback: true），**不 throw**——
 * 问答不被角色判定阻断（红线 8 精神）。
 */
import { chatCompletion } from '../core/harness/modelClient';
import {
  defaultPersona,
  judgePersona,
  type PersonaModelFn,
} from '../core/pipeline/persona';
import { DB } from '../config';
import { MSG } from '../messages';
import { getPersonaSystemPrompt, PROMPT_VERSIONS } from '../prompts';
import { createSubtitleDb, getSubtitle } from '../storage/db';
import { resolveModel } from './settings/modelForm';
import type { Settings, ModelConfig, Persona, Section } from '../types';

/** 模块级单例 DB（惰性 open 由 db 层内部保证幂等） */
const db = createSubtitleDb();

/** 角色缓存键：与概念图键用 `persona::` 前缀隔离，防碰撞 */
export function personaCacheKey(videoId: string, promptVersion: string, model: string): string {
  return `persona::${videoId}::${promptVersion}::${model}`;
}

/**
 * 读角色缓存（outlines store 同库共存），未命中返回 null。
 * DB 异常不向上抛（缓存降级，红线 8 精神）。
 */
export async function getPersonaCached(
  videoId: string,
  model: ModelConfig,
): Promise<Persona | null> {
  try {
    await db.open();
    const rec = await db.get<Persona>(
      DB.stores.outlines,
      personaCacheKey(videoId, PROMPT_VERSIONS.persona, model.model),
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

/** 读设置并按问答模块解析模型（角色判定随问答模块：方案缺 Key 回退默认） */
async function fetchModelConfig(): Promise<ModelConfig | null> {
  const settings = await fetchSettings();
  return resolveModel(settings);
}

/**
 * 生成并缓存角色判定（每视频一次）：
 * 读设置 → judgePersona（确定性单调用）→ 落缓存。
 * 模型未配置 / 调用或校验失败 → defaultPersona（fallback: true），不 throw。
 */
export async function generatePersona(args: {
  videoId: string;
  title: string;
  sections: Section[];
  /** 字幕开头若干条文本；不传则从字幕缓存读取前 8 条 */
  cueHead?: string[];
}): Promise<Persona> {
  const cueHead =
    args.cueHead && args.cueHead.length > 0
      ? args.cueHead
      : (await getSubtitle(db, args.videoId).catch(() => null))?.cues
          ?.slice(0, 8)
          .map((c) => c.text) ?? [];
  const promptVersion = PROMPT_VERSIONS.persona;
  let model: ModelConfig | null = null;
  try {
    model = await fetchModelConfig();
    if (!model?.apiKey) {
      return defaultPersona(args.videoId, promptVersion, '');
    }
    const cfg = model;
    const settings = await fetchSettings();
    const modelFn: PersonaModelFn = ({ systemPrompt, userPrompt }) =>
      chatCompletion({
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
        // 结构化任务禁用思考：推理会消耗输出 token 预算
        thinking: settings.disableThinking === false ? { type: 'enabled' } : { type: 'disabled' },
        label: 'persona',
      }).then((res) => ({ content: res.content }));

    const judged = await judgePersona({
      title: args.title,
      sections: args.sections,
      cueHead,
      modelFn,
      // 红线 6：system prompt 单一事实源
      getSystemPrompt: getPersonaSystemPrompt,
    });

    const persona: Persona = {
      videoId: args.videoId,
      promptVersion,
      model: cfg.model,
      role: judged.role,
      expertise: judged.expertise,
      style: judged.style,
      createdAt: new Date().toISOString(),
    };
    // 结果落缓存（写失败不阻断返回）
    try {
      await db.open();
      await db.put(DB.stores.outlines, personaCacheKey(persona.videoId, promptVersion, persona.model), persona);
    } catch {
      /* 缓存写失败忽略 */
    }
    return persona;
  } catch {
    return defaultPersona(args.videoId, promptVersion, model?.model ?? '');
  }
}
