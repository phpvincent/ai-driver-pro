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

/** 笔记在 vault 中的分类目录（分层目录，借鉴 ai-knowlage） */
export const NOTE_DIR = {
  video: '视频笔记',
  term: '术语',
} as const;

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
): { videoNote: string; termDir: string } {
  const course = sanitizeFileName(meta.bvid || meta.videoId);
  return {
    videoNote: joinVaultPath(rootDir, NOTE_DIR.video, course, `${sanitizeFileName(meta.title)}.md`),
    termDir: joinVaultPath(rootDir, NOTE_DIR.term),
  };
}

/** 术语卡落盘路径（扁平存放于术语目录） */
export function termNotePath(term: string, termDir: string): string {
  return joinVaultPath(termDir, `${sanitizeFileName(term)}.md`);
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
  { category: 'video-note', title: '视频笔记' },
  { category: 'term', title: '术语' },
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
