/**
 * 自由画布纯函数单测（SPEC-13/17）：素材构建 / 围栏提取 / 归一 / Zod 校验 / 一次纠错重试 /
 * 流程图增强（分支断言 / 形状配色注入 / 节点文字锚点匹配）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Section } from '../../../src/types';
import {
  assertHasBranching,
  buildCanvasUserPrompt,
  enhanceFlowchartColors,
  extractFenced,
  generateCanvas,
  matchNodeAnchorMs,
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

describe('MindmapMarkdownSchema 校验（红线 4）', () => {
  it('导图：需根 + 分支', () => {
    expect(MindmapMarkdownSchema.safeParse('# 上下文管理核心主题\n## 滑动窗口机制板块').success).toBe(true);
    expect(MindmapMarkdownSchema.safeParse('# 只有一个根节点没有分支内容').success).toBe(false);
  });
});

describe('assertHasBranching（纯直线链打回）', () => {
  it('有分支/汇合/循环 → 通过', () => {
    expect(() => assertHasBranching('flowchart TD\nA-->B\nA-->C\nB-->D\nC-->D')).not.toThrow();
    expect(() => assertHasBranching('flowchart TD\nA-->B\nB-->C\nC-->A')).not.toThrow(); // 循环
  });
  it('纯直线链 → throw 可读错误（回灌重试）', () => {
    expect(() => assertHasBranching('flowchart TD\nA-->B\nB-->C\nC-->D')).toThrow(/纯直线链/);
  });
});

describe('enhanceFlowchartColors（形状 → 配色确定性注入）', () => {
  it('菱形/胶囊/圆柱各得配色，方框走主题默认；幂等', () => {
    const code = 'flowchart TD\nA(["开始"]) --> B{"超限?"}\nB --> C[("产物")]\nB --> D["步骤"]';
    const out = enhanceFlowchartColors(code);
    expect(out).toContain('classDef mmDecision fill:#fff4e0');
    expect(out).toContain('classDef mmCapsule fill:#e7f5e8');
    expect(out).toContain('classDef mmData fill:#e1f5ee');
    expect(out).toContain('class B mmDecision');
    expect(out).toContain('class A mmCapsule');
    expect(out).toContain('class C mmData');
    expect(out).not.toContain('class D mm'); // 方框走主题默认色
    // 幂等：再次注入不重复
    expect(enhanceFlowchartColors(out)).toBe(out);
  });

  it('纯方框图 → 原样返回（无 classDef）', () => {
    const code = 'flowchart TD\nA["a"] --> B["b"]';
    expect(enhanceFlowchartColors(code)).toBe(code);
  });
});

describe('matchNodeAnchorMs（节点文字 → 章节锚点）', () => {
  const sections = [
    section({ id: 's1', startMs: 65_000, title: '滑动窗口机制', terms: ['滑动窗口', 'token'], summary: '固定窗口保留最近对话' }),
    section({ id: 's2', startMs: 180_000, title: '上下文压缩策略', terms: ['压缩', '摘要'], summary: '把历史对话压缩成摘要' }),
  ];

  it('节点含章节标题 → 命中该章起点', () => {
    expect(matchNodeAnchorMs('滑动窗口机制：窗口大小固定', sections)).toBe(65_000);
  });

  it('节点含章节术语/摘要词 → 命中对应章节', () => {
    expect(matchNodeAnchorMs('对话压缩成摘要节省 token', sections)).toBe(180_000);
  });

  it('完全不相关文字 → null（宁可不跳不错跳）', () => {
    expect(matchNodeAnchorMs('洗碗机的喷淋臂数量', sections)).toBeNull();
  });
});

describe('generateCanvas（单调用 + 一次纠错重试）', () => {
  const base = { systemPrompt: 'sys', userPrompt: 'user', videoTitle: '课程' };

  it('流程图：首轮合格（含分支）直接返回 + 配色注入（只调一次模型）', async () => {
    const modelFn = vi.fn(async () => ({
      content: '```mermaid\nflowchart TD\nA(["开始"]) --> B{"超限?"}\nB --> C["继续"]\nB --> D["告警"]\n```',
    }));
    const out = await generateCanvas({ ...base, kind: 'flowchart', modelFn });
    expect(out).toContain('flowchart TD');
    expect(out).toContain('classDef mmDecision'); // 配色已注入
    expect(modelFn).toHaveBeenCalledTimes(1);
  });

  it('首轮纯直线链 → 打回重试 → 分支版成功', async () => {
    const modelFn = vi
      .fn()
      .mockResolvedValueOnce({ content: '```mermaid\nflowchart TD\nA-->B\nB-->C\nC-->D\n```' })
      .mockResolvedValueOnce({ content: '```mermaid\nflowchart TD\nA-->B\nA-->C\nB-->D\n```' });
    const onRetry = vi.fn();
    const out = await generateCanvas({ ...base, kind: 'flowchart', modelFn, onRetry });
    expect(out).toContain('A-->C');
    expect(modelFn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalled();
    // 重试 prompt 带上了"纯直线链"错误
    expect(modelFn.mock.calls[1]![0].userPrompt).toContain('纯直线链');
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
