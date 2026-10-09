/**
 * 共享数据契约 —— 仅父 agent 可修改（CONSTITUTION §4）。
 * 权威说明见 TECH-DESIGN.md §4。
 */

/** 视频标识：`{bvid}_p{page}`，URL 无 p 参数时 page = 1 */
export type VideoId = string;

export interface VideoMeta {
  videoId: VideoId;
  bvid: string;
  page: number;
  cid: number;
  /** 分 P 标题 */
  title: string;
  durationMs: number;
  url: string;
}

export interface Cue {
  /** 全局递增序号 */
  index: number;
  /** 毫秒，绝对时间 */
  startMs: number;
  endMs: number;
  text: string;
  /** 时间为估算（手动粘贴无时间戳文本时为 true） */
  approximate?: boolean;
}

export type SubtitleStatus =
  | 'ok'
  | 'no_subtitle'
  | 'need_login'
  | 'api_changed'
  | 'network'
  | 'manual_pasted';

/** UP 主上传字幕 / 平台 AI 字幕 / 手动粘贴 */
export type SubtitleSource = 'bili_uploader' | 'bili_ai' | 'manual';

export interface FetchResult {
  /** 空数组 = 未命中 */
  cues: Cue[];
  status: SubtitleStatus;
  source?: SubtitleSource;
  lang?: string;
  /** 原始错误摘要，进 trace */
  error?: string;
}

export type Density = 'low' | 'mid' | 'high';

/** 章节要点（SPEC-03 3c 范围变更：bullets 升级为带时间戳对象，可点跳播） */
export interface SectionBullet {
  text: string;
  /** 吸附后的 Cue 开始时间（毫秒） */
  startMs: number;
  /** 吸附偏差超阈值回落到章节起点时为 true（UI 可弱化跳播精度提示） */
  approximate?: boolean;
}

export interface Section {
  id: string;
  /** 8-20 字 */
  title: string;
  /** 等于某条 Cue.startMs（吸附后） */
  startMs: number;
  /** 下一章 startMs - 1；末章 = 视频时长 */
  endMs: number;
  /** 40-80 字 */
  summary: string;
  /** 2-5 条（每条带吸附后的开始时间） */
  bullets: SectionBullet[];
  /** 本章出现的技术术语（模型抽取；密度由代码确定性计算） */
  terms: string[];
  /** 1-5，模型给出的章节重要性（SPEC-03 3c） */
  importance: number;
  /** 0-100 综合打分（代码计算：新知识率 45% + 术语密度 25% + importance 30%；density 徽标由 score 分档） */
  score?: number;
  density: Density;
  /** 覆盖的 Cue 序号区间 */
  cueRange: [number, number];
}

export type InteractionType = 'term' | 'segment' | 'free';

export interface QaRecord {
  id: string;
  videoId: VideoId;
  interactionType: InteractionType;
  /** 提问时刻命中的章节 */
  sectionId: string | null;
  /** 提问时刻的播放位置 */
  timestampMs: number;
  /** 区间提问的区间 */
  rangeMs: [number, number] | null;
  question: string;
  /** 渲染后的回答正文 */
  answer: string;
  /** 结构化输出（TermSchema / SegmentAnswerSchema 校验结果） */
  payload: unknown;
  createdAt: string;
}

export interface TermCard {
  term: string;
  /** 在本视频语境中的含义 */
  inVideoMeaning: string;
  generalDefinition: string;
  analogy: string;
  relatedTerms: string[];
  videoId: VideoId;
  /** 带 p 与 t 参数的回放链接 */
  sourceUrl: string;
  timestampMs: number;
  createdAt: string;
}

export type ChunkStatus = 'pending' | 'running' | 'done' | 'failed';

/** 大纲分块状态：断点续跑的粒度 */
export interface ChunkState {
  index: number;
  status: ChunkStatus;
  startMs: number;
  endMs: number;
  inputTokens?: number;
  outputTokens?: number;
  retries?: number;
  error?: string;
}

/** IndexedDB subtitles store 记录，键 videoId */
export interface SubtitleRecord {
  videoId: VideoId;
  meta: VideoMeta;
  source: SubtitleSource | null;
  lang: string | null;
  status: SubtitleStatus;
  cues: Cue[];
  fetchedAt: string;
  /**
   * 顺句后的标记（SPEC-08 8.5）：cues 已是整理后的文本，rawCues 保留 ASR 原文
   * 供"切回原文"。缺省 = 未整理过。
   */
  punctuated?: { promptVersion: string; rawCues: Cue[] };
}

