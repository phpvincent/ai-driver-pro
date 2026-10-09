/**
 * 端点、默认值与阈值 —— 仅父 agent 可修改（CONSTITUTION §4，红线 9）。
 * 接口 URL、密钥、模型标识、平台正则只允许出现在本目录。
 * 注意：content script 禁止 import 本文件（红线 10），只能 import ./shared。
 */

export { BILI_URL_PATTERN, BVID_REGEXES } from './shared';

export const BILI_ENDPOINTS = {
  view: 'https://api.bilibili.com/x/web-interface/view',
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  playerWbiV2: 'https://api.bilibili.com/x/player/wbi/v2',
} as const;

/** 字幕轨语言带此前缀 = 平台 AI 字幕 */
export const BILI_AI_SUBTITLE_PREFIX = 'ai-';

export const DEFAULT_MODEL = {
  baseUrl: 'https://api.deepseek.com',
  /** 模型标识以 DeepSeek 官方文档当前可用版本为准 */
  model: 'deepseek-chat',
  temperature: { outline: 0.2, qa: 0.4 },
  maxTokens: 4096,
  outlineTokenBudget: 200_000,
} as const;

export const OUTLINE = {
  chunkTargetChars: 1800,
  chunkOverlapChars: 200,
  concurrency: 3,
  chunkTimeoutMs: 30_000,
  maxRetries: 1,
  /** 吸附容差：候选时间戳超此值视为幻觉，丢弃该章节 */
  snapMaxDriftMs: 5_000,
  /** 最短章节时长：finalize 后不足此值的章节并入相邻较长章节（SPEC-03 3c） */
  minSectionDurationMs: 90_000,
} as const;

export const DENSITY = {
  /** 章节数少于该值时用绝对阈值，否则用分位数分档 */
  minSectionsForQuantile: 4,
  /** 绝对阈值：每分钟新术语数 ≥ 此值为 high */
  highNewTermsPerMin: 3,
  highQuantile: 0.75,
  lowQuantile: 0.25,
} as const;

/** 概念知识图（SPEC-04 四次迭代：阶段流）：结构与阈值约束（pipeline zod 与 UI 共用） */
export const CONCEPT_MAP = {
  /** 阶段数量下/上限（模型输出 zod 约束） */
  stagesMin: 3,
  stagesMax: 5,
  /** 阶段名长度上限（zod 硬上限，阶段名体现推进逻辑可稍长） */
  stageLabelMax: 20,
  /** 每阶段概念数量下/上限 */
  conceptsPerStageMin: 2,
  conceptsPerStageMax: 6,
  /** 概念标签展示长度上限（代码截断目标，所有构树路径强制 shortenLabel） */
  labelMax: 12,
  /** 概念标签 zod 硬上限（防注入式超长仍拒；labelMax~hardMax 之间由代码截断，
   *  二次迭代：模型输出 13~16 字常见，12 字硬拒是降级根因） */
  labelHardMax: 30,
  /** 细节短语数量上限 / 展示长度上限（代码截断目标） */
  detailsMax: 4,
  detailLabelMax: 20,
  /** 细节短语 zod 硬上限（防注入式超长） */
  detailHardMax: 40,
  /** 术语关联图（降级）最多展示的术语数 */
  termsTop: 12,
  /** 降级阶段名称 */
  fallbackStageLabel: '核心术语',
  /** 预告章节识别：只检查前 N 个章节（index < N，P8 洞察：预告章在开头） */
  overviewSectionMaxIndex: 2,
  /** 预告章节识别：章节文本命中全部概念 label 的比例阈值（≥ 则视为预告章，
   *  其 startMs 不进入任何 anchor，修复 00:01 开场锚点 bug） */
  overviewHitRatio: 0.5,
  /** 解析失败重试次数（附错误信息重试） */
  maxRetries: 1,
} as const;

export const CONTEXT = {
  /** 单次提问上下文上限（红线 3 的量化边界） */
  maxTokens: 4_000,
  defaultRangePadMs: 30_000,
  chapterCompressChars: 3_000,
  prevSummaryMaxTokens: 150,
  /** 问答多轮记忆：保留最近几轮（SPEC-08 8.4b，用户确认 5 轮） */
  dialogueMaxTurns: 5,
  /** 单轮摘要最长字符（问题 + 回答要点压缩后） */
  dialogueTurnMaxChars: 240,
  /** 公开资料检索结果注入上下文的字符上限（红线 3：与字幕/知识库共享同一预算，不膨胀） */
  webContextMaxChars: 1_000,
} as const;

/**
 * 内置公开资料检索（DuckDuckGo Instant Answer）：**免 API Key、免用户配置**，
 * 问答时自动调用，用户无感知。红线 9：检索端点只能来自本常量。
 */
