/**
 * prompt 单一事实源 loader（SPEC-03 子任务 3.4，TECH-DESIGN §3.4，红线 6）。
 *
 * 运行时 prompt 正文只存在于 src/prompts/*.md（本目录），构建时经 vite `?raw`
 * 内联为字符串；头注释携带 promptVersion / kind，改动正文必须递增版本
 * （驱动大纲缓存失效）。解析失败在模块加载期即 throw——属构建期问题，应尽早暴露。
 */
import outlinePromptMd from './outline.md?raw';
import outlineRegenerateMd from './outline-regenerate.md?raw';
import conceptMapMd from './concept-map.md?raw';
import segmentQaMd from './segment-qa.md?raw';
import termExplainerMd from './term-explainer.md?raw';
import knowledgeCaptureMd from './knowledge-capture.md?raw';
import personaMd from './persona.md?raw';
import framePlanMd from './frame-plan.md?raw';
import subtitlePunctuateMd from './subtitle-punctuate.md?raw';
import conceptFlowsMd from './concept-flows.md?raw';

export interface PromptHeader {
  promptVersion: string;
  kind: string;
}

/** 头注释格式：`<!-- promptVersion: x.y.z -->` 与 `<!-- kind: name -->` */
const PROMPT_VERSION_RE = /<!--\s*promptVersion:\s*([\w.-]+)\s*-->/;
const KIND_RE = /<!--\s*kind:\s*([\w-]+)\s*-->/;

/** 解析 prompt 文件头注释（promptVersion / kind）；缺失或非法即 throw */
export function parsePromptHeader(raw: string): PromptHeader {
  const version = raw.match(PROMPT_VERSION_RE);
  const kind = raw.match(KIND_RE);
  if (!version || !kind) {
    throw new Error(
      'prompt 文件头注释不完整：需含 <!-- promptVersion: ... --> 与 <!-- kind: ... --> 两行注释',
    );
  }
  return { promptVersion: version[1], kind: kind[1] };
}

/** 去掉文件头部的 HTML 注释块，返回 prompt 正文 */
export function stripPromptHeaderComments(raw: string): string {
  return raw.replace(/^(?:\s*<!--[\s\S]*?-->\s*)+/, '').trim();
}

const OUTLINE_HEADER = parsePromptHeader(outlinePromptMd);
const OUTLINE_REGENERATE_HEADER = parsePromptHeader(outlineRegenerateMd);
const CONCEPT_MAP_HEADER = parsePromptHeader(conceptMapMd);
const TERM_EXPLAINER_HEADER = parsePromptHeader(termExplainerMd);
const SEGMENT_QA_HEADER = parsePromptHeader(segmentQaMd);
const KNOWLEDGE_CAPTURE_HEADER = parsePromptHeader(knowledgeCaptureMd);
const PERSONA_HEADER = parsePromptHeader(personaMd);
const FRAME_PLAN_HEADER = parsePromptHeader(framePlanMd);
const SUBTITLE_PUNCTUATE_HEADER = parsePromptHeader(subtitlePunctuateMd);
const CONCEPT_FLOWS_HEADER = parsePromptHeader(conceptFlowsMd);

/** 各 prompt 当前版本（来自文件头注释，单一事实源） */
export const PROMPT_VERSIONS = {
  outline: OUTLINE_HEADER.promptVersion,
  outlineRegenerate: OUTLINE_REGENERATE_HEADER.promptVersion,
  conceptMap: CONCEPT_MAP_HEADER.promptVersion,
  termExplainer: TERM_EXPLAINER_HEADER.promptVersion,
  segmentQa: SEGMENT_QA_HEADER.promptVersion,
  knowledgeCapture: KNOWLEDGE_CAPTURE_HEADER.promptVersion,
  persona: PERSONA_HEADER.promptVersion,
  framePlan: FRAME_PLAN_HEADER.promptVersion,
  subtitlePunctuate: SUBTITLE_PUNCTUATE_HEADER.promptVersion,
  conceptFlows: CONCEPT_FLOWS_HEADER.promptVersion,
} as const;

/** 大纲生成 system prompt 正文（单一事实源：src/prompts/outline.md） */
export function getOutlineSystemPrompt(): string {
  return stripPromptHeaderComments(outlinePromptMd);
}

/** 单章重生成 system prompt 正文（单一事实源：src/prompts/outline-regenerate.md） */
export function getOutlineRegenerateSystemPrompt(): string {
  return stripPromptHeaderComments(outlineRegenerateMd);
}

/** 概念知识图 system prompt 正文（单一事实源：src/prompts/concept-map.md，SPEC-04 范围变更） */
export function getConceptMapSystemPrompt(): string {
  return stripPromptHeaderComments(conceptMapMd);
}

/** 术语解释 system prompt 正文（单一事实源：src/prompts/term-explainer.md，SPEC-05） */
export function getTermExplainerSystemPrompt(): string {
  return stripPromptHeaderComments(termExplainerMd);
}

/** 区间问答 system prompt 正文（单一事实源：src/prompts/segment-qa.md，SPEC-05） */
export function getSegmentQaSystemPrompt(): string {
  return stripPromptHeaderComments(segmentQaMd);
}

/**
 * 知识捕获 system prompt 正文（单一事实源：src/prompts/knowledge-capture.md，SPEC-06）。
 * 本期仅预留未来模型辅助摘要：frontmatter 与去重由代码确定性实现，落盘链路不调用本 prompt。
 */
export function getKnowledgeCaptureSystemPrompt(): string {
  return stripPromptHeaderComments(knowledgeCaptureMd);
}

/**
 * 问答动态角色判定 system prompt 正文（单一事实源：src/prompts/persona.md）。
 * 每视频一次判定（judgePersona）后缓存，注入问答时只追加角色设定，不覆盖既有规则。
 */
export function getPersonaSystemPrompt(): string {
  return stripPromptHeaderComments(personaMd);
}

/**
 * 抽帧规划 system prompt 正文（单一事实源：src/prompts/frame-plan.md）。
 * 模型规划失败时回退确定性公式（core/vision/framePlanner）。
 */
export function getFramePlanSystemPrompt(): string {
  return stripPromptHeaderComments(framePlanMd);
}

/** AI 字幕顺句 system prompt 正文（单一事实源：src/prompts/subtitle-punctuate.md，SPEC-08 8.5） */
export function getSubtitlePunctuateSystemPrompt(): string {
  return stripPromptHeaderComments(subtitlePunctuateMd);
}

/** 概念关系边生成 system prompt（单一事实源：src/prompts/concept-flows.md，冒烟 3b 二轮） */
export function getConceptFlowsSystemPrompt(): string {
  return stripPromptHeaderComments(conceptFlowsMd);
}