/** IndexedDB outlines store 记录，键 [videoId, promptVersion, model] */
export interface OutlineRecord {
  videoId: VideoId;
  promptVersion: string;
  model: string;
  sections: Section[];
  chunkState: ChunkState[];
  tokenUsage: { input: number; output: number };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 大纲笔记（SPEC-09 9.1）：与大纲解耦存储，大纲重生成不触碰 notes store
// ---------------------------------------------------------------------------

/** 锚点粒度：整章 / 某条要点 / 某个时间点（SPEC-09 §1 用户拍板） */
export type NoteAnchorKind = 'section' | 'bullet' | 'time';

/**
 * 笔记锚点。tMs 是重新归位与跨版本导入的**唯一可靠依据**，创建后永不改写；
 * sectionId / bulletId 只是加速提示，重生成后由 reanchor 按时间重新对上。
 */
export interface NoteAnchor {
  kind: NoteAnchorKind;
  /** 锚点所在章节；未归位为 null */
  sectionId: string | null;
  /** kind=bullet 时指向要点（导出侧合成 `${sectionId}-b${序号}`） */
  bulletId?: string | null;
  /** 锚定时间（毫秒） */
  tMs: number;
}

export type NoteAuthor = 'self' | 'assistant';

/** 讨论串回复；「请助教回答」的回答以 author='assistant' 追加（SPEC-09 9.2） */
export interface NoteReply {
  id: string;
  author: NoteAuthor;
  body: string;
  createdAt: string;
}

/** IndexedDB notes store 记录，键 note.id（SPEC-09 §3.5） */
export interface OutlineNote {
  id: string;
  videoId: VideoId;
  anchor: NoteAnchor;
  /** Markdown 纯文本（v1 不做富文本） */
  body: string;
  createdAt: string;
  updatedAt: string;
  replies: NoteReply[];
  /** 导入来源（导入的笔记与自己的笔记区分显示；自建笔记无此字段） */
  importedFrom?: { exporter: string; exportedAt: string };
}

export interface ModelConfig {
  /** 命名方案名（默认模型无 name；modelProfiles 中的方案必有） */
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: { outline: number; qa: number };
  maxTokens: number;
  /** 单视频大纲 token 预算上限（熔断） */
  outlineTokenBudget: number;
  /** 该模型是否支持图像输入（多模态）。未声明视为不支持；能力随方案走 */
  supportsVision?: boolean;
}

export interface ObsidianConfig {
  baseUrl: string;
  apiKey: string;
  /** 笔记根目录 */
  rootDir: string;
  /** 暂时停用（SPEC-10 二轮冒烟：关掉后存入走本地 .md 下载，凭据保留不擦除） */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// 概念知识图（SPEC-04 四次迭代：知识流程图，导图 = 知识导航）
// ---------------------------------------------------------------------------

/** 概念时间锚：tMs 为该概念出现章节的 startMs（吸附产物，红线 2） */
export interface ConceptAnchor {
  tMs: number;
  sectionId: string;
}

/** 概念（阶段内）：anchors[0] 为主锚（得分最高章节，实心强调），其余次锚按时间升序 */
export interface ConceptItem {
  /** cm_0001... */
  id: string;
  /** ≤12 字短语 */
  label: string;
  /** 1-5 */
  importance: number;
  /** 主锚在前；主锚 = 实质讲解该概念且 score 最高的章节（排除预告章节） */
  anchors: ConceptAnchor[];
  /** 主锚时间（该概念得分最高章节的 startMs；无锚为 -1） */
  primaryAnchorTMs: number;
  /** 补充短语（≤4 条，每条 ≤20 字） */
  details: string[];
}

/** 阶段（讲解推进逻辑的最小单位：概念属于阶段，阶段构成流程） */
export interface ConceptStage {
  /** st_01... */
  id: string;
  /** 阶段名（如"核心机制"，≤20 字） */
  label: string;
  /** 阶段内概念（模型输出顺序 = 讲解顺序，保留不重排） */
  concepts: ConceptItem[];
}

/** 概念图完整数据（缓存于 outlines store，键 concept:: 前缀；阶段流结构，v3） */
/**
 * 知识库索引条目（借鉴 ai-knowlage 的分类目录 + 双索引机制）。
 * 机器检索读 _meta/index.json；人在 Obsidian 看 _索引.md（双链）。
 */
export interface KnowledgeIndexEntry {
  /** 相对 vault 根目录的笔记路径（POSIX） */
  path: string;
  title: string;
  /** 分类：video-note | term */
  category: 'video-note' | 'term' | 'note';
  tags: string[];
  /** 关键词/术语（检索命中源） */
  terms: string[];
  /** 摘要预览（≤200 字；检索只喂预览，红线 3 预算） */
  summaryPreview: string;
  /** 来源视频（视频笔记/术语卡归属） */
  videoId?: string;
  /** ISO 8601 */
  updatedAt: string;
}

export interface KnowledgeIndexFile {
  version: 1;
  entries: KnowledgeIndexEntry[];
}

/** 检索命中结果（供 QA 注入上下文） */
export interface KnowledgeHit {
  entry: KnowledgeIndexEntry;
  /** 命中打分（0~1，确定性计算） */
  score: number;
}

/** 面板设置（GET_SETTINGS / SET_SETTINGS 的形状） */
export interface Settings {
  /**
   * 当前生效的模型（大纲 / 导图 / 问答三模块共用一套，不再按模块分别选）。
   * 其 baseUrl 决定"当前选中哪个预设"，由 modelForm.activePreset() 反推。
   */
  model?: ModelConfig;
  /**
   * 预设槽位：每个内置预设（deepseek / qwen）各自保存一份完整配置（含 API Key）。
   * **这是 Key 的唯一权威存储**：切换预设时各带各的 Key，永不互踩（修复"配了 A 平台
   * B 平台的 Key 就没了"的根因）。设置页 UI 只暴露一个 Key 输入框，槽位对用户不可见。
   */
  modelSlots?: Record<string, ModelConfig>;
  /** @deprecated 不再区分视觉模型：统一使用 model；保留仅为兼容旧设置数据 */
  visionModel?: ModelConfig;
  /** @deprecated 多模态能力随 ModelConfig.supportsVision 走；保留仅为兼容旧设置数据 */
  modelSupportsVision?: boolean;
  /** @deprecated 命名模型方案已废弃（统一为预设槽位）；保留仅为兼容旧设置数据的迁移 */
  modelProfiles?: ModelConfig[];
  /** @deprecated 按模块选模型已废弃（三模块共用一套）；保留仅为兼容旧设置数据 */
  moduleModel?: { outline?: string; mindmap?: string; qa?: string };
  /** @deprecated 端点级 Key 已并入 modelSlots；保留仅为兼容旧设置数据的迁移 */
  endpointKeys?: Record<string, string>;
  /** 禁用模型思考过程（默认开启禁用）：结构化任务更快更省，避免思考耗尽输出 token。设为 false 才启用思考 */
  disableThinking?: boolean;
  /** 全局抽帧开关（默认 false，避免不必要的成本与延迟） */
  visionEnabled?: boolean;
  /** 各模块是否结合画面（默认随全局开关；未配置视为开启） */
  visionModules?: { outline?: boolean; mindmap?: boolean; qa?: boolean };
  /** @deprecated 公开资料检索已内置 DuckDuckGo，无需配置；保留仅为兼容旧设置数据 */
  webSearch?: { endpoint?: string; apiKey?: string; engine?: string };
  /** @deprecated 检索已内置且默认开启 */
  webSearchEnabled?: boolean;
  /** 问答时检索个人知识库（默认开启） */
  knowledgeSearch?: boolean;
  /** Obsidian 配置 */
  obsidian?: { baseUrl?: string; apiKey?: string; rootDir?: string };
}

/** 概念间的逻辑关系边（draw.io 式流程；SPEC-08 冒烟 3b） */
export interface ConceptFlow {
  /** 起点概念 id（cm_xxx） */
  fromId: string;
  /** 终点概念 id */
  toId: string;
  /** 边上的条件/动作（如"判断：md5 相同"；可缺省） */
  label?: string;
}

export interface ConceptMapData {
  videoId: VideoId;
  promptVersion: string;
  model: string;
  /** 3~5 个阶段（模型按内容逻辑划分，顺序 = 讲解推进顺序） */
  stages: ConceptStage[];
  /** 概念间关系边（模型输出；缺省 = 无，流程视图退化为阶段内顺序边） */
  flows?: ConceptFlow[];
  generatedAt: string;
}

export type TraceKind = 'outline' | 'term' | 'segment' | 'capture';

/** pipeline 运行轨迹（TECH-DESIGN §5.4），traces store 保留最近 50 条 */
export interface PipelineTrace {
  id: string;
  videoId: VideoId;
  kind: TraceKind;
  startedAt: string;
  finishedAt?: string;
  chunks?: Array<{ index: number; ms: number; retries: number; error?: string }>;
  inputTokens?: number;
  outputTokens?: number;
  /** 吸附阶段丢弃的幻觉章节数 */
  droppedBySnap?: number;
  /** 是否触发预算熔断 */
  budgetHit?: boolean;
  error?: string;
}

/**
 * 问答动态角色（每视频一次判定并缓存，缓存键 persona::{videoId}::{pv}::{model}）。
 * 由 src/core/pipeline/persona.ts 判定、src/panel/personaLoader.ts 落库，
 * 注入问答 system prompt 时只追加"以谁的身份讲"，不覆盖任何防编造/引用规则。
 */
export interface Persona {
  videoId: VideoId;
  promptVersion: string;
  model: string;
  /** 角色名，如「AI 应用工程讲师」≤20 字 */
  role: string;
  /** 专业领域 2~5 项 */
  expertise: string[];
  /** 讲解风格描述 ≤40 字 */
  style: string;
  /** true=模型判定失败后的默认角色（UI 可标注"默认"） */
  fallback?: boolean;
  createdAt: string;
}
