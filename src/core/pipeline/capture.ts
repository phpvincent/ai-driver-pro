/**
 * 知识捕获管道（SPEC-06 子任务 6.2/6.3，TECH-DESIGN §4.7 / §6.4 / §7.2）。
 *
 * 全部为纯函数（无 chrome.* / 无网络 / 无模型调用），便于单测与确定性：
 * - frontmatter 严格按 TECH-DESIGN §4.7 由代码组装，**不由模型生成**；
 * - 正文含跳播链接（§7.2：`?p={page}&t={秒}`）；
 * - 目录分层（借鉴 ai-knowlage）：`{root}/视频笔记/{课程}/{标题}.md`、`{root}/术语/{术语}.md`；
 * - 双索引：`_meta/index.json`（机器检索）+ `_索引.md`（人类可读 MOC，Obsidian 双链）；
 * - 检索只喂 ≤200 字摘要预览（红线 3 预算）；
 * - 术语去重为确定性相似度（最长公共子序列比例），阈值 0.8；
 *   模型评分推迟（见 SPEC-06 执行记录：A5 的">0.8 提示"本期走确定性实现）。
 */
import type {
  KnowledgeIndexEntry,
  KnowledgeIndexFile,
  OutlineNote,
  Section,
  VideoMeta,
} from '../../types';
import { formatMmSs } from '../context/compiler';

/** 笔记类型（frontmatter 的 type 字段） */
export type NoteType = 'video-note' | 'term-card';

/** 术语卡正文所需字段（对应 explain 的 TermPayload，此处只声明消费到的部分） */
export interface TermPayloadLike {
  inVideoMeaning: string;
  generalDefinition: string;
  analogy: string;
  relatedTerms: string[];
}

/**
 * 笔记在 vault 中的分类目录（SPEC-17 LLM wiki 层级）。
 * 批 1 先新增 raw/moc/qa；video/term 的目录名切换（笔记/概念）随批 2 蒸馏管线一起做。
 */
export const NOTE_DIR = {
  video: '笔记',
  term: '概念',
  /** SPEC-17：原料层（字幕原文，行级锚点，只读） */
  raw: 'raw',
  /** SPEC-17：人类目录 MOC（每领域一张） */
  moc: '索引',
  /** SPEC-17：QA 沉淀（手动存入，带溯源） */
  qa: '问答',
} as const;

/** SPEC-17：蒸馏未判定领域时的回落目录名 */
export const DEFAULT_DOMAIN = '通用';

/** 机器索引（JSON，检索读）与人类索引（MOC，Obsidian 浏览）的相对路径 */
export const INDEX_JSON_NAME = '_meta/index.json';
export const INDEX_MD_NAME = '_索引.md';

/** frontmatter 固定字段：来源与标签（TECH-DESIGN §4.7） */
export const FRONTMATTER_SOURCE = 'bilibili';
export const FRONTMATTER_TAGS = ['ai', '视频笔记', 'B站'];

/**
 * 内容标签（SPEC-10 10.4 二轮冒烟：tags 不能只有固定标签，脱离文章内容）：
 * 从各章 terms 按跨章出现频次取前 N（≤10 字、与固定标签去重），让 .md
 * 裸读 frontmatter 或被外部工具索引时能知道"这篇讲什么"。
 * 并列时按字典序稳定排序。
 */
