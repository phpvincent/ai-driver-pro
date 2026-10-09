/**
 * 概念知识图 pipeline（SPEC-04 四次迭代：知识流程图，阶段流）。
 *
 * 输入为已生成的章节大纲（Section[]，时间结构），输出为阶段流知识结构
 * （stages: [{label, concepts:[{label, importance, anchors, details}]}]）：
 * - buildConceptMap：单次结构化模型调用 + zod 校验（红线 1：确定性单调用，
 *   非 agent loop）+ 失败附错误重试 1 次，两次失败 throw 由调用方降级；
 * - 预告章节过滤（确定性，P8 洞察）：前两章中章节文本命中全部概念 ≥50%
 *   → 视为预告章，其 startMs 不进入任何 anchor（修复 00:01 开场锚点 bug）；
 * - 主锚：anchors 中 score 最高的章节排首位（primaryAnchorTMs），其余按
 *   startMs 升序；阶段顺序 = 模型输出推进顺序，阶段内概念保留模型顺序；
 * - buildTermIndexMap：零模型确定性降级（术语按出现章节聚合，stages 形状）；
 * - 概念时间锚 = 出现章节的 startMs（大纲管线吸附产物，红线 2）。
 * 纯函数 + 注入式模型调用（ConceptModelFn），无 chrome.* 依赖。
 */
import { CONCEPT_MAP } from '../../config';
import type { ConceptAnchor, ConceptFlow, ConceptItem, ConceptStage, Section } from '../../types';
import { formatTimecode } from './prompts';
import { parseJsonLoose, withRepairHint } from './jsonRepair';
import type {
  ConceptModelFn,
  ConceptRaw,
  ConceptStagesRaw,
  PipelineImage,
} from './types';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema 与解析（红线 4 同款：JSON.parse + zod，失败 throw 由重试捕获）
// ---------------------------------------------------------------------------

/** 模型输出整体 Schema：{stages:[{label, concepts:[...]}]}
 * （沿用二次迭代策略：label/detail 用硬上限（30/40）防注入式超长；超
 *  labelMax 的常见输出（13~16 字）不再硬拒，由构树代码 shortenLabel 截断） */
export const ConceptStagesSchema = z.object({
  stages: z
    .array(
      z.object({
        label: z.string().min(1).max(CONCEPT_MAP.stageLabelMax),
        concepts: z
          .array(
            z.object({
              label: z.string().min(1).max(CONCEPT_MAP.labelHardMax),
              importance: z.number().int().min(1).max(5),
              anchorSections: z.array(z.number().int().nonnegative()),
              details: z
                .array(z.string().min(1).max(CONCEPT_MAP.detailHardMax))
                .max(CONCEPT_MAP.detailsMax),
            }),
          )
          .min(CONCEPT_MAP.conceptsPerStageMin)
          .max(CONCEPT_MAP.conceptsPerStageMax),
      }),
    )
    .min(CONCEPT_MAP.stagesMin)
    .max(CONCEPT_MAP.stagesMax),
  /** 概念间关系边（可选；draw.io 式流程的关键，缺省时流程视图退化为顺序边） */
  flows: z
    .array(
      z.object({
        from: z.string().min(1).max(30),
        to: z.string().min(1).max(30),
        label: z.string().min(1).max(12).optional(),
      }),
    )
    .max(30)
    .optional(),
});

/** 关系边独立生成（冒烟 3b 二轮：与概念图分开，省 token）的输出 Schema */
export const ConceptFlowsSchema = z.object({
  flows: z.array(
    z.object({
      from: z.string().min(1).max(30),
      to: z.string().min(1).max(30),
      label: z.string().min(1).max(12).optional(),
    }),
  ),
});

/** 解析关系边输出（宽松 JSON 修复同口径）；非法 throw（调用方提示重试） */
export function parseConceptFlows(content: string): ConceptStagesRaw['flows'] {
  const loose = parseJsonLoose(content);
  let rawValue: unknown = null;
  if (loose !== null) rawValue = loose.value;
  else {
    try {
      rawValue = JSON.parse(content);
    } catch {
      rawValue = null;
    }
  }
  const parsed = ConceptFlowsSchema.safeParse(rawValue);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`关系边输出未通过校验：${issues}`);
  }
  return parsed.data.flows;
}

/**
 * 解析并校验模型输出：JSON.parse（失败时尝试修复**被截断**的输出）+ 概念形状
 * 归一化 + ConceptStagesSchema。
 * 解析/校验失败 throw，由 buildConceptMap 的重试逻辑捕获。
 *
 * 截断是最常见的失败形态（最外层 `}` 缺失，或最后一个阶段只输出一半），此时重试
 * 往往得到同样的截断结果；故先由代码补齐闭合括号，实在不行才判失败。
 */
