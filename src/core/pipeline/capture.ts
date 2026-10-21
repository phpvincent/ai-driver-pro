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
import { normalizeBullets, textOverlap } from './merge';

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
/**
 * 人类可读全局索引（SPEC-06 遗留）：**当前未接线写盘**——人类目录已由
 * `索引/MOC-{领域}.md`（见 `mocPath`）承担。保留此常量与 `buildIndexMarkdown`
 * 仅供单元测试与将来"全局索引"场景复用；AGENTS.md 契约不再承诺 `_索引.md`。
 */
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

/** 文件名非法字符（`/\?:*"><|`、控制字符、全角等价符）替换为 `_`；中文与空格保留；长度截断 60 */
export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  // 半角非法字符 + 控制字符 + 全角等价符（＊？：＂＜＞｜／＼）——
  // 全角冒号虽在 Windows 合法，但网盘同步 / zip / URL 编码下仍有隐患，统一替换（SPEC-18 18.5）
  let cleaned = name.replace(/[/\\:*?"<>|＊？：＂＜＞｜／＼\u0000-\u001f]/g, '_').trim();
  // SPEC-19 N-6：归一 `._` 序列、去首尾点号/下划线/空白（B 站标题常带尾随点号，拼接后成
  // `._` 观感差；`._xxx` 在 macOS 会被当 AppleDouble 隐藏文件）
  cleaned = cleaned.replace(/\._+/g, '_').replace(/^[.\s_]+/, '').replace(/[.\s_]+$/, '');
  const clipped = cleaned.slice(0, FILE_NAME_MAX).replace(/[.\s_]+$/, '');
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

/**
 * terms 噪音过滤（SPEC-18 18.5 / SPEC-19 19.3）：模型抽取"本章技术术语"时会把
 * 命令、文件名、代码标识符、操作细节一并带回（`npm install` / `main.js` / `counter`
 * / `记事本` / `Ctrl+S` 等），这些词条入索引后会稀释术语匹配、拉低检索信噪比。
 *
 * 这里做确定性过滤（只删不改，保留原词）：
 * - 长度 < 2；
 * - **命令形短语**：全 ASCII 且含空格（`npm install`、`vue create`）；
 * - **文件名/代码符号**：带常见扩展名、或以 `$ @ #` 开头（`main.js`、`$store.state`）；
 * - **快捷键/盘符**：`Ctrl+S`、`Shift+Enter`、`E盘`（操作细节，不是概念）；
 * - **停用词**：英文小写归一或中文精确命中表内（`import` / `记事本` / `输入法` 等）。
 *
 * 与 `mapState` / `router-view` / `createStore` / `HTML` 这类真实 API 与概念名不冲突。
 */
export function filterTerms(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    const t = (raw ?? '').trim();
    if (t.length < 2) continue;
    if (/^[A-Za-z0-9\s.\-_]+$/.test(t) && /\s/.test(t)) continue; // 命令形短语
    if (/\.(js|ts|jsx|tsx|vue|json|css|html|md|mjs|cjs)$/i.test(t)) continue; // 文件名
    if (/^[$@#]/.test(t)) continue; // 代码符号
    if (/^(?:ctrl|alt|shift|cmd|win|fn)\s*\+\s*\S+$/i.test(t)) continue; // 快捷键
    if (/^[a-z]:盘$/i.test(t) || /^[a-z]盘$/i.test(t)) continue; // 盘符（E盘/C盘）
    if (TERM_STOPWORDS.has(t.toLowerCase()) || TERM_STOPWORDS_ZH.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** terms 停用词（英文小写归一；只删噪音，不删真实 API 名） */
const TERM_STOPWORDS = new Set([
  'npm', 'install', 'import', 'export', 'create', 'run', 'build', 'test', 'dev', 'start',
  'demo', 'example', 'project', 'folder', 'file', 'code', 'text', 'line', 'node', 'package',
  'version', 'config', 'setup', 'script', 'style', 'name', 'value', 'key', 'page', 'list',
  'item', 'index', 'src', 'app', 'main', 'counter', 'hello', 'world', 'helloworld', 'foo', 'bar',
  'click', 'input', 'output', 'return', 'function', 'class', 'const', 'let', 'var', 'string',
  'number', 'boolean', 'object', 'array', 'null', 'undefined', 'true', 'false',
]);

/** terms 停用词（中文；操作细节与软件名，不是知识概念） */
const TERM_STOPWORDS_ZH = new Set([
  '记事本', '文本文档', '输入法', '文件管理器', '资源管理器', '浏览器', '命令行', '终端',
  '桌面', '窗口', '菜单', '右键', '左键', '单击', '双击', '点击', '拖拽', '滚动条',
  '快捷键', '热键', '按钮', '图标', '标签页', '工具栏', '状态栏', '地址栏', '标题栏',
  '新建', '打开', '保存', '关闭', '退出', '复制', '粘贴', '剪切', '删除', '重命名',
  '刷新', '下载', '上传', '安装', '卸载', '设置', '选项', '属性', '默认', '示例', '演示',
]);

/**
 * 索引条目统一构造（SPEC-18 18.6）：视频笔记与概念页共用同一套字段口径——
 * terms 一律过 `filterTerms`、summaryPreview 一律 `truncatePreview`、
 * `sourceType` 一律显式写入（不再缺省），tags/domain 由调用方传入规范值。
 */
export function buildVideoNoteIndexEntry(args: {
  path: string;
  title: string;
  terms: readonly string[];
  summaryPreview: string;
  videoId: string;
  domain: string;
  entities?: readonly string[];
  now?: Date;
}): KnowledgeIndexEntry {
  return {
    path: args.path,
    title: args.title,
    category: 'video-note',
    tags: ['ai', '视频笔记'],
    terms: filterTerms(args.terms),
    summaryPreview: truncatePreview(args.summaryPreview),
    videoId: args.videoId,
    updatedAt: (args.now ?? new Date()).toISOString(),
    domain: args.domain,
    sourceType: 'ai-distill',
    ...(args.entities && args.entities.length > 0 ? { entities: [...args.entities] } : {}),
  };
}

/** 概念页索引条目（SPEC-18 18.6）：与视频笔记同一口径，sourceType 显式 */
export function buildConceptIndexEntry(args: {
  path: string;
  name: string;
  aliases: readonly string[];
  definition: string;
  domain: string;
  sourceType: 'ai-distill' | 'user-note';
  now?: Date;
}): KnowledgeIndexEntry {
  return {
    path: args.path,
    title: args.name,
    category: 'concept',
    tags: ['ai', '概念', args.domain],
    terms: filterTerms([args.name, ...args.aliases]),
    summaryPreview: truncatePreview(args.definition),
    updatedAt: (args.now ?? new Date()).toISOString(),
    domain: args.domain,
    sourceType: args.sourceType,
    entities: [args.name],
  };
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
  // SPEC-18 复核：date 用本地时区（与笔记 created 一致）；toISOString 是 UTC，
  // 凌晨生成会比用户认知的日期早一天
  const date = formatDate(args.now ?? new Date());
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
export const AGENTS_MD = `# AGENTS.md · 知识库宪法（v2）

> 本文件是知识库的"员工手册"：入库蒸馏的规则宪法 + 检索消费的行为准则。
> 由「视频学习副驾」扩展维护（每次存入覆盖为最新版）；其他 Agent 读写本库时请遵循。

## A. 目录契约

| 目录 | 内容 | 写入规则 |
|------|------|----------|
| \`raw/{领域}/{课程}/\` | 字幕原文（行级 [mm:ss](回放URL) 锚点） | **只读**：入库写一次，之后任何流程不得改写 |
| \`笔记/{领域}/{课程}/\` | 视频笔记（章节 ## 蒸馏 + \`%% vsc:notes %%\` 用户笔记区块） | 存入时合并刷新；区块外手写内容保留 |
| \`概念/{概念名}.md\` | 概念页（**全局唯一，不分领域**；同名不同语境 = 两个概念，靠名字带语境区分） | **追加式合并**：引用记录与 aliases 只增不删 |
| \`索引/MOC-{领域}.md\` | 每领域一张 MOC（人类目录） | 存入时重建该领域页 |
| \`_meta/index.json\` | 机器索引（检索入口；只索引蒸馏层，raw 不进） | 存入时增量合并 |
| \`AGENTS.md\` | 本文件 | 扩展权威维护：存入时覆盖为最新版 |

\`{领域}\` 由蒸馏判定（逻辑学/编程/考研数学…），目录随新领域自动生长；未知回落 \`通用\`。
领域名用下划线复合（如 \`公考_判断推理\`）；**标签**用斜杠嵌套（\`#公考/判断推理\`，Obsidian 层级折叠）——
\`domain\` 字段取下划线形式（规范键），\`tags\` 取斜杠形式（展示），两者同源不同表示。

> 规划中（暂未实现，勿按此寻址）：\`问答/{领域}/{课程}/\`（QA 沉淀）。

## A2. 字段字典（产物中可见的口径）

| 字段 | 口径 |
|------|------|
| \`## mm:ss-mm:ss 标题（N 分）\` 的 N | 0-100 **综合打分**，代码计算：新知识率 45% + 术语密度 25% + 章节重要性 30%。用于密度徽标分档，不是重要度排序 |
| 概念页 frontmatter | 8 字段：\`title / preferred / aliases / broader / domains / type / tags / date\` |
| 引用记录条目 | \`### [[笔记]] [mm:ss](url)\` + \`source:\` + \`语境性质:\` + \`概念语境：\` |
| \`source:\`（引用记录） | \`raw\`（原文溯源）\| \`user-note\`（用户批注，已核验） |
| \`sourceType:\`（索引条目） | \`ai-distill\`（AI 蒸馏，待核验）\| \`user-note\`（用户批注，已核验·检索加权） |

## B. 蒸馏规则（入库时强制执行）

1. **原料只读**：raw 只转录不加工；蒸馏页结论句尾必须带 \`[mm:ss](回放URL)\` 溯源锚点，一路点回原文。
2. **强制 ## 章节结构**：蒸馏页（视频笔记/概念页）正文必须用 \`##\` 二级标题分节——天然语义分割，任何检索方式都受益。
3. **术语归一（可逆性原则）**：蒸馏产出的每个概念必须落位到概念页（新建或合并到既有），不得凭空自造表述；概念名 = frontmatter \`preferred\`（文件名即规范名）。
4. **aliases 只增不删**：同一概念的不同表述（含中英对照、常见缩写）追加进 aliases；删除别名会毁掉历史条目的可检索性。
5. **定义是划界不是解释**：概念页定义须区分邻近概念，不是科普。
6. **引用带身份（"以什么身份连"）**：概念页引用记录不只写"谁提到谁"，必须带**语境**（blockquote + 回放锚点）——同一概念在不同视频中的角色决定检索跳转方向。
   - **逐字原句**（\`语境性质：原句\`）：直接取自 raw，加引号渲染；
   - **语境转述**（\`语境性质：转述\`）：ASR 碎片无法逐字时的忠实转述，**不加引号**并显式标注——引号只留给逐字原句。
   - **锚点必须有效**：取不到锚点就不写这条引用，**禁止 \`[00:00]\` 占位**（占位比缺条目更伤可信度）。
7. **来源标注**：引用记录的 \`source:\` 与索引条目的 \`sourceType:\` 见 A2 字段字典；AI 蒸馏与用户批注冲突时**以用户笔记为准**并在概念页标注分歧。
8. **用户笔记避让**：\`%% vsc:notes:start … %%\` 区块是用户手写保险区，AI 永不进入；讨论串中用户追问 = 用户批注（加权），助教回答 = AI 生成（待核验）。
9. **AI 产出可辨识**：AI 蒸馏的笔记与概念页定义/要点用 \`> [!note] AI 蒸馏 · 待核验\` callout；人改写过的段落自动免标（追加式合并不触碰改写段）。

## C. 检索规则（消费本库时遵循）

1. **先查库再答**：涉及库内领域的问题，先检索 \`_meta/index.json\` 命中蒸馏层，再决定是否补充外部知识。
2. **术语经 aliases 映射**：查询词先按概念页 aliases 归一到 preferred 再匹配，防同概念多表述漏检。
3. **答案必须带溯源锚点**：引用库内知识时给 \`[mm:ss](回放URL)\` 或 \`[[wikilink]]\`，可一路点回原文。
4. **related 关联链**：命中笔记时把其 frontmatter 涉及的概念页一并检查——一条关联链抵三次重搜。
5. **加权**：\`sourceType: user-note\`（用户批注）权重高于 \`ai-distill\`；raw 不参与检索（只做溯源）。
6. **待核验内容如实标注**：引用未核验的 AI 蒸馏时保持 callout 标记可见，不冒充已认定知识。

## D. 变更协议

schema / 目录 / 字段口径变更时，**必须同步本文件**并在 \`版本记录.md\` 留痕；未同步的变更视为无效。
本文件由扩展覆盖维护——手写内容会在下次存入时被覆盖，自定义规则请写进 \`版本记录.md\` 或单独文档。
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
 * 领域标签注入（SPEC-17 关联网）：视频笔记 frontmatter tags 追加嵌套领域标签
 * （公考_判断推理 → #公考/判断推理）。幂等：已有不重复；无 tags 行则跳过（保守）。
 * 效果：Obsidian 图谱开「标签」显示后，同领域笔记经标签节点互连（MOC 星形之外的
 * 第二条领域归群边）；标签面板也可按父域折叠。
 */
export function upsertDomainTag(markdown: string, domain: string): string {
  if (!domain) return markdown;
  // 复合领域同时注入子域标签与父域标签（公考_判断推理 → #公考/判断推理 + #公考）：
  // Obsidian 图谱中嵌套标签各自为独立节点、不按父级合并——父域标签让同域笔记
  // （公考_判断推理 / 公考_数量关系）经共享的 #公考 节点在图谱中互连。
  const tagsToAdd = [domain.replace(/_/g, '/')];
  const parent = domain.split('_')[0];
  if (parent && parent !== domain) tagsToAdd.push(parent);
  const m = markdown.match(/^tags: \[([^\]]*)\]/m);
  if (!m) return markdown;
  const existing = m[1].split(',').map((t) => t.trim());
  const add = tagsToAdd.filter((t) => !existing.includes(t));
  if (add.length === 0) return markdown;
  const current = m[1].trim();
  return markdown.replace(/^tags: \[([^\]]*)\]/m, `tags: [${current}${current ? ', ' : ''}${add.join(', ')}]`);
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

/**
 * 引文原文定位（SPEC-19 N-1）：在提示锚点附近的 raw 行里找出与引文最贴合的
 * 连续行段，返回**逐字原文**与**命中行的时间戳**。
 *
 * 存在的意义：`excerptKind: verbatim` 的引文不能信模型写的文本——真机核验显示
 * 模型会把改写句标成"原句"（19/19 失实），还会批量赋锚（多个概念共用同一时间点）。
 * 改为**代码从 raw 截取**：引文 100% 是原文，锚点 = 命中行时间戳，各概念自然落到各自行。
 *
 * @returns 命中 → `{ text: 逐字原文, startMs: 命中行时间戳 }`；未命中 → null（调用方降级 paraphrase）
 */
export function locateQuoteInRaw(args: {
  /** 模型给的引文（用于定位，不直接使用） */
  excerpt: string;
  cues: ReadonlyArray<{ startMs: number; text: string }>;
  /** 模型给的锚点提示（秒）；允许不准，只作搜索中心 */
  hintSec: number;
  /** 搜索窗口（秒，前后各取）；默认 60 */
  windowSec?: number;
  /** 最多拼接的连续行数；默认 3 */
  maxLines?: number;
}): { text: string; startMs: number } | null {
  const windowSec = args.windowSec ?? 60;
  const maxLines = args.maxLines ?? 3;
  const hintMs = Math.max(0, args.hintSec) * 1000;
  const window = [...args.cues]
    .filter((c) => c.startMs >= hintMs - windowSec * 1000 && c.startMs <= hintMs + windowSec * 1000)
    .sort((a, b) => a.startMs - b.startMs);
  if (window.length === 0) return null;

  let best: { text: string; startMs: number; score: number; quoteCover: number; sourceCover: number } | null = null;
  // 对每个起点生成 1..maxLines 行的多个候选（不是只生成拼满的那一个）——
  // 否则多行拼接会压过真正贴合的单行（真机实测 3 行拼接得高分、引文带进无关内容）
  for (let i = 0; i < window.length; i++) {
    for (let n = 1; n <= maxLines && i + n <= window.length; n++) {
      const joined = window
        .slice(i, i + n)
        .map((c) => (c.text ?? '').trim())
        .filter((x) => x.length > 0)
        .join('');
      if (joined.length === 0) continue;
      // 双向覆盖率（真机核验得出的判据，两个方向缺一不可）：
      // - quoteCover：引文字符被原文覆盖的比例——低 = 引文是改写/编造，不能叫"原句"；
      // - sourceCover：原文字符被引文覆盖的比例——低 = 原文远长于引文（短碎片吞长改写句、
      //   多行拼接带进无关内容），同样不能当命中。
      // 只用其一会误判：'就是加强论据'(6) vs '加强论据是对论据加强'(10) 单向覆盖 0.83 看似高，
      // 实为改写句；而真命中 '加强论点呢是对论点进行支持'(13) vs '加强论点是对论点支持'(10)
      // 单向也是 0.84——必须靠 sourceCover(0.73 vs 0.83) 与 quoteCover(1.0 vs 0.83) 分开。
      const m = coverageScores(joined, args.excerpt);
      const score = m.quoteCover * m.sourceCover;
      if (!best || score > best.score) {
        best = { text: joined, startMs: window[i].startMs, score, ...m };
      }
    }
  }
  return best && best.quoteCover >= VERBATIM_QUOTE_COVER && best.sourceCover >= VERBATIM_SOURCE_COVER
    ? { text: best.text, startMs: best.startMs }
    : null;
}

/** 字符集合双向覆盖率：quoteCover = |A∩B|/|B|（引文被覆盖），sourceCover = |A∩B|/|A|（原文被覆盖） */
function coverageScores(source: string, quote: string): { quoteCover: number; sourceCover: number } {
  const sa = new Set(source.replace(/\s+/g, ''));
  const sb = new Set(quote.replace(/\s+/g, ''));
  if (sa.size === 0 || sb.size === 0) return { quoteCover: 0, sourceCover: 0 };
  let inter = 0;
  for (const ch of sb) if (sa.has(ch)) inter += 1;
  return { quoteCover: inter / sb.size, sourceCover: inter / sa.size };
}

/** 引文字符被原文覆盖的最低比例（低于即视为改写/编造） */
export const VERBATIM_QUOTE_COVER = 0.85;

/** 原文字符被引文覆盖的最低比例（低于即视为短碎片吞长句 / 多行拼接冗余） */
export const VERBATIM_SOURCE_COVER = 0.6;

/**
 * 引用入库校验（SPEC-18/19）：在 conceptReferenceBlock 之前判定该引用能否入库、以何种形态入库。
 *
 * **诚实性优先**（SPEC-19 N-1）：
 * - 标 `verbatim` 的引文**由代码从 raw 截取**（`locateQuoteInRaw`），模型写的文本只用于定位；
 *   命中 → 引文 = 逐字原文、锚点 = 命中行时间戳（根治批量赋锚）；
 * - 定位不到（改写句 / 锚点偏离 / 无 raw 可查）→ **强制降级为 paraphrase**（去引号、标"转述"），
 *   绝不保留假"原句"；
 * - 标 `paraphrase` 的引文原样使用，不加引号并标注。
 *
 * 锚点非法（`anchorSec ≤ 0`）→ 不产出该引用（禁止 `[00:00]` 占位）。
 *
 * @returns `reference` 为可入库的引用块（可能为空串）；`skipped` 为丢弃原因；`downgraded` 标记被降级
 */
export function buildVerifiedReference(args: {
  concept: { anchorSec: number; sourceExcerpt: string; excerptKind?: 'verbatim' | 'paraphrase' };
  videoTitle: string;
  noteLink: string;
  sourceType: 'raw' | 'user-note';
  playbackUrl: string;
  /** raw 原料层字幕（原文定位素材）；不传则 verbatim 一律降级 paraphrase（无法验证就不敢叫原句） */
  cues?: ReadonlyArray<{ startMs: number; text: string }>;
}): { reference: string; skipped?: string; downgraded?: boolean } {
  const { concept } = args;
  const anchorValid = Number.isFinite(concept.anchorSec) && concept.anchorSec > 0;
  if (!anchorValid) {
    return { reference: '', skipped: 'anchor-missing（锚点缺失/为 0，拒绝 [00:00] 占位）' };
  }
  const kind = concept.excerptKind ?? 'verbatim';

  // 转述：原样使用，不加引号
  if (kind === 'paraphrase') {
    return {
      reference: conceptReferenceBlock({
        videoTitle: args.videoTitle,
        noteLink: args.noteLink,
        anchorSec: concept.anchorSec,
        sourceExcerpt: concept.sourceExcerpt,
        sourceType: args.sourceType,
        playbackUrl: args.playbackUrl,
        excerptKind: 'paraphrase',
      }),
    };
  }

  // 原句：代码从 raw 截取；定位不到 → 降级转述
  const hit =
    args.cues && args.cues.length > 0
      ? locateQuoteInRaw({ excerpt: concept.sourceExcerpt, cues: args.cues, hintSec: concept.anchorSec })
      : null;
  if (hit) {
    return {
      reference: conceptReferenceBlock({
        videoTitle: args.videoTitle,
        noteLink: args.noteLink,
        anchorSec: Math.round(hit.startMs / 1000),
        sourceExcerpt: hit.text,
        sourceType: args.sourceType,
        playbackUrl: args.playbackUrl,
        excerptKind: 'verbatim',
      }),
    };
  }
  return {
    reference: conceptReferenceBlock({
      videoTitle: args.videoTitle,
      noteLink: args.noteLink,
      anchorSec: concept.anchorSec,
      sourceExcerpt: concept.sourceExcerpt,
      sourceType: args.sourceType,
      playbackUrl: args.playbackUrl,
      excerptKind: 'paraphrase',
    }),
    downgraded: true,
  };
}

/** 概念页引用记录块（"以什么身份连"：带语境 + 回放锚点 + 来源标注） */
export function conceptReferenceBlock(args: {
  videoTitle: string;
  /** 来源笔记文件名（不含 .md）；wikilink 目标——Obsidian 图谱由此连线（概念 → 笔记 边） */
  noteLink: string;
  anchorSec: number;
  sourceExcerpt: string;
  sourceType: 'raw' | 'user-note';
  playbackUrl: string;
  /**
   * SPEC-18：语境性质。`verbatim`（缺省）= 逐字原句，加引号渲染；
   * `paraphrase` = 语境转述，**不加引号**并标注——引号只留给逐字原句，
   * 转述必须显式标识，否则会让读者误以为点回去能看到同一句话。
   */
  excerptKind?: 'verbatim' | 'paraphrase';
}): string {
  const ts = formatClock(args.anchorSec * 1000);
  const link = args.playbackUrl ? `[${ts}](${args.playbackUrl})` : `[${ts}]`;
  const kind = args.excerptKind ?? 'verbatim';
  const quoted = kind === 'paraphrase' ? `> （语境转述）${args.sourceExcerpt}` : `> "${args.sourceExcerpt}"`;
  return [
    `### [[${args.noteLink}|${args.videoTitle}]] ${link}`,
    `- source: ${args.sourceType}`,
    kind === 'paraphrase' ? `- 语境性质：转述（非逐字原句）` : `- 语境性质：原句`,
    `- 概念语境：`,
    '',
    quoted,
    '',
  ].join('\n');
}

/**
 * broader 入库校验（SPEC-19 N-2）：上位概念必须指向**存在的概念页**且**不得是自身**，
 * 否则置空（自指环 / 悬空链接会让概念图不可用——真机核验发现 1 自指 + 1 悬空）。
 *
 * 只做机械可判定项：存在性 + 非自指。语义层级（是否母题而非同级兄弟）由 prompt 引导。
 *
 * @returns 合法的 broader；非法（空/自指/目标不存在）返回 ''
 */
export function sanitizeBroader(args: {
  broader: string;
  selfName: string;
  /** 已存在的概念名集合（既有库 + 本批新建，含自身也无妨） */
  knownConcepts: ReadonlySet<string>;
}): string {
  const b = (args.broader ?? '').trim();
  if (b.length === 0) return '';
  if (b === args.selfName.trim()) return '';
  if (!args.knownConcepts.has(b)) return '';
  return b;
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
  // SPEC-18 复核：date 用本地时区（与笔记 created 一致），避免凌晨生成差一天
  const date = formatDate(args.now ?? new Date());
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
    // SPEC-18：引用记录为空时省略该节（宁缺毋滥，不写占位条目）
    ...(args.reference.trim().length > 0 ? ['', '## 引用记录', '', args.reference] : []),
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
    // SPEC-18：AI 产出可辨识（宪法 B.9）+ 待核验如实标注（C.6）
    '> [!note] AI 蒸馏 · 待核验',
    '> 本笔记由 AI 从字幕原文蒸馏，尚未人工核验；引用前请点锚点回原文确认。',
    '',
  ];
  const body = sections.map((s) => {
    const score = s.score != null ? `${s.score} 分` : '-';
    // SPEC-18：bullets 确定性归一（对非 finalizeOutline 路径的 sections 也生效，幂等）
    const bullets = normalizeBullets(s.bullets, s.startMs, s.endMs);
    // SPEC-18：章节摘要句尾带溯源锚点（宪法 B.1「结论句尾必须带锚点」）
    const summaryLine = `${s.summary} ${timestampLink(meta, s.startMs)}`;
    const lines = [`## ${formatMmSs(s.startMs)}-${formatMmSs(s.endMs)} ${s.title}（${score}）`, '', summaryLine, ''];
    for (const bullet of bullets) {
      lines.push(`- ${timestampLink(meta, bullet.startMs)} ${bullet.text}`);
    }
    if (s.terms.length > 0) {
      // SPEC-19：正文「术语：」行同样过噪音过滤（与索引 terms 同口径）
      const secTerms = filterTerms(s.terms);
      if (secTerms.length > 0) lines.push('', `术语：${secTerms.join(' · ')}`);
    }
    return lines.join('\n');
  });
  const terms = dedupeStrings(filterTerms(sections.flatMap((s) => s.terms)));
  const firstSummary = sections.length > 0 ? sections[0].summary : '';
  const previewRaw = [firstSummary, terms.length > 0 ? `术语：${terms.join(' · ')}` : '']
    .filter((x) => x.length > 0)
    .join(' ');
  const summaryPreview = truncatePreview(previewRaw || meta.title);
  const markdown = withFrontmatter(
    buildFrontmatter(meta, 'video-note', now, filterTerms(contentTagsFor(sections))),
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
