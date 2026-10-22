/**
 * 蒸馏回归守卫（SPEC-18/19/20 累计改动回归审查）：
 * 三轮整改的副作用实证——每个用例对应一个真机踩过的误伤，防再回归。
 */
import { describe, expect, it } from 'vitest';
import {
  filterTerms,
  sanitizeFileName,
  wikiLink,
  buildConceptIndexEntry,
} from '../../../src/core/pipeline/capture';
import { normalizeBullets, textOverlap, textSimilarity, isNearDup } from '../../../src/core/pipeline/merge';

describe('近重复去重不得吞并列概念句（回归：字符集重叠 0.83 误合并）', () => {
  it('加强论据 vs 加强论点：非子串且相似度低 → 不合并', () => {
    // 字符集重叠 0.83（虚高）；二元组 Dice ≈ 0.44，且互不为子串 —— 必须保留两条
    expect(textSimilarity('加强论据是对论据加强', '加强论点是对论点支持')).toBeLessThan(0.6);
    expect(isNearDup('加强论据是对论据加强', '加强论点是对论点支持')).toBe(false);
  });
  it('真近重复（强改写）仍合并', () => {
    expect(isNearDup('实验加强的大前提是单一变量原则', '实验加强的大前提就是单一变量原则')).toBe(true);
  });
  it('包含关系（短句是长句子串）仍合并', () => {
    expect(isNearDup('本质的定义', '本质的定义：事物本身所固有的根本属性')).toBe(true);
  });
  it('normalizeBullets：同窗三条并列概念全部保留', () => {
    const out = normalizeBullets(
      [
        { text: '加强论据是对论据加强', startMs: 496_000 },
        { text: '加强论点是对论点支持', startMs: 500_000 },
        { text: '加强论证呢是对整个过程进行加强', startMs: 508_000 },
      ],
      480_000,
      520_000,
    );
    expect(out).toHaveLength(3);
  });
  it('normalizeBullets：真近重复合并为一条（保留较长）', () => {
    const out = normalizeBullets(
      [
        { text: '实验加强的大前提是单一变量原则', startMs: 94_000 },
        { text: '实验加强的大前提就是单一变量原则啊', startMs: 95_000 },
      ],
      90_000,
      100_000,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toContain('就是');
  });
  it('textOverlap 保留原语义（containment 判据，不用于近重复）', () => {
    expect(textOverlap('本质的定义', '本质的定义：事物本身所固有的根本属性')).toBeGreaterThan(0.9);
    expect(textOverlap('主体是动作的实施者', '客体是行为的承受者')).toBeLessThan(0.6);
  });
});

describe('filterTerms 不得误杀品牌技术名（回归：Node.js/Next.js 被 .js 规则清空）', () => {
  it('品牌名保留：Node.js / Next.js / Three.js / Vue.js', () => {
    expect(filterTerms(['Node.js', 'Next.js', 'Three.js', 'Vue.js'])).toEqual([
      'Node.js', 'Next.js', 'Three.js', 'Vue.js',
    ]);
  });
  it('文件名风格仍被过滤（含 App.vue）', () => {
    expect(filterTerms(['main.js', 'styles.css', 'package.json', 'index.ts', 'App.vue'])).toEqual([]);
  });
  it('真实术语保留（回归审查基线）', () => {
    expect(filterTerms(['单一变量原则', '加强论点', 'HTML5', 'mapState', 'router-view'])).toEqual([
      '单一变量原则', '加强论点', 'HTML5', 'mapState', 'router-view',
    ]);
  });
});

describe('概念名不进 filterTerms（回归：名字恰为停用词时被自身词条表误杀）', () => {
  it('概念名「属性」即便命中停用词也保留为 terms 首项', () => {
    const e = buildConceptIndexEntry({
      path: '概念/属性.md',
      name: '属性',
      aliases: ['特性', 'attribute'],
      definition: '标签上的键值对',
      domain: '前端开发',
      sourceType: 'ai-distill',
    });
    expect(e.terms[0]).toBe('属性');
    expect(e.terms).toContain('特性');
    expect(e.terms).toContain('attribute');
  });
  it('aliases 噪音照常过滤', () => {
    const e = buildConceptIndexEntry({
      path: '概念/HTML 属性.md',
      name: 'HTML 属性',
      aliases: ['记事本', 'Ctrl+S'],
      definition: 'HTML 标签的键值对',
      domain: '前端开发',
      sourceType: 'ai-distill',
    });
    expect(e.terms).toContain('HTML 属性');
    expect(e.terms).not.toContain('记事本');
    expect(e.terms).not.toContain('Ctrl+S');
  });
});

describe('sanitizeFileName 与 wikiLink 一致性', () => {
  it('B站标题尾随点号清洗', () => {
    expect(sanitizeFileName('001_第一个前端程序._哔哩哔哩_bilibili')).toBe('001_第一个前端程序_哔哩哔哩_bilibili');
  });
  it('干净名不变（wikiLink 不加别名）', () => {
    expect(wikiLink('加强论点')).toBe('[[加强论点]]');
    expect(sanitizeFileName('加强论点')).toBe('加强论点');
  });
  it('非法字符名：目标=落盘名，显示=原名', () => {
    expect(wikiLink('h$*6 快捷键')).toBe('[[h$_6 快捷键|h$*6 快捷键]]');
  });
});
