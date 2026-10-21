/**
 * Obsidian 存库接线层（SPEC-06，父 agent 在 App.tsx 接线）。
 *
 * 组装 sink（src/sinks/obsidian.ts，注入式 fetch）+ 捕获管道（capture 纯函数）+
 * 双索引（`_meta/index.json` 机器检索 / `_索引.md` 人类 MOC）+ 术语卡本地缓存
 * （IndexedDB terms store，键 [term, videoId]）。
 *
 * 一律用户点按钮触发（无自动落盘，SPEC-06「不做自动写入」）；失败 throw 由
 * UI 行内展示（红线 8：不崩面板）。配置读写经 MSG.GET_SETTINGS / SET_SETTINGS，
 * settings.obsidian 与 model 分区独立，保存只合并 obsidian 段。
 */
import { DB } from '../config';
import {
  applyNotesToMarkdown,
  AGENTS_MD,
  AGENTS_MD_PATH,
  buildConceptPageMarkdown,
  buildIndexMarkdown,
  buildMocMarkdown,
  buildRawMarkdown,
  buildTermCardMarkdown,
  buildVideoNoteIndexEntry,
  buildVideoNoteMarkdown,
  buildVerifiedReference,
  buildConceptIndexEntry,
  conceptNotePath,
  conceptReferenceBlock,
  DEFAULT_DOMAIN,
  buildConceptLinksBlock,
  emptyIndexFile,
  filterTerms,
  findDuplicateTerm,
  INDEX_JSON_NAME,
  INDEX_MD_NAME,
  joinVaultPath,
  localMarkdownFileName,
  mergeConceptPageMarkdown,
  upsertConceptLinksBlock,
  upsertDomainTag,
  mocPath,
  playbackUrl,
  termNotePath,
  upsertIndexEntry,
  vaultPathsFor,
} from '../core/pipeline/capture';
import type { DistillResult } from '../core/pipeline/explain';
import { deleteNote, getNote, putNote, testConnection, type ObsidianFetch } from '../sinks/obsidian';
import { fixLintIssues, lintKnowledgeIndex, type KnowledgeLintIssue } from '../core/knowledge/retriever';
import { downloadTextFile } from '../platform/files';
import { createSubtitleDb, listNotesByVideo } from '../storage/db';
import type {
  KnowledgeIndexEntry,
  KnowledgeIndexFile,
  ObsidianConfig,
  OutlineNote,
  Section,
  TermCard,
  VideoMeta,
} from '../types';
import { MSG } from '../messages';
import type { TermPayloadLike } from '../core/pipeline/capture';

/** 模块级单例 DB（惰性 open 由 db 层内部保证幂等） */
const db = createSubtitleDb();

/** 默认请求实现：侧边栏上下文直接用全局 fetch */
const defaultFetch: ObsidianFetch = (url, init) => fetch(url, init);

/** chrome.runtime.sendMessage 的安全包装：上下文失效时返回 null */
function sendRuntimeMessage(message: unknown): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve(null);
  }
}

/** 读完整 settings（background 返回整个 settings 对象） */
async function readSettings(): Promise<Record<string, unknown>> {
  const response = await sendRuntimeMessage({ type: MSG.GET_SETTINGS });
  const stored = (response ?? {}) as Record<string, unknown>;
  return stored && typeof stored === 'object' ? stored : {};
}

/** 索引文件路径（`{rootDir}/_meta/index.json`） */
export function indexPath(rootDir: string): string {
  return joinVaultPath(rootDir, INDEX_JSON_NAME);
}

/** 人类可读索引路径（`{rootDir}/_索引.md`） */
export function indexMarkdownPath(rootDir: string): string {
  return joinVaultPath(rootDir, INDEX_MD_NAME);
}

/**
 * 读机器索引：getNote 读 `{rootDir}/_meta/index.json`；
 * 404 / 网络异常 / JSON 解析失败一律回落空索引（索引缺失不阻断存库）。
 */
