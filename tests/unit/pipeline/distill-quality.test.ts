/**
 * SPEC-18/19 · 蒸馏质量门禁、溯源诚实性与入库校验 单测：
 * 章节要点确定性归一（滑动窗去重）、引文原文定位（locateQuoteInRaw）、
 * 引用入库校验（禁 [00:00] 占位、原句代码截取、未命中降级转述）、
 * broader 入库校验（自指/悬空置空）、terms 噪音过滤（含中文/快捷键）、
 * 文件名清洗（全角 + 尾随标点）、索引条目统一构造、AGENTS.md 契约、
 * 笔记可辨识（callout + 摘要锚点）、日期时区一致。
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
  locateQuoteInRaw,
  sanitizeBroader,
  sanitizeFileName,
} from '../../../src/core/pipeline/capture';
import { normalizeBullets, textOverlap } from '../../../src/core/pipeline/merge';
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

  it('同刻近重复合并，保留较长的一条', () => {
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

  it('跨秒近重复也合并（±5s 窗口）', () => {
    const out = normalizeBullets(
      [
        { text: '总结：定义判断需要每个选项都去甄别', startMs: 935 },
        { text: '定义判断需要每个选项都去甄别', startMs: 938 },
      ],
      0,
      1000,
    );
    expect(out).toHaveLength(1);
    expect(out[0].startMs).toBe(935);
    expect(out[0].text).toContain('总结');
  });

  it('内容不同则保留（即使同刻）', () => {
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

  it('时间相隔较远（>5s）的相似表述不去重', () => {
    const out = normalizeBullets(
      [
        { text: '这是一个重要的结论', startMs: 100 },
        { text: '这是一个重要的结论', startMs: 40_000 },
      ],
      0,
      50_000,
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

describe('textOverlap（文本重叠度：较小集覆盖率）', () => {
  it('包含关系识别为高重叠（Jaccard 判不准的场景）', () => {
    // 长句涵盖短句 → 较小集覆盖率 = 1
    expect(textOverlap('本质的定义', '本质的定义：事物本身所固有的根本属性')).toBeGreaterThan(0.9);
  });

  it('不同内容低重叠', () => {
    expect(textOverlap('主体是动作的实施者', '客体是行为的承受者')).toBeLessThan(0.6);
  });
});

describe('locateQuoteInRaw（引文原文定位）', () => {
  const cues = [
    { startMs: 481_000, text: '就是加强论据' },
    { startMs: 490_000, text: '我们就得了解加强论据' },
    { startMs: 500_000, text: '加强论点呢是对论点进行支持' },
    { startMs: 508_000, text: '加强论证呢是对整个过程进行加强' },
  ];

  it('命中 → 返回逐字原文与命中行时间戳（非提示锚点）', () => {
    const hit = locateQuoteInRaw({ excerpt: '加强论点是对论点支持', cues, hintSec: 496 });
    expect(hit).not.toBeNull();
    // 引文必须是 raw 的逐字原文（含 ASR 原貌"呢/进行"）
    expect(hit!.text).toBe('加强论点呢是对论点进行支持');
    expect(hit!.startMs).toBe(500_000);
  });

  it('同一提示锚点下不同引文各自落到各自行（根治批量赋锚）', () => {
    const a = locateQuoteInRaw({ excerpt: '加强论点是对论点支持', cues, hintSec: 496 });
    const b = locateQuoteInRaw({ excerpt: '加强论证是对整个过程加强', cues, hintSec: 496 });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // 虽然提示锚点同为 496s，两条引文各自定位到各自行
    expect(a!.startMs).not.toBe(b!.startMs);
    expect(a!.text).toBe('加强论点呢是对论点进行支持');
    expect(b!.text).toBe('加强论证呢是对整个过程进行加强');
  });

  it('引文是改写句（raw 无贴合原文）→ 未命中，调用方降级转述', () => {
    // raw 只有"就是加强论据""我们就得了解加强论据"，没有"加强论据是对论据加强"这句
    const hit = locateQuoteInRaw({ excerpt: '加强论据是对论据加强', cues, hintSec: 496 });
    expect(hit).toBeNull();
  });

  it('多行拼接定位：引文跨连续行时返回拼接原文', () => {
    const hit = locateQuoteInRaw({ excerpt: '就是加强论据我们就得了解加强论据', cues, hintSec: 485 });
    expect(hit).not.toBeNull();
    expect(hit!.startMs).toBe(481_000);
  });

  it('引文与原文差异过大 → 未命中（返回 null，调用方降级）', () => {
    const hit = locateQuoteInRaw({ excerpt: '完全不相关的一句话', cues, hintSec: 496 });
    expect(hit).toBeNull();
  });

  it('窗口外的原文不参与定位', () => {
    const hit = locateQuoteInRaw({ excerpt: '加强论点呢是对论点进行支持', cues, hintSec: 5, windowSec: 10 });
    expect(hit).toBeNull();
  });
});

describe('buildVerifiedReference（引用入库校验）', () => {
  const cues = [
    { startMs: 5_000, text: '状态管理模式加库' },
    { startMs: 6_000, text: '它采用集中式存储管理应用的所有组件的状态' },
  ];

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

  it('verbatim 定位命中 → 引文为 raw 逐字原文、锚点为命中行时间戳', () => {
    const { reference, skipped, downgraded } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '状态管理模式加库', excerptKind: 'verbatim' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
      cues,
    });
    expect(skipped).toBeUndefined();
    expect(downgraded).toBeUndefined();
    expect(reference).toContain('> "状态管理模式加库"');
    expect(reference).toContain('语境性质：原句');
    expect(reference).toContain('[00:05]'); // 命中行时间戳（5_000ms）
  });

  it('verbatim 定位不到（改写句）→ 强制降级为转述，不丢内容也不撒谎', () => {
    const { reference, skipped, downgraded } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '完全不相关的一句话', excerptKind: 'verbatim' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
      cues,
    });
    expect(skipped).toBeUndefined(); // 不再丢弃
    expect(downgraded).toBe(true);
    expect(reference).toContain('语境性质：转述');
    expect(reference).not.toContain('> "');
    expect(reference).toContain('（语境转述）完全不相关的一句话');
  });

  it('paraphrase 原样使用，不加引号并标注', () => {
    const { reference, skipped, downgraded } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '一段转述的语境', excerptKind: 'paraphrase' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
      cues,
    });
    expect(skipped).toBeUndefined();
    expect(downgraded).toBeUndefined();
    expect(reference).toContain('语境性质：转述');
    expect(reference).not.toContain('> "');
  });

  it('无 cues（无法验证）→ verbatim 一律降级转述，绝不假称原句', () => {
    const { reference, skipped, downgraded } = buildVerifiedReference({
      concept: { anchorSec: 5, sourceExcerpt: '任意语境', excerptKind: 'verbatim' },
      videoTitle: 'V',
      noteLink: 'n',
      sourceType: 'raw',
      playbackUrl: 'u',
    });
    expect(skipped).toBeUndefined();
    expect(downgraded).toBe(true);
    expect(reference).toContain('语境性质：转述');
    expect(reference).not.toContain('> "');
  });
});

describe('sanitizeBroader（上位概念入库校验）', () => {
  const known = new Set(['加强方式', '论证评价', '加强论据']);

  it('合法上位概念保留', () => {
    expect(sanitizeBroader({ broader: '加强方式', selfName: '加强论据', knownConcepts: known })).toBe('加强方式');
  });

  it('自指 → 置空', () => {
    expect(sanitizeBroader({ broader: '加强论证', selfName: '加强论证', knownConcepts: known })).toBe('');
  });

  it('悬空（目标不存在）→ 置空', () => {
    expect(sanitizeBroader({ broader: '论证评价X', selfName: '无关项', knownConcepts: known })).toBe('');
  });

  it('空值原样返回空', () => {
    expect(sanitizeBroader({ broader: '', selfName: 'X', knownConcepts: known })).toBe('');
    expect(sanitizeBroader({ broader: '   ', selfName: 'X', knownConcepts: known })).toBe('');
  });
});

describe('filterTerms（terms 噪音过滤）', () => {
  it('丢命令形短语 / 文件名 / 代码符号 / 英文停用词', () => {
    const out = filterTerms(['npm install', 'main.js', 'App.vue', '$store.state', 'import', 'counter']);
    expect(out).toEqual([]);
  });

  it('丢中文实现细节词与快捷键、盘符', () => {
    const out = filterTerms(['记事本', '输入法', '文本文档', 'Ctrl+S', 'E盘', '右键', '刷新']);
    expect(out).toEqual([]);
  });

  it('保留真实 API 名与中文概念术语', () => {
    const out = filterTerms(['Vuex', 'mapState', 'router-view', 'createStore', '状态管理', '嵌套路由', 'HTML']);
    expect(out).toEqual(['Vuex', 'mapState', 'router-view', 'createStore', '状态管理', '嵌套路由', 'HTML']);
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

  it('归一 `._` 序列（B 站标题尾点 + 后缀拼接）', () => {
    expect(sanitizeFileName('001_第一个前端程序._哔哩哔哩_bilibili')).toBe('001_第一个前端程序_哔哩哔哩_bilibili');
  });

  it('去尾随点号/下划线', () => {
    expect(sanitizeFileName('001_第一个前端程序.')).toBe('001_第一个前端程序');
    expect(sanitizeFileName('标题__')).toBe('标题');
  });

  it('去开头点号（macOS `._xxx` 是隐藏文件）', () => {
    expect(sanitizeFileName('.hidden')).toBe('hidden');
    expect(sanitizeFileName('._foo')).toBe('foo');
  });
});

describe('buildVideoNoteIndexEntry / buildConceptIndexEntry（索引条目统一构造）', () => {
  it('video-note 条目含显式 sourceType 且 terms 已过滤', () => {
    const e = buildVideoNoteIndexEntry({
      path: '笔记/前端开发_Vue/x.md',
      title: 'T',
      terms: ['Vuex', 'npm install', 'main.js', '记事本'],
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

describe('buildVideoNoteMarkdown（可辨识、摘要锚点、术语行过滤）', () => {
  const md = buildVideoNoteMarkdown({
    meta: meta(),
    sections: [section({ terms: ['Agent', '记事本', 'Ctrl+S'] })],
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

  it('正文「术语：」行同样过滤噪音（SPEC-19）', () => {
    expect(md).toContain('术语：Agent');
    expect(md).not.toContain('记事本');
    expect(md).not.toContain('Ctrl+S');
  });
});

describe('日期时区一致性（概念页 date 与笔记 created 同源）', () => {
  it('同一时刻下概念页 date 与笔记 created 必须相同（都用本地时区）', () => {
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
