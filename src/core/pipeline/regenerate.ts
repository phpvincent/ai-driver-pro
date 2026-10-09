/**
 * 单章重生成管道（SPEC-03 3c 范围变更 2.3）：
 * 用户对某一章不满意时，取该章时间范围内的 cues 重新调模型生成单章，
 * 吸附到 Cue 边界后替换原章节（保留 id/endMs）。
 * 防幻觉约束（红线 2）：候选时间戳超阈值回落原章节起点；反馈仅方向性引导，
 * 事实性内容必须来自字幕（由 prompt 层约束，见 outline-regenerate.md）。
 * 纯函数 + 注入式模型调用，无 chrome.* 依赖。
 */
import { OUTLINE } from '../../config';
import type { Cue, Section } from '../../types';
import { attachDensity } from './density';
import { nearestCueStartMs, snapBullets } from './snap';
import { OutlineChunkSchema, type OutlineModelFn, type SectionCandidate } from './types';

export interface RegenerateOptions {
  /** 被重生成的章节 */
  section: Section;
  /** 全片 cues（时间范围过滤 + 吸附基准都用它） */
  cues: Cue[];
  /** 用户反馈（可空；仅方向性引导） */
  feedback?: string;
  modelFn: OutlineModelFn;
  buildRegenPrompts: (args: {
    section: Section;
    chunkCues: Cue[];
    feedback?: string;
  }) => { systemPrompt: string; userPrompt: string };
  snapMaxDriftMs?: number;
  /** 校验失败重试次数，默认 1 */
  maxRetries?: number;
  /** 模型输出解析（默认复用 SectionCandidateSchema，取 sections[0]） */
  parseModelJson?: (content: string) => SectionCandidate;
}

/** 默认解析：JSON.parse + OutlineChunkSchema（红线 4），取 sections[0] */
function defaultParseModelJson(content: string): SectionCandidate {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`模型输出不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = OutlineChunkSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`模型输出未通过 Schema 校验：${issues}`);
  }
  if (parsed.data.sections.length === 0) {
    throw new Error('模型输出 sections 为空');
  }
  return parsed.data.sections[0];
}

/**
 * 单章重生成：取 section 时间范围内的 cues（startMs ≤ cue.startMs < endMs）→
 * 调 modelFn（经 parseModelJson 校验，失败附错误重试，默认 1 次）→
 * startSec 吸附 Cue 边界（>5s 回落原 section.startMs）→ bullets 同 4.3 规则吸附。
 * 返回新 Section：保留原 id/endMs/cueRange；density/score 为占位值，
 * 由调用方经 rescoreOutline 对全片重算。
 */
export async function regenerateSection(opts: RegenerateOptions): Promise<Section> {
  const { section, cues, feedback, modelFn, buildRegenPrompts } = opts;
  const maxRetries = opts.maxRetries ?? OUTLINE.maxRetries;
  const snapMaxDriftMs = opts.snapMaxDriftMs ?? OUTLINE.snapMaxDriftMs;
  const parseModelJson = opts.parseModelJson ?? defaultParseModelJson;

  // 章节时间范围内的 cues（排序副本保证乱序输入下行为确定，红线 1）
  const chunkCues = cues
    .filter((c) => c.startMs >= section.startMs && c.startMs < section.endMs)
    .sort((a, b) => a.startMs - b.startMs);

  const prompts = buildRegenPrompts({ section, chunkCues, feedback });

  let lastError = '';
  let candidate: SectionCandidate | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 失败附错误信息重试（与 runOutline 的重试策略一致，红线 4 的"重试"落在本层）
    const userPrompt =
      attempt === 0
        ? prompts.userPrompt
        : `${prompts.userPrompt}\n\n[重试] 上一次输出未通过校验：${lastError}\n请重新输出严格符合要求的 JSON，不要包含任何其他文字。`;
    try {
      const res = await modelFn({ systemPrompt: prompts.systemPrompt, userPrompt });
      candidate = parseModelJson(res.content);
      break;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (candidate === null) {
    throw new Error(`单章重生成失败（${section.id}）：${lastError}`);
  }

  // 章节 startSec 吸附：>5s（snapMaxDriftMs）→ 回落原 section.startMs（不采用幻觉时间）
  const starts = cues.map((c) => c.startMs).sort((a, b) => a - b);
  const target = candidate.startSec * 1000;
  const nearest = nearestCueStartMs(starts, target);
  const startMs =
    nearest !== null && Math.abs(nearest - target) <= snapMaxDriftMs
      ? nearest
      : section.startMs;

  // bullets 逐条吸附（与主 pipeline 相同规则：>5s 回落章节起点 + approximate）
  const bullets = snapBullets(candidate.bullets, startMs, starts, snapMaxDriftMs);

  return {
    ...section, // 保留原 id / endMs / cueRange
    title: candidate.title,
    startMs,
    summary: candidate.summary,
    bullets,
    terms: candidate.terms,
    importance: candidate.importance,
    // 占位：调用方替换后用 rescoreOutline 对全片重算 score 与 density
    score: 0,
    density: 'mid',
  };
}

/**
 * 对替换后的全片章节列表重算 score 与 density（复用 computeScores 的
 * min-max 全片归一——单章重生成会改变其他章节的归一基准，必须整体重算）。
 */
export function rescoreOutline(sections: Section[]): Section[] {
  return attachDensity(sections);
}