export async function readIndex(
  cfg: ObsidianConfig,
  fetchFn: ObsidianFetch = defaultFetch,
): Promise<KnowledgeIndexFile> {
  try {
    const raw = await getNote(cfg, fetchFn, indexPath(cfg.rootDir));
    const parsed = JSON.parse(raw) as KnowledgeIndexFile;
    if (!parsed || !Array.isArray(parsed.entries)) return emptyIndexFile();
    return { version: 1, entries: parsed.entries };
  } catch {
    return emptyIndexFile();
  }
}

/**
 * 写双索引：JSON（机器检索）+ `_索引.md`（人类 MOC）。
 * 索引写失败不阻断主流程——调用方自行决定是否向上传播（存库主笔记已成功）。
 */
export async function writeIndex(
  cfg: ObsidianConfig,
  fetchFn: ObsidianFetch,
  file: KnowledgeIndexFile,
): Promise<void> {
  const json = JSON.stringify({ version: 1, entries: file.entries }, null, 2);
  await putNote(cfg, fetchFn, indexPath(cfg.rootDir), json);
  // _索引.md 已被 索引/MOC-{领域}.md 取代（SPEC-17 审计：全局索引与领域 MOC 功能重叠，不再双写）
}

/**
 * 读当前生效的知识库配置（SPEC-16：按通道分离）——
 * knowledgeSink='obsidian' 读 obsidian 段；'companion'（默认）读 companion 段。
 * 未设置时按存量迁移：obsidian 段已配 Key → obsidian（老用户不破坏），否则 companion。
 * 未配置（三段全空 / enabled=false）返回 null（存入走本地 .md 下载降级）。
 */
export async function getObsidianConfig(): Promise<ObsidianConfig | null> {
  const settings = await readSettings();
  const obsidianStored = (settings.obsidian ?? {}) as Partial<ObsidianConfig>;
  const companionStored = ((settings as { companion?: Partial<ObsidianConfig> }).companion ??
    {}) as Partial<ObsidianConfig>;
  // readSettings 返回 Record<string, unknown>：通道值需显式收窄
  const rawSink = settings.knowledgeSink;
  const sink: 'companion' | 'obsidian' =
    rawSink === 'obsidian' || rawSink === 'companion'
      ? rawSink
      : typeof obsidianStored.apiKey === 'string' && obsidianStored.apiKey.length > 0
        ? 'obsidian'
        : 'companion';
  const stored = sink === 'obsidian' ? obsidianStored : companionStored;
  if (!stored || typeof stored !== 'object') return null;
  const cfg: ObsidianConfig = {
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : '',
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
    rootDir: typeof stored.rootDir === 'string' ? stored.rootDir : '',
    enabled: stored.enabled !== false,
    kind: sink,
  };
  // enabled=false（设置页"暂时停用"）→ 视同未配置：存入走本地 .md 下载降级
  if (cfg.enabled === false) return null;
  if (!cfg.baseUrl && !cfg.apiKey && !cfg.rootDir) return null;
  return cfg;
}

/** 保存知识库配置：按通道写入各自分区（companion / obsidian 互不覆盖） */
export async function saveKnowledgeConfig(
  sink: 'companion' | 'obsidian',
  cfg: ObsidianConfig,
): Promise<void> {
  const settings = await readSettings();
  if (sink === 'obsidian') {
    await sendRuntimeMessage({
      type: MSG.SET_SETTINGS,
      payload: { ...settings, obsidian: cfg, knowledgeSink: sink },
    });
    return;
  }
  await sendRuntimeMessage({
    type: MSG.SET_SETTINGS,
    payload: { ...settings, companion: cfg, knowledgeSink: sink },
  });
}

/** 保存 Obsidian 配置：与 settings 现有分区合并写（不动 model 段） */
export async function saveObsidianConfig(cfg: ObsidianConfig): Promise<void> {
  const settings = await readSettings();
  await sendRuntimeMessage({ type: MSG.SET_SETTINGS, payload: { ...settings, obsidian: cfg } });
}

