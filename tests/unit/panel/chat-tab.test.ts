/**
 * 问答 Tab 单测（SPEC-05）：区间选择器 / 打字机分片 / 时间戳吸附 / mm:ss 解析 /
 * renderToString 冒烟（模型未配置引导）+ SubtitleTab 划词提取纯函数。
 * 环境为 node 且未安装 @testing-library/react：纯逻辑直接断言，
 * 渲染用 react-dom/server 的 renderToString（不含 effect）。
 *
 * 问答 Tab 三项增强追加：历史恢复映射（recordsToMessages）、兜底搜索链接
 * （buildSearchUrl）、来源区文案（formatSources / formatRangeSource）。
 */
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_FALLBACK_URL } from '../../../src/config';
import {
  ChatTab,
  buildSearchUrl,
  chunkTypewriter,
  formatPersonaLine,
  formatRangeSource,
  formatSources,
  parseMmSs,
  recordsToMessages,
  resolveRange,
  snapTimestamps,
  splitInlineTimestamps,
  hasInlineTimestamps,
} from '../../../src/panel/ChatTab';
import { extractSelectionText } from '../../../src/panel/SubtitleTab';
import type { Cue, QaRecord, Section } from '../../../src/types';

const mkSection = (id: string, startMs: number, endMs: number): Section => ({
  id,
  title: `章节${id}`,
  startMs,
  endMs,
  summary: '摘要',
  bullets: [{ text: '要点', startMs }],
  terms: [],
  importance: 3,
  density: 'mid',
  cueRange: [0, 5],
});

const sections = [mkSection('s1', 0, 120_000), mkSection('s2', 120_000, 240_000)];

const cue = (index: number, startMs: number, endMs: number, text: string): Cue => ({
  index,
  startMs,
  endMs,
  text,
});

describe('resolveRange（区间选择器解析）', () => {
  it('around：播放位置 ±30s', () => {
    expect(resolveRange('around', 100_000, sections)).toEqual([70_000, 130_000]);
  });

  it('around：不足 30s 时起点 clamp 到 0', () => {
    expect(resolveRange('around', 10_000, sections)).toEqual([0, 40_000]);
  });

  it('chapter：命中 positionMs 所在整章', () => {
    expect(resolveRange('chapter', 130_000, sections)).toEqual([120_000, 240_000]);
  });

  it('chapter 查不到章节时回落 ±30s', () => {
    expect(resolveRange('chapter', 100_000, [])).toEqual([70_000, 130_000]);
  });

  it('custom：合法自定义区间原样返回', () => {
    expect(resolveRange('custom', 100_000, sections, [30_000, 90_000])).toEqual([30_000, 90_000]);
  });

  it('custom 非法（起点>终点）回落 ±30s', () => {
    expect(resolveRange('custom', 100_000, sections, [90_000, 30_000])).toEqual([70_000, 130_000]);
  });
});

describe('parseMmSs', () => {
  it('"05:30" → 330000ms', () => {
    expect(parseMmSs('05:30')).toBe(330_000);
  });

  it('容忍空格；"0:5" 合法', () => {
    expect(parseMmSs(' 0:5 ')).toBe(5_000);
  });

  it('非法输入返回 null（秒 ≥60 / 缺冒号 / 字母）', () => {
    expect(parseMmSs('00:60')).toBeNull();
    expect(parseMmSs('12345')).toBeNull();
    expect(parseMmSs('ab:cd')).toBeNull();
  });
});

describe('chunkTypewriter（打字机分片）', () => {
  it('每片 1-3 字，join 还原原文', () => {
    const text = '注意力机制让模型学会对齐上下文';
    const chunks = chunkTypewriter(text);
    expect(chunks.join('')).toBe(text);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThanOrEqual(1);
      expect(c.length).toBeLessThanOrEqual(3);
    }
  });

  it('空字符串返回空数组', () => {
    expect(chunkTypewriter('')).toEqual([]);
  });
});

