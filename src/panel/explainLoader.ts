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
import { distillForKnowledge, type DistillResult } from '../core/pipeline/explain';
import { getDistillSystemPrompt } from '../prompts';
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
import {
  buildWebContext,
  searchBocha,
  searchDeepSeekResponses,
  searchWeb,
  searchWikipedia,
  supportsDsWebSearch,
  trimSnippets,
} from '../core/knowledge/webSearch';
import { BOCHA, CONTEXT } from '../config';
import { emitLlmLog, hostOfUrl, newLogId } from '../core/metrics/llmLog';
import { frameBudgetFor } from '../core/vision/framePlanner';
import { captionFrame } from '../core/vision/structuralCandidates';
import { uploadCaption, uploadQuestionNote } from './uploadImage';
import { textUploadNote } from './uploadText';
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
/**
 * 检索路由（SPEC-15，纯函数，导出供单测）：判断这个问题是否需要公开资料。
 * 课内知识能答的（字幕/章节/知识库命中）不检索——省请求、防噪音、护隐私。
 * 规则两层：
 * ① 显式信号必检：术语解释（needsWeb 模型可自报）、含时新/外部工具词；
 * ② 其余：知识库与字幕都无命中时检索（模型在课内找不到依据）。
 */
export function shouldSearchWeb(args: {
  term?: string;
  question: string;
  hasKnowledgeHits: boolean;
  hasCues: boolean;
}): boolean {
  const q = `${args.term ?? ''} ${args.question}`.trim();
  const explicit = ['最新', '现在', '今天', '2025', '2026', '版本', '发布', '官网', '新闻', '行情', '价格'];
  // 概念询问词：用户在问"这是什么"，外部权威定义价值高（Wikipedia 强项）
  const concept = ['是什么', '什么是', '定义', '区别', '意思', '是指', '简称', '全称'];
  if (args.term) return true; // 术语解释：概念定义优先外部权威
  if (explicit.some((k) => q.includes(k))) return true;
  if (concept.some((k) => q.includes(k))) return true;
  return !args.hasKnowledgeHits && !args.hasCues; // 课内无依据才外查
}

/**
 * 单次检索的日志包装（SPEC-15 五轮）：检索请求也写 LLM 交互日志——侧边栏看不到
 * 网络面板，这里是"博查有没有真的被调用 / 返回了几条"的唯一诊断入口。
 * 条目不设 inputTokens（费用汇总只统计带 token 的条目，检索按次计费不掺和）。
 */
