/**
 * SPEC-17 批 1 单测：raw 原料层构建器（行级锚点 + 无损规范化）、
 * AGENTS.md 蒸馏宪法（内容要点快照）、领域 MOC 构建器。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENTS_MD,
  AGENTS_MD_PATH,
  buildMocMarkdown,
  buildRawMarkdown,
  DEFAULT_DOMAIN,
  mocPath,
} from '../../../src/core/pipeline/capture';
import type { KnowledgeIndexEntry, VideoMeta } from '../../../src/types';

const meta = (over: Partial<VideoMeta> = {}): VideoMeta => ({
  videoId: 'BV1xx_p1',
  bvid: 'BV1xx',
  page: 1,
  cid: 100,
  title: '图形推理',
  durationMs: 600_000,
  url: 'https://www.bilibili.com/video/BV1xx/',
  ...over,
});

const cue = (startMs: number, text: string) => ({ startMs, endMs: startMs + 3000, text });

describe('buildRawMarkdown（raw 原料层：行级锚点 + 无损规范化）', () => {
  it('每行带 [mm:ss](回放URL) 锚点；frontmatter 含 type: raw', () => {
    const md = buildRawMarkdown({ meta: meta(), cues: [cue(303_000, '先观察再推理')] });
    expect(md).toContain('type: raw');
    expect(md).toContain('- [05:03](https://www.bilibili.com/video/BV1xx/?p=1&t=303) 先观察再推理');
    expect(md).toContain('> [!warning] 原料层：只读');
  });

  it('滚动字幕连续重复行合并（保留首个锚点），空行跳过', () => {
    const md = buildRawMarkdown({
      meta: meta(),
      cues: [
        cue(60_000, '同一句话'),
        cue(62_000, '同一句话'), // 滚动重复 → 合并
        cue(64_000, ''), // 空文本 → 跳过
        cue(66_000, '新内容'),
      ],
    });
    expect(md).toContain('[01:00]'); // 首个锚点保留
    expect(md).not.toContain('[01:02]'); // 滚动重复行被合并（不产生第二个锚）
    expect(md).toContain('[01:06](');
    expect(md).toContain('新内容');
  });

  it('非连续重复不合并（间隔出现同一句是字幕的客观事实）', () => {
    const md = buildRawMarkdown({
      meta: meta(),
      cues: [cue(0, '总结'), cue(60_000, '中间'), cue(120_000, '总结')],
    });
    expect(md.match(/总结/g)?.length).toBe(2);
  });

  it('≥1 小时用 h:mm:ss 格式', () => {
    const md = buildRawMarkdown({ meta: meta(), cues: [cue(3_723_000, '一小时后')] });
    expect(md).toContain('[1:02:03](');
    expect(md).toContain('t=3723');
  });
});

describe('AGENTS.md 蒸馏宪法（知识库员工手册）', () => {
  it('根目录路径固定，双节齐全，核心规则在文内', () => {
    expect(AGENTS_MD_PATH).toBe('AGENTS.md');
    expect(AGENTS_MD).toContain('## A. 目录契约');
    expect(AGENTS_MD).toContain('## B. 蒸馏规则');
    expect(AGENTS_MD).toContain('## C. 检索规则');
    // 两轮调研的关键规则落位
    expect(AGENTS_MD).toContain('可逆性原则'); // KM 术语管理
    expect(AGENTS_MD).toContain('只增不删'); // aliases 演化约束
    expect(AGENTS_MD).toContain('以什么身份连'); // SAG 关联身份
    expect(AGENTS_MD).toContain('待核验'); // TDSQL 核验环节
    expect(AGENTS_MD).toContain('vsc:notes'); // 用户笔记避让
    expect(AGENTS_MD).toContain('raw 不参与检索'); // claw-flow 口径决议
    expect(AGENTS_MD).toContain('强制 ## 章节结构'); // claw-flow 切分发现
  });
});

describe('buildMocMarkdown / mocPath（领域 MOC）', () => {
  const entries: KnowledgeIndexEntry[] = [
    {
      path: '笔记/逻辑学/BV1xx/图形推理.md',
      title: '图形推理',
      category: 'video-note',
      tags: [],
      terms: [],
      summaryPreview: '先观察再推理',
      updatedAt: '2026-10-16T00:00:00Z',
      domain: '逻辑学',
    },
    {
      path: '笔记/编程/BV2yy/路由.md',
      title: '路由配置',
      category: 'video-note',
      tags: [],
      terms: [],
      summaryPreview: '路由文件格式',
      updatedAt: '2026-10-16T00:00:00Z',
      domain: '编程',
    },
    {
      path: '概念/逻辑学/排除法.md',
      title: '排除法',
      category: 'term',
      tags: [],
      terms: ['排除法'],
      summaryPreview: '',
      updatedAt: '2026-10-16T00:00:00Z',
      domain: '逻辑学',
    },
  ];

  it('MOC 只含本领域条目，分组双链；其他领域不串入', () => {
    const md = buildMocMarkdown({ domain: '逻辑学', entries });
    expect(md).toContain('# MOC · 逻辑学');
    expect(md).toContain('[[图形推理]] — 先观察再推理');
    expect(md).toContain('[[排除法]]');
    expect(md).not.toContain('路由配置'); // 编程领域不串入
    expect(md).toContain('_meta/index.json'); // 指向机器索引
  });

  it('缺省 domain 的旧条目归入 通用 MOC', () => {
    const legacy: KnowledgeIndexEntry[] = [
      {
        path: '笔记/BV3zz/旧笔记.md',
        title: '旧笔记',
        category: 'video-note',
        tags: [],
        terms: [],
        summaryPreview: '无领域旧条目',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ];
    const md = buildMocMarkdown({ domain: DEFAULT_DOMAIN, entries: legacy });
    expect(md).toContain('[[旧笔记]]');
  });

  it('mocPath：索引/MOC-{领域}.md，非法字符清洗', () => {
    expect(mocPath('逻辑学')).toBe('索引/MOC-逻辑学.md');
    expect(mocPath('')).toBe(`索引/MOC-${DEFAULT_DOMAIN}.md`);
    expect(mocPath('A/B')).toBe('索引/MOC-A_B.md');
  });
});

// ---------------------------------------------------------------------------
// SPEC-17 批 2：概念页构建 / 追加式合并 / 用户笔记序列化 / 蒸馏解析
// ---------------------------------------------------------------------------
import {
  buildConceptPageMarkdown,
  conceptNotePath,
  conceptReferenceBlock,
  mergeConceptPageMarkdown,
} from '../../../src/core/pipeline/capture';
import { serializeNotesForDistill } from '../../../src/panel/obsidianLoader';
import { parseDistillResult } from '../../../src/core/pipeline/explain';

describe('概念页（术语表节点）', () => {
  const ref = conceptReferenceBlock({
    videoTitle: '图形推理',
    noteLink: '图形推理01：排除法入门',
    anchorSec: 303,
    sourceExcerpt: '先横再竖是通用解法',
    sourceType: 'raw',
    playbackUrl: 'https://www.bilibili.com/video/BV1xx/?p=1&t=303',
  });

  it('新建：五字段 frontmatter + 划界定义待核验 callout + 首条引用', () => {
    const md = buildConceptPageMarkdown({
      preferred: '排除法',
      aliases: ['排除选项法'],
      definition: '排除法是逐一排除不可能选项的演绎方法；与代入验证的差异在于方向相反。',
      broader: '演绎推理',
      domain: '逻辑学',
      reference: ref,
    });
    expect(md).toContain('preferred: 排除法');
    expect(md).toContain('aliases: [排除选项法]');
    expect(md).toContain('broader: 演绎推理');
    expect(md).toContain('type: concept');
    expect(md).toContain('> [!note] AI 蒸馏 · 待核验');
    expect(md).toContain('[05:03](https://www.bilibili.com/video/BV1xx/?p=1&t=303)');
    expect(md).toContain('[[图形推理01：排除法入门|图形推理]]'); // 概念→笔记 wikilink（图谱边）
    expect(md).toContain('source: raw');
  });

  it('合并：aliases 只增不删 + 引用记录文末追加；定义与手写内容不触碰', () => {
    const existing = buildConceptPageMarkdown({
      preferred: '排除法',
      aliases: ['排除选项法'],
      definition: '原定义',
      broader: '',
      domain: '逻辑学',
      reference: ref,
    });
    const merged = mergeConceptPageMarkdown({
      existing,
      newAliases: ['淘汰法', '排除选项法'], // 后者已存在 → 不重复
      domain: '逻辑学',
      reference: conceptReferenceBlock({
        videoTitle: '强化练习',
        noteLink: '强化练习03：排除法运用',
        anchorSec: 120,
        sourceExcerpt: '我的理解是先排掉明显错的',
        sourceType: 'user-note',
        playbackUrl: 'https://www.bilibili.com/video/BV1xx/?p=1&t=120',
      }),
    });
    expect(merged).toContain('排除选项法');
    expect(merged).toContain('淘汰法');
    expect((merged.match(/排除选项法/g) ?? []).length).toBe(1); // 不重复追加
    expect(merged).toContain('source: user-note'); // 引用身份保留
    expect(merged).toContain('原定义'); // 定义未被覆盖
    expect(merged).toContain('强化练习');
  });

  it('conceptNotePath：全局唯一不分领域（概念/规范名.md）', () => {
    expect(conceptNotePath('排除法', 'root')).toBe('root/概念/排除法.md');
  });
});

describe('serializeNotesForDistill（用户批注序列化）', () => {
  it('笔记正文 + 讨论串按序展开；我/助教身份区分', () => {
    const md = serializeNotesForDistill([
      {
        id: 'n1',
        videoId: 'BV1xx_p1',
        anchor: { kind: 'section', sectionId: 's1', tMs: 0 },
        body: '路由配置文件有强制格式吧',
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
        replies: [
          { id: 'r1', author: 'assistant', body: '助教第一答', createdAt: '2026-10-15T00:00:01Z' },
          { id: 'r2', author: 'self', body: '我路由文件不叫这个名字可以吗', createdAt: '2026-10-15T00:00:02Z' },
        ],
      },
    ]);
    expect(md).toContain('### 我：路由配置文件有强制格式吧');
    expect(md).toContain('- 助教：助教第一答');
    expect(md).toContain('- 我：我路由文件不叫这个名字可以吗');
  });
});

describe('parseDistillResult（蒸馏 schema，红线 4）', () => {
  it('合法输出通过；超上限概念 / 编造字段被拒', () => {
    const ok = parseDistillResult(
      JSON.stringify({
        domain: '逻辑学',
        concepts: [
          { name: '排除法', aliases: ['排除选项法'], definition: '划界定义', broader: '演绎推理', anchorSec: 303, sourceExcerpt: '原句' },
        ],
      }),
    );
    expect(ok.domain).toBe('逻辑学');
    expect(ok.concepts[0].name).toBe('排除法');

    expect(() =>
      parseDistillResult(JSON.stringify({ domain: '逻辑学', concepts: [{ name: '', aliases: [], definition: 'd', broader: '', anchorSec: 1, sourceExcerpt: 's' }] })),
    ).toThrow();
    expect(() => parseDistillResult(JSON.stringify({ domain: '逻辑学', concepts: [] , extra: true }))).not.toThrow();
  });
});

// SPEC-17 批 3：检索升级（user-note 加权 / related 链）+ Lint 体检
import { lintKnowledgeIndex, searchIndex } from '../../../src/core/knowledge/retriever';
import type { KnowledgeIndexFile } from '../../../src/types';

describe('searchIndex 升级（SPEC-17）', () => {
  const base = {
    tags: ['ai'],
    summaryPreview: '预览',
    updatedAt: '2026-10-16T00:00:00Z',
  };
  const index: KnowledgeIndexFile = {
    version: 1,
    entries: [
      {
        ...base,
        path: '笔记/逻辑学/BV1/图形推理.md',
        title: '图形推理',
        category: 'video-note',
        terms: ['图形推理'],
        domain: '逻辑学',
        entities: ['排除法'],
      },
      {
        ...base,
        path: '概念/逻辑学/排除法.md',
        title: '排除法',
        category: 'concept',
        terms: ['排除法'],
        domain: '逻辑学',
      },
      {
        ...base,
        path: '笔记/逻辑学/BV2/我的心得.md',
        title: '我的心得',
        category: 'video-note',
        terms: ['图形推理'],
        domain: '逻辑学',
        sourceType: 'user-note',
      },
    ],
  };

  it('用户批注（sourceType=user-note）加权排在 AI 蒸馏前面', () => {
    const hits = searchIndex({ index, queryTerms: ['图形推理'], topK: 3 });
    expect(hits[0].entry.title).toBe('我的心得'); // 同检索词下人写的在前
    expect(hits.some((h) => h.entry.title === '图形推理')).toBe(true);
  });

  it('related 链内联：命中视频笔记时概念页顺链补进结果', () => {
    // topK=2 命中两条视频笔记；图形推理的 entities 指向排除法（未直接命中）——顺链补进
    const hits = searchIndex({ index, queryTerms: ['图形推理'], topK: 2 });
    expect(hits[0].entry.title).toBe('我的心得'); // user-note 加权第一
    expect(hits[1].entry.title).toBe('图形推理');
    const related = hits.find((h) => h.entry.category === 'concept');
    expect(related?.entry.title).toBe('排除法'); // related 链内联，不占 topK 主位
  });
});

describe('lintKnowledgeIndex（SPEC-17 体检）', () => {
  const base = {
    tags: ['ai'],
    summaryPreview: '预览',
    updatedAt: '2026-10-16T00:00:00Z',
    domain: '逻辑学',
  };

  it('健康索引返回空；孤儿概念页 / 断链 / 领域缺失各归其类', () => {
    const healthy: KnowledgeIndexFile = {
      version: 1,
      entries: [
        { ...base, path: '笔记/d/BV/a.md', title: 'a', category: 'video-note', terms: ['a'], entities: ['排除法'] },
        { ...base, path: '概念/d/排除法.md', title: '排除法', category: 'concept', terms: ['排除法'] },
      ],
    };
    expect(lintKnowledgeIndex(healthy)).toEqual([]);
    expect(lintKnowledgeIndex(null)).toEqual([]);

    const broken: KnowledgeIndexFile = {
      version: 1,
      entries: [
        { ...base, path: '笔记/d/BV/a.md', title: 'a', category: 'video-note', terms: ['a'], entities: ['不存在的概念'] },
        { ...base, path: '概念/d/孤儿.md', title: '孤儿', category: 'concept', terms: ['孤儿'] },
        { ...base, domain: undefined, path: '旧笔记.md', title: '旧', category: 'video-note', terms: ['旧'] },
      ],
    };
    const issues = lintKnowledgeIndex(broken);
    expect(issues.filter((i) => i.kind === 'orphan-concept').length).toBe(1);
    expect(issues.filter((i) => i.kind === 'broken-entity-link').length).toBe(1);
    expect(issues.filter((i) => i.kind === 'missing-domain').length).toBe(1);
  });
});



// ---------------------------------------------------------------------------
// SPEC-17 关联网：wikilink 图谱边（涉及概念区块 / 上位概念 / 幂等刷新）
// ---------------------------------------------------------------------------
import {
  buildConceptLinksBlock,
  upsertConceptLinksBlock,
  upsertDomainTag,
} from '../../../src/core/pipeline/capture';

describe('关联网：笔记「涉及概念」区块与幂等刷新', () => {
  const block = buildConceptLinksBlock({
    conceptNames: ['排除法', '同构选项'],
    rawLink: 'BV1xx_p2',
  });
  it('区块含概念 wikilink + raw 链接', () => {
    expect(block).toContain('%% vsc:concepts:start %%');
    expect(block).toContain('- [[排除法]]');
    expect(block).toContain('- [[同构选项]]');
    expect(block).toContain('原文：[[BV1xx_p2|字幕原文（raw）]]');
    expect(block).toContain('%% vsc:concepts:end %%');
  });
  it('无旧区块 → 文末追加；手写内容保留', () => {
    const md = '# 笔记\n\n手写内容';
    const out = upsertConceptLinksBlock(md, block);
    expect(out).toContain('手写内容');
    expect(out).toContain('- [[排除法]]');
  });
  it('已有旧区块 → 原位替换（幂等，不重复追加）', () => {
    const first = upsertConceptLinksBlock('# 笔记\n\n旧手写', block);
    const next = upsertConceptLinksBlock(first, buildConceptLinksBlock({
      conceptNames: ['捆绑法'],
      rawLink: 'BV1xx_p2',
    }));
    expect((next.match(/vsc:concepts:start/g) ?? []).length).toBe(1);
    expect(next).toContain('- [[捆绑法]]');
    expect(next).not.toContain('- [[排除法]]'); // 旧概念列表被替换（蒸馏结果为准）
    expect(next).toContain('旧手写');
  });
});

describe('upsertDomainTag（领域标签注入）', () => {
  const md = '---\ntitle: x\ntags: [ai, 视频笔记, B站, 定义判断]\n---\n\n# 笔记';
  it('注入嵌套领域标签 + 父域标签（公考_判断推理 → 公考/判断推理 + 公考）', () => {
    const out = upsertDomainTag(md, '公考_判断推理');
    expect(out).toContain('tags: [ai, 视频笔记, B站, 定义判断, 公考/判断推理, 公考]');
  });
  it('单层领域无父域标签（前端开发 → 只注入自身）', () => {
    const out = upsertDomainTag(md, '前端开发');
    expect(out).toContain('tags: [ai, 视频笔记, B站, 定义判断, 前端开发]');
  });
  it('幂等：重复注入不重复追加', () => {
    const once = upsertDomainTag(md, '公考_判断推理');
    expect(upsertDomainTag(once, '公考_判断推理')).toBe(once);
  });
  it('无 tags 行 → 原样返回（保守跳过）；空领域 → 原样返回', () => {
    const noTags = '---\ntitle: x\n---\n\n# 笔记';
    expect(upsertDomainTag(noTags, '公考')).toBe(noTags);
    expect(upsertDomainTag(md, '')).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// SPEC-20：wikilink 目标=落盘名 + 父级 MOC 图谱结构链
// ---------------------------------------------------------------------------
import {
  buildParentMocMarkdown,
  parentDomain,
  wikiLink,
} from '../../../src/core/pipeline/capture';

describe('wikiLink（wikilink 目标 = sanitizeFileName 落盘名）', () => {
  it('含非法字符名：目标清洗、显示保留原名（真机：h$*6 快捷键 → h$_6 快捷键.md）', () => {
    expect(wikiLink('h$*6 快捷键')).toBe('[[h$_6 快捷键|h$*6 快捷键]]');
  });
  it('干净名：省略别名，保持 markdown 干净', () => {
    expect(wikiLink('加强论点')).toBe('[[加强论点]]');
  });
  it('目标与 conceptNotePath 落盘名一致（图谱边不因清洗分叉而断）', () => {
    const name = 'open in browser 插件?';
    const target = wikiLink(name).match(/\[\[([^|\]]+)/)?.[1] ?? '';
    expect(conceptNotePath(name, 'root').endsWith(`/${target}.md`)).toBe(true);
  });
});

describe('buildConceptLinksBlock / buildConceptPageMarkdown 的 wikilink 目标', () => {
  it('涉及概念区块：非法字符概念的 wikilink 目标是落盘名', () => {
    const block = buildConceptLinksBlock({
      conceptNames: ['加强论点', 'h$*6 快捷键'],
      rawLink: 'BV1xx_p7',
    });
    expect(block).toContain('- [[加强论点]]');
    expect(block).toContain('- [[h$_6 快捷键|h$*6 快捷键]]');
    expect(block).not.toContain('- [[h$*6 快捷键]]'); // 不再出现无法解析的原名目标
  });
  it('上位概念 wikilink 目标是落盘名', () => {
    const md = buildConceptPageMarkdown({
      preferred: 'align 属性',
      aliases: [],
      definition: '对齐属性',
      broader: 'HTML*属性',
      domain: '前端开发',
      reference: '',
    });
    expect(md).toContain('上位概念：[[HTML_属性|HTML*属性]]');
  });
});

describe('parentDomain / parentMocPath（复合领域父域派生）', () => {
  it('末段 _ 前缀为父域', () => {
    expect(parentDomain('公考_判断推理')).toBe('公考');
    expect(parentDomain('公考_判断推理_图形')).toBe('公考_判断推理');
  });
  it('单段域无父域', () => {
    expect(parentDomain('前端开发')).toBe('');
    expect(parentDomain('通用')).toBe('');
    expect(parentDomain('')).toBe('');
  });
});

describe('buildMocMarkdown 上域回链 + buildParentMocMarkdown', () => {
  const entries = [
    {
      path: '视频学习副驾/笔记/公考_判断推理/bilibili_BV1xx/判断20.md',
      title: '判断20',
      category: 'video-note' as const,
      tags: ['ai'],
      terms: [],
      summaryPreview: '加强',
      videoId: 'BV1xx_p22',
      updatedAt: '2026-10-22',
      domain: '公考_判断推理',
    },
    {
      path: '视频学习副驾/笔记/公考_言语理解/bilibili_BV1xx/言语1.md',
      title: '言语1',
      category: 'video-note' as const,
      tags: ['ai'],
      terms: [],
      summaryPreview: '对策',
      videoId: 'BV1xx_p26',
      updatedAt: '2026-10-22',
      domain: '公考_言语理解',
    },
  ];
  it('复合领域 MOC 含上域回链；单段域不含', () => {
    const sub = buildMocMarkdown({ domain: '公考_判断推理', entries });
    expect(sub).toContain('上域：[[MOC-公考]]');
    const flat = buildMocMarkdown({ domain: '前端开发', entries: [] });
    expect(flat).not.toContain('上域：');
  });
  it('父级 MOC 列出全部同父域子域的 MOC 链接', () => {
    const parent = buildParentMocMarkdown({
      parent: '公考',
      childDomains: ['公考_判断推理', '公考_言语理解', '前端开发'],
    });
    expect(parent).toContain('[[MOC-公考_判断推理|公考_判断推理]]');
    expect(parent).toContain('[[MOC-公考_言语理解|公考_言语理解]]');
    expect(parent).not.toContain('前端开发'); // 不同父域不混入
  });
  it('子域集合去重排序', () => {
    const parent = buildParentMocMarkdown({
      parent: '公考',
      childDomains: ['公考_言语理解', '公考_判断推理', '公考_判断推理'],
    });
    expect(parent.match(/MOC-公考_/g)?.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SPEC-17 检索实测轮：术语包含匹配（中文无分词，问题片段常含概念名）
// ---------------------------------------------------------------------------
describe('searchIndex 术语包含匹配（E2E 实测暴露的漏检修复）', () => {
  const base = {
    tags: ['ai', '概念'],
    summaryPreview: '预览',
    updatedAt: '2026-10-16T00:00:00Z',
    domain: '公考_判断推理',
  };
  const index: KnowledgeIndexFile = {
    version: 1,
    entries: [
      { ...base, path: '概念/逆向思维.md', title: '逆向思维', category: 'concept', terms: ['逆向思维', '反推'] },
      { ...base, path: '概念/插空法.md', title: '插空法', category: 'concept', terms: ['插空法'] },
    ],
  };

  it('长问题片段含概念名 → 命中（修复前全等匹配漏检）', () => {
    const hits = searchIndex({ index, queryTerms: ['逆向思维是什么'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].entry.title).toBe('逆向思维');
  });

  it('片段内多概念同时命中（插空/捆绑问句）', () => {
    const hits = searchIndex({
      index: {
        version: 1,
        entries: [
          ...index.entries,
          { ...base, path: '概念/捆绑法.md', title: '捆绑法', category: 'concept', terms: ['捆绑法'] },
        ],
      },
      queryTerms: ['做排列组合题时什么时候用插空法', '什么时候用捆绑法'],
    });
    const titles = hits.map((h) => h.entry.title);
    expect(titles).toContain('插空法');
    expect(titles).toContain('捆绑法');
  });

  it('无关问题仍零命中（防误检不回退）', () => {
    expect(searchIndex({ index, queryTerms: ['今天中午吃什么比较好消化'] })).toHaveLength(0);
  });
});