export const WEB_SEARCH = {
  endpoint: 'https://api.duckduckgo.com/',
  defaultMaxResults: 5,
  requestTimeoutMs: 8_000,
} as const;

/**
 * 兜底搜索页前缀（红线 9：代码里唯一的 URL 来源，任何搜索链接只能由本常量 +
 * encodeURIComponent(query) 拼出）。用于术语卡"建议联网核实"的人工查证入口。
 */
export const WEB_SEARCH_FALLBACK_URL = 'https://duckduckgo.com/?q=';

export const SUBTITLE = {
  mergeShorterThanMs: 800,
  /** 手动粘贴纯文本的时间估算速率 */
  manualCharsPerSecond: 4,
  requestTimeoutMs: 15_000,
} as const;

export { PLAYBACK } from './shared';

/**
 * 模型预设（端点与默认模型的唯一来源，红线 9）。
 * 走 OpenAI 兼容的 chat/completions：Qwen 官方兼容模式支持图文多模态，
 * 用户也可换成自建网关地址。模型名由用户在设置里自填（成本与能力自选）。
 */
export const MODEL_PRESETS = {
  deepseek: {
    label: 'DeepSeek（文本/结构化，便宜）',
    baseUrl: 'https://api.deepseek.com',
    // 官方已将 deepseek-chat 别名至 deepseek-flash（推理模型），此处用规范名
    model: 'deepseek-flash',
    /** 开放平台控制台（冷启动引导：注册/充值/创建 Key，SPEC-10 10.1） */
    consoleUrl: 'https://platform.deepseek.com/api_keys',
    /** 费用参考（设置页引导文案用；估算口径见 PRICING） */
    costHint: '一集 30 分钟视频的大纲+导图+问答，通常不到 0.1 元',
  },
  qwen: {
    label: '通义千问 Qwen · maas 网关（OpenAI 兼容，支持多模态）',
    // 只保留一个 Qwen 入口：统一走 maas 网关（本项目验证可用的端点）
    baseUrl: 'https://maas.qianwenaiapi.com/compatible-mode/v1',
    // 便宜的多模态模型；更可选 qwen-vl-max / qwen2.5-vl-72b-instruct
    model: 'qwen-vl-plus',
    consoleUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    costHint: '多模态可看课程画面；新用户通常有免费额度',
  },
} as const;

/** 抽帧（视觉）默认参数：成本与延迟的护栏 */
export const VISION = {
  /**
   * 帧最长边像素与 JPEG 质量。
   *
   * **token 由像素尺寸决定，与 JPEG 质量无关**（Qwen-VL 约每 28×28 像素 1 token；
   * GPT-4o 按 512 瓦片计）。降低 quality 只省传输字节，不省 token；降低分辨率才省 token，
   * 但会直接损失可读性：512px 宽时 1080p 画面里的代码/PPT 小字只剩 6~7px，模型读不清。
   * 896px 下正文字号约 12px，可稳定识别；16:9 画面约 896×504 ≈ 576 token/帧。
   * 省 token 的正确手段是**去重复画面**（dHash），而不是降清晰度。
   */
  maxSize: 896,
  quality: 0.75,
  /** 感知哈希去重：两帧 dHash 汉明距离 ≤ 此值视为同一画面（64 位中约 8% 差异） */
  dhashMaxDistance: 5,
  /** 结构感知抽帧：两个取帧点最小间隔（毫秒）——过近大概率是同一页 PPT */
  minGapMs: 15_000,
  /** 结构感知抽帧：低于此画面价值分的窗口不取（避免为抽而抽） */
  minScore: 25,
  /** 单帧抽取超时 */
  timeoutMs: 3000,
} as const;

/**
 * 帧预算：**随视频时长增长（分段递减）+ 按章节数兜底 + 知识密集加成**。
 *
 * 为什么分段递减而不是线性：长视频的信息量随时长增长，但单次请求的图像 token 与上下文窗口有限；
 * 线性（45s/帧）会让 3 小时视频要 240 帧，既超窗口又不必要——长课的后半段常有复习、演示重复。
 * 所以前 10 分钟密（45s/帧）、10~60 分钟次之（90s/帧）、60 分钟后更疏（180s/帧），总量仍单调增长。
 *
 * 章节兜底：导图每章至少首尾两帧（章节演进靠首尾对照），长视频章节多，帧数自然跟着涨。
 *
 * hardMax 是**唯一的成本护栏**：导图单帧约 576 图像 token（896px），40 帧 ≈ 23k token。
 * 若所用多模态模型上下文更大、愿意多花钱，调大 hardMax 即可。
 */
export interface FrameTier {
  /** 本段覆盖到视频的第几秒（累计） */
  uptoSec: number;
  /** 本段每多少秒一帧 */
  secPerFrame: number;
}