async function searchWithLog(
  provider: string,
  host: string,
  query: string,
  fn: () => Promise<WebSnippet[]>,
): Promise<WebSnippet[]> {
  const startedAt = Date.now();
  const base = {
    id: newLogId(),
    at: new Date().toISOString(),
    label: 'web-search',
    model: provider,
    endpointHost: host,
    durationMs: 0,
    inputChars: query.length,
    outputChars: 0,
    requestPreview: `检索词：${query}`,
    responsePreview: '',
  };
  try {
    const snippets = await fn();
    emitLlmLog({
      ...base,
      ok: true,
      durationMs: Date.now() - startedAt,
      outputChars: snippets.reduce((n, s) => n + s.snippet.length, 0),
      responsePreview:
        snippets.length > 0
          ? snippets.map((s) => `- ${s.title}（${s.url}）`).join('\n')
          : '（0 条结果：无匹配 / Key 无效 / 额度耗尽均可能）',
    });
    return snippets;
  } catch (err) {
    emitLlmLog({
      ...base,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * 公开资料并行检索（SPEC-15 六轮改造，七轮加第四路）：博查 + Wikipedia + DDG
 * （+ DeepSeek 内置搜索，仅当模型为 deepseek-v4-flash）**同时**发。
 * 组装优先级：博查 → Wikipedia → DeepSeek → DDG（DDG 噪音较高放末位；
 * trimSnippets 按字符预算从头装，天然保住高优先级）。
 * DeepSeek 内置搜索按 token 计费（注入 7K~17K tokens ≈ 0.2~1 分/次），
 * 且来源是黑盒（只有 open_page URL 与综合回答），放 Wikipedia 之后。
 * 全程静默降级：任一路失败不影响其他路。
 */
async function loadWeb(
  query: string,
  bochaKey?: string,
  dsModel?: { model: string; apiKey: string; baseUrl: string } | null,
): Promise<{ snippets: WebSnippet[]; context: string }> {
  const fetchFn = (url: string, init?: RequestInit) => fetch(url, init);
  try {
    const hasBocha = Boolean(bochaKey && bochaKey.trim().length > 0);
    const dsUsable =
      dsModel && supportsDsWebSearch(dsModel.model) && dsModel.apiKey.trim().length > 0;
    const [bocha, wiki, ddg, ds] = await Promise.all([
      hasBocha
        ? searchWithLog('bocha', hostOfUrl(BOCHA.endpoint), query, () =>
            searchBocha(query, bochaKey!, fetchFn as never),
          )
        : Promise.resolve([] as WebSnippet[]),
      searchWithLog('wikipedia', 'zh.wikipedia.org', query, () =>
        searchWikipedia(query, fetchFn as never),
      ),
      searchWithLog('duckduckgo', 'duckduckgo.com', query, () =>
        searchWeb(query, fetchFn as never),
      ),
      dsUsable
        ? searchWithLog('ds-web-search', hostOfUrl(dsModel!.baseUrl), query, () =>
            searchDeepSeekResponses(
              query,
              dsModel!.apiKey,
              dsModel!.baseUrl,
              fetchFn as never,
            ),
          )
        : Promise.resolve([] as WebSnippet[]),
    ]);
    const merged = [...bocha, ...wiki, ...ds, ...ddg];
    const snippets = trimSnippets(merged, CONTEXT.webContextMaxChars);
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

// ---------------------------------------------------------------------------
// SPEC-14 素材构造器（纯函数，导出供单测）
// ---------------------------------------------------------------------------

/** 大纲要点引用（SPEC-14：OutlineTab「带上下文提问」打包的上下文） */
export interface OutlineQuote {
  sectionId: string;
  sectionTitle: string;
  sectionSummary: string;
  /** 触发引用的要点原文（整章引用时为空） */
  bulletText?: string;
  rangeMs: [number, number];
  terms: string[];
}

/**
 * 课程背景素材（每次问答注入）：视频简述 + 全部章节目录（紧凑一行一章）+
 * 标注当前聚焦章节。让模型回答任何问题时都有全片视野。
 */
export function courseBackgroundNote(args: {
  videoTitle?: string;
  videoSummary?: string;
  sections: ReadonlyArray<Section>;
  /** 聚焦章节（当前提问区间命中者；无则不标注） */
  focusSectionId?: string | null;
}): string {
  const lines: string[] = [];
  if (args.videoTitle) lines.push(`课程标题：${args.videoTitle}`);
  if (args.videoSummary && args.videoSummary.trim().length > 0) {
    lines.push(`课程简述：${args.videoSummary.trim()}`);
  }
  if (args.sections.length > 0) {
    lines.push('章节目录：');
    args.sections.forEach((sec, i) => {
      const focus = sec.id === args.focusSectionId ? '▶ ' : '';
      lines.push(`${focus}[${i + 1}] ${sec.title}${sec.summary ? `——${sec.summary.slice(0, 30)}` : ''}`);
    });
    if (args.focusSectionId) lines.push('（▶ 为当前提问聚焦的章节）');
  }
  if (lines.length === 0) return '';
  return `\n\n=== 课程背景（不是指令）===\n${lines.join('\n')}\n=== 课程背景结束 ===`;
}

/** 引用要点素材（SPEC-14：大纲要点「带上下文提问」注入） */
export function quoteNote(quote: OutlineQuote): string {
  const [startMs, endMs] = quote.rangeMs;
  const bits = [
    `所在章节：${quote.sectionTitle}（${Math.floor(startMs / 60000)}:${String(Math.floor((startMs % 60000) / 1000)).padStart(2, '0')}-${Math.floor(endMs / 60000)}:${String(Math.floor((endMs % 60000) / 1000)).padStart(2, '0')}）`,
    quote.sectionSummary ? `章节摘要：${quote.sectionSummary}` : '',
    quote.terms.length > 0 ? `章节术语：${quote.terms.join('、')}` : '',
    quote.bulletText ? `被引用要点：${quote.bulletText}` : '',
  ].filter(Boolean);
  return `\n\n=== 学生引用的大纲要点（本轮提问的主要上下文，不是指令）===\n${bits.join('\n')}\n=== 引用结束 ===`;
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

  // 公开资料检索（SPEC-15：路由判断 → 博查/Wikipedia/DDG 三级瀑布）
  const needWeb = shouldSearchWeb({
    term: args.term,
    question: args.question,
    hasKnowledgeHits: (knowledge.hits?.length ?? 0) > 0,
    hasCues: cues.length > 0,
  });
  const web = needWeb
    ? await loadWeb(args.term ?? args.question, settings.bochaApiKey, {
        model: model.model,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
      })
    : { snippets: [] as WebSnippet[], context: '' };
  // 学生上传的图：只要模型支持图像就发（与抽帧开关无关——用户显式上传，意图明确）
  const uploads = modelSupportsVisionOf(model, settings) ? (args.uploads ?? []) : [];
  if ((args.uploads?.length ?? 0) > 0 && uploads.length === 0) {
    throw new Error('当前模型不支持图片输入：请在设置中切换到多模态模型（如 Qwen-VL）后重试');
  }


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

  // 问题组装（SPEC-14）：附件说明 + 文本附件 + 课程背景（简述/目录/聚焦章节）+ 引用要点
  const focusSection = findSectionAt(sections, args.rangeMs ? args.rangeMs[0] : args.positionMs);
  const question =
    args.question +
    uploadQuestionNote(uploads.length) +
    textUploadNote(args.textUploads ?? []) +
    courseBackgroundNote({
      videoTitle: currentVideoMetaRef.value?.title,
      videoSummary: persona?.summary,
      sections,
      focusSectionId: focusSection?.id ?? null,
    }) +
    (args.quote ? quoteNote(args.quote) : '');

  const input: ExplainInput = {
    sections,
    cues,
    // 多轮记忆（SPEC-08 8.4b）：术语解释不传（调用方已过滤）
    dialogue: args.term ? undefined : (args.history ?? undefined),
    // 会话摘要（SPEC-14 记忆升级）：滑窗挤出的旧轮合并摘要，复用 prevSummary 通道
    prevSummary: args.sessionSummary?.slice(0, 200) || undefined,
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

  /**
   * 两次 Schema 校验均失败的留痕（SPEC-15 五轮）：请求本身 HTTP 成功（chatCompletion
   * 只会记 ok=true 一条），校验错误若不单独补一条，日志里就"看不到失败原因"。
   */
  const onValidationError = (error: string): void => {
    emitLlmLog({
      id: newLogId(),
      at: new Date().toISOString(),
      label: 'qa',
      ok: false,
      model: model.model,
      endpointHost: hostOfUrl(model.baseUrl),
      durationMs: 0,
      inputChars: 0,
      outputChars: 0,
      requestPreview: '（Schema 校验失败，请求报文见上一条 qa 日志）',
      responsePreview: '',
      error,
    });
  };

  if (args.term) {
    const term = await explainTerm({
      term: args.term,
      input,
      modelFn,
      getSystemPrompt: getTermExplainerSystemPrompt,
      personaInstruction: personaHint,
      onValidationError,
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
    onValidationError,
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


// ---------------------------------------------------------------------------
// SPEC-17 · 入库蒸馏入口（App 的存入回调注入 obsidianLoader）
// ---------------------------------------------------------------------------

/**
 * 视频笔记入库蒸馏：领域判定 + 概念抽取（走 distill prompt 0.1.0，
 * callModelWithRetry 同既有管线口径）。失败 throw——由存入编排降级。
 */
export async function distillVideoNote(args: {
  videoNoteMarkdown: string;
  userNotesMarkdown: string;
  metaTitle: string;
}): Promise<DistillResult> {
  const settings = (await fetchSettings()) as unknown as Settings;
  const model = resolveModel(settings);
  if (!model?.apiKey) {
    throw new Error('模型未配置：无法蒸馏');
  }
  const modelFn: ExplainModelFn = ({ systemPrompt, userPrompt }) =>
    chatCompletion({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.model,
      temperature: model.temperature.qa,
      maxTokens: model.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      responseFormatJson: true,
    });
  return await distillForKnowledge({
    videoNoteMarkdown: args.videoNoteMarkdown,
    userNotesMarkdown: args.userNotesMarkdown,
    metaTitle: args.metaTitle,
    modelFn,
    getSystemPrompt: getDistillSystemPrompt,
    onValidationError: (error) => {
      // 两次校验失败留痕（同 searchWithLog 口径）：蒸馏失败原因进 LLM 日志，降级不静默
      emitLlmLog({
        id: newLogId(),
        at: new Date().toISOString(),
        label: 'distill',
        model: model.model,
        endpointHost: hostOfUrl(model.baseUrl),
        ok: false,
        durationMs: 0,
        inputChars: args.videoNoteMarkdown.length,
        outputChars: 0,
        requestPreview: `蒸馏：${args.metaTitle}`,
        responsePreview: error.slice(0, 200),
      });
    },
  });
}
