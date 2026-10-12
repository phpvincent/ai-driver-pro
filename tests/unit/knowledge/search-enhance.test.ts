/**
 * SPEC-15 单测：检索路由 + Tavily/Wikipedia 解析器。
 */
import { describe, expect, it } from 'vitest';
import { shouldSearchWeb } from '../../../src/panel/explainLoader';
import {
  buildWikipediaUrl,
  parseTavilyResults,
  parseWikipediaResults,
} from '../../../src/core/knowledge/webSearch';

describe('shouldSearchWeb（检索路由，SPEC-15）', () => {
  it('术语解释必检；时新词必检', () => {
    expect(shouldSearchWeb({ term: '类比推理', question: '', hasKnowledgeHits: true, hasCues: true })).toBe(true);
    expect(shouldSearchWeb({ term: undefined, question: 'Rust 最新版本是多少', hasKnowledgeHits: true, hasCues: true })).toBe(true);
    expect(shouldSearchWeb({ term: undefined, question: '这个库今天发布了吗', hasKnowledgeHits: false, hasCues: false })).toBe(true);
  });
  it('课内有依据且无时新信号 → 不检索', () => {
    expect(shouldSearchWeb({ term: undefined, question: '这章讲的交叉关系再展开讲讲', hasKnowledgeHits: true, hasCues: true })).toBe(false);
    // 概念询问词（是什么/定义…）必检：外部权威定义价值高（SPEC-15 二轮放宽）
    expect(shouldSearchWeb({ term: undefined, question: '交叉关系是什么', hasKnowledgeHits: true, hasCues: true })).toBe(true);
    expect(shouldSearchWeb({ term: undefined, question: '刚才老师说的步骤', hasKnowledgeHits: false, hasCues: true })).toBe(false);
  });
  it('课内完全无依据 → 检索', () => {
    expect(shouldSearchWeb({ term: undefined, question: '考研数学怎么复习', hasKnowledgeHits: false, hasCues: false })).toBe(true);
  });
});

describe('parseTavilyResults', () => {
  it('提取 results[].{title,url,content}；缺 url/content 丢弃；截 400 字', () => {
    const json = {
      results: [
        { title: 'T1', url: 'https://a.com', content: 'C1' },
        { title: '', url: 'https://b.com', content: 'C2' },
        { title: 'T3', content: 'no url' },
        { title: 'T4', url: 'https://d.com', content: 'x'.repeat(500) },
      ],
    };
    const out = parseTavilyResults(json, 5);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ title: 'T1', url: 'https://a.com', snippet: 'C1' });
    expect(out[1]!.title).toBe('https://b.com'); // 无标题回落 url
    expect(out[2]!.snippet.length).toBe(400); // 截断
    expect(parseTavilyResults({}, 5)).toEqual([]);
    expect(parseTavilyResults({ results: 'oops' }, 5)).toEqual([]);
  });
  it('maxResults 上限生效', () => {
    const json = { results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://${i}.com`, content: 'C' })) };
    expect(parseTavilyResults(json, 3)).toHaveLength(3);
  });
});

describe('parseWikipediaResults / buildWikipediaUrl', () => {
  it('提取 query.search[]；去 HTML 标签；url 指向中文维基词条', () => {
    const json = {
      query: {
        search: [
          { title: '类比推理', snippet: '类比推理是<b>推理</b>的一种形式' },
          { title: 'NoSnippet', snippet: '' },
        ],
      },
    };
    const out = parseWikipediaResults(json, 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('类比推理');
    expect(out[0]!.snippet).toBe('类比推理是推理的一种形式'); // 标签已剥
    expect(out[0]!.url).toContain('zh.wikipedia.org/wiki/');
  });
  it('buildWikipediaUrl：含 action=list=search 与 srsearch', () => {
    const url = buildWikipediaUrl('交叉关系');
    expect(url).toContain('action=query');
    expect(url).toContain('list=search');
    expect(url).toContain(`srsearch=${encodeURIComponent('交叉关系')}`);
  });
});