describe('snapTimestamps（A3：渲染前吸附到 Cue，越界丢弃）', () => {
  const cues = [
    cue(0, 0, 4000, 'a'),
    cue(1, 36_000, 40_000, 'b'),
    cue(2, 100_000, 104_000, 'c'),
  ];

  it('秒 → 最近 Cue 开始时间', () => {
    expect(snapTimestamps([36], cues)).toEqual([36_000]);
    expect(snapTimestamps([38], cues)).toEqual([36_000]);
  });

  it('越界值丢弃（早于首句 / 晚于末句），无 Cue 返回空', () => {
    expect(snapTimestamps([-10, 130], cues)).toEqual([]);
    expect(snapTimestamps([50], [])).toEqual([]);
  });

  it('距最近 Cue 超过 10s 丢弃（SPEC-15 九轮：防换算偏差跳到无关句）', () => {
    // 50s 距 36s 差 14s、距 100s 差 50s → 都超 10s 上限，丢弃
    expect(snapTimestamps([50], cues)).toEqual([]);
    // 40s 距 36s 差 4s → 保留
    expect(snapTimestamps([40], cues)).toEqual([36_000]);
  });

  it('去重并升序', () => {
    expect(snapTimestamps([100, 36, 38], cues)).toEqual([36_000, 100_000]);
  });
});

describe('splitInlineTimestamps / hasInlineTimestamps（SPEC-15 九轮：正文内嵌 [mm:ss] chip）', () => {
  const cues = [
    cue(0, 0, 4000, 'a'),
    cue(1, 36_000, 40_000, 'b'),
    cue(2, 100_000, 104_000, 'c'),
  ];

  it('文本与 chip 交替切分；chip 吸附到最近 Cue 起点', () => {
    const segs = splitInlineTimestamps('先横再竖是通用解法 [00:36]，位置对应 [01:40]。', cues);
    expect(segs).toEqual([
      { text: '先横再竖是通用解法 ', ms: null },
      { text: '', ms: 36_000 },
      { text: '，位置对应 ', ms: null },
      { text: '', ms: 100_000 },
      { text: '。', ms: null },
    ]);
    expect(hasInlineTimestamps('先横再竖 [00:36]', cues)).toBe(true);
  });

  it('越界/无字幕的标记按普通文本处理（不可点，防编造时间戳）', () => {
    const outOfRange = splitInlineTimestamps('编造的时间 [99:99] 与 [05:00]。', cues);
    expect(outOfRange.every((s) => s.ms === null)).toBe(true); // 全部退化为文本
    expect(hasInlineTimestamps('编造 [99:99]', cues)).toBe(false);
    const noCues = splitInlineTimestamps('无字幕时 [00:36] 不可点', []);
    expect(noCues.every((s) => s.ms === null)).toBe(true);
  });

  it('距最近 Cue 超过 10s 的标记同样按普通文本（与 snapTimestamps 同口径）', () => {
    const segs = splitInlineTimestamps('偏差的标记 [00:50] 应退化。', cues);
    expect(segs.every((s) => s.ms === null)).toBe(true); // 50s 距 36s/100s 都超 10s
    expect(hasInlineTimestamps('偏差 [00:50]', cues)).toBe(false);
  });

  it('无标记正文 → 单段文本', () => {
    expect(splitInlineTimestamps('普通回答，没有标记。', cues)).toEqual([
      { text: '普通回答，没有标记。', ms: null },
    ]);
  });
});

