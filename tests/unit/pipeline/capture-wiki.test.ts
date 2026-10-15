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
      path: '视频笔记/逻辑学/BV1xx/图形推理.md',
      title: '图形推理',
      category: 'video-note',
      tags: [],
      terms: [],
      summaryPreview: '先观察再推理',
      updatedAt: '2026-10-16T00:00:00Z',
      domain: '逻辑学',
    },
    {
      path: '视频笔记/编程/BV2yy/路由.md',
      title: '路由配置',
      category: 'video-note',
      tags: [],
      terms: [],
      summaryPreview: '路由文件格式',
      updatedAt: '2026-10-16T00:00:00Z',
      domain: '编程',
    },
    {
      path: '术语/逻辑学/排除法.md',
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
        path: '视频笔记/BV3zz/旧笔记.md',
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
