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

