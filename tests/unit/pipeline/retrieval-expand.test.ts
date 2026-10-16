/**
 * SPEC-17 检索兜底扩展（query expansion）：
 * 触发矩阵 / 概念清单预算 / 检索词合并 / 管线解析（红线 4）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildConceptList,
  EXPAND,
  mergeQueryTerms,
  needsQueryExpansion,
  searchIndex,
  type KnowledgeHit,
} from '../../../src/core/knowledge/retriever';
import type { KnowledgeIndexEntry, KnowledgeIndexFile } from '../../../src/types';
import { expandQueryForRetrieval } from '../../../src/core/pipeline/explain';

const base = {
  tags: ['ai'],
  summaryPreview: '预览',
  updatedAt: '2026-10-16T00:00:00Z',
};
const entry = (title: string, domain = '公考_判断推理'): KnowledgeIndexEntry => ({
  ...base,
  path: `概念/${title}.md`,
  title,
  category: 'concept',
  terms: [title],
  domain,
});

describe('buildConceptList（渐进式披露：名称层 + 预算）', () => {
  it('预算内返回 概念名（领域） 清单文本', () => {
    const list = buildConceptList([
      entry('插空法'),
      entry('捆绑法'),
      { ...base, path: '笔记/x/a.md', title: '视频笔记标题', category: 'video-note', terms: ['x'], domain: '公考_判断推理' },
    ]);
    expect(list).toContain('- 插空法（公考_判断推理）');
    expect(list).not.toContain('视频笔记标题'); // video-note 不进清单
  });

  it('超预算返回 null（调用方退化为纯改写）；空清单返回 null', () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`概念${i}`));
    expect(buildConceptList(many)).toBeNull();
    expect(buildConceptList([])).toBeNull();
  });
});

describe('needsQueryExpansion（触发矩阵）', () => {
  const hit = (score: number): KnowledgeHit => ({
    score,
    entry: entry('排除法'),
  });

  it('零命中 → 触发（有无清单都触发）', () => {
    expect(needsQueryExpansion({ hits: [], conceptList: '- 插空法' })).toBe(true);
    expect(needsQueryExpansion({ hits: [], conceptList: null })).toBe(true);
  });

  it('低分命中 → 仅清单在预算内才触发（纯改写对低分无效）', () => {
    const low = [hit(0.2)];
    expect(needsQueryExpansion({ hits: low, conceptList: '- 插空法' })).toBe(true);
    expect(needsQueryExpansion({ hits: low, conceptList: null })).toBe(false);
  });

  it('高分命中 → 不触发', () => {
    expect(needsQueryExpansion({ hits: [hit(EXPAND.lowScoreThreshold)], conceptList: '- 插空法' })).toBe(false);
    expect(needsQueryExpansion({ hits: [hit(0.8)], conceptList: null })).toBe(false);
  });
});

describe('mergeQueryTerms', () => {
  it('原词 + 扩展词去重；扩展词截断到上限', () => {
    expect(mergeQueryTerms(['插空法'], ['插空法', '捆绑法'])).toEqual(['插空法', '捆绑法']);
    const many = Array.from({ length: 20 }, (_, i) => `词${i}`);
    expect(mergeQueryTerms([], many).length).toBeLessThanOrEqual(EXPAND.maxTerms);
  });
});

describe('expandQueryForRetrieval（管线，红线 4）', () => {
  const okModel = async () => ({ content: JSON.stringify({ concepts: ['选项择优', '排除错误选项'] }) });

  it('附带清单时 userPrompt 含清单原文；解析出概念词', async () => {
    let seenPrompt = '';
    const spyModel = async (req: { systemPrompt: string; userPrompt: string }) => {
      seenPrompt = req.userPrompt;
      return { content: JSON.stringify({ concepts: ['插空法'] }) };
    };
    const out = await expandQueryForRetrieval({
      question: '怎么排除不对的选项',
      conceptList: '- 插空法（公考_数量关系）',
      modelFn: spyModel,
    });
    expect(seenPrompt).toContain('- 插空法（公考_数量关系）');
    expect(out).toEqual(['插空法']);
  });

  it('纯改写模式（conceptList=null）不附清单', async () => {
    let seenPrompt = '';
    const spyModel = async (req: { userPrompt: string }) => {
      seenPrompt = req.userPrompt;
      return { content: JSON.stringify({ concepts: ['排除法'] }) };
    };
    await expandQueryForRetrieval({ question: 'Q', conceptList: null, modelFn: spyModel });
    expect(seenPrompt).not.toContain('知识库概念清单');
  });

  it('非法输出 throw（调用方降级）；空数组合法', async () => {
    const bad = async () => ({ content: 'not json' });
    await expect(
      expandQueryForRetrieval({ question: 'Q', conceptList: null, modelFn: bad }),
    ).rejects.toThrow();
    const empty = await expandQueryForRetrieval({ question: 'Q', conceptList: null, modelFn: okModel })
      .catch(() => null);
    expect(empty).not.toBeNull();
  });
});

describe('端到端语义：零命中 → 扩展词 → 二次匹配命中', () => {
  it('同义改写场景（库有 选项择优，问题说 排除错误选项）', () => {
    const index: KnowledgeIndexFile = {
      version: 1,
      entries: [entry('选项择优'), entry('主体')],
    };
    // 一次检索（问题原词）零命中
    const first = needsQueryExpansion({ hits: [], conceptList: buildConceptList(index.entries) });
    expect(first).toBe(true);
    // 模拟 LLM 从清单选中 选项择优 → 合并 → 二次机械匹配命中
    const merged = mergeQueryTerms(['怎么排除错误选项'], ['选项择优']);
    const second = searchIndex({ index, queryTerms: merged });
    expect(second.length).toBeGreaterThan(0);
    expect(second[0].entry.title).toBe('选项择优');
  });
});