/** 连通性自检：成功返回根目录条目（供设置页显示条目数）；失败 throw（文案含操作指引） */
export async function testObsidianConnection(
  cfg: ObsidianConfig,
  fetchFn: ObsidianFetch = defaultFetch,
): Promise<{ ok: true; rootEntries: string[] }> {
  return await testConnection(cfg, fetchFn);
}

/** 读配置并校验必填（未配置时 throw 可操作文案） */
async function requireConfig(): Promise<ObsidianConfig> {
  const cfg = await getObsidianConfig();
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    throw new Error('未配置知识库同步：请先在设置页（个人知识库）填写接口地址、API Key 与笔记根目录');
  }
  return cfg;
}

/** 存入结果（SPEC-10 10.4：local=true 表示未配置 Obsidian 时的本地 .md 下载降级） */
export interface SaveNoteResult {
  path: string;
  /** true = 走了本地下载（未配置 Obsidian），UI 文案需区分 */
  local?: boolean;
  /** SPEC-17：存入即体检——对刚写回的索引跑 Lint（断链/孤儿/领域分裂），有问题在此提示 */
  lintIssues?: KnowledgeLintIssue[];
}

/**
 * 视频笔记存库：Obsidian 已配置 → 落盘 + 双索引；**未配置 → 自动降级为本地
 * .md 下载**（SPEC-10 10.4 Obsidian 解绑：同一构建函数 = 同一格式，裸读文件
 * 即知来源与类型）。SPEC-09 9.7：目标笔记文件已存在时走标记合并路径——
 * 只增删/替换 `%% vsc:notes:start … %%` 区块，标记外（含用户手写）原样保留。
 */