export function contentTagsFor(sections: readonly Section[], max = 4): string[] {
  const counts = new Map<string, number>();
  for (const s of sections) {
    for (const t of s.terms) {
      const k = t.trim();
      if (!k || k.length > 10 || FRONTMATTER_TAGS.includes(k)) continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, max)
    .map(([k]) => k);
}

/** 去重阈值：相似度 ≥ 此值视为同一术语（TECH-DESIGN §6.4 的 >0.8 口径取 ≥0.8） */
export const DUPLICATE_THRESHOLD = 0.8;

/** 文件名截断长度（含扩展名；防 vault 路径过长） */
export const FILE_NAME_MAX = 60;

/** 摘要预览长度上限（检索只喂预览，红线 3 预算） */
export const SUMMARY_PREVIEW_MAX = 200;

// ---------------------------------------------------------------------------
// 通用小工具（导出供单测）
// ---------------------------------------------------------------------------

/**
 * YAML 标量转义：`冒号+空格` / `#` / 引号 / 方括号等 YAML 敏感字符时加双引号，
 * 布尔与数字字面量同样加引号（否则 Obsidian 属性面板会把它们解析成非字符串）。
 * 冒号后非空白（如 URL 的 `https:`）在 YAML 中是合法字面量，不加引号以保持可读。
 */
export function yamlValue(value: string): string {
  if (value.length === 0) return '""';
  if (/^[\s]|[\s]$/.test(value)) return JSON.stringify(value);
  if (/:\s/.test(value)) return JSON.stringify(value);
  if (/[#[\]{}&*!|>'"%@`]/.test(value)) return JSON.stringify(value);
  if (/^(?:true|false|null|yes|no|on|off)$/i.test(value)) return JSON.stringify(value);
  if (/^[-+]?\d+(?:\.\d+)?$/.test(value)) return JSON.stringify(value);
  if (/[\n\r\t]/.test(value)) return JSON.stringify(value);
  return value;
}

/** 文件名非法字符（`/\?:*"><|` 与控制字符）替换为 `_`；中文与空格保留；长度截断 60 */
export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim();
  const clipped = cleaned.slice(0, FILE_NAME_MAX).trim();
  return clipped.length > 0 ? clipped : '_';
}

/** vault 路径拼接：忽略空段，逐段去掉首尾斜杠与空白 */
export function joinVaultPath(...segments: string[]): string {
  return segments
    .map((s) => s.replace(/^\/+|\/+$/g, '').trim())
    .filter((s) => s.length > 0)
    .join('/');
}

/** 日期 → `YYYY-MM-DD`（frontmatter created；本地时区，与用户认知一致） */
export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 视频页 URL 带分 P 参数。
 * - url 存在：解析后补齐缺失的 p 参数（已带则不重复追加）；
 * - url 为空（旧 content / 数据缺失）：**按 bvid + page 兜底拼接**——
 *   SPEC-08 8.2 之前这里直接返回空串，导致 Obsidian 里所有时间戳都只是纯文本。
 */
export function videoPageUrl(meta: VideoMeta): string {
  const base = (meta.url ?? '').trim();
  if (base) {
    try {
      const u = new URL(base);
      if (!u.searchParams.has('p')) u.searchParams.set('p', String(meta.page));
      return u.toString();
    } catch {
      // 非法 URL 走兜底
    }
  }
  if (!meta.bvid) return '';
  return `https://www.bilibili.com/video/${meta.bvid}?p=${meta.page}`;
}

/**
 * 跳播链接（TECH-DESIGN §7.2）：`{url}?p={page}&t={秒}`，秒 = floor(ms/1000)。
 * ms 非法或为负时按 0 处理。
 */
export function playbackUrl(meta: VideoMeta, tMs: number): string {
  const sec = Number.isFinite(tMs) && tMs > 0 ? Math.floor(tMs / 1000) : 0;
  const base = videoPageUrl(meta);
  if (!base) return '';
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}t=${sec}`;
}

/** markdown 链接：`[mm:ss](url)`；url 为空时只返回文本（无链接可跳时不造死链） */
export function timestampLink(meta: VideoMeta, tMs: number): string {
  const label = formatMmSs(tMs);
  const url = playbackUrl(meta, tMs);
  return url ? `[${label}](${url})` : label;
}

/** 摘要预览：去空白字符压缩为单行 + 截断至 SUMMARY_PREVIEW_MAX（≤200 字） */
export function truncatePreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SUMMARY_PREVIEW_MAX) return flat;
  return `${flat.slice(0, SUMMARY_PREVIEW_MAX - 1)}…`;
}

// ---------------------------------------------------------------------------
// frontmatter（TECH-DESIGN §4.7）
// ---------------------------------------------------------------------------

/**
 * 视频笔记 frontmatter（含首尾 `---` 分隔线）。字段：
 * title / source / url（带 ?p=）/ video_id / duration（秒）/ created / tags / type。
 * `now` 可注入以固定日期（默认当前时间，保证单测可确定性断言）。
 */
export function buildFrontmatter(
  meta: VideoMeta,
  type: NoteType,
  now: Date = new Date(),
  /** 内容标签（视频笔记=章节术语 topN；术语卡=术语本身），与固定标签合并 */
  extraTags: readonly string[] = [],
): string {
  const fixed = type === 'video-note' ? FRONTMATTER_TAGS : TERM_FRONTMATTER_TAGS;
  const tags = [...fixed, ...extraTags.filter((t) => !fixed.includes(t))]
    .map((t) => (t === yamlValue(t) ? t : JSON.stringify(t)))
    .join(', ');
  const lines = [
    `title: ${yamlValue(meta.title)}`,
    `source: ${FRONTMATTER_SOURCE}`,
    `url: ${yamlValue(videoPageUrl(meta))}`,
    `video_id: ${yamlValue(meta.videoId)}`,
    `duration: ${Math.max(0, Math.floor((Number.isFinite(meta.durationMs) ? meta.durationMs : 0) / 1000))}`,
    `created: ${formatDate(now)}`,
    `tags: [${tags}]`,
    `type: ${type}`,
  ];
  return ['---', ...lines, '---'].join('\n');
}

/** 术语卡固定标签（与视频笔记同构：裸读 frontmatter 即知来源与类型） */
export const TERM_FRONTMATTER_TAGS = ['ai', '术语', 'B站'];

/**
 * 本地 .md 下载文件名（SPEC-10 10.4 Obsidian 解绑）：`{标题}.{bvid}_p{page}.md`。
 * 与交换格式文件名同构（仅扩展名不同），用户能把两类文件归置在一起。
 */
export function localMarkdownFileName(meta: VideoMeta): string {
  const safe = sanitizeFileName(meta.title);
  return `${safe}.${meta.bvid || 'video'}_p${meta.page || 1}.md`;
}

/** 术语卡 frontmatter：type: term-card + term / video_id / source / created / tags */
export function buildTermFrontmatter(
  term: string,
  meta: VideoMeta,
  now: Date = new Date(),
): string {
  const lines = [
    `title: ${yamlValue(term)}`,
    `term: ${yamlValue(term)}`,
    `source: ${FRONTMATTER_SOURCE}`,
    `url: ${yamlValue(videoPageUrl(meta))}`,
    `video_id: ${yamlValue(meta.videoId)}`,
    `created: ${formatDate(now)}`,
    `tags: [${[...TERM_FRONTMATTER_TAGS, ...(yamlValue(term) === term ? [term] : [JSON.stringify(term)])]
      .join(', ')}]`,
    `type: term-card`,
  ];
  return ['---', ...lines, '---'].join('\n');
}

/** 正文 + frontmatter 拼接（笔记最终落盘内容） */
function withFrontmatter(frontmatter: string, body: string): string {
  return `${frontmatter}\n\n${body.trim()}\n`;
}

// ---------------------------------------------------------------------------
// vault 路径（分层目录）
// ---------------------------------------------------------------------------

/**
 * 笔记落盘路径：`视频笔记/{课程}/{标题}.md` 与术语目录 `术语/`。
 * 课程目录：VideoMeta 无课程名字段，v0.1 以 bvid 分课程（缺失回落 videoId）。
 */
export function vaultPathsFor(
  meta: VideoMeta,
  rootDir: string,
  /** SPEC-17：蒸馏判定的领域（领域目录自动生长）；缺省回落 通用 */
  domain: string = DEFAULT_DOMAIN,
): { videoNote: string; termDir: string; rawNote: string; domainDir: string } {
  // SPEC-17 平台前缀：课程目录 = {platform}_{视频号}（向后兼容多平台；缺省 bilibili）
  const course = sanitizeFileName(`${meta.platform || 'bilibili'}_${meta.bvid || meta.videoId}`);
  const domainDir = sanitizeFileName(domain || DEFAULT_DOMAIN);
  return {
    videoNote: joinVaultPath(rootDir, NOTE_DIR.video, domainDir, course, `${sanitizeFileName(meta.title)}.md`),
    termDir: joinVaultPath(rootDir, NOTE_DIR.term, domainDir),
    // raw 按 P 分文件：多 P 课程每 P 一份原文（只读语义=写一次，若全课程一个文件，
    // 第二个 P 会因"已存在"被跳过导致字幕丢失）
    rawNote: joinVaultPath(
      rootDir,
      NOTE_DIR.raw,
      domainDir,
      course,
      `${sanitizeFileName(meta.bvid || meta.videoId)}_p${meta.page}.md`,
    ),
    domainDir,
  };
}

/** 术语卡落盘路径（扁平存放于术语目录） */
export function termNotePath(term: string, termDir: string): string {
  return joinVaultPath(termDir, `${sanitizeFileName(term)}.md`);
}

// ---------------------------------------------------------------------------
// SPEC-17 · LLM wiki：raw 原料层 / AGENTS.md 蒸馏宪法 / 领域 MOC
// ---------------------------------------------------------------------------

/**
 * raw 原料层构建器：字幕全文 md 化，行级 `[mm:ss](回放URL)` 锚点——一切蒸馏的溯源终点。
 * 无损规范化（用户决策②）：合并滚动字幕的**连续重复文本行**（保留首个时间锚）、
 * 跳过空文本行；不做任何破坏性压缩。只读：入库后任何流程不得再写此文件。
 */
export function buildRawMarkdown(args: {
  meta: VideoMeta;
  cues: ReadonlyArray<{ startMs: number; endMs: number; text: string }>;
  now?: Date;
}): string {
  const { meta: m, cues } = args;
  const date = (args.now ?? new Date()).toISOString().slice(0, 10);
  const head = [
    '---',
    `title: ${yamlValue(m.title)}`,
    `bvid: ${yamlValue(m.bvid || m.videoId)}`,
    `page: ${m.page}`,
    'source: bilibili',
    `url: ${yamlValue(videoPageUrl(m))}`,
    `date: ${date}`,
    'type: raw',
    '---',
    '',
    `# ${m.title}（原文）`,
    '',
    '> [!warning] 原料层：只读。此文件是字幕原文的忠实转录（仅合并滚动重复行），',
    '> 是所有蒸馏页的溯源终点，任何流程不得改写。',
    '',
  ];
  let lastText = '';
  const lines: string[] = [];
  for (const cue of cues) {
    const text = (cue.text ?? '').trim();
    if (text.length === 0) continue;
    if (text === lastText) continue; // 滚动字幕重复行：合并（保留首个锚点）
    lastText = text;
    const url = playbackUrl(m, cue.startMs);
    const ts = formatClock(cue.startMs);
    lines.push(url ? `- [${ts}](${url}) ${text}` : `- [${ts}] ${text}`);
  }
  return `${head.concat(lines).join('\n').trim()}\n`;
}