export const FRAME_PLAN: Record<
  'outline' | 'mindmap' | 'qa',
  { tiers: readonly FrameTier[]; min: number; hardMax: number; perSection: number }
> = {
  outline: {
    tiers: [{ uptoSec: Number.POSITIVE_INFINITY, secPerFrame: 90 }],
    min: 3,
    hardMax: 8,
    perSection: 0,
  },
  mindmap: {
    tiers: [
      { uptoSec: 600, secPerFrame: 45 },
      { uptoSec: 3600, secPerFrame: 90 },
      { uptoSec: Number.POSITIVE_INFINITY, secPerFrame: 180 },
    ],
    min: 6,
    hardMax: 40,
    perSection: 2,
  },
  qa: {
    tiers: [{ uptoSec: Number.POSITIVE_INFINITY, secPerFrame: 30 }],
    min: 2,
    hardMax: 8,
    perSection: 0,
  },
};

/** AI 字幕顺句（SPEC-08 8.5）：手动触发，仅 bili_ai 来源 */
export const PUNCTUATE = {
  /** 单块累计字符数（约 60~80 句 ASR 短句） */
  chunkChars: 2_000,
  /** 单句去标点后允许的最大字符改动比例（同音错字远低于此，改写必超过） */
  maxChangeRatio: 0.3,
} as const;

/** 知识密集时的密度系数（各段 secPerFrame 除以该值 → 帧数约 ×1.5） */
export const FRAME_DENSE_BOOST = 1.5;

export const OBSIDIAN = {
  baseUrl: 'http://127.0.0.1:27123', // Local REST API 的 HTTP 模式端口（HTTPS 模式为 27124）
  requestTimeoutMs: 8_000,
} as const;

/** 大纲笔记（SPEC-09）：重新归位算法常量（spec §3.3 用户确认值） */
export const NOTES = {
  /** bullet 锚点重新归位的时间窗口：新要点与 tMs 的偏差 ≤ 15s 才参与文本相似度匹配 */
  reanchorBulletWindowMs: 15_000,
  /** 章节锚点「待确认」判定：旧/新章节标题完全不同 且 时长重叠 < 50% */
  reanchorPendingOverlapRatio: 0.5,
} as const;

/**
 * 预设模型价格表（SPEC-10 10.8 成本估算）：元 / 百万 token，官方公示价。
 * **估算口径**：缓存命中、阶梯折扣、活动价不区分；价格随官网变动需人工维护；
 * 命中按模型名前缀最长匹配（先精确后泛化列表序）。自定义模型不在表内 → 只计 token。
 */
export const PRICING = {
  presets: [
    { prefix: 'deepseek-chat', inputPerM: 2, outputPerM: 8 },
    { prefix: 'deepseek-flash', inputPerM: 2, outputPerM: 8 },
    { prefix: 'deepseek-reasoner', inputPerM: 4, outputPerM: 16 },
    { prefix: 'qwen-flash', inputPerM: 0.5, outputPerM: 2 },
    { prefix: 'qwen3.5-flash', inputPerM: 0.5, outputPerM: 2 },
    { prefix: 'qwen3.5-plus', inputPerM: 0.8, outputPerM: 2 },
    { prefix: 'qwen3-plus', inputPerM: 0.8, outputPerM: 2 },
    { prefix: 'qwen-max', inputPerM: 20, outputPerM: 60 },
    { prefix: 'qwen-vl-max', inputPerM: 20, outputPerM: 60 },
    { prefix: 'qwen-plus', inputPerM: 0.8, outputPerM: 2 },
    { prefix: 'qwen-vl-plus', inputPerM: 0.8, outputPerM: 2 },
    { prefix: 'qwen-turbo', inputPerM: 0.3, outputPerM: 0.6 },
    { prefix: 'qwen3-vl-plus', inputPerM: 0.8, outputPerM: 2 },
  ],
} as const;

export const DB = {
  name: 'vsc-cache',
  stores: {
    subtitles: 'subtitles',
    outlines: 'outlines',
    qaHistory: 'qaHistory',
    terms: 'terms',
    traces: 'traces',
    /** SPEC-07 追加：使用统计（键 videoId，值 UsageRecord，纯本地、不上报）。
     *  注意：已有 v1 库需升版本才会建该 store（版本常量在 storage/db.ts 的 open 调用处，留给父 agent 统一处理）。 */
    usage: 'usage',
    /** LLM 交互日志（键 entry.id，值 LlmLogEntry；验证期报告的「LLM 交互日志」子模块读它） */
    logs: 'logs',
    /** SPEC-09 追加：大纲笔记（键 note.id，值 OutlineNote；与大纲解耦，重生成不触碰） */
    notes: 'notes',
  },
  traceKeep: 50,
  /** LLM 交互日志保留条数（超出从最旧一条开始丢弃） */
  logKeep: 200,
} as const;
