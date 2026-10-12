/**
 * SPEC-15 单测：检索路由 + 博查/Wikipedia 解析器。
 */
import { describe, expect, it } from 'vitest';
import { shouldSearchWeb } from '../../../src/panel/explainLoader';
import {
  buildWikipediaUrl,
  parseBochaResults,
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

describe('parseBochaResults（博查响应：data.webPages.value[]，实测形状）', () => {
  it('真实形状 {code,data:{webPages}}：提取 {name,url,snippet,summary}；summary 优先；缺 url/摘要丢弃；截 400 字', () => {
    const json = {
      code: 200,
      data: {
        webPages: {
          value: [
            { name: 'T1', url: 'https://a.com', snippet: 'S1', summary: '摘要优先' },
            { name: '', url: 'https://b.com', snippet: 'S2' },
            { name: 'T3', snippet: 'no url' },
            { name: 'T4', url: 'https://d.com', snippet: 'x'.repeat(500) },
          ],
        },
      },
    };
    const out = parseBochaResults(json, 5);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ title: 'T1', url: 'https://a.com', snippet: '摘要优先' });
    expect(out[1]!.title).toBe('https://b.com'); // 无标题回落 url
    expect(out[2]!.snippet.length).toBe(400); // 截断
    expect(parseBochaResults({}, 5)).toEqual([]);
    expect(parseBochaResults({ data: { webPages: { value: 'oops' } } }, 5)).toEqual([]);
    expect(parseBochaResults({ code: 401, data: {} }, 5)).toEqual([]);
  });
  it('兼容根级 webPages 旧形状', () => {
    const json = { webPages: { value: [{ name: 'T', url: 'https://a.com', snippet: 'S' }] } };
    expect(parseBochaResults(json, 5)).toHaveLength(1);
  });
  it('maxResults 上限生效', () => {
    const json = { data: { webPages: { value: Array.from({ length: 8 }, (_, i) => ({ name: `T${i}`, url: `https://${i}.com`, snippet: 'C' })) } } };
    expect(parseBochaResults(json, 3)).toHaveLength(3);
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