/** 毫秒 → mm:ss（raw 行锚点显示；≥1h 用 h:mm:ss） */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * AGENTS.md 蒸馏宪法 + 检索规则（SPEC-17 §7）：知识库根目录的"员工手册"。
 * 扩展是权威维护者——存入时**无则创建、有则覆盖为最新版**（用户决策）。
 * 脱离扩展的其他 agent 读库时按此规则行事。
 */
export const AGENTS_MD = `# AGENTS.md · 知识库宪法（v1）

> 本文件是知识库的"员工手册"：入库蒸馏的规则宪法 + 检索消费的行为准则。
> 由「视频学习副驾」扩展维护（每次存入覆盖为最新版）；其他 Agent 读写本库时请遵循。

## A. 目录契约

| 目录 | 内容 | 写入规则 |
|------|------|----------|
| \`raw/{领域}/{课程}/\` | 字幕原文（行级 [mm:ss](回放URL) 锚点） | **只读**：入库写一次，之后任何流程不得改写 |
| \`视频笔记/{领域}/{课程}/\` | 视频笔记（章节 ## 蒸馏 + \`%% vsc:notes %%\` 用户笔记区块） | 存入时合并刷新；区块外手写内容保留 |
| \`术语/{领域}/\` | 概念页（术语表节点，五字段 frontmatter） | **追加式合并**：引用记录与 aliases 只增不删 |
| \`问答/{领域}/{课程}/\` | QA 沉淀（用户手动存入） | 只追加 |
| \`索引/\` | 每领域一张 MOC（人类目录） | 存入时重建该领域页 |
| \`_meta/index.json\` | 机器索引（检索入口；只索引蒸馏层，raw 不进） | 存入时增量合并 |

\`{领域}\` 由蒸馏判定（逻辑学/编程/考研数学…），目录随新领域自动生长；未知回落 \`通用\`。

## B. 蒸馏规则（入库时强制执行）

1. **原料只读**：raw 只转录不加工；蒸馏页结论句尾必须带 \`[mm:ss](回放URL)\` 溯源锚点，一路点回原文。
2. **强制 ## 章节结构**：蒸馏页（视频笔记/概念页）正文必须用 \`##\` 二级标题分节——天然语义分割，任何检索方式都受益。
3. **术语归一（可逆性原则）**：蒸馏产出的每个概念必须落位到概念页（新建或合并到既有），不得凭空自造表述；概念名 = frontmatter \`preferred\`（文件名即规范名）。
4. **aliases 只增不删**：同一概念的不同表述追加进 aliases；删除别名会毁掉历史条目的可检索性。
5. **定义是划界不是解释**：概念页定义须区分邻近概念，不是科普。
6. **引用带身份（"以什么身份连"）**：概念页引用记录不只写"谁提到谁"，必须带**原句语境**（blockquote + 回放锚点）——同一概念在不同视频中的角色决定检索跳转方向。
7. **来源标注**：\`source: raw\`（AI 蒸馏，待核验）vs \`source: user-note\`（用户批注，已核验）；两者冲突时**以用户笔记为准**并在概念页标注分歧。
8. **用户笔记避让**：\`%% vsc:notes:start … %%\` 区块是用户手写保险区，AI 永不进入；讨论串中用户追问 = 用户批注（加权），助教回答 = AI 生成（待核验）。
9. **AI 产出可辨识**：AI 蒸馏的定义/要点用 \`> [!note] AI 蒸馏 · 待核验\` callout；人改写过的段落自动免标（追加式合并不触碰改写段）。

## C. 检索规则（消费本库时遵循）

1. **先查库再答**：涉及库内领域的问题，先检索 \`_meta/index.json\` 命中蒸馏层，再决定是否补充外部知识。
2. **术语经 aliases 映射**：查询词先按概念页 aliases 归一到 preferred 再匹配，防同概念多表述漏检。
3. **答案必须带溯源锚点**：引用库内知识时给 \`[mm:ss](回放URL)\` 或 \`[[wikilink]]\`，可一路点回原文。
4. **related 关联链**：命中笔记时把其 frontmatter 涉及的概念页一并检查——一条关联链抵三次重搜。
5. **加权**：\`sourceType: user-note\`（用户批注）权重高于 \`ai-distill\`；raw 不参与检索（只做溯源）。
6. **待核验内容如实标注**：引用未核验的 AI 蒸馏时保持 callout 标记可见，不冒充已认定知识。
`;