export function parseConceptStages(content: string): ConceptStagesRaw {
  const loose = parseJsonLoose(content);
  if (loose === null) {
    let message = '未知原因';
    try {
      JSON.parse(content);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    throw new Error(`模型输出不是合法 JSON：${message}`);
  }
  const parsed = ConceptStagesSchema.safeParse(normalizeConceptStages(loose.value));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(withRepairHint(`模型输出未通过 Schema 校验：${issues}`, loose.repaired));
  }
  return parsed.data;
}

/**
 * 概念输出形状归一化（确定性，红线 1；与 jsonRepair 同哲学：能救则救，SPEC-10 10.3）。
 * 实测失败形态（qwen3.5-flash）：stages 数组里先输出完整阶段对象，随后混入
 * 字符串/数字/数组等垃圾元素（弱模型抄 prompt 片段的典型畸形）。整批拒绝太
 * 可惜——垃圾元素丢弃、合法对象保留：
 * - stages：只留对象元素（数组/字符串/数字等丢弃），截到 stagesMax（保序取前 N）；
 * - 每阶段 concepts：只留对象元素，截到 conceptsPerStageMax；
 * - 每概念 details：只留字符串元素。
 * 全合法输入恒等返回（幂等）；归一化后仍不满足 Schema（如阶段 < 3）由 zod 如实报出。
 */
export function normalizeConceptStages(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.stages)) return value;
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v != null && typeof v === 'object' && !Array.isArray(v);
  const stages = root.stages
    .filter(isPlainObject)
    .map((stage) => {
      if (!Array.isArray(stage.concepts)) return stage;
      const concepts = stage.concepts
        .filter(isPlainObject)
        .map((concept) => {
          if (!Array.isArray(concept.details)) return concept;
          return {
            ...concept,
            details: concept.details.filter((d): d is string => typeof d === 'string'),
          };
        })
        .slice(0, CONCEPT_MAP.conceptsPerStageMax);
      return { ...stage, concepts };
    })
    .slice(0, CONCEPT_MAP.stagesMax);
  return { ...root, stages };
}

// ---------------------------------------------------------------------------
// 纯工具
// ---------------------------------------------------------------------------

/**
 * 标签截断（代码强制 ≤max 字）：超长截断并以省略号结尾（总长 ≤max）。
 * 按码点计数（中文等宽：1 个汉字算 1 字，不按 UTF-16 单元）。
 */
export function shortenLabel(s: string, max: number = CONCEPT_MAP.labelMax): string {
  const chars = Array.from(s.trim());
  if (max <= 1) return chars.slice(0, 1).join('');
  if (chars.length <= max) return chars.join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}

/** clamp importance 到 1-5（防御模型边界值，zod 已保证正常路径） */
function clampImportance(n: number): number {
  return Math.max(1, Math.min(5, Math.round(n)));
}

/** 章节得分（score 缺省视为 -1：任何有分数的章节主锚优先级更高） */
function sectionScore(s: Section): number {
  return s.score != null ? s.score : -1;
}

/**
 * 组装模型 user prompt（纯函数）：章节编号 + 标题 + 分数 + 重要性 + 摘要 + 术语。
 * 编号从 1 开始，模型输出的 anchorSections 引用这些编号。
 */
