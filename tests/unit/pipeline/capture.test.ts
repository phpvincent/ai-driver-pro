/**
 * 知识捕获管道单测（SPEC-06 子任务 6.2/6.3，A1/A2）：
 * YAML 转义、frontmatter 字段齐（解析回读）、文件名清洗、分层目录路径、
 * 视频笔记（章节 / 回放链接 / 摘要预览）、术语卡、双索引 MOC、索引去重覆盖、
 * 术语去重（确定性相似度）。全部为纯函数断言。
 *
 * 红线 9：URL 字面量只作为被测输入（视频地址）出现，不涉及受管控端点。
 */
import { describe, expect, it } from 'vitest';
import {
  buildIndexMarkdown,
  buildTermCardMarkdown,
  buildVideoNoteMarkdown,
  contentTagsFor,
  emptyIndexFile,
  findDuplicateTerm,
  formatDate,
  INDEX_JSON_NAME,
  INDEX_MD_NAME,
  joinVaultPath,
  playbackUrl,
  timestampLink,
  sanitizeFileName,
  SUMMARY_PREVIEW_MAX,
  termSimilarity,
  truncatePreview,
  upsertIndexEntry,
  vaultPathsFor,
  videoPageUrl,
  yamlValue,
} from '../../../src/core/pipeline/capture';
import type { KnowledgeIndexEntry, KnowledgeIndexFile, Section, VideoMeta } from '../../../src/types';

const meta = (over: Partial<VideoMeta> = {}): VideoMeta => ({
  videoId: 'BV1YG7G6eEPR_p2',
  bvid: 'BV1YG7G6eEPR',
  page: 2,
  cid: 30_000,
  title: 'P2 Agent基本概念',
  durationMs: 1_922_000,
  url: 'https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/',
  ...over,
});

const section = (over: Partial<Section> = {}): Section => ({
  id: 'sec_0001',
  title: 'Agent 的定义',
  startMs: 60_000,
  endMs: 180_000,
  summary: '本章讲清 Agent 与工作流的区别，强调自主规划能力。',
  bullets: [{ text: 'Agent 能自己拆任务', startMs: 75_000 }],
  terms: ['Agent', '工作流'],
  importance: 4,
  score: 78,
  density: 'high',
  cueRange: [0, 10],
  ...over,
});