/** AGENTS.md 在 vault 根目录的落盘路径 */
export const AGENTS_MD_PATH = 'AGENTS.md';

/**
 * 领域 MOC 构建器（人类目录，每领域一张；存入时重建该领域页）。
 * 双链汇聚：笔记/概念/问答按类分组，Obsidian 图谱由此自然长出领域网络。
 */
export function buildMocMarkdown(args: {
  domain: string;
  entries: ReadonlyArray<KnowledgeIndexEntry>;
}): string {
  const inDomain = args.entries.filter(
    (e) => (e.domain ?? '通用') === args.domain || args.domain === '通用',
  );
  const groups: Array<{ category: KnowledgeIndexEntry['category']; title: string }> = [
    { category: 'video-note', title: '视频笔记' },
    { category: 'term', title: '术语' },
    { category: 'concept', title: '概念' },
    { category: 'qa', title: '问答' },
    { category: 'note', title: '其他笔记' },
  ];
  const lines = [
    `# MOC · ${args.domain}`,
    '',
    `本领域共 ${inDomain.length} 条知识（笔记 ${inDomain.filter((e) => e.category === 'video-note').length} · 概念 ${inDomain.filter((e) => e.category === 'concept' || e.category === 'term').length} · 问答 ${inDomain.filter((e) => e.category === 'qa').length}）。`,
    '',
    '_本文件由扩展生成；机器检索读 `_meta/index.json`，人类浏览从这里出发。_',
    '',
  ];
  for (const g of groups) {
    const items = inDomain.filter((e) => e.category === g.category);
    if (items.length === 0) continue;
    lines.push(`## ${g.title}`, '');
    for (const e of items) {
      const preview = truncatePreview(e.summaryPreview);
      lines.push(
        preview ? `- [[${noteLinkName(e.path, e.title)}]] — ${preview}` : `- [[${noteLinkName(e.path, e.title)}]]`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

// ---------------------------------------------------------------------------
// SPEC-17 关联网 · 笔记侧标记区块（涉及概念 wikilinks + raw 原文链接）
// ---------------------------------------------------------------------------

export const CONCEPTS_MARKER_START = '%% vsc:concepts:start %%';
export const CONCEPTS_MARKER_END = '%% vsc:concepts:end %%';

/**
 * 笔记的「涉及概念」区块（vsc:concepts 标记包裹，与 vsc:notes 同款刷新语义）：
 * 笔记 → 概念 wikilink（图谱边）+ 笔记 → raw 原文 wikilink（溯源终点入口）。
 */
export function buildConceptLinksBlock(args: {
  conceptNames: ReadonlyArray<string>;
  rawLink: string;
}): string {
  const lines = [CONCEPTS_MARKER_START, '', '## 涉及概念', ''];
  if (args.conceptNames.length > 0) {
    for (const c of args.conceptNames) lines.push(`- [[${c}]]`);
    lines.push('');
  }
  lines.push(`原文：[[${args.rawLink}|字幕原文（raw）]]`, '', CONCEPTS_MARKER_END);
  return lines.join('\n');
}

/**
 * 幂等刷新笔记的 vsc:concepts 区块：已有 → 原位替换；没有 → 追加文末。
 * 区块外内容（含手写）一律不动。
 */
export function upsertConceptLinksBlock(markdown: string, block: string): string {
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === CONCEPTS_MARKER_START);
  if (startIdx === -1) {
    return `${markdown.trimEnd()}

${block}
`;
  }
  let endIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === CONCEPTS_MARKER_END) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    return `${lines.slice(0, startIdx).join('\n').trimEnd()}

${block}
`;
  }
  return `${lines.slice(0, startIdx).join('\n').trimEnd()}

${block}

${lines
    .slice(endIdx + 1)
    .join('\n').replace(/^\n+/, '')}`;
}

/** MOC 落盘路径：索引/MOC-{领域}.md */
export function mocPath(domain: string): string {
  return joinVaultPath(NOTE_DIR.moc, `MOC-${sanitizeFileName(domain || DEFAULT_DOMAIN)}.md`);
}

// ---------------------------------------------------------------------------
// SPEC-17 · 概念页（术语表节点）：构建与追加式合并
// ---------------------------------------------------------------------------

/**
 * 概念页落盘路径：概念/{preferred}.md（**全局唯一，不分领域**）。
 * 概念是知识网络的节点——节点跨领域复用（domains 记录出现的领域），
 * 领域目录只用于 raw/笔记（内容归属）。同名不同语境 = 两个概念，靠名字带语境区分。
 */
export function conceptNotePath(preferred: string, rootDir: string): string {
  return joinVaultPath(rootDir, NOTE_DIR.term, `${sanitizeFileName(preferred)}.md`);
}

/** 概念页引用记录块（"以什么身份连"：带原句语境 + 回放锚点 + 来源标注） */
export function conceptReferenceBlock(args: {
  videoTitle: string;
  /** 来源笔记文件名（不含 .md）；wikilink 目标——Obsidian 图谱由此连线（概念 → 笔记 边） */
  noteLink: string;
  anchorSec: number;
  sourceExcerpt: string;
  sourceType: 'raw' | 'user-note';
  playbackUrl: string;
}): string {
  const ts = formatClock(args.anchorSec * 1000);
  const link = args.playbackUrl ? `[${ts}](${args.playbackUrl})` : `[${ts}]`;
  return [
    `### [[${args.noteLink}|${args.videoTitle}]] ${link}`,
    `- source: ${args.sourceType}`,
    `- 概念语境：`,
    '',
    `> "${args.sourceExcerpt}"`,
    '',
  ].join('\n');
}

/** 新建概念页（五字段 frontmatter + 划界定义待核验 callout + 首条引用记录） */
export function buildConceptPageMarkdown(args: {
  preferred: string;
  aliases: string[];
  definition: string;
  broader: string;
  domain: string;
  reference: string;
  now?: Date;
}): string {
  const date = (args.now ?? new Date()).toISOString().slice(0, 10);
  const aliases = args.aliases.filter((a) => a.trim().length > 0 && a !== args.preferred);
  const lines = [
    '---',
    `title: ${yamlValue(args.preferred)}`,
    `preferred: ${yamlValue(args.preferred)}`,
    `aliases: [${aliases.map((a) => yamlValue(a)).join(', ')}]`,
    ...(args.broader ? [`broader: ${yamlValue(args.broader)}`] : []),
    // domains 多值：概念全局唯一，出现在哪些领域在此累积（跨领域复用追加）
    `domains: [${yamlValue(args.domain)}]`,
    'type: concept',
    // 嵌套标签：复合领域名转斜杠形式（公考_判断推理 → #公考/判断推理），
    // Obsidian 标签面板原生层级折叠——浏览体验等同多层目录，但不把层级写进路径
    `tags: [ai, 概念, ${yamlValue(args.domain.replace(/_/g, '/'))}]`,
    `date: ${date}`,
    '---',
    '',
    `# ${args.preferred}`,
    '',
    '> [!note] AI 蒸馏 · 待核验',
    `> **定义（划界）**：${args.definition}`,
    // 上位概念 wikilink（SPEC-17 关联网：概念 → 上位概念 的图谱边）
    ...(args.broader ? ['', `上位概念：[[${args.broader}]]`] : []),
    '',
    '## 引用记录',
    '',
    args.reference,
  ];
  return `${lines.join('\n').trim()}\n`;
}

/**
 * 概念页**追加式合并**（AGENTS.md 宪法 B4/B6/B9）：
 * - aliases **只增不删**（frontmatter 行合并去重写回）
 * - 引用记录块文末追加（不触碰任何既有内容）
 * - 定义不覆盖：已有页不再写定义（人改写过的定义/删掉的待核验标记不会被复活）
 */
export function mergeConceptPageMarkdown(args: {
  existing: string;
  newAliases: string[];
  /** 本视频所属领域（domains 多值并集：概念跨领域复用时追加） */
  domain: string;
  reference: string;
}): string {
  let merged = args.existing;
  // aliases 行合并（只增不删）
  const aliasMatch = merged.match(/^aliases: \[(.*)\]$/m);
  const add = args.newAliases
    .map((a) => a.trim())
    .filter((a) => a.length > 0)
    .filter((a) => !aliasMatch?.[1]?.includes(yamlValue(a)));
  if (add.length > 0 && aliasMatch) {
    const current = aliasMatch[1].trim();
    merged = merged.replace(
      /^aliases: \[.*\]$/m,
      `aliases: [${current ? `${current}, ` : ''}${add.map((a) => yamlValue(a)).join(', ')}]`,
    );
  }
  // domains 并集（跨领域复用追加）
  const domainMatch = merged.match(/^domains: \[(.*)\]$/m);
  if (domainMatch && args.domain && !domainMatch[1].includes(yamlValue(args.domain))) {
    merged = merged.replace(
      /^domains: \[.*\]$/m,
      `domains: [${domainMatch[1].trim()}, ${yamlValue(args.domain)}]`,
    );
  }
  // 引用记录文末追加
  const base = merged.trimEnd();
  const sep = base.includes('## 引用记录') ? '\n\n' : '\n\n## 引用记录\n\n';
  return `${base}${sep}${args.reference.trim()}\n`;
}

// ---------------------------------------------------------------------------
// 视频笔记
// ---------------------------------------------------------------------------

export interface BuildVideoNoteArgs {
  meta: VideoMeta;
  sections: Section[];
  /** 索引条目的归属视频（App 传入的 videoId，通常与 meta.videoId 相同） */
  sourceVideoId: string;
  /** 注入时钟（单测固定日期） */
  now?: Date;
}

/**
 * 视频笔记：H1 标题 + 来源链接（含 `?p=&t=` 回放锚点）+ 每章（时间范围 + 标题 +
 * 分数 + 摘要 + 可跳播要点 + 术语行）。同时产出全片术语（去重）与 ≤200 字摘要预览。
 */
export function buildVideoNoteMarkdown(args: BuildVideoNoteArgs): {
  markdown: string;
  terms: string[];
  summaryPreview: string;
} {
  const { meta, sections, sourceVideoId } = args;
  const now = args.now ?? new Date();
  const head = [
    `# ${meta.title}`,
    '',
    `来源：[B 站播放页](${videoPageUrl(meta)}) · 回放起点 ${timestampLink(meta, 0)} · 时长 ${formatMmSs(meta.durationMs)} · video_id \`${sourceVideoId || meta.videoId}\``,
    '',
  ];
  const body = sections.map((s) => {
    const score = s.score != null ? `${s.score} 分` : '-';
    const lines = [`## ${formatMmSs(s.startMs)}-${formatMmSs(s.endMs)} ${s.title}（${score}）`, '', s.summary, ''];
    for (const bullet of s.bullets) {
      lines.push(`- ${timestampLink(meta, bullet.startMs)} ${bullet.text}`);
    }
    if (s.terms.length > 0) {
      lines.push('', `术语：${s.terms.join(' · ')}`);
    }
    return lines.join('\n');
  });
  const terms = dedupeStrings(sections.flatMap((s) => s.terms));
  const firstSummary = sections.length > 0 ? sections[0].summary : '';
  const previewRaw = [firstSummary, terms.length > 0 ? `术语：${terms.join(' · ')}` : '']
    .filter((x) => x.length > 0)
    .join(' ');
  const summaryPreview = truncatePreview(previewRaw || meta.title);
  const markdown = withFrontmatter(
    buildFrontmatter(meta, 'video-note', now, contentTagsFor(sections)),
    [...head, ...body].join('\n'),
  );
  return { markdown, terms, summaryPreview };
}

// ---------------------------------------------------------------------------
// 术语卡
// ---------------------------------------------------------------------------

export interface BuildTermCardArgs {
  term: string;
  payload: TermPayloadLike;
  meta: VideoMeta;
  /** 该术语在视频中的出现位置（毫秒；缺省 0） */
  timestampMs?: number;
  now?: Date;
}

/**
 * 术语卡：H1 术语 + 视频语境含义 / 通用定义 / 类比 / 相关术语 / 出处跳播链接。
 * 摘要预览取视频语境含义（≤200 字），供知识库检索只喂预览。
 */
export function buildTermCardMarkdown(args: BuildTermCardArgs): {
  markdown: string;
  summaryPreview: string;
} {
  const { term, payload, meta } = args;
  const tMs = args.timestampMs ?? 0;
  const now = args.now ?? new Date();
  const parts = [
    `# ${term}`,
    '',
    '## 视频语境',
    payload.inVideoMeaning,
    '',
    '## 通用定义',
    payload.generalDefinition,
    '',
    '## 类比',
    payload.analogy,
  ];
  if (payload.relatedTerms.length > 0) {
    parts.push('', '## 相关术语', payload.relatedTerms.map((t) => `- ${t}`).join('\n'));
  }
  parts.push('', `在《${meta.title}》中出现于 ${timestampLink(meta, tMs)}`);
  const summaryPreview = truncatePreview(
    [payload.inVideoMeaning, payload.generalDefinition].filter((x) => x.length > 0).join(' '),
  );
  const markdown = withFrontmatter(buildTermFrontmatter(term, meta, now), parts.join('\n'));
  return { markdown, summaryPreview };
}

// ---------------------------------------------------------------------------
// 双索引（_meta/index.json 机器用；_索引.md 人用）
// ---------------------------------------------------------------------------

/** 空索引（readIndex 未命中 / 解析失败时的回落） */
export function emptyIndexFile(): KnowledgeIndexFile {
  return { version: 1, entries: [] };
}

/** 笔记名（双链 `[[...]]` 用）：路径末段去掉 .md */
export function noteLinkName(path: string, fallbackTitle: string): string {
  const base = path.split('/').filter((s) => s.length > 0).pop() ?? '';
  const name = base.replace(/\.md$/i, '');
  return name.length > 0 ? name : fallbackTitle;
}

/** 索引分组展示顺序与标题（未登记的分类归到"其他笔记"） */
const INDEX_GROUPS: Array<{ category: KnowledgeIndexEntry['category']; title: string }> = [
  { category: 'video-note', title: '笔记' },
  { category: 'term', title: '概念' },
  { category: 'note', title: '其他笔记' },
];

/** 人类可读索引 MOC：统计 + 按分类分组的双链列表（`[[笔记名]] — 摘要预览`） */
export function buildIndexMarkdown(file: KnowledgeIndexFile): string {
  const entries = file?.entries ?? [];
  const count = (category: KnowledgeIndexEntry['category']): number =>
    entries.filter((e) => e.category === category).length;
  const lines = [
    '# 知识库索引',
    '',
    `共 ${entries.length} 条笔记（视频笔记 ${count('video-note')} · 术语 ${count('term')}）`,
    '',
    `_本文件由扩展生成，机器检索读 \`${INDEX_JSON_NAME}\`。_`,
    '',
  ];
  for (const group of INDEX_GROUPS) {
    const groupEntries = entries.filter((e) => e.category === group.category);
    if (groupEntries.length === 0) continue;
    lines.push(`## ${group.title}`, '');
    for (const e of groupEntries) {
      const preview = truncatePreview(e.summaryPreview);
      lines.push(preview ? `- [[${noteLinkName(e.path, e.title)}]] — ${preview}` : `- [[${noteLinkName(e.path, e.title)}]]`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

/**
 * 按 path 去重覆盖：已存在则原位替换（保持顺序），否则追加到末尾。
 * 纯确定性（无排序抖动），返回新对象（不改入参）。
 */
export function upsertIndexEntry(
  file: KnowledgeIndexFile,
  entry: KnowledgeIndexEntry,
): KnowledgeIndexFile {
  const entries = [...(file?.entries ?? [])];
  const idx = entries.findIndex((e) => e.path === entry.path);
  if (idx >= 0) entries[idx] = { ...entries[idx], ...entry };
  else entries.push(entry);
  return { version: 1, entries };
}

/** 字符串去重（保持首次出现顺序，去首尾空白后比较） */
function dedupeStrings(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const key = item.trim();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// 去重（确定性）
// ---------------------------------------------------------------------------

/** 最长公共子序列长度（动态规划，术语长度量级极小，直出即可） */
function lcsLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** 归一化：trim + 小写（大小写与首尾空白不视为差异） */
function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

/** 相似度：归一化后的 LCS 比例 `2*LCS/(lenA+lenB)`（完全相等为 1） */
export function termSimilarity(a: string, b: string): number {
  const na = normalizeTerm(a);
  const nb = normalizeTerm(b);
  if (na.length === 0 && nb.length === 0) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  if (na === nb) return 1;
  return (2 * lcsLength(na, nb)) / (na.length + nb.length);
}

/**
 * 在已有术语表中查找重复项：相似度 ≥ 0.8 返回该术语（原样返回，非归一化形式）
 * 与相似度；否则 `{ duplicate: null, similarity }`（similarity 为最高相似度）。
 * 空术语 / 空表 → `{ duplicate: null, similarity: 0 }`。
 */
export function findDuplicateTerm(
  newTerm: string,
  existing: Array<{ term: string }>,
): { duplicate: string | null; similarity: number } {
  let best = 0;
  let bestTerm: string | null = null;
  for (const item of existing) {
    const sim = termSimilarity(newTerm, item.term);
    if (sim > best) {
      best = sim;
      bestTerm = item.term;
    }
  }
  if (bestTerm !== null && best >= DUPLICATE_THRESHOLD) {
    return { duplicate: bestTerm, similarity: Number(best.toFixed(4)) };
  }
  return { duplicate: null, similarity: Number(best.toFixed(4)) };
}

// ---------------------------------------------------------------------------
// 大纲笔记区块（SPEC-09 9.7）：标记包裹的 Obsidian 可折叠 callout
// ---------------------------------------------------------------------------

/** 笔记区块标记（Obsidian 阅读视图不可见；重复导出只替换标记之间的内容） */
export function notesMarkerStart(sectionId: string): string {
  return `%% vsc:notes:start ${sectionId} %%`;
}

export const NOTES_MARKER_END = '%% vsc:notes:end %%';

/** 未归位笔记区的 marker id（文末「未归位的笔记」标题下） */
export const UNANCHORED_MARKER_ID = 'unanchored';

/**
 * 单条笔记 → callout 行（纯函数）：
 * `> **[mm:ss](回链)** 正文`；回复串 `> - 我：…` / `> - 助教：…`；
 * 导入的笔记追加「（导入）」标记。多行正文逐行 `> ` 前缀。
 */
export function noteToCalloutLines(meta: VideoMeta, note: OutlineNote): string[] {
  const lines: string[] = [];
  const imported = note.importedFrom ? '（导入）' : '';
  const head = `> **${timestampLink(meta, note.anchor.tMs)}**${imported} `;
  note.body.split('\n').forEach((line, i) => {
    lines.push(i === 0 ? `${head}${line}` : `> ${line}`);
  });
  for (const r of note.replies) {
    lines.push(`> - ${r.author === 'assistant' ? '助教' : '我'}：${r.body}`);
  }
  return lines;
}

/** 某章节的笔记区块（marker 包裹 + 可折叠 callout 头）；无笔记返回 null */
export function buildNotesBlock(
  meta: VideoMeta,
  sectionId: string,
  notes: readonly OutlineNote[],
): string | null {
  if (notes.length === 0) return null;
  const lines = [
    notesMarkerStart(sectionId),
    `> [!note]- 我的笔记（${notes.length}）`,
    ...notes.flatMap((n) => noteToCalloutLines(meta, n)),
    NOTES_MARKER_END,
  ];
  return lines.join('\n');
}

/** 行是否为 vsc 笔记区块的起始标记 */
function isNotesMarkerStartLine(line: string): boolean {
  return /^\s*%%\s*vsc:notes:start\b/.test(line);
}

/** 行是否为 vsc 笔记区块的结束标记 */
function isNotesMarkerEndLine(line: string): boolean {
  return /^\s*%%\s*vsc:notes:end\s*%%\s*$/.test(line);
}

/** 章节标题行匹配：`## {mm:ss}-{mm:ss} {标题}`（时间前缀 + 标题包含） */
function isSectionHeadingLine(line: string, section: Section): boolean {
  if (!line.startsWith(`## ${formatMmSs(section.startMs)}`)) return false;
  return line.includes(section.title);
}

/**
 * 把笔记区块合并进已有笔记正文（纯函数，spec §3.2 / A9 的算法部分）：
 * 1. 剥掉旧的全部 vsc:notes 区块（标记与内容整段移除）；
 * 2. 每个有笔记的章节：区块插在章节标题行之后（找不到标题 → 视同未归位）；
 * 3. 未归位 + 章节缺失的笔记 → 文末「## 未归位的笔记」区块；
 * 4. **标记之外的任何内容（含用户手写）原样保留**——这是 A9 的核心保证。
 * 无任何笔记时返回剥掉旧区块后的正文（区块被清除，其余不动）。
 */
export function applyNotesToMarkdown(
  existing: string,
  meta: VideoMeta,
  sections: readonly Section[],
  notes: readonly OutlineNote[],
): string {
  // ① 剥旧区块
  const cleaned: string[] = [];
  let inBlock = false;
  for (const line of existing.split('\n')) {
    if (isNotesMarkerStartLine(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (isNotesMarkerEndLine(line)) inBlock = false;
      continue;
    }
    cleaned.push(line);
  }

  // ② 按章节分组；找不到章节的并入未归位
  const bySectionId = new Map<string, OutlineNote[]>();
  const unanchored: OutlineNote[] = [];
  const sectionIds = new Set(sections.map((s) => s.id));
  for (const n of notes) {
    if (n.anchor.sectionId && sectionIds.has(n.anchor.sectionId)) {
      const list = bySectionId.get(n.anchor.sectionId) ?? [];
      list.push(n);
      bySectionId.set(n.anchor.sectionId, list);
    } else {
      unanchored.push(n);
    }
  }

  // ③ 逐行重建：章节标题行之后插入该章区块
  const out: string[] = [];
  for (const line of cleaned) {
    out.push(line);
    const section = sections.find((s) => isSectionHeadingLine(line, s));
    if (section) {
      const block = buildNotesBlock(meta, section.id, bySectionId.get(section.id) ?? []);
      bySectionId.delete(section.id);
      if (block) {
        out.push('');
        out.push(block);
      }
    }
  }

  // ④ 未归位（+ 章节标题缺失的）→ 文末
  for (const [, list] of bySectionId) unanchored.push(...list);
  if (unanchored.length > 0) {
    const block = buildNotesBlock(meta, UNANCHORED_MARKER_ID, unanchored);
    if (block) {
      while (out.length > 0 && out[out.length - 1] === '') out.pop();
      out.push('', '## 未归位的笔记', '', block, '');
    }
  }

  return out.join('\n');
}
