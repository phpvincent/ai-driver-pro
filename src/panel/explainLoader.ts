/**
 * 问答组装层（SPEC-05 父 agent 接线）：explain pipeline + 真实 prompt
 * （prompts/index 单一事实源，红线 6）+ qaHistory 落库（buildQaRecord 盖章）。
 * ChatTab 的 explain props 由本模块实现。
 */
import { findSectionAt } from '../core/context/compiler';
import { modelSupportsVisionOf, resolveModel, visionActiveFor } from './settings/modelForm';
import { setGenerationSource } from './generationTrace';
import { VISION } from '../config';
import { planFrames } from './framesClient';
import { chatCompletion } from '../core/harness/modelClient';
import {
  buildKnowledgeContext,
  extractQueryTerms,
  searchIndex,
} from '../core/knowledge/retriever';
import {
  answerSegment,
  buildQaRecord,
  explainTerm,
  type ExplainInput,
  type ExplainModelFn,
} from '../core/pipeline/explain';
import { MSG } from '../messages';
import {
  getSegmentQaSystemPrompt,
  getTermExplainerSystemPrompt,
  PROMPT_VERSIONS,
} from '../prompts';
import { createSubtitleDb, getOutline, getSubtitle, saveQaRecord } from '../storage/db';
import type { Cue, KnowledgeHit, QaRecord, Section, Settings } from '../types';
import type { ExplainRequest, ExplainResponse } from './ChatTab';
import { getObsidianConfig, readIndex } from './obsidianLoader';
import { personaInstruction } from '../core/pipeline/persona';
import { getPersonaCached } from './personaLoader';
import { buildWebContext, searchWeb, trimSnippets } from '../core/knowledge/webSearch';
import { CONTEXT } from '../config';
import { frameBudgetFor } from '../core/vision/framePlanner';
import { captionFrame } from '../core/vision/structuralCandidates';
import { uploadCaption, uploadQuestionNote } from './uploadImage';
import type { WebSnippet } from '../core/knowledge/webSearch';
import type { CapturedFrame } from '../messages';

const db = createSubtitleDb();

/** App 当前视频 id 的共享 ref（App 接线时设置，explain 时读取） */
export const currentVideoIdRef: { value: string | null } = { value: null };
/** 当前视频元信息（App 同步）：问答上下文注入【视频信息】块，模型可直接回答时长/标题类问题 */
export const currentVideoMetaRef: { value: { title?: string; durationMs?: number } | null } = {
  value: null,
};

/** chrome.runtime.sendMessage 安全包装 */
function sendRuntimeMessage(message: unknown): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve(null);
  }
}

/** 读完整 settings（model 分区 + 知识库检索开关等顶层项） */
async function fetchSettings(): Promise<Record<string, unknown>> {
  const response = await sendRuntimeMessage({ type: MSG.GET_SETTINGS });
  const stored = (response ?? {}) as Record<string, unknown>;
  return stored && typeof stored === 'object' ? stored : {};
}

/**
 * 个人知识库检索（SPEC-05 范围变更第 4 条）：
 * 开关闭合 + Obsidian 已配置时才检索；任何异常（未配置 / 未启动 / 索引缺失）
 * 一律静默降级为空上下文，不阻断问答（红线 8 精神）。
 */
async function loadKnowledge(args: {
  question: string;
  sections: Section[];
  positionMs: number;
  enabled: boolean;
}): Promise<{ hits: KnowledgeHit[]; context: string }> {
  if (!args.enabled) return { hits: [], context: '' };
  try {
    const obsidianConfig = await getObsidianConfig();
    if (!obsidianConfig) return { hits: [], context: '' };
    const index = await readIndex(obsidianConfig);
    const section = findSectionAt(args.sections, args.positionMs);
    const queryTerms = extractQueryTerms({
      question: args.question,
      sectionTerms: section?.terms,
      positionMs: args.positionMs,
    });
    const hits = searchIndex({ index, queryTerms });
    return { hits, context: buildKnowledgeContext(hits) };
  } catch {
    return { hits: [], context: '' };
  }
}

/** ChatTab explain props 的实现（App 接线传入） */
/**
 * 公开资料检索（内置 DuckDuckGo，免配置、用户无感知）：
 * 每次问答自动检索一次；失败 / 超时 / 无结果一律返回空，回答照常（红线 8）。
 * 结果走与字幕、知识库同一预算（红线 3）。
 */