export async function saveVideoNoteToObsidian(args: {
  videoId: string;
  meta: VideoMeta;
  sections: Section[];
  /** SPEC-17：字幕 cue（raw 原料层落盘；不传则跳过 raw） */
  cues?: ReadonlyArray<{ startMs: number; endMs: number; text: string }>;
  /**
   * SPEC-17：入库蒸馏回调（App 层注入——loader 不 import providers，模块边界不变）。
   * 内部 try/catch 降级：失败 → domain=通用、概念页跳过，笔记照常落盘（用户决策⑤）。
   */
  distill?: (args: {
    videoNoteMarkdown: string;
    userNotesMarkdown: string;
    /** SPEC-17 概念合并：库内既有概念清单（蒸馏据此判定合并 or 新建） */
    existingConcepts: ReadonlyArray<{ name: string; aliases: string[] }>;
    /** SPEC-17 领域归一：库内既有领域清单（模型优先复用，防同域异名分裂目录） */
    existingDomains: ReadonlyArray<string>;
  }) => Promise<DistillResult>;
  fetchFn?: ObsidianFetch;
}): Promise<SaveNoteResult> {
  const cfg = await getObsidianConfig();
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) {
    return await exportVideoNoteLocal(args);
  }
  const fetchFn = args.fetchFn ?? defaultFetch;

  // 大纲笔记（SPEC-09 9.7）：自动携带该视频全部笔记
  const notes = await listNotesByVideo(db, args.videoId).catch(() => []);

  // ---- SPEC-17 蒸馏（Ingest）：领域判定 + 概念抽取；失败降级不阻断 ----
  const userNotesMd = serializeNotesForDistill(notes);
  const noteDraft = buildVideoNoteMarkdown({
    meta: args.meta,
    sections: args.sections,
    sourceVideoId: args.videoId,
  });
  let domain = DEFAULT_DOMAIN;
  let concepts: DistillResult['concepts'] = [];
  if (args.distill) {
    try {
      // SPEC-17 概念合并：蒸馏前读既有索引，提取全部概念页（名+别名）喂给模型——
      // 单视频蒸馏看不到全局，清单补上"库里已有什么"的视角，同义概念走合并不新建
      const existingIndex = await readIndex(cfg, fetchFn).catch(() => null);
      const existingConcepts = (existingIndex?.entries ?? [])
        .filter((e) => e.category === 'concept' || e.category === 'term')
        .map((e) => ({ name: e.title, aliases: e.terms.filter((t) => t !== e.title) }));
      // 领域归一：distinct 领域名喂模型（优先复用，防 公考_判断推理 vs 公考行测_判断推理 分裂）
      const existingDomains = [...new Set((existingIndex?.entries ?? [])
        .map((e) => e.domain)
        .filter((d): d is string => typeof d === 'string' && d.length > 0))];
      const distilled = await args.distill({
        videoNoteMarkdown: noteDraft.markdown,
        userNotesMarkdown: userNotesMd,
        existingConcepts,
        existingDomains,
      });
      domain = distilled.domain?.trim() || DEFAULT_DOMAIN;
      concepts = distilled.concepts ?? [];
    } catch (err) {
      // 降级（用户决策⑤）：domain 回落 通用、概念页跳过，笔记照常落盘
      console.warn('[vsc] distill failed, fallback to plain save', err);
    }
  }
  const paths = vaultPathsFor(args.meta, cfg.rootDir, domain);
  const { videoNote } = paths;

  let markdown = noteDraft.markdown;
  try {
    const existing = await getNote(cfg, fetchFn, videoNote);
    if (existing.trim().length > 0) {
      // 已有文件：只动笔记区块，手写内容保留（A9）
      markdown = applyNotesToMarkdown(existing, args.meta, args.sections, notes);
    } else {
      markdown = applyNotesToMarkdown(noteDraft.markdown, args.meta, args.sections, notes);
    }
  } catch {
    // 读取失败（404 / 网络）→ 全量生成并内联笔记区块
    markdown = applyNotesToMarkdown(noteDraft.markdown, args.meta, args.sections, notes);
  }

  // SPEC-17 关联网：刷新笔记的「涉及概念」标记区块（笔记→概念/笔记→raw wikilink），
  // 幂等：重存只替换 vsc:concepts 区块，手写内容不动
  const rawLink = `${args.meta.bvid || args.meta.videoId}_p${args.meta.page}`;
  // SPEC-17 关联网：frontmatter 注入嵌套领域标签（同域笔记经标签节点互连；幂等）
  markdown = upsertDomainTag(markdown, domain);
  markdown = upsertConceptLinksBlock(
    markdown,
    buildConceptLinksBlock({ conceptNames: concepts.map((c) => c.name), rawLink }),
  );
  await putNote(cfg, fetchFn, videoNote, markdown);

  // ---- SPEC-17：raw 原料层（只写一次；已存在不覆盖——只读语义）----
  if (args.cues && args.cues.length > 0) {
    try {
      await getNote(cfg, fetchFn, paths.rawNote);
    } catch {
      await putNote(cfg, fetchFn, paths.rawNote, buildRawMarkdown({ meta: args.meta, cues: args.cues }));
    }
  }

  // ---- SPEC-17：概念页（追加式合并；aliases 只增不删）----
  for (const concept of concepts) {
    // 笔记文件名（wikilink 目标——Obsidian 图谱由概念→笔记连线）
    const noteLink = paths.videoNote.split('/').pop()?.replace(/\.md$/, '') ?? '';
    // SPEC-18：引用入库校验（禁 [00:00] 占位 + 窗口软校验）；被丢弃只记日志，不阻断概念页
    const verified = buildVerifiedReference({
      concept,
      videoTitle: args.meta.title,
      noteLink,
      // 原话出现在用户笔记序列化里 → user-note（已核验·加权）；否则 raw 溯源
      sourceType: userNotesMd.includes(concept.sourceExcerpt) ? 'user-note' : 'raw',
      playbackUrl: playbackUrl(args.meta, concept.anchorSec * 1000),
      cues: args.cues,
    });
    if (verified.skipped) {
      console.warn(`[vsc] 概念「${concept.name}」引用被丢弃：${verified.skipped}`);
    }
    const ref = verified.reference;
    const cPath = conceptNotePath(concept.name, cfg.rootDir);
    try {
      const existing = await getNote(cfg, fetchFn, cPath);
      await putNote(
        cfg,
        fetchFn,
        cPath,
        mergeConceptPageMarkdown({
          existing,
          newAliases: concept.aliases,
          domain,
          reference: ref,
        }),
      );
    } catch {
      await putNote(
        cfg,
        fetchFn,
        cPath,
        buildConceptPageMarkdown({
          preferred: concept.name,
          aliases: concept.aliases,
          definition: concept.definition,
          broader: concept.broader,
          domain,
          reference: ref,
        }),
      );
    }
  }

  // ---- SPEC-17：AGENTS.md 宪法（权威维护：无则创建、有则覆盖）+ 领域 MOC ----
  // AGENTS.md 与知识库同根（rootDir 下）——与笔记/概念/raw 一棵子树，不散落 vault 根
  await putNote(cfg, fetchFn, joinVaultPath(cfg.rootDir, AGENTS_MD_PATH), AGENTS_MD).catch(() => undefined);

  // ---- 索引（机器检索入口）：视频笔记 entry 带 domain/entities；概念页 entry ----
  // SPEC-18：条目由共享构造函数产出（terms 过滤、sourceType 显式、预览统一截断）
  const file = await readIndex(cfg, fetchFn);
  const entityNames = concepts.map((c) => c.name);
  const entry = buildVideoNoteIndexEntry({
    path: videoNote,
    title: args.meta.title,
    terms: noteDraft.terms,
    summaryPreview: noteDraft.summaryPreview,
    videoId: args.videoId,
    domain,
    entities: entityNames,
  });
  let fileNext = upsertIndexEntry(file, entry);
  for (const concept of concepts) {
    const cPath = conceptNotePath(concept.name, cfg.rootDir);
    fileNext = upsertIndexEntry(
      fileNext,
      buildConceptIndexEntry({
        path: cPath,
        name: concept.name,
        aliases: concept.aliases,
        definition: concept.definition,
        domain,
        sourceType: userNotesMd.includes(concept.sourceExcerpt) ? 'user-note' : 'ai-distill',
      }),
    );
  }
  await writeIndex(cfg, fetchFn, fileNext);

  // ---- 领域 MOC（人类目录）：存入时重建该领域页 ----
  await putNote(
    cfg,
    fetchFn,
    joinVaultPath(cfg.rootDir, mocPath(domain)),
    buildMocMarkdown({ domain, entries: fileNext.entries }),
  ).catch(() => undefined);

  // ---- SPEC-17 存入即体检：对刚写回的索引跑 Lint（纯函数，零额外请求）----
  const lintIssues = lintKnowledgeIndex(fileNext);
  return { path: videoNote, ...(lintIssues.length > 0 ? { lintIssues } : {}) };
}

