/**
 * SPEC-18 · 蒸馏质量门禁与契约对齐 单测：
 * 章节要点确定性归一、引文窗口软校验、引用入库校验（禁 [00:00] 占位）、
 * terms 噪音过滤、文件名全角清洗、索引条目统一构造、AGENTS.md 契约内容、
 * 笔记可辨识（AI 蒸馏 callout + 章节摘要锚点）。
 *
 * 红线 9：URL 字面量只作为被测输入（视频地址）出现，不涉及受管控端点。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENTS_MD,
  buildConceptIndexEntry,
  buildConceptPageMarkdown,
  buildVerifiedReference,
  buildVideoNoteIndexEntry,
  buildVideoNoteMarkdown,
  filterTerms,
  quoteWindowCoverage,
  sanitizeFileName,
} from '../../../src/core/pipeline/capture';
import { normalizeBullets } from '../../../src/core/pipeline/merge';
import type { Section, VideoMeta } from '../../../src/types';

const meta = (over: Partial<VideoMeta> = {}): VideoMeta => ({
  videoId: 'BV1YG7G6eEPR_p2',
  bvid: 'BV1YG7G6eEPR',
  page: 2,
  cid: 30_000,
  title: 'P2 Agent基本概念',
  durationMs: 1_922_000,
  url: 'https://www.bilibili.com/video/BV1YG7G6eEPR/',
  ...over,
});

const section = (over: Partial<Section> = {}): Section => ({
  id: 'sec_0001',
  title: '核心概念',
  startMs: 0,
  endMs: 60_000,
  summary: '本章讲解 Agent 的定义与边界。',
  bullets: [{ text: 'Agent 是能自主行动的实体', startMs: 1_000 }],
  terms: ['Agent'],
  importance: 4,
  density: 'mid',
  cueRange: [0, 9],
  ...over,
});

describe('normalizeBullets（章节要点确定性归一）', () => {
  it('乱序 → 按 startMs 升序', () => {
    const out = normalizeBullets(
      [
        { text: 'b', startMs: 300 },
        { text: 'a', startMs: 100 },
      ],
      0,
      500,
    );
    expect(out.map((b) => b.startMs)).toEqual([100, 300]);
  });

  it('同刻重复文本去重，保留较长的一条', () => {
    const out = normalizeBullets(
      [
        { text: '本质的定义', startMs: 100 },
        { text: '本质的定义：事物本身所固有的根本属性', startMs: 100 },
      ],
      0,
      500,
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('根本属性');
  });

  it('同刻不同文本都保留（内容不同）', () => {
    const out = normalizeBullets(
      [
        { text: '主体是动作的实施者', startMs: 100 },
        { text: '客体是行为的承受者', startMs: 100 },
      ],
      0,
      500,
    );
    expect(out).toHaveLength(2);
  });

  it('越界要点回落到章节起点并标 approximate', () => {
    const out = normalizeBullets(
      [
        { text: '正常', startMs: 100 },
        { text: '越界到下一章', startMs: 900 },
        { text: '早于章节起点', startMs: -50 },
      ],
      0,
      500,
    );
    const overflow = out.find((b) => b.text === '越界到下一章');
    expect(overflow?.startMs).toBe(0);
    expect(overflow?.approximate).toBe(true);
    const early = out.find((b) => b.text === '早于章节起点');
    // -50 非法（负数）→ 被过滤
    expect(early).toBeUndefined();
  });

  it('越界回落后仍保持有序（回落条目不留在末尾）', () => {
    const out = normalizeBullets(
      [
        { text: 'a', startMs: 100 },
        { text: 'b', startMs: 200 },
        { text: '越界内容', startMs: 900 },
      ],
      0,
      500,
    );
    // 回落到章节起点后必须重排到最前，否则会形成新的乱序
    expect(out.map((b) => b.startMs)).toEqual([0, 100, 200]);
  });

  it('幂等：对已归一的输入再跑一遍结果不变', () => {
    const once = normalizeBullets(
      [
        { text: 'b', startMs: 300 },
        { text: 'a', startMs: 100 },
      ],
      0,
      500,
    );
    const twice = normalizeBullets(once, 0, 500);
    expect(twice).toEqual(once);
  });
});

describe('quoteWindowCoverage（引文窗口软校验）', () => {
  const cues = [
    { startMs: 0, text: '状态管理模式加库' },
    { startMs: 2_000, text: '它采用集中式存储管理应用的所有组件的状态' },
    { startMs: 120_000, text: '后面完全无关的内容' },
  ];

  it('锚点附近原文与引文高度重叠 → 覆盖率高', () => {
    const cov = quoteWindowCoverage('状态管理模式加库', cues, 1);
    expect(cov).toBeGreaterThan(0.5);
  });

  it('锚点附近无相关内容 → 覆盖率低', () => {
    const cov = quoteWindowCoverage('完全不相关的一句话', cues, 1);
    expect(cov).toBeLessThan(0.35);
  });

  it('窗口外的原文不参与（限锚点前后窗口）', () => {
    const cov = quoteWindowCoverage('后面完全无关的内容', cues, 1);
    expect(cov).toBe(0);
  });
});

describe('buildVerifiedReference（引用入库校验）', () => {
  const cues = [{ startMs: 5_000, text: '状态管理模式加库' }];

  it('anchorSec 为 0 → 拒绝（禁 [00:00] 占位）', () => {
    const { reference, skipped } = buildVerifiedReference({
      concept: { anchorSec: 0, sourceExcerpt: '状态管理模式加库' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
      cues,
    });
    expect(reference).toBe('');
    expect(skipped).toContain('anchor-missing');
  });

  it('verbatim 且窗口覆盖率低 → 丢弃', () => {
    const { reference, skipped } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '完全不相关的一句话', excerptKind: 'verbatim' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
      cues,
    });
    expect(reference).toBe('');
    expect(skipped).toContain('low-coverage');
  });

  it('paraphrase 不做覆盖率硬校验，正常产出且标"转述"', () => {
    const { reference, skipped } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '一段转述的语境', excerptKind: 'paraphrase' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
      cues,
    });
    expect(skipped).toBeUndefined();
    expect(reference).toContain('语境转述');
    expect(reference).toContain('语境性质：转述');
    expect(reference).not.toContain('> "');
  });

  it('verbatim 且覆盖率合格 → 产出加引号的原句', () => {
    const { reference, skipped } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '状态管理模式加库', excerptKind: 'verbatim' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
      cues,
    });
    expect(skipped).toBeUndefined();
    expect(reference).toContain('> "状态管理模式加库"');
    expect(reference).toContain('语境性质：原句');
  });

  it('无 cues 时只做锚点合法性（不报覆盖率）', () => {
    const { reference, skipped } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '任意语境' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
    });
    expect(skipped).toBeUndefined();
    expect(reference).toContain('任意语境');
  });
});

describe('filterTerms（terms 噪音过滤）', () => {
  it('丢命令形短语 / 文件名 / 代码符号 / 停用词', () => {
    const out = filterTerms(['npm install', 'main.js', 'App.vue', '$store.state', 'import', 'counter']);
    expect(out).toEqual([]);
  });

  it('保留真实 API 名与中文术语', () => {
    const out = filterTerms(['Vuex', 'mapState', 'router-view', 'createStore', '状态管理', '嵌套路由']);
    expect(out).toEqual(['Vuex', 'mapState', 'router-view', 'createStore', '状态管理', '嵌套路由']);
  });

  it('去重且丢空串与过短词条', () => {
    expect(filterTerms(['Vuex', 'Vuex', ' a ', ''])).toEqual(['Vuex']);
  });
});

describe('sanitizeFileName（文件名清洗）', () => {
  it('全角冒号等被替换', () => {
    expect(sanitizeFileName('判断推理12：定义判断')).not.toContain('：');
  });

  it('半角非法字符全部替换', () => {
    expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('中文与空格保留', () => {
    expect(sanitizeFileName('Vue 状态管理')).toBe('Vue 状态管理');
  });
});

describe('buildVideoNoteIndexEntry / buildConceptIndexEntry（索引条目统一构造）', () => {
  it('video-note 条目含显式 sourceType 且 terms 已过滤', () => {
    const e = buildVideoNoteIndexEntry({
      path: '笔记/前端开发_Vue/x.md',
      title: 'T',
      terms: ['Vuex', 'npm install', 'main.js'],
      summaryPreview: '摘要',
      videoId: 'BV1_p1',
      domain: '前端开发_Vue',
    });
    expect(e.category).toBe('video-note');
    expect(e.sourceType).toBe('ai-distill');
    expect(e.terms).toEqual(['Vuex']);
  });

  it('concept 条目 entities = [name]，terms 含 name 与 aliases', () => {
    const e = buildConceptIndexEntry({
      path: '概念/Vuex.md',
      name: 'Vuex',
      aliases: ['状态管理模式加库'],
      definition: '定义',
      domain: '前端开发_Vue',
      sourceType: 'user-note',
    });
    expect(e.sourceType).toBe('user-note');
    expect(e.entities).toEqual(['Vuex']);
    expect(e.terms).toContain('Vuex');
  });
});

describe('AGENTS.md 契约（目录 / 字段字典 / 变更协议）', () => {
  it('目录名为实际实现，不含未实现的 术语/{领域}/ 与 问答/ 承诺', () => {
    expect(AGENTS_MD).toContain('`笔记/{领域}/{课程}/`');
    expect(AGENTS_MD).toContain('`概念/{概念名}.md`');
    expect(AGENTS_MD).toContain('`索引/MOC-{领域}.md`');
    // 旧契约的漂移写法不应再出现
    expect(AGENTS_MD).not.toContain('`视频笔记/{领域}/{课程}/`');
    expect(AGENTS_MD).not.toContain('`术语/{领域}/`');
  });

  it('含字段字典（「N 分」口径）与 tag 双表示说明', () => {
    expect(AGENTS_MD).toContain('新知识率 45% + 术语密度 25% + 章节重要性 30%');
    expect(AGENTS_MD).toContain('domain');
    expect(AGENTS_MD).toContain('tags');
    expect(AGENTS_MD).toContain('sourceType');
  });

  it('含引用语境双形态与禁 [00:00] 占位规则', () => {
    expect(AGENTS_MD).toContain('语境性质');
    expect(AGENTS_MD).toContain('[00:00]');
    expect(AGENTS_MD).toContain('占位');
  });

  it('含变更协议', () => {
    expect(AGENTS_MD).toContain('## D. 变更协议');
    expect(AGENTS_MD).toContain('版本记录.md');
  });
});

describe('buildVideoNoteMarkdown（可辨识与摘要锚点）', () => {
  const md = buildVideoNoteMarkdown({
    meta: meta(),
    sections: [section()],
    sourceVideoId: 'BV1YG7G6eEPR_p2',
  }).markdown;

  it('含 AI 蒸馏 · 待核验 callout（宪法 B.9/C.6）', () => {
    expect(md).toContain('> [!note] AI 蒸馏 · 待核验');
  });

  it('章节摘要句尾带溯源锚点（宪法 B.1）', () => {
    expect(md).toMatch(/本章讲解 Agent 的定义与边界。 \[00:00\]\(/);
  });

  it('章节标题仍带综合打分', () => {
    expect(md).toContain('## 00:00-01:00 核心概念（-）');
  });
});

describe('日期时区一致性（概念页 date 与笔记 created 同源）', () => {
  it('同一时刻下概念页 date 与笔记 created 必须相同（都用本地时区）', () => {
    // 本地 10-22 00:30 —— UTC 下会落到 10-21，可鉴别两种实现
    const now = new Date(2026, 9, 22, 0, 30);
    const note = buildVideoNoteMarkdown({ meta: meta(), sections: [section()], sourceVideoId: 'x', now }).markdown;
    const concept = buildConceptPageMarkdown({
      preferred: 'X',
      aliases: [],
      definition: '定义',
      broader: '',
      domain: '通用',
      reference: '',
      now,
    });
    const created = /created: (\S+)/.exec(note)?.[1];
    const date = /date: (\S+)/.exec(concept)?.[1];
    expect(created).toBeTruthy();
    expect(date).toBe(created);
  });
});
