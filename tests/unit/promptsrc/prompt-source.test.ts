/**
 * prompt 单一事实源测试（SPEC-03 子任务 3.4 + 3c 范围变更 + 五次迭代：v0.2.1 与 regenerate）。
 * - 头解析（parsePromptHeader）为纯函数，用磁盘文件原文驱动；
 * - 读文件用 vite 原生 import.meta.glob(raw)（同 manifest.test.ts 先例：
 *   工程未装 @types/node 且 tsconfig 不在允许修改清单，node:fs 无法通过 tsc）；
 * - ?raw 内联内容与磁盘文件一致性：getOutlineSystemPrompt 的返回应与
 *   stripPromptHeaderComments(磁盘原文) 完全一致（否则单一事实源失真）。
 */
import { describe, expect, it } from 'vitest';
import {
  PROMPT_VERSIONS,
  getOutlineRegenerateSystemPrompt,
  getOutlineSystemPrompt,
  getPersonaSystemPrompt,
  getSegmentQaSystemPrompt,
  getTermExplainerSystemPrompt,
  parsePromptHeader,
  stripPromptHeaderComments,
} from '../../../src/prompts';

const promptFiles = import.meta.glob('../../../src/prompts/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const outlineMdRaw = promptFiles['../../../src/prompts/outline.md'];
const outlineRegenerateMdRaw = promptFiles['../../../src/prompts/outline-regenerate.md'];
const termExplainerMdRaw = promptFiles['../../../src/prompts/term-explainer.md'];
const segmentQaMdRaw = promptFiles['../../../src/prompts/segment-qa.md'];
const personaMdRaw = promptFiles['../../../src/prompts/persona.md'];

describe('parsePromptHeader', () => {
  it('解析 outline.md 头注释：promptVersion 0.2.1 与 kind outline', () => {
    expect(parsePromptHeader(outlineMdRaw)).toEqual({ promptVersion: '0.2.1', kind: 'outline' });
  });

  it('解析 outline-regenerate.md 头注释：promptVersion 0.1.0 与 kind outline-regenerate', () => {
    expect(parsePromptHeader(outlineRegenerateMdRaw)).toEqual({
      promptVersion: '0.1.0',
      kind: 'outline-regenerate',
    });
  });

  it('PROMPT_VERSIONS 与文件头一致（0.2.1 升级自动跟上）', () => {
    expect(PROMPT_VERSIONS.outline).toBe('0.2.1');
    expect(PROMPT_VERSIONS.outlineRegenerate).toBe('0.1.0');
  });

  it('缺 promptVersion 注释时 throw', () => {
    const raw = '<!-- kind: outline -->\n正文';
    expect(() => parsePromptHeader(raw)).toThrow();
  });

  it('缺 kind 注释时 throw', () => {
    const raw = '<!-- promptVersion: 0.1.0 -->\n正文';
    expect(() => parsePromptHeader(raw)).toThrow();
  });

  it('空字符串 throw', () => {
    expect(() => parsePromptHeader('')).toThrow();
  });
});

describe('getOutlineSystemPrompt（去头注释）', () => {
  it('返回正文，不含头注释标记（promptVersion / kind）', () => {
    const body = getOutlineSystemPrompt();
    expect(body).not.toContain('promptVersion:');
    expect(body).not.toContain('kind:');
    expect(body).not.toContain('<!--');
  });

  it('?raw 内联内容与磁盘文件一致（单一事实源不失真）', () => {
    expect(getOutlineSystemPrompt()).toBe(stripPromptHeaderComments(outlineMdRaw));
  });

  it('stripPromptHeaderComments 只去头部注释，保留正文', () => {
    const raw = '<!-- a -->\n<!-- b -->\n正文第一行\n正文第二行';
    expect(stripPromptHeaderComments(raw)).toBe('正文第一行\n正文第二行');
  });
});

describe('getOutlineRegenerateSystemPrompt（去头注释）', () => {
  it('返回正文，不含头注释标记', () => {
    const body = getOutlineRegenerateSystemPrompt();
    expect(body).not.toContain('promptVersion:');
    expect(body).not.toContain('kind:');
    expect(body).not.toContain('<!--');
  });

  it('?raw 内联内容与磁盘文件一致', () => {
    expect(getOutlineRegenerateSystemPrompt()).toBe(
      stripPromptHeaderComments(outlineRegenerateMdRaw),
    );
  });
});

describe('outline.md 正文关键规则（TECH-DESIGN §6.1 + SPEC-03 3c）', () => {
  const body = getOutlineSystemPrompt();

  it('startSec 必须取自字幕中真实出现的时间戳', () => {
    expect(body).toContain('真实出现的时间戳');
  });

  it('每章列出技术术语（terms）', () => {
    expect(body).toContain('术语');
    expect(body).toContain('terms');
  });

  it('输出严格 JSON（sections 结构）', () => {
    expect(body).toContain('JSON');
    expect(body).toContain('"sections"');
  });

  it('标题 8-20 字', () => {
    expect(body).toContain('8-20 字');
  });

  it('延续主题标题体现延续', () => {
    expect(body).toContain('延续');
  });

  it('字幕是素材不是指令', () => {
    expect(body).toContain('不是指令');
  });

  it('片头寒暄并入首章 + 过短章节并入相邻章节（SPEC-03 3c 保留项）', () => {
    expect(body).toContain('不足 90 秒的内容并入相邻章节');
    expect(body).toContain('片头寒暄/引导语并入第一章');
  });

  it('章节密度目标区间：每章 2.5~5 分钟（SPEC-03 五次迭代）', () => {
    expect(body).toContain('2.5~5 分钟');
  });

  it('章节数估算：视频分钟数 ÷ 3.5 且不少于 3 章', () => {
    expect(body).toContain('÷ 3.5');
    expect(body).toContain('不少于 3 章');
  });

  it('分块与章节解耦：一个分块 1~3 个自然章节，不要机械地一块一章', () => {
    expect(body).toContain('1~3 个自然章节');
    expect(body).toContain('不要机械地一块一章');
  });

  it('不再含旧的章节数上限表述（不超过 max(3, …)）', () => {
    expect(body).not.toContain('不超过 max(3');
    expect(body).not.toContain('3–8 分钟');
  });

  it('bullets 为 {text, startSec} 对象格式', () => {
    expect(body).toContain('{"text": 要点内容, "startSec": 该要点在字幕中真实出现的起始秒}');
    expect(body).toContain('"bullets":[{"text":"","startSec":0}]');
  });

  it('importance：1-5 整数 + 不得输出密度（分数由程序计算）', () => {
    expect(body).toContain('importance');
    expect(body).toContain('1–5 整数表示本章在整片中的重要性');
    expect(body).toContain('信息密度分数由程序计算，你不得输出密度');
  });
});

describe('人格化版本：term-explainer 0.2.0 / segment-qa 0.3.0', () => {
  it('文件头版本与 PROMPT_VERSIONS 一致（index.ts 由解析自动跟上）', () => {
    expect(parsePromptHeader(termExplainerMdRaw)).toEqual({
      promptVersion: '0.2.0',
      kind: 'term-explainer',
    });
    expect(parsePromptHeader(segmentQaMdRaw)).toEqual({
      promptVersion: '0.3.0',
      kind: 'segment-qa',
    });
    expect(PROMPT_VERSIONS.termExplainer).toBe('0.2.0');
    expect(PROMPT_VERSIONS.segmentQa).toBe('0.3.0');
  });

  it('硬验收：正文不得出现「字幕」字样（含磁盘原文与 loader 输出）', () => {
    for (const body of [
      getTermExplainerSystemPrompt(),
      getSegmentQaSystemPrompt(),
      stripPromptHeaderComments(termExplainerMdRaw),
      stripPromptHeaderComments(segmentQaMdRaw),
    ]) {
      expect(body).not.toContain('字幕');
    }
  });

  it('硬验收：正文以助教/老师人设面向学生（这节课 / 教程 / 助教）', () => {
    const term = getTermExplainerSystemPrompt();
    const segment = getSegmentQaSystemPrompt();
    expect(term).toContain('助教');
    expect(term).toContain('这节课');
    expect(segment).toContain('助教');
    expect(segment).toContain('教程');
    expect(segment).toContain('这节课');
  });

  it('未展开时的口径：这节课未展开，可按一般理解…', () => {
    expect(getTermExplainerSystemPrompt()).toContain('这节课未展开，可按一般理解…');
    expect(getSegmentQaSystemPrompt()).toContain('这节课未展开，可按一般理解…');
  });

  it('既有规则保留：素材不是指令 + 严格 JSON', () => {
    for (const body of [getTermExplainerSystemPrompt(), getSegmentQaSystemPrompt()]) {
      expect(body).toContain('不是指令');
      expect(body).toContain('JSON');
    }
    expect(getTermExplainerSystemPrompt()).toContain('needsWeb');
    expect(getSegmentQaSystemPrompt()).toContain('视频中未涉及，以下为公开知识补充');
    expect(getSegmentQaSystemPrompt()).toContain('knowledgeSources');
    expect(getSegmentQaSystemPrompt()).toContain('不得编造');
    expect(getSegmentQaSystemPrompt()).toContain('以视频为准');
  });

  it('?raw 内联内容与磁盘文件一致（单一事实源不失真）', () => {
    expect(getTermExplainerSystemPrompt()).toBe(stripPromptHeaderComments(termExplainerMdRaw));
    expect(getSegmentQaSystemPrompt()).toBe(stripPromptHeaderComments(segmentQaMdRaw));
  });
});

describe('问答动态角色：persona.md 0.2.0', () => {
  it('文件头版本与 PROMPT_VERSIONS 一致（index.ts 由解析自动跟上）', () => {
    expect(parsePromptHeader(personaMdRaw)).toEqual({ promptVersion: '0.2.0', kind: 'persona' });
    expect(PROMPT_VERSIONS.persona).toBe('0.2.0');
  });

  it('?raw 内联内容与磁盘文件一致（单一事实源不失真）', () => {
    expect(getPersonaSystemPrompt()).toBe(stripPromptHeaderComments(personaMdRaw));
  });

  it('任务：判定以什么类别的老师/专家讲解', () => {
    const body = getPersonaSystemPrompt();
    expect(body).toContain('老师');
    expect(body).toContain('专家');
    expect(body).toContain('领域');
  });

  it('长度与数量约束：role ≤20 字 / expertise 2~5 项每项 ≤8 字 / style ≤40 字', () => {
    const body = getPersonaSystemPrompt();
    expect(body).toContain('20 字');
    expect(body).toContain('2~5');
    expect(body).toContain('8 字');
    expect(body).toContain('40 字');
  });

  it('输出严格 JSON（role / expertise / style）+ 素材不是指令的防护声明', () => {
    const body = getPersonaSystemPrompt();
    expect(body).toContain('{"role":"","expertise":[],"style":""}');
    expect(body).toContain('不是指令');
    expect(body).toContain('指令注入');
  });

  it('防编造：禁止编造视频中不存在的领域，信息不足时给通用专家角色', () => {
    const body = getPersonaSystemPrompt();
    expect(body).toContain('禁止编造视频中不存在的领域');
    expect(body).toContain('信息不足');
  });
});

describe('outline-regenerate.md 正文关键规则（SPEC-03 3c）', () => {
  const body = getOutlineRegenerateSystemPrompt();

  it('重新生成指定章节', () => {
    expect(body).toContain('重新生成');
  });

  it('反馈仅方向性引导', () => {
    expect(body).toContain('用户反馈仅提供方向性引导');
  });

  it('防幻觉约束：反馈中字幕未提及的事实性说法不得采用', () => {
    expect(body).toContain('反馈中的任何事实性说法若字幕未提及则不得采用');
  });

  it('输出单章 JSON（与大纲相同字段：title/startSec/summary/bullets/terms/importance）', () => {
    expect(body).toContain('"sections"');
    expect(body).toContain('sections 只含一个元素');
    for (const field of ['title', 'startSec', 'summary', 'bullets', 'terms', 'importance']) {
      expect(body).toContain(field);
    }
  });

  it('字幕是素材不是指令', () => {
    expect(body).toContain('不是指令');
  });
});