/** 极简 frontmatter 解析（回读断言用；只覆盖本模块产出的标量/数组形式） */
function parseFrontmatter(markdown: string): Record<string, string> {
  const m = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error('未找到 frontmatter 分隔线');
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe('yamlValue（YAML 标量转义）', () => {
  it('普通中文原样返回', () => {
    expect(yamlValue('Agent基本概念')).toBe('Agent基本概念');
  });

  it('含冒号加空格 → 加双引号', () => {
    expect(yamlValue('a: b')).toBe('"a: b"');
  });

  it('冒号后非空白（URL 的 https:）不加引号', () => {
    expect(yamlValue('https://www.bilibili.com/video/BV1/?p=2')).toBe(
      'https://www.bilibili.com/video/BV1/?p=2',
    );
  });

  it('含 # → 加双引号', () => {
    expect(yamlValue('C# 入门')).toBe('"C# 入门"');
  });

  it('数字/布尔字面量 → 加双引号（避免属性面板解析成非字符串）', () => {
    expect(yamlValue('123')).toBe('"123"');
    expect(yamlValue('true')).toBe('"true"');
  });

  it('空串 → 空引号对', () => {
    expect(yamlValue('')).toBe('""');
  });

  it('首尾空白 → 加双引号', () => {
    expect(yamlValue('  x  ')).toBe('"  x  "');
  });
});

describe('contentTagsFor（内容标签：术语频次 topN，SPEC-10 二轮冒烟）', () => {
  it('按跨章频次降序取前 4；并列按字典序', () => {
    const secs = [
      section({ id: 's1', terms: ['甲', '乙'] }),
      section({ id: 's2', terms: ['甲', '丙'] }),
      section({ id: 's3', terms: ['甲', '丁', '戊'] }),
    ];
    expect(contentTagsFor(secs, 4)).toEqual(['甲', '丁', '丙', '乙']); // 并列按码元序：丁(U+4E01)<丙(U+4E19)<乙(U+4E59)
  });

  it('超 10 字术语跳过；与固定标签重名跳过；空输入空数组', () => {
    const secs = [section({ terms: ['这是一个特别特别长的术语', '视频笔记', '短'] })];
    expect(contentTagsFor(secs)).toEqual(['短']);
    expect(contentTagsFor([])).toEqual([]);
  });
});

describe('sanitizeFileName', () => {
  it('非法字符替换为 _', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('中文与空格保留', () => {
    expect(sanitizeFileName('P2 Agent 基本概念')).toBe('P2 Agent 基本概念');
  });

  it('trim 首尾空白', () => {
    expect(sanitizeFileName('  术语  ')).toBe('术语');
  });

  it('长度截断 60', () => {
    expect(sanitizeFileName('x'.repeat(100))).toHaveLength(60);
  });

  it('全非法字符 → 回落 _', () => {
    // 非法字符替换为 _ 后再清尾随下划线（SPEC-19 N-6），全非法时回落占位 _
    expect(sanitizeFileName('///')).toBe('_');
  });
});

describe('vaultPathsFor（分层目录 + SPEC-17 领域层）', () => {
  it('默认领域 通用：笔记 笔记/{领域}/{课程}/{标题}.md，术语 概念/{领域}/，raw 同层', () => {
    const paths = vaultPathsFor(meta(), '视频学习副驾');
    expect(paths.videoNote).toBe('视频学习副驾/笔记/通用/bilibili_BV1YG7G6eEPR/P2 Agent基本概念.md');
    expect(paths.termDir).toBe('视频学习副驾/概念/通用');
    expect(paths.rawNote).toBe('视频学习副驾/raw/通用/bilibili_BV1YG7G6eEPR/BV1YG7G6eEPR_p2.md');
    expect(paths.domainDir).toBe('通用');
  });

  it('指定领域：目录随领域生长（逻辑学/编程…）', () => {
    const paths = vaultPathsFor(meta(), 'root', '逻辑学');
    expect(paths.videoNote).toBe('root/笔记/逻辑学/bilibili_BV1YG7G6eEPR/P2 Agent基本概念.md');
    expect(paths.termDir).toBe('root/概念/逻辑学');
    expect(paths.rawNote).toBe('root/raw/逻辑学/bilibili_BV1YG7G6eEPR/BV1YG7G6eEPR_p2.md');
  });

  it('领域名含非法字符被清洗；空领域回落 通用', () => {
    expect(vaultPathsFor(meta(), 'root', '逻辑:学').domainDir).toBe('逻辑_学');
    expect(vaultPathsFor(meta(), 'root', '').domainDir).toBe('通用');
  });

  it('rootDir 为空时不带前导斜杠', () => {
    expect(vaultPathsFor(meta(), '').videoNote.startsWith('笔记/')).toBe(true);
  });

  it('标题含非法字符被清洗', () => {
    const paths = vaultPathsFor(meta({ title: 'A/B:概念' }), 'root');
    expect(paths.videoNote).toBe('root/笔记/通用/bilibili_BV1YG7G6eEPR/A_B_概念.md');
  });

  it('bvid 缺失时回落 videoId 作课程目录', () => {
    const paths = vaultPathsFor(meta({ bvid: '' }), 'root');
    expect(paths.videoNote).toBe('root/笔记/通用/bilibili_BV1YG7G6eEPR_p2/P2 Agent基本概念.md');
    expect(paths.rawNote).toBe('root/raw/通用/bilibili_BV1YG7G6eEPR_p2/BV1YG7G6eEPR_p2_p2.md');
  });
});

describe('playbackUrl / videoPageUrl（跳播链接）', () => {
  it('url 带 ?p=，回放链接再带 &t=秒', () => {
    expect(videoPageUrl(meta())).toBe('https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/?p=2');
    expect(playbackUrl(meta(), 75_000)).toBe('https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/?p=2&t=75');
  });

  it('page=1 也显式带 p 参数', () => {
    expect(playbackUrl(meta({ page: 1 }), 0)).toContain('?p=1&t=0');
  });

  it('毫秒向下取整为秒；负数按 0', () => {
    expect(playbackUrl(meta(), 1_999)).toContain('&t=1');
    expect(playbackUrl(meta(), -5_000)).toContain('&t=0');
  });

  it('已有 query 的视频地址用 & 追加 p', () => {
    expect(videoPageUrl(meta({ url: 'https://www.bilibili.com/video/BV1/?x=1' }))).toBe(
      'https://www.bilibili.com/video/BV1/?x=1&p=2',
    );
  });

  it('SPEC-08 A2：url 为空时按 bvid + page 兜底（笔记回链不再产出空串）', () => {
    const m = meta({ url: '' });
    expect(videoPageUrl(m)).toBe('https://www.bilibili.com/video/BV1YG7G6eEPR?p=2');
    expect(playbackUrl(m, 75_000)).toBe('https://www.bilibili.com/video/BV1YG7G6eEPR?p=2&t=75');
  });

  it('SPEC-08 A2：url 已带 p 参数时不重复追加；分 P 与秒数正确', () => {
    const m = meta({ url: 'https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/?p=2' });
    expect(playbackUrl(m, 61_500)).toBe('https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/?p=2&t=61');
    // url 带的 p 与 meta.page 冲突时以 url 为准（用户实际所在页）
    expect(videoPageUrl(meta({ url: 'https://www.bilibili.com/video/BV1/?p=5', page: 2 }))).toBe(
      'https://www.bilibili.com/video/BV1/?p=5',
    );
  });

  it('url 与 bvid 都缺失才返回空串（timestampLink 降级为纯文本）', () => {
    expect(videoPageUrl(meta({ url: '', bvid: '' }))).toBe('');
    expect(timestampLink(meta({ url: '', bvid: '' }), 5_000)).toBe('00:05');
  });
});

describe('buildVideoNoteMarkdown', () => {
  const args = { meta: meta(), sections: [section()], sourceVideoId: 'BV1YG7G6eEPR_p2', now: new Date('2026-09-30T10:00:00') };

  it('frontmatter 字段齐且可解析回读（TECH-DESIGN §4.7）', () => {
    const { markdown } = buildVideoNoteMarkdown(args);
    const fm = parseFrontmatter(markdown);
    expect(fm.title).toBe('P2 Agent基本概念');
    expect(fm.source).toBe('bilibili');
    expect(fm.url).toBe('https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/?p=2');
    expect(fm.video_id).toBe('BV1YG7G6eEPR_p2');
    expect(fm.duration).toBe('1922');
    expect(fm.created).toBe('2026-09-30');
    // SPEC-10 二轮冒烟：固定标签 + 内容标签（章节术语按频次 topN）——裸读即知讲什么
    expect(fm.tags).toBe('[ai, 视频笔记, B站, Agent, 工作流]');
    expect(fm.type).toBe('video-note');
  });

  it('正文含 H1 标题与章节时间范围、分数', () => {
    const { markdown } = buildVideoNoteMarkdown(args);
    expect(markdown).toContain('# P2 Agent基本概念');
    expect(markdown).toContain('## 01:00-03:00 Agent 的定义（78 分）');
    expect(markdown).toContain('本章讲清 Agent 与工作流的区别');
  });

  it('来源链接与要点含 ?p=&t= 回放锚点', () => {
    const { markdown } = buildVideoNoteMarkdown(args);
    expect(markdown).toContain('?p=2&t=0');
    expect(markdown).toContain('[01:15](https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/?p=2&t=75)');
  });

  it('terms 为全片去重数组', () => {
    const { terms } = buildVideoNoteMarkdown({
      ...args,
      sections: [section(), section({ id: 'sec_0002', terms: ['Agent', '工具调用'] })],
    });
    expect(terms).toEqual(['Agent', '工作流', '工具调用']);
  });

  it('summaryPreview ≤200 字', () => {
    const { summaryPreview } = buildVideoNoteMarkdown({
      ...args,
      sections: [section({ summary: '长'.repeat(500) })],
    });
    expect(summaryPreview.length).toBeLessThanOrEqual(SUMMARY_PREVIEW_MAX);
  });

  it('无章节时仍能产出笔记与预览（回退标题）', () => {
    const out = buildVideoNoteMarkdown({ ...args, sections: [] });
    expect(out.terms).toEqual([]);
    expect(out.summaryPreview).toBe('P2 Agent基本概念');
  });

  it('score 缺失时章节标题显示 -', () => {
    const { markdown } = buildVideoNoteMarkdown({ ...args, sections: [section({ score: undefined })] });
    expect(markdown).toContain('（-）');
  });
});

describe('buildTermCardMarkdown', () => {
  const payload = {
    inVideoMeaning: '本课把 Agent 定义为能自主规划并调用工具的模型',
    generalDefinition: '能感知环境、自主决策并采取行动以达成目标的系统',
    analogy: '像会自己排日程的助理',
    relatedTerms: ['工作流', '工具调用'],
  };

  it('frontmatter type 为 term-card 且含 term', () => {
    const { markdown } = buildTermCardMarkdown({
      term: 'Agent',
      payload,
      meta: meta(),
      timestampMs: 75_000,
      now: new Date('2026-09-30T10:00:00'),
    });
    const fm = parseFrontmatter(markdown);
    expect(fm.type).toBe('term-card');
    expect(fm.term).toBe('Agent');
    expect(fm.video_id).toBe('BV1YG7G6eEPR_p2');
    expect(fm.source).toBe('bilibili');
    expect(fm.created).toBe('2026-09-30');
  });

  it('正文含四段结构与出处跳播链接', () => {
    const { markdown } = buildTermCardMarkdown({
      term: 'Agent',
      payload,
      meta: meta(),
      timestampMs: 75_000,
    });
    expect(markdown).toContain('# Agent');
    expect(markdown).toContain('## 视频语境');
    expect(markdown).toContain('## 通用定义');
    expect(markdown).toContain('## 类比');
    expect(markdown).toContain('- 工作流');
    expect(markdown).toContain('在《P2 Agent基本概念》中出现于 [01:15](https://www.bilibili.com/video/bilibili_BV1YG7G6eEPR/?p=2&t=75)');
  });

  it('summaryPreview ≤200 字且非空', () => {
    const { summaryPreview } = buildTermCardMarkdown({ term: 'Agent', payload, meta: meta() });
    expect(summaryPreview.length).toBeGreaterThan(0);
    expect(summaryPreview.length).toBeLessThanOrEqual(SUMMARY_PREVIEW_MAX);
  });
});

describe('buildIndexMarkdown（人类可读 MOC）', () => {
  const entry = (over: Partial<KnowledgeIndexEntry> = {}): KnowledgeIndexEntry => ({
    path: '视频学习副驾/笔记/BV1/P2.md',
    title: 'P2 Agent基本概念',
    category: 'video-note',
    tags: ['ai', '视频笔记'],
    terms: ['Agent'],
    summaryPreview: '本课讲 Agent 定义',
    videoId: 'BV1_p2',
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...over,
  });

  it('空索引：H1 + 统计 0 条', () => {
    const md = buildIndexMarkdown(emptyIndexFile());
    expect(md).toContain('# 知识库索引');
    expect(md).toContain('共 0 条笔记');
  });

  it('按 category 分组并用 [[双链]] 列出摘要预览', () => {
    const md = buildIndexMarkdown({
      version: 1,
      entries: [entry(), entry({ path: '视频学习副驾/概念/Agent.md', title: 'Agent', category: 'term', summaryPreview: '能自主规划的系统' })],
    });
    expect(md).toContain('## 笔记');
    expect(md).toContain('## 概念');
    expect(md).toContain('- [[P2]] — 本课讲 Agent 定义');
    expect(md).toContain('- [[Agent]] — 能自主规划的系统');
    expect(md).toContain('共 2 条笔记（视频笔记 1 · 术语 1）');
  });

  it('人工索引标注机器索引路径', () => {
    expect(buildIndexMarkdown(emptyIndexFile())).toContain(INDEX_JSON_NAME);
  });

  it('INDEX_MD_NAME 为 _索引.md（人类浏览入口）', () => {
    expect(INDEX_MD_NAME).toBe('_索引.md');
  });
});

describe('upsertIndexEntry（按 path 去重覆盖）', () => {
  const e1: KnowledgeIndexEntry = {
    path: 'root/概念/Agent.md',
    title: 'Agent',
    category: 'term',
    tags: ['ai'],
    terms: ['Agent'],
    summaryPreview: '旧预览',
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
  const e2: KnowledgeIndexEntry = { ...e1, path: 'root/概念/Workflow.md', title: '工作流', summaryPreview: '工作流预览' };

  it('新 path 追加到末尾', () => {
    const out = upsertIndexEntry({ version: 1, entries: [e1] }, e2);
    expect(out.entries.map((x) => x.path)).toEqual([e1.path, e2.path]);
  });

  it('同 path 原位覆盖（不新增、不改顺序）', () => {
    const updated: KnowledgeIndexEntry = { ...e1, summaryPreview: '新预览', updatedAt: '2026-09-30T00:00:00.000Z' };
    const out = upsertIndexEntry({ version: 1, entries: [e1, e2] }, updated);
    expect(out.entries).toHaveLength(2);
    expect(out.entries[0].summaryPreview).toBe('新预览');
    expect(out.entries[0].updatedAt).toBe('2026-09-30T00:00:00.000Z');
    expect(out.entries[1].path).toBe(e2.path);
  });

  it('不改入参（返回新对象）', () => {
    const file: KnowledgeIndexFile = { version: 1, entries: [e1] };
    upsertIndexEntry(file, e2);
    expect(file.entries).toHaveLength(1);
  });

  it('覆盖后写回 MOC 用新预览', () => {
    const out = upsertIndexEntry({ version: 1, entries: [e1] }, { ...e1, summaryPreview: '新预览' });
    expect(buildIndexMarkdown(out)).toContain('新预览');
  });
});

describe('findDuplicateTerm（确定性去重）', () => {
  it('完全相等 → 命中，相似度 1', () => {
    expect(findDuplicateTerm('Agent', [{ term: 'Agent' }])).toEqual({ duplicate: 'Agent', similarity: 1 });
  });

  it('大小写/空白差异 → 仍命中（返回原始写法）', () => {
    expect(findDuplicateTerm('  agent ', [{ term: 'Agent' }]).duplicate).toBe('Agent');
  });

  it('高相似（≥0.8）→ 命中', () => {
    const res = findDuplicateTerm('Agent框架', [{ term: 'Agent框架s' }]);
    expect(res.duplicate).toBe('Agent框架s');
    expect(res.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it('无关术语 → 不命中（duplicate 为 null）', () => {
    const res = findDuplicateTerm('Transformer', [{ term: 'Agent' }]);
    expect(res.duplicate).toBeNull();
    expect(res.similarity).toBeLessThan(0.8);
  });

  it('空术语表 → 不命中，相似度 0', () => {
    expect(findDuplicateTerm('Agent', [])).toEqual({ duplicate: null, similarity: 0 });
  });

  it('空术语字符串 → 不命中', () => {
    expect(findDuplicateTerm('', [{ term: 'Agent' }]).duplicate).toBeNull();
  });

  it('termSimilarity：相等为 1，空串与非空为 0', () => {
    expect(termSimilarity('a', 'a')).toBe(1);
    expect(termSimilarity('', 'a')).toBe(0.0);
    expect(termSimilarity('', '')).toBe(1);
  });

  it('多个候选取相似度最高的一个', () => {
    const res = findDuplicateTerm('Agent', [{ term: 'RAG' }, { term: 'Agents' }, { term: 'Transformer' }]);
    expect(res.duplicate).toBe('Agents');
  });
});

describe('其他确定性小工具', () => {
  it('formatDate → YYYY-MM-DD', () => {
    expect(formatDate(new Date('2026-01-05T23:00:00'))).toBe('2026-01-05');
  });

  it('truncatePreview 截断至 ≤200 字', () => {
    expect(truncatePreview('字'.repeat(300)).length).toBe(SUMMARY_PREVIEW_MAX);
    expect(truncatePreview('短文本')).toBe('短文本');
  });

  it('joinVaultPath 忽略空段与多余斜杠', () => {
    expect(joinVaultPath('/root/', '', '概念/', 'A.md')).toBe('root/概念/A.md');
    expect(joinVaultPath('', '', '')).toBe('');
  });
});