/**
 * 用户笔记与讨论串 → 蒸馏输入序列化（纯函数，导出供单测）：
 * 笔记正文与每条讨论串回复按序展开——用户批注是最高优先级口径，
 * 蒸馏 prompt 据此优先采用用户表述，概念引用可标 source: user-note。
 */
export function serializeNotesForDistill(notes: OutlineNote[]): string {
  const parts: string[] = [];
  for (const n of notes) {
    parts.push(`### 我：${n.body}`);
    for (const r of n.replies) {
      parts.push(r.author === 'assistant' ? `- 助教：${r.body}` : `- 我：${r.body}`);
    }
  }
  return parts.join('\n\n');
}

/** 本地 .md 下载降级（未配置 Obsidian）：视频笔记 + 大纲笔记区块，同一构建函数 */
async function exportVideoNoteLocal(args: {
  videoId: string;
  meta: VideoMeta;
  sections: Section[];
}): Promise<SaveNoteResult> {
  const note = buildVideoNoteMarkdown({
    meta: args.meta,
    sections: args.sections,
    sourceVideoId: args.videoId,
  });
  const notes = await listNotesByVideo(db, args.videoId).catch(() => []);
  const markdown = applyNotesToMarkdown(note.markdown, args.meta, args.sections, notes);
  const filename = localMarkdownFileName(args.meta);
  downloadTextFile(filename, markdown, 'text/markdown');
  return { path: filename, local: true };
}