async function loadWeb(query: string): Promise<{ snippets: WebSnippet[]; context: string }> {
  try {
    const raw = await searchWeb(
      query,
      ((url: string, init?: RequestInit) => fetch(url, init)) as never,
    );
    const snippets = trimSnippets(raw, CONTEXT.webContextMaxChars);
    return { snippets, context: buildWebContext(snippets, CONTEXT.webContextMaxChars) };
  } catch {
    return { snippets: [], context: '' };
  }
}

/**
 * 关键帧抽取（视觉问答）：向 content 请求区间内若干帧。
 * 需要用户开启"结合画面回答"；content 未就绪 / videoId 不符 / 抽帧失败 → 空数组。
 */
async function loadFrames(args: {
  enabled: boolean;
  videoId: string;
  rangeMs: [number, number] | null;
  positionMs: number;
  cues: Cue[];
  /** 已有大纲的章节：用于生成"章节开头/知识点/结尾"候选（区间内的部分） */
  sections?: Section[];
}): Promise<CapturedFrame[]> {
  if (!args.enabled) return [];
  const [start, end] = args.rangeMs ?? [args.positionMs - 30_000, args.positionMs + 30_000];
  // 模型优先（区间内如何抽最能回答问题），失败/未配置则回退确定性公式
  const rangeCues = args.cues.filter((c) => c.startMs >= start && c.startMs < end);
  const targets = (
    await planFrames({
      videoId: args.videoId,
      module: 'qa',
      cues: rangeCues.length > 0 ? rangeCues : args.cues,
      // 只取与区间相交的章节，并把边界裁到区间内（候选才不会落到区间外）
      sections: (args.sections ?? [])
        .filter((s) => s.startMs < end && s.endMs > start)
        .map((s) => ({ ...s, startMs: Math.max(s.startMs, start), endMs: Math.min(s.endMs, end) })),
      durationMs: Math.max(end, args.cues[args.cues.length - 1]?.endMs ?? end),
      budget: frameBudgetFor('qa', Math.max(0, end - start)),
      meta: currentVideoMetaRef.value
        ? { title: currentVideoMetaRef.value.title, page: undefined }
        : undefined,
    })
  )
    .filter((t) => Number.isFinite(t) && t >= 0)
    .slice(0, frameBudgetFor('qa', Math.max(0, end - start)));
  // 模型规划可能给出区间外的时间点：问答只关心本区间，越界点丢弃后由去重闸门兜底
  if (targets.length === 0) return [];
  try {
    const response = (await sendRuntimeMessage({
      type: MSG.CAPTURE_FRAMES,
      payload: { videoId: args.videoId, targetsMs: targets },
    })) as { frames?: CapturedFrame[] } | null;
    return Array.isArray(response?.frames) ? response!.frames! : [];
  } catch {
    return [];
  }
}

