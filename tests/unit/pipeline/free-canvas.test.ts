/**
 * 自由画布纯函数单测（SPEC-13）：素材构建 / 围栏提取 / 归一 / Zod 校验 / 一次纠错重试。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Section } from '../../../src/types';
import {
  buildCanvasUserPrompt,
  extractFenced,
  generateCanvas,
  MermaidFlowSchema,
  MindmapMarkdownSchema,
  normalizeMermaidCode,
  normalizeMindmapMarkdown,
} from '../../../src/core/pipeline/freeCanvas';

const section = (over: Partial<Section> = {}): Section =>
  ({
    id: 's1',
    startMs: 65_000,
    endMs: 120_000,
    title: '滑动窗口机制',
    summary: '固定窗口保留最近对话',
    bullets: [{ startMs: 70_000, text: '窗口大小固定', approximate: false }],
    terms: ['滑动窗口', 'token'],
    density: 'normal',
    score: 50,
    importance: 3,
    ...over,
  }) as Section;

describe('buildCanvasUserPrompt（素材：不带时间戳）', () => {
  it('含标题/摘要/要点/术语，且不出现任何 mm:ss 时间戳', () => {
    const p = buildCanvasUserPrompt([section()], '上下文管理');
    expect(p).toContain('上下文管理');
    expect(p).toContain('滑动窗口机制');
    expect(p).toContain('窗口大小固定');
    expect(p).toContain('滑动窗口、token');
    expect(p).not.toMatch(/\d{1,2}:\d{2}/);
  });
});

describe('extractFenced', () => {
  it('优先取指定语言围栏，忽略前后废话', () => {
    const c = '好的，如下：\n```mermaid\nflowchart TD\nA-->B\n```\n希望有帮助';
    expect(extractFenced(c, ['mermaid'])).toBe('flowchart TD\nA-->B');
  });
  it('无匹配语言时取第一个围栏；无围栏取原文', () => {
    expect(extractFenced('```\n# 根\n```', ['markdown'])).toBe('# 根');
    expect(extractFenced('  # 根\n## 子 ', ['markdown'])).toBe('# 根\n## 子');
  });
});

describe('normalizeMindmapMarkdown', () => {
  it('丢弃首个标题前的废话；无根时补视频标题', () => {
    expect(normalizeMindmapMarkdown('说明文字\n## 板块A\n### 细节', '课程')).toBe('# 课程\n## 板块A\n### 细节');
  });
  it('多个一级标题：保留第一个为根，其余降级', () => {
    expect(normalizeMindmapMarkdown('# 根\n## A\n# 第二根', 'x')).toBe('# 根\n## A\n## 第二根');
  });
});

describe('normalizeMermaidCode', () => {
  it('去掉 init 指令行', () => {
    expect(normalizeMermaidCode("%%{init: {'theme':'dark'}}%%\nflowchart LR\nA-->B")).toBe('flowchart LR\nA-->B');
  });
});

describe('Schema 校验（红线 4）', () => {
  it('导图：需根 + 分支', () => {
    expect(MindmapMarkdownSchema.safeParse('# 上下文管理核心主题\n## 滑动窗口机制板块').success).toBe(true);
    expect(MindmapMarkdownSchema.safeParse('# 只有一个根节点没有分支内容').success).toBe(false);
  });
  it('流程图：需方向声明 + 连线', () => {
    expect(MermaidFlowSchema.safeParse('flowchart TD\nA[开始]-->B[结束]').success).toBe(true);
    expect(MermaidFlowSchema.safeParse('graph LR\nA-.->B').success).toBe(true);
    expect(MermaidFlowSchema.safeParse('sequenceDiagram\nA->>B: hi').success).toBe(false);
    expect(MermaidFlowSchema.safeParse('flowchart TD\nA[孤立节点很长很长]').success).toBe(false);
  });
});

describe('generateCanvas（单调用 + 一次纠错重试）', () => {
  const base = { systemPrompt: 'sys', userPrompt: 'user', videoTitle: '课程' };

  it('首轮合格直接返回（只调一次模型）', async () => {
    const modelFn = vi.fn(async () => ({ content: '```mermaid\nflowchart TD\nA-->B\n```' }));
    const out = await generateCanvas({ ...base, kind: 'flowchart', modelFn });
    expect(out).toBe('flowchart TD\nA-->B');
    expect(modelFn).toHaveBeenCalledTimes(1);
  });

  it('首轮渲染器校验失败 → 错误回灌重试 → 成功', async () => {
    const modelFn = vi
      .fn()
      .mockResolvedValueOnce({ content: '```mermaid\nflowchart TD\nA(坏]-->B\n```' })
      .mockResolvedValueOnce({ content: '```mermaid\nflowchart TD\nA["好"]-->B\n```' });
    const validate = vi.fn(async (code: string) => {
      if (code.includes('A(坏]')) throw new Error('Parse error on line 2');
    });
    const onRetry = vi.fn();
    const out = await generateCanvas({ ...base, kind: 'flowchart', modelFn, validate, onRetry });
    expect(out).toContain('A["好"]');
    expect(modelFn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith('Parse error on line 2');
    // 重试 prompt 带上了具体错误
    expect(modelFn.mock.calls[1]![0].userPrompt).toContain('Parse error on line 2');
  });

  it('两轮都失败 → throw 可读错误（不无限重试）', async () => {
    const modelFn = vi.fn(async () => ({ content: '我画不出来' }));
    await expect(generateCanvas({ ...base, kind: 'mindmap', modelFn })).rejects.toThrow('已重试 1 次');
    expect(modelFn).toHaveBeenCalledTimes(2);
  });

  it('导图路径：围栏 + 补根后通过校验', async () => {
    const modelFn = vi.fn(async () => ({ content: '```markdown\n## 板块一\n### 细节甲\n## 板块二\n```' }));
    const out = await generateCanvas({ ...base, kind: 'mindmap', modelFn });
    expect(out.startsWith('# 课程')).toBe(true);
  });
});