/**
 * 术语卡存库：Obsidian 已配置 → 先确定性去重（阈值 0.8，命中 throw 由 UI 提示
 * 合并）再落盘；**未配置 → 本地 .md 下载降级**（SPEC-10 10.4，不做去重——
 * 没有 vault 共享术语表，重复下载由用户自己管理）。
 */
export async function saveTermCardToObsidian(args: {
  term: string;
  payload: TermPayloadLike;
  meta: VideoMeta;
  existingTerms: Array<{ term: string }>;
  /** 该术语在视频中的出现位置（毫秒；缺省 0） */
  timestampMs?: number;
  fetchFn?: ObsidianFetch;
}): Promise<{ path: string; duplicate: string | null; local?: boolean }> {
  const cfgNow = await getObsidianConfig();
  if (!cfgNow || !cfgNow.baseUrl || !cfgNow.apiKey) {
    const tMs = args.timestampMs ?? 0;
    const note = buildTermCardMarkdown({ term: args.term, payload: args.payload, meta: args.meta, timestampMs: tMs });
    const filename = `术语_${localMarkdownFileName(args.meta)}`;
    downloadTextFile(filename, note.markdown, 'text/markdown');
    return { path: filename, duplicate: null, local: true };
  }

  const dup = findDuplicateTerm(args.term, args.existingTerms);
  if (dup.duplicate !== null) {
    throw new Error(`已存在相似术语「${dup.duplicate}」（相似度 ${dup.similarity}），是否合并？`);
  }

  const cfg = await requireConfig();
  const fetchFn = args.fetchFn ?? defaultFetch;
  const tMs = args.timestampMs ?? 0;
  const { termDir } = vaultPathsFor(args.meta, cfg.rootDir);
  const path = termNotePath(args.term, termDir);
  const note = buildTermCardMarkdown({
    term: args.term,
    payload: args.payload,
    meta: args.meta,
    timestampMs: tMs,
  });

  await putNote(cfg, fetchFn, path, note.markdown);

  const file = await readIndex(cfg, fetchFn);
  const entry: KnowledgeIndexEntry = {
    path,
    title: args.term,
    category: 'term',
    tags: ['ai', '术语'],
    terms: filterTerms([args.term, ...(args.payload.relatedTerms ?? [])]),
    summaryPreview: note.summaryPreview,
    videoId: args.meta.videoId,
    updatedAt: new Date().toISOString(),
    sourceType: 'ai-distill',
  };
  await writeIndex(cfg, fetchFn, upsertIndexEntry(file, entry));

  // 术语卡同时入本地缓存（键 [term, videoId]）；写失败不阻断存库结果
  try {
    const card: TermCard = {
      term: args.term,
      inVideoMeaning: args.payload.inVideoMeaning,
      generalDefinition: args.payload.generalDefinition,
      analogy: args.payload.analogy,
      relatedTerms: args.payload.relatedTerms ?? [],
      videoId: args.meta.videoId,
      sourceUrl: playbackUrl(args.meta, tMs),
      timestampMs: tMs,
      createdAt: new Date().toISOString(),
    };
    await db.put(DB.stores.terms, [args.term, args.meta.videoId], card);
  } catch {
    /* 本地缓存写失败忽略 */
  }

  return { path, duplicate: null };
}


/**
 * 知识库体检（SPEC-17 Lint v1）：拉取机器索引 → 结构检查，返回问题清单。
 * 索引缺失/读取失败返回空清单（空库 = 无问题，不报错，红线 8）。
 */
export async function checkKnowledgeHealth(): Promise<KnowledgeLintIssue[]> {
  const cfg = await getObsidianConfig();
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) return [];
  try {
    const file = await readIndex(cfg, defaultFetch);
    return lintKnowledgeIndex(file);
  } catch {
    return [];
  }
}