export function buildConceptMapUserPrompt(sections: Section[], videoTitle: string): string {
  const lines = [`视频标题：${videoTitle}`, '以下是该视频的章节列表（按时间顺序编号）：'];
  sections.forEach((s, i) => {
    const score = s.score != null ? `${s.score}分` : '无分数';
    const terms = s.terms.length > 0 ? s.terms.join('、') : '无';
    lines.push(
      `[${i + 1}] ${s.title} | ${score} | 重要性${s.importance} | ${s.summary} | 术语：${terms}`,
    );
  });
  lines.push('请将上述章节重组为知识流程（阶段 → 概念），输出严格 JSON。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 预告章节识别与锚点构造（确定性，红线 1）
// ---------------------------------------------------------------------------

/**
 * 全片关键帧的画面说明行（确定性拼接，红线 1；图像是独立模态，不占章节文本预算）。
 * 时间点 = 帧的 timeMs（mm:ss）；无 timeMs 时按序号标注。无图 → ''（旧行为不变）。
 */
export function describeMapImages(images?: PipelineImage[] | null): string {
  if (!images || images.length === 0) return '';
  const times = images.map((image, i) =>
    typeof image.timeMs === 'number' && Number.isFinite(image.timeMs)
      ? formatTimecode(image.timeMs)
      : `第 ${i + 1} 张`,
  );
  const paired = images.some((image) => typeof image.caption === 'string' && image.caption.length > 0);
  if (!paired) {
    return `以下附带 ${images.length} 张课程画面（时间点：${times.join('、')}），请结合画面中的标题、代码、图示理解内容结构。`;
  }
  // 配对模式：每张图前紧贴【画面 i/N · 时间 · 第几章 · 章节开头/知识点/结尾】+ 此刻字幕
  return (
    `以下附带 ${images.length} 张课程画面，每张图前都有一行【说明】标出它属于第几章、处于章节开头/知识点/结尾，以及此刻字幕。\n` +
    '使用方式：①把同一章的"开头"与"结尾"画面对照，看出本章从什么问题出发、推进到什么结论，据此划分阶段；' +
    '②画面中的标题、代码、图示、界面文字是字幕说不清的信息，概念与细节优先从画面中提炼（仍须与章节内容一致，禁止编造）；' +
    '③画面与字幕冲突时以字幕为准，画面看不清时不要臆测其中的文字。'
  );
}

/**
 * 预告章节识别（确定性，导出供单测）：对每个章节（仅前
 * CONCEPT_MAP.overviewSectionMaxIndex 个）统计其 title+summary+terms 归一化
 * 拼接命中的概念 label 数，命中比例 ≥ overviewHitRatio（50%）→ 预告章。
 * 返回被标记章节的下标集合（0-based）；其 startMs 不进入任何 anchor。
 */
export function findOverviewSectionIndices(
  raw: ConceptStagesRaw,
  sections: Section[],
): ReadonlySet<number> {
  const labels = new Set<string>();
  for (const stage of raw.stages) {
    for (const c of stage.concepts) {
      const label = c.label.trim().toLowerCase();
      if (label) labels.add(label);
    }
  }
  const overview = new Set<number>();
  if (labels.size === 0) return overview;
  sections.forEach((sec, idx) => {
    if (idx >= CONCEPT_MAP.overviewSectionMaxIndex) return;
    const text = `${sec.title} ${sec.summary} ${sec.terms.join(' ')}`
      .trim()
      .toLowerCase();
    if (!text) return;
    let hits = 0;
    for (const label of labels) {
      if (text.includes(label)) hits += 1;
    }
    if (hits / labels.size >= CONCEPT_MAP.overviewHitRatio) {
      overview.add(idx);
    }
  });
  return overview;
}

/**
 * anchorSections（1-based 章节编号）→ 时间锚（纯函数，确定性）：
 * - 越界 / 非整数编号丢弃（模型幻觉防御）；预告章节排除（不贡献锚点）；
 * - 主锚 = 剩余章节中 score 最高者（并列取时间最早，确定性），排 anchors[0]；
 * - 其余锚按 startMs 升序跟随；无有效锚返回空数组。
 */
export function buildConceptAnchors(
  anchorSections: number[],
  sections: Section[],
  overview: ReadonlySet<number>,
  /** 章内细分锚（可选）：概念在本阶段的序号与阶段内概念总数，用于把同章概念错开到不同要点 */
  spread?: { indexInStage: number; stageConceptCount: number },
): ConceptAnchor[] {
  const seen = new Set<string>();
  const valid: Section[] = [];
  for (const n of new Set(anchorSections)) {
    if (!Number.isInteger(n) || n < 1 || n > sections.length) continue;
    if (overview.has(n - 1)) continue;
    const sec = sections[n - 1];
    if (!seen.has(sec.id)) {
      seen.add(sec.id);
      valid.push(sec);
    }
  }
  valid.sort((a, b) => a.startMs - b.startMs);
  if (valid.length === 0) return [];
  let primary = valid[0];
  for (const sec of valid) {
    if (sectionScore(sec) > sectionScore(primary)) primary = sec;
  }
  const rest = valid.filter((s) => s !== primary);
  const pickTime = (s: Section): number => {
    // 冒烟 3a：同章多个概念此前全部锚在章节起点（00:00）。章节有要点时，
    // 按概念在阶段内的顺序取对应要点的时间（确定性、循环取），讲解顺序即时间顺序。
    const bullets = (s.bullets ?? []).filter((b) => Number.isFinite(b.startMs));
    if (bullets.length === 0 || !spread || spread.stageConceptCount <= 0) return s.startMs;
    const idx = spread.indexInStage % bullets.length;
    return bullets[idx]!.startMs;
  };
  return [primary, ...rest].map((s) => ({ tMs: pickTime(s), sectionId: s.id }));
}

// ---------------------------------------------------------------------------
// 构阶段流（zod 校验后的 raw → ConceptStage[]）
// ---------------------------------------------------------------------------

/**
 * 原始输出 → 阶段流（纯函数）：
 * - 阶段顺序 = 模型输出顺序（讲解推进顺序）；阶段内概念保留模型顺序
 *   （模型顺序即讲解顺序，不重排）；
 * - 阶段 / 概念 id 重编（st_01 / cm_0001）；
 * - anchors：预告章节过滤 + 主锚（score 最高）排首位；
 * - 所有 label 代码强制截断（阶段 ≤20、概念 ≤12、细节 ≤20）。
 */
export function buildStagesFromRaw(
  raw: ConceptStagesRaw,
  sections: Section[],
): ConceptStage[] {
  const overview = findOverviewSectionIndices(raw, sections);
  let cmSeq = 0;
  return raw.stages.map((stage, si) => {
    const concepts: ConceptItem[] = stage.concepts.map((c: ConceptRaw, ci) => {
      const anchors = buildConceptAnchors(c.anchorSections, sections, overview, {
        indexInStage: ci,
        stageConceptCount: stage.concepts.length,
      });
      cmSeq += 1;
      return {
        id: `cm_${String(cmSeq).padStart(4, '0')}`,
        label: shortenLabel(c.label, CONCEPT_MAP.labelMax),
        importance: clampImportance(c.importance),
        anchors,
        primaryAnchorTMs: anchors.length > 0 ? anchors[0].tMs : -1,
        details: c.details.map((d) => shortenLabel(d, CONCEPT_MAP.detailLabelMax)),
      };
    });
    return {
      id: `st_${String(si + 1).padStart(2, '0')}`,
      label: shortenLabel(stage.label, CONCEPT_MAP.stageLabelMax),
      concepts,
    };
  });
}

/**
 * 模型输出的 flows（label 引用）→ ConceptFlow（id 引用）纯函数：
 * - from/to 按概念 label 归一化匹配（trim + 小写）；同 label 多个概念取首个（确定性）；
 * - 引用不存在 / 自环 / 重复边 丢弃；
 * - 输出顺序保持模型顺序（渲染不重排）。
 */
export function resolveFlows(
  raw: ConceptStagesRaw['flows'],
  stages: ConceptStage[],
): ConceptFlow[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const idByLabel = new Map<string, string>();
  for (const stage of stages) {
    for (const c of stage.concepts) {
      const key = c.label.trim().toLowerCase();
      if (!idByLabel.has(key)) idByLabel.set(key, c.id);
    }
  }
  const out: ConceptFlow[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const fromId = idByLabel.get(normalizeFlowLabel(f.from));
    const toId = idByLabel.get(normalizeFlowLabel(f.to));
    if (!fromId || !toId || fromId === toId) continue;
    const key = `${fromId}->${toId}:${f.label ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fromId, toId, ...(f.label ? { label: f.label } : {}) });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 关系边端点归一化（冒烟 3b 三轮）：模型常把清单编号前缀一并抄进 from/to
 * （实测 qwen3.5-flash 返回 "S1-2 实线含义"），剥掉常见前缀再做精确匹配。
 * 前缀形态：S1-2 / 1-2 / 1. / 1、 / 1) / - / • 等。
 */
function normalizeFlowLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^s?\d+(?:-\d+)?(?:\s*[.、)）]\s*|\s+)/, '')
    .replace(/^[\-•·]\s+/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// 模型路径（buildConceptMap）与确定性降级（buildTermIndexMap）
// ---------------------------------------------------------------------------

export interface BuildConceptMapArgs {
  sections: Section[];
  videoTitle: string;
  modelFn: ConceptModelFn;
  /** system prompt 单一事实源注入（红线 6：调用方传 getConceptMapSystemPrompt） */
  getSystemPrompt: () => string;
  /** 解析失败附错误重试次数，默认 CONCEPT_MAP.maxRetries（1） */
  maxRetries?: number;
  /** 全片抽样的教学画面关键帧（调用方注入；不传则 req.images 为 undefined） */
  images?: PipelineImage[];
}

/** 生成成功结果（降级图用 degraded: true 区分，见 buildTermIndexMap） */
export interface ConceptMapBuildResult {
  stages: ConceptStage[];
  /** 概念间关系边（模型输出；无 = undefined） */
  flows?: ConceptFlow[];
  degraded: false;
}

/**
 * 概念图生成主入口：单次结构化模型调用 → zod 校验 → 构阶段流。
 * 失败附错误重试 1 次；两次失败 throw（由调用方降级到术语关联图）。
 */
export async function buildConceptMap(
  args: BuildConceptMapArgs,
): Promise<ConceptMapBuildResult> {
  if (args.sections.length === 0) {
    throw new Error('无章节可用：请先生成大纲');
  }
  const maxRetries = args.maxRetries ?? CONCEPT_MAP.maxRetries;
  const imageNote = describeMapImages(args.images);
  const plainUserPrompt = buildConceptMapUserPrompt(args.sections, args.videoTitle);
  const baseUserPrompt = imageNote ? `${plainUserPrompt}\n${imageNote}` : plainUserPrompt;

  let lastError = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 截断（输出在 JSON 结束前就没了）是最常见的失败形态：同样的上下文重试大概率
    // 得到同样的截断，故重试提示必须明确要求"输出更短、务必闭合"，而不是泛泛重来。
    // 形状错误（stages 混入非对象元素）次之：明确告诉模型该长什么样。
    const truncated = lastError.includes('不是合法 JSON');
    const nonObject = lastError.includes('expected object');
    const retryHint = truncated
      ? '上次输出在 JSON 结束前就被截断了。请压缩内容：阶段取 3 个、每阶段概念不超过 4 个、每条 details 尽量短，务必输出完整闭合的 JSON。'
      : nonObject
        ? '上次输出的 stages 数组里混入了字符串、数字或数组等非对象元素。stages 的每个元素必须且只能是 {"label":"阶段名","concepts":[{"label":"概念名","importance":3,"anchorSections":[1],"details":[""]}]} 形态的对象，共 3~5 个。请重新输出严格符合要求的 JSON。'
        : '请重新输出严格符合要求的 JSON，不要包含任何其他文字。';
    const userPrompt =
      attempt === 0
        ? baseUserPrompt
        : `${baseUserPrompt}\n\n[重试] 上一次输出未通过校验：${lastError}\n${retryHint}`;
    try {
      const res = await args.modelFn({
        systemPrompt: args.getSystemPrompt(),
        userPrompt,
        images: args.images,
      });
      const raw = parseConceptStages(res.content);
      const stages = buildStagesFromRaw(raw, args.sections);
      return {
        stages,
        flows: resolveFlows(raw.flows, stages),
        degraded: false,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`概念图生成失败（重试 ${maxRetries} 次后仍失败）：${lastError}`);
}

/** 术语关联图降级结果（stages 形状，与模型路径同构） */
export interface TermIndexResult {
  stages: ConceptStage[];
  degraded: true;
}

/**
 * 确定性降级（零模型，红线 1）：全片术语去重（大小写不敏感）后
 * 按出现章节数降序取前 N，单阶段「核心术语」，每术语一个概念
 * （importance = min(5, 出现章节数)，anchors = 出现章节起点，主锚 = 首个），
 * 无 details。排序并列时按首次出现顺序（确定性）。
 */
export function buildTermIndexMap(sections: Section[]): TermIndexResult {
  interface TermEntry {
    label: string;
    firstIndex: number;
    sections: Section[];
  }
  const byKey = new Map<string, TermEntry>();
  sections.forEach((sec, idx) => {
    for (const term of sec.terms) {
      const label = term.trim();
      if (!label) continue;
      const key = label.toLowerCase();
      const entry = byKey.get(key);
      if (entry) {
        if (!entry.sections.includes(sec)) entry.sections.push(sec);
      } else {
        byKey.set(key, { label, firstIndex: idx, sections: [sec] });
      }
    }
  });

  const top = [...byKey.values()]
    .sort(
      (a, b) =>
        b.sections.length - a.sections.length || a.firstIndex - b.firstIndex,
    )
    .slice(0, CONCEPT_MAP.termsTop);

  const concepts: ConceptItem[] = top.map((entry, i) => {
    const anchors: ConceptAnchor[] = entry.sections
      .map((s) => ({ tMs: s.startMs, sectionId: s.id }))
      .sort((a, b) => a.tMs - b.tMs);
    return {
      id: `cm_${String(i + 1).padStart(4, '0')}`,
      label: shortenLabel(entry.label, CONCEPT_MAP.labelMax),
      importance: Math.min(5, entry.sections.length),
      anchors,
      primaryAnchorTMs: anchors.length > 0 ? anchors[0].tMs : -1,
      details: [],
    };
  });

  const stages: ConceptStage[] =
    concepts.length > 0
      ? [
          {
            id: 'st_01',
            label: CONCEPT_MAP.fallbackStageLabel,
            concepts,
          },
        ]
      : [];
  return { stages, degraded: true };
}

export type { ConceptRaw, ConceptStagesRaw, ConceptStageRaw, PipelineImage } from './types';
