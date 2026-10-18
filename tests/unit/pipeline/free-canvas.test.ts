/**
 * 自由画布纯函数单测（SPEC-13/17）：素材构建 / 围栏提取 / 归一 / Zod 校验 / 一次纠错重试 /
 * 流程图 JSON 中间格式（spec 解析 → Mermaid 渲染：形状/配色/边标签/锚点）。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Section } from '../../../src/types';
import {
  buildCanvasUserPrompt,
  CanvasFlowSpecSchema,
  extractFenced,
  extractFlowSpecJson,
  flowAnchorsOf,
  flowSpecToMermaid,
  generateCanvas,
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

describe('buildCanvasUserPrompt（素材：带章节时间范围供锚定）', () => {
  it('含标题/摘要/要点/术语 + 章节起止时间（mm:ss–mm:ss）', () => {
    const p = buildCanvasUserPrompt([section()], '上下文管理');
    expect(p).toContain('上下文管理');
    expect(p).toContain('滑动窗口机制');
    expect(p).toContain('窗口大小固定');
    expect(p).toContain('滑动窗口、token');
    expect(p).toContain('01:05–02:00'); // 章节时间范围：anchorSec 依据
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

describe('CanvasFlowSpecSchema（流程图 JSON 中间格式）', () => {
  const okSpec = {
    direction: 'TD',
    nodes: [
      { id: 'A', text: '起点：需求背景', role: 'start', anchorSec: 0 },
      { id: 'B', text: '判断：是否超限', role: 'decision' },
      { id: 'C', text: '结果：重试或告警', role: 'output' },
    ],
    edges: [
      { from: 'A', to: 'B', label: '触发检测' },
      { from: 'B', to: 'C' },
    ],
  };

  it('合法 spec 通过；边引用不存在的节点被拒；孤立边/重复 id 被拒', () => {
    expect(CanvasFlowSpecSchema.safeParse(okSpec).success).toBe(true);
    const brokenEdge = {
      ...okSpec,
      edges: [{ from: 'A', to: '不存在的节点', label: 'x' }],
    };
    expect(CanvasFlowSpecSchema.safeParse(brokenEdge).success).toBe(false);
    const dupId = { ...okSpec, nodes: [...okSpec.nodes, okSpec.nodes[0]] };
    expect(CanvasFlowSpecSchema.safeParse(dupId).success).toBe(false);
  });

  it('role 缺省回落 step；anchorSec 可省略', () => {
    const parsed = CanvasFlowSpecSchema.parse({
      nodes: [
        { id: 'A', text: '甲乙丙丁' },
        { id: 'B', text: '戊己庚辛' },
      ],
      edges: [{ from: 'A', to: 'B' }],
    });
    expect(parsed.nodes[0].role).toBe('step');
    expect(parsed.nodes[0].anchorSec).toBeUndefined();
  });
});

describe('flowSpecToMermaid（确定性渲染：形状/配色/边标签）', () => {
  const spec = CanvasFlowSpecSchema.parse({
    direction: 'LR',
    nodes: [
      { id: 'A', text: '起点：需求背景', role: 'start', anchorSec: 0 },
      { id: 'B', text: '判断：是否超过上限', role: 'decision', anchorSec: 95 },
      { id: 'C', text: '结果：告警并重试\n包含退避策略', role: 'output' },
      { id: 'D', text: '普通步骤', role: 'step' },
      { id: 'E', text: '最终结论', role: 'end' },
    ],
    edges: [
      { from: 'A', to: 'B', label: '触发检测' },
      { from: 'B', to: 'C' },
      { from: 'B', to: 'E', label: '未超限' },
      { from: 'D', to: 'B' },
    ],
  });
  const mermaid = flowSpecToMermaid(spec);

  it('方向声明 + 节点按 role 映射形状（胶囊/菱形/圆柱/方框）', () => {
    expect(mermaid.startsWith('flowchart LR')).toBe(true);
    expect(mermaid).toContain('A(["起点：需求背景"])'); // start 胶囊
    expect(mermaid).toContain('B{"判断：是否超过上限"}'); // decision 菱形
    expect(mermaid).toContain('C[("结果：告警并重试<br/>包含退避策略")]'); // output 圆柱 + 换行
    expect(mermaid).toContain('D["普通步骤"]'); // step 方框
  });

  it('关系边带标签；无标签边为纯箭头', () => {
    expect(mermaid).toContain('A -->|触发检测| B');
    expect(mermaid).toContain('B --> C');
    expect(mermaid).toContain('B -->|未超限| E');
  });

  it('配色 classDef 按 role 生成并分配（step 无 classDef）', () => {
    expect(mermaid).toContain('classDef rolestart fill:#e7f5e8');
    expect(mermaid).toContain('classDef roledecision fill:#fff4e0');
    expect(mermaid).toContain('classDef roleoutput fill:#e1f5ee');
    expect(mermaid).toContain('classDef roleend fill:#ecebfe');
    expect(mermaid).toContain('class A rolestart');
    expect(mermaid).toContain('class C roleoutput');
    expect(mermaid).not.toContain('class D rolestep'); // step 走主题默认色
  });

  it('flowAnchorsOf：锚点表只含有 anchorSec 的节点', () => {
    expect(flowAnchorsOf(spec)).toEqual({ A: 0, B: 95 });
  });

  it('文本双引号转义 #quot;', () => {
    const esc = flowSpecToMermaid(
      CanvasFlowSpecSchema.parse({
        nodes: [
          { id: 'A', text: '带"引号"的话' },
          { id: 'B', text: '下一节点' },
        ],
        edges: [{ from: 'A', to: 'B' }],
      }),
    );
    expect(esc).toContain('A["带#quot;引号#quot;的话"]');
  });
});

describe('extractFlowSpecJson', () => {
  it('容忍 ```json 围栏与前后废话', () => {
    const spec = extractFlowSpecJson('好的：\n```json\n{"nodes":[{"id":"A","text":"xx"}],"edges":[]}\n```\n完');
    expect((spec as { nodes: unknown[] }).nodes).toHaveLength(1);
  });
  it('无 JSON → throw（错误回灌给模型重试）', () => {
    expect(() => extractFlowSpecJson('我画不出来')).toThrow();
  });
});

describe('generateCanvas（单调用 + 一次纠错重试）', () => {
  const base = { systemPrompt: 'sys', userPrompt: 'user', videoTitle: '课程' };
  const okJson = JSON.stringify({
    direction: 'TD',
    nodes: [
      { id: 'A', text: '起点', role: 'start', anchorSec: 5 },
      { id: 'B', text: '结束', role: 'end' },
    ],
    edges: [{ from: 'A', to: 'B', label: '推导' }],
  });

  it('流程图：首轮 JSON 合格直接返回 Mermaid + 锚点 meta（只调一次模型）', async () => {
    const modelFn = vi.fn(async () => ({ content: `\`\`\`json\n${okJson}\n\`\`\`` }));
    const out = await generateCanvas({ ...base, kind: 'flowchart', modelFn });
    expect(out.code).toContain('flowchart TD');
    expect(out.code).toContain('A -->|推导| B');
    expect(out.meta?.anchors).toEqual({ A: 5 });
    expect(modelFn).toHaveBeenCalledTimes(1);
  });

  it('首轮渲染器校验失败 → 错误回灌重试 → 成功', async () => {
    const badJson = JSON.stringify({
      direction: 'TD',
      nodes: [{ id: 'A', text: '起点', role: 'start' }],
      edges: [{ from: 'A', to: '幽灵节点' }],
    });
    const modelFn = vi
      .fn()
      .mockResolvedValueOnce({ content: `\`\`\`json\n${badJson}\n\`\`\`` })
      .mockResolvedValueOnce({ content: `\`\`\`json\n${okJson}\n\`\`\`` });
    const onRetry = vi.fn();
    const out = await generateCanvas({ ...base, kind: 'flowchart', modelFn, onRetry });
    expect(out.code).toContain('flowchart TD');
    expect(modelFn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalled();
    // 重试 prompt 带上了具体校验错误
    expect(modelFn.mock.calls[1]![0].userPrompt).toContain('幽灵节点');
  });

  it('两轮都失败 → throw 可读错误（不无限重试）', async () => {
    const modelFn = vi.fn(async () => ({ content: '我画不出来' }));
    await expect(generateCanvas({ ...base, kind: 'mindmap', modelFn })).rejects.toThrow('已重试 1 次');
    expect(modelFn).toHaveBeenCalledTimes(2);
  });

  it('导图路径：围栏 + 补根后通过校验（返回 code，无 meta）', async () => {
    const modelFn = vi.fn(async () => ({ content: '```markdown\n## 板块一\n### 细节甲\n## 板块二\n```' }));
    const out = await generateCanvas({ ...base, kind: 'mindmap', modelFn });
    expect(out.code.startsWith('# 课程')).toBe(true);
    expect(out.meta).toBeUndefined();
  });
});