/** 体检修复报告（SPEC-17 v2） */
export interface HealthRepairReport {
  /** 补全领域条数 */
  fixedDomains: number;
  /** 移除断链引用条数 */
  fixedLinks: number;
  /** 已删除的纯 AI 孤儿概念页 */
  cleanedOrphans: string[];
  /** 含手写内容而保留的孤儿概念页（不误删人的劳动） */
  keptManualOrphans: string[];
}

/**
 * 体检修复（SPEC-17 v2，设置页「一键修复」）：
 * - 领域补全（笔记按路径解析；概念读文件 frontmatter domains）
 * - 断链移除引用（index 自洽；重新存入可重建概念页）
 * - 孤儿概念页：**仅删纯 AI 页**（仍带「AI 蒸馏 · 待核验」标记 = 人没动过）；
 *   被人改写过的（标记已消失）一律保留报告——宁可留垃圾不删人写的内容
 * - 写回索引 + 重建涉及领域的 MOC
 */
export async function repairKnowledgeHealth(): Promise<HealthRepairReport | null> {
  const cfg = await getObsidianConfig();
  if (!cfg || !cfg.baseUrl || !cfg.apiKey) return null;
  const fetchFn = defaultFetch;
  const file = await readIndex(cfg, fetchFn);
  if ((file?.entries ?? []).length === 0) return null;

  // 概念条目缺领域：读文件 frontmatter domains（title → domain 首值）
  const conceptDomains = new Map<string, string>();
  const domainRe = /^domains: \[([^\]]*)\]/m;
  for (const e of file.entries) {
    if (e.category === 'concept' && !e.domain) {
      try {
        const md = await getNote(cfg, fetchFn, e.path);
        const m = md.match(domainRe);
        if (m && m[1]) conceptDomains.set(e.title, m[1].split(',')[0].trim());
      } catch {
        /* 文件读不到：留给断链/孤儿逻辑处理 */
      }
    }
  }

  const fix = fixLintIssues(file.entries, { conceptDomains });
  const cleanedOrphans: string[] = [];
  const keptManualOrphans: string[] = [];
  const cleanedPaths = new Set<string>();
  for (const orphanPath of fix.orphanPaths) {
    try {
      const md = await getNote(cfg, fetchFn, orphanPath);
      // 含待核验标记 = 纯 AI 页（人没动过）→ 可删；标记消失 = 人改写过 → 保留
      if (md.includes('AI 蒸馏 · 待核验')) {
        await deleteNote(cfg, fetchFn, orphanPath);
        cleanedOrphans.push(orphanPath);
        cleanedPaths.add(orphanPath);
      } else {
        keptManualOrphans.push(orphanPath);
      }
    } catch {
      keptManualOrphans.push(orphanPath); // 文件不存在/读失败：不删，保守保留
    }
  }

  // 写回：修复后的条目（去掉已删孤儿）+ 涉及领域 MOC 重建
  const finalEntries = fix.entries.filter((e) => !cleanedPaths.has(e.path));
  const report: HealthRepairReport = {
    fixedDomains: fix.fixedDomains,
    fixedLinks: fix.fixedLinks,
    cleanedOrphans,
    keptManualOrphans,
  };
  if (fix.fixedDomains === 0 && fix.fixedLinks === 0 && cleanedOrphans.length === 0 && keptManualOrphans.length === 0) {
    return report; // 无变化，不写回
  }
  await writeIndex(cfg, fetchFn, { version: 1, entries: finalEntries });
  const domains = [...new Set(finalEntries.map((e) => e.domain).filter((d): d is string => !!d))];
  for (const d of domains) {
    await putNote(
      cfg,
      fetchFn,
      joinVaultPath(cfg.rootDir, mocPath(d)),
      buildMocMarkdown({ domain: d, entries: finalEntries }),
    ).catch(() => undefined);
  }
  return report;
}