export async function explain(args: ExplainRequest): Promise<ExplainResponse> {
  const settings = (await fetchSettings()) as unknown as Settings;
  // 当前生效模型（大纲 / 导图 / 问答共用一套，不再按模块分别选）
  const model = resolveModel(settings);
  if (!model?.apiKey) {
    setGenerationSource('qa', { kind: 'fallback', reason: '模型未配置' });
    throw new Error('模型未配置：请先在设置页配置模型');
  }
  setGenerationSource('qa', { kind: 'model', model: model.model });
  /** 问答时检索个人知识库（默认开启；未存过该项也视为开启） */
  const knowledgeSearch = settings.knowledgeSearch !== false;

  const videoId = currentVideoIdRef.value;
  if (!videoId) throw new Error('未检测到视频');

  const [subRec, outlineRec] = await Promise.all([
    getSubtitle(db, videoId).catch(() => null),
    getOutline(db, videoId, PROMPT_VERSIONS.outline, model.model).catch(() => null),
  ]);
  const cues: Cue[] = subRec?.cues ?? [];
  const sections: Section[] = outlineRec?.sections ?? [];

  // 知识库检索（术语解释复用当前章节 terms；区间/自由提问用问题原文）
  const knowledge = await loadKnowledge({
    question: args.term ?? args.question,
    sections,
    positionMs: args.positionMs,
    enabled: knowledgeSearch,
  });

  // 公开资料检索（内置 DuckDuckGo，免配置；与字幕/知识库共享预算）
  const web = await loadWeb(args.term ?? args.question);
  // 学生上传的图：只要模型支持图像就发（与抽帧开关无关——用户显式上传，意图明确）
  const uploads = modelSupportsVisionOf(model, settings) ? (args.uploads ?? []) : [];
  if ((args.uploads?.length ?? 0) > 0 && uploads.length === 0) {
    throw new Error('当前模型不支持图片输入：请在设置中切换到多模态模型（如 Qwen-VL）后重试');
  }
  const question = args.question + uploadQuestionNote(uploads.length);

  // 关键帧（可选：需多模态模型，deepseek-chat 不支持视觉）
  const frames = await loadFrames({
    enabled: visionActiveFor({ settings, module: 'qa' }),
    cues,
    sections,
    videoId,
    rangeMs: args.rangeMs,
    positionMs: args.positionMs,
  });

  // 动态角色（每视频一次判定并缓存；失败自动降级默认角色，不阻断问答）
  const persona = await getPersonaCached(videoId, model).catch(() => null);
  const personaHint = persona ? personaInstruction(persona) : '';

  const input: ExplainInput = {
    sections,
    cues,
    // 多轮记忆（SPEC-08 8.4b）：术语解释不传（调用方已过滤）
    dialogue: args.term ? undefined : (args.history ?? undefined),
    rangeMs: args.rangeMs,
    positionMs: args.positionMs,
    videoMeta: currentVideoMetaRef.value ?? undefined,
    // 知识库与公开资料各自带独立分隔标记，合并进同一素材分区
    knowledgeContext: [knowledge.context, web.context].filter(Boolean).join('\n\n'),
    images: [
      // 学生上传的题目排在最前：它是本轮提问的主体，课程画面只是参考
      ...uploads.map((u, i) => ({
        dataBase64: u.dataBase64,
        mime: u.mime,
        caption: uploadCaption(i, uploads.length, u.name),
      })),
      ...frames.map((f, i) => ({
        dataBase64: f.dataBase64,
        mime: 'image/jpeg',
        timeMs: f.actualMs,
        caption: captionFrame(f.actualMs, i, frames.length, sections, cues),
        ...(f.thumbBase64 ? { thumbBase64: f.thumbBase64 } : {}),
      })),
    ],
  };

  // 单模型口径：图片与文本一起发给同一个模型
  const modelFn: ExplainModelFn = ({ systemPrompt, userPrompt, images }) => {
    // 带图的请求走视觉模型（用户可另配 Qwen 等），不带图仍走文本模型
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
      // 多模态：图像由 explain 层透传（需模型支持，如未支持会返回错误由重试逻辑处理）
      images: images?.map((i) => ({ dataBase64: i.dataBase64, mime: i.mime, timeMs: i.timeMs, caption: i.caption, thumbBase64: i.thumbBase64 })),
      label: 'qa',
    }).then((res) => ({ content: res.content }));
  };

  if (args.term) {
    const term = await explainTerm({
      term: args.term,
      input,
      modelFn,
      getSystemPrompt: getTermExplainerSystemPrompt,
      personaInstruction: personaHint,
    });
    const record: QaRecord = buildQaRecord({
      videoId,
      interactionType: 'term',
      input,
      question: args.term,
      answer: `${term.inVideoMeaning}\n\n通用定义：${term.generalDefinition}\n\n类比：${term.analogy}`,
      payload: term,
    });
    await saveQaRecord(db, record).catch(() => {});
    return { term, record, hits: knowledge.hits, sources: web.snippets };
  }

  const answer = await answerSegment({
    question,
    input,
    modelFn,
    getSystemPrompt: getSegmentQaSystemPrompt,
    personaInstruction: personaHint,
  });
  const record: QaRecord = buildQaRecord({
    videoId,
    interactionType: args.rangeMs ? 'segment' : 'free',
    input,
    // 历史只记原问题 + 附图张数（图像本身不落库，避免 IndexedDB 膨胀）
    question: uploads.length > 0 ? `${args.question}（附 ${uploads.length} 张图片）` : args.question,
    answer: answer.answer,
    payload: answer,
  });
  await saveQaRecord(db, record).catch(() => {});
  return { answer, record, sources: web.snippets, hits: knowledge.hits };
}