describe('ChatTab renderToString 冒烟', () => {
  it('无视频：idle 占位', () => {
    const html = renderToString(createElement(ChatTab, { videoId: null }));
    expect(html).toContain('打开 B 站视频');
  });

  it('模型未配置：去设置引导（含按钮）', () => {
    const html = renderToString(
      createElement(ChatTab, {
        videoId: 'BV1X_p1',
        modelReady: false,
        onOpenSettings: () => {},
      }),
    );
    expect(html).toContain('模型未配置');
    expect(html).toContain('去设置');
  });

  it('就绪态：渲染区间选择器与输入区', () => {
    const record: QaRecord = {
      id: 'r',
      videoId: 'BV1X_p1',
      interactionType: 'free',
      sectionId: null,
      timestampMs: 0,
      rangeMs: null,
      question: 'q',
      answer: 'a',
      payload: {},
      createdAt: '',
    };
    const html = renderToString(
      createElement(ChatTab, {
        videoId: 'BV1X_p1',
        sections,
        cues: [cue(0, 0, 1000, '首句')],
        positionMs: 130_000,
        modelReady: true,
        explain: async () => ({ record }),
      }),
    );
    // SPEC-14：区间选择收进时间胶囊（浮层内选项初始不渲染）
    expect(html).toContain('chat-pill');
    expect(html).toContain('播放位置±30s');
    expect(html).toContain('输入问题');
  });
});

describe('recordsToMessages（历史恢复：qaHistory → 消息列表）', () => {
  const base: QaRecord = {
    id: 'r1',
    videoId: 'BV1X_p1',
    interactionType: 'free',
    sectionId: null,
    timestampMs: 0,
    rangeMs: null,
    question: 'q',
    answer: 'a',
    payload: {},
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  const termPayload = {
    term: '注意力机制',
    inVideoMeaning: '课上含义',
    generalDefinition: '通用定义',
    analogy: '类比',
    relatedTerms: ['QKV'],
    needsWeb: false,
  };
  const segmentPayload = {
    answer: '这段讲了 X',
    keyPoints: ['要点1'],
    referencedTimestamps: [60],
    followUpQuestions: ['然后呢'],
    coveredByVideo: true,
  };

  it('term 记录：用户消息显示术语名，assistant 回填 term payload', () => {
    const msgs = recordsToMessages([{ ...base, interactionType: 'term', question: '注意力机制', payload: termPayload }]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ role: 'user', text: '解释「注意力机制」' });
    expect(msgs[1]).toMatchObject({ role: 'assistant', kind: 'term', text: 'a', typing: false });
    expect(msgs[1].term?.term).toBe('注意力机制');
  });

  it('segment 记录：回填 answer payload 与区间', () => {
    const msgs = recordsToMessages([
      { ...base, interactionType: 'segment', rangeMs: [30_000, 90_000], payload: segmentPayload },
    ]);
    expect(msgs[0].text).toBe('q');
    expect(msgs[1]).toMatchObject({ kind: 'segment', typing: false });
    expect(msgs[1].answer?.keyPoints).toEqual(['要点1']);
    expect(msgs[1].rangeMs).toEqual([30_000, 90_000]);
  });

  it('free 记录：正文渲染，payload 形状不匹配时不回填', () => {
    const msgs = recordsToMessages([{ ...base, answer: '自由回答', payload: { foo: 1 } }]);
    expect(msgs[1]).toMatchObject({ kind: 'free', text: '自由回答' });
    expect(msgs[1].term).toBeUndefined();
    expect(msgs[1].answer).toBeUndefined();
  });

  it('空数组 → 空消息列表', () => {
    expect(recordsToMessages([])).toEqual([]);
  });

  it('payload 缺失（undefined）不报错，只渲染正文', () => {
    const msgs = recordsToMessages([{ ...base, payload: undefined }]);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].text).toBe('a');
    expect(msgs[1].term).toBeUndefined();
  });

  it('多条回答按序成对展开且 id 唯一递增', () => {
    const msgs = recordsToMessages([base, { ...base, id: 'r2', interactionType: 'term', question: 'T' }]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('buildSearchUrl（兜底搜索链接，红线 9）', () => {
  it('URL 前缀来自 config 常量', () => {
    expect(buildSearchUrl('注意力').startsWith(WEB_SEARCH_FALLBACK_URL)).toBe(true);
  });

  it('query 做 URL 编码（中文与空格）', () => {
    expect(buildSearchUrl('注意力 机制')).toBe(
      `${WEB_SEARCH_FALLBACK_URL}${encodeURIComponent('注意力 机制')}`,
    );
    expect(buildSearchUrl('注意力 机制')).toContain('%E6%B3%A8%E6%84%8F%E5%8A%9B');
  });
});

describe('来源区文案（formatSources / formatRangeSource）', () => {
  it('公开资料：有结果返回标题列表，无结果返回 null', () => {
    expect(formatSources([{ title: 'MDN', url: 'u1', snippet: 's' }])).toBe('公开资料：MDN');
    expect(formatSources([])).toBeNull();
    expect(formatSources(undefined)).toBeNull();
  });

  it('公开资料：标题缺失回落 url', () => {
    expect(formatSources([{ title: '', url: 'u1', snippet: 's' }])).toBe('公开资料：u1');
  });

  it('命中课程区间：无时间戳时给出区间，已有时间戳则省略', () => {
    expect(formatRangeSource([60_000, 90_000], false)).toBe('命中课程区间 01:00-01:30');
    expect(formatRangeSource([60_000, 90_000], true)).toBeNull();
    expect(formatRangeSource(null, false)).toBeNull();
  });
});

describe('formatPersonaLine / ChatTab 角色条（动态回答角色）', () => {
  const base: QaRecord = {
    id: 'r',
    videoId: 'BV1X_p1',
    interactionType: 'free',
    sectionId: null,
    timestampMs: 0,
    rangeMs: null,
    question: 'q',
    answer: 'a',
    payload: {},
    createdAt: '',
  };
  const render = (props: Record<string, unknown>): string =>
    renderToString(
      createElement(ChatTab, {
        videoId: 'BV1X_p1',
        sections,
        cues: [cue(0, 0, 1000, '首句')],
        positionMs: 130_000,
        modelReady: true,
        explain: async () => ({ record: base }),
        ...props,
      }) as never,
    );

  it('注入 persona：渲染角色条（含 fallback 的「默认角色」标注）与重判按钮', () => {
    const html = render({
      persona: {
        videoId: 'BV1X_p1',
        promptVersion: '0.1.0',
        model: 'm',
        role: 'AI 应用工程讲师',
        expertise: ['大模型应用', '提示工程'],
        style: '先给结论再讲原理',
        fallback: true,
        createdAt: '',
      },
      onRefreshPersona: async () => {},
    });
    expect(html).toContain('以「AI 应用工程讲师」身份回答');
    expect(html).toContain('领域：大模型应用、提示工程');
    expect(html).toContain('（默认角色）');
    // SPEC-14：重判入口收进角色胶囊浮层（初始收起，title 携带完整角色行）
    expect(html).toContain('👤');
  });

  it('未注入 persona：不显示角色条（旧行为兼容）', () => {
    const html = render({});
    expect(html).not.toContain('身份回答');
    expect(html).not.toContain('重判角色');
  });

  it('formatPersonaLine：无 fallback 不标注默认；role 为空返回 null', () => {
    expect(
      formatPersonaLine({ role: '产品经理', expertise: ['需求拆解'], style: 's', videoId: 'v', promptVersion: '0.1.0', model: 'm', createdAt: '' }),
    ).toBe('以「产品经理」身份回答 · 领域：需求拆解');
    expect(formatPersonaLine(null)).toBeNull();
    expect(formatPersonaLine(undefined)).toBeNull();
    expect(
      formatPersonaLine({ role: '  ', expertise: ['x'], style: 's', videoId: 'v', promptVersion: '0.1.0', model: 'm', createdAt: '' }),
    ).toBeNull();
  });
});

describe('SubtitleTab extractSelectionText（划词提取纯函数）', () => {
  it('trim 两侧空白', () => {
    expect(extractSelectionText('  注意力机制 \n')).toBe('注意力机制');
  });

  it('纯空白返回 null', () => {
    expect(extractSelectionText('   \n\t ')).toBeNull();
    expect(extractSelectionText('')).toBeNull();
  });

  it('限长 40 字：超出截断', () => {
    expect(extractSelectionText('a'.repeat(50))).toBe('a'.repeat(40));
  });
});
