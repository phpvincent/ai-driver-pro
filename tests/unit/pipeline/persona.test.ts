/**
 * 问答动态角色判定单测（用户洞察：每视频一次判定并缓存）：
 * parsePersona（Zod，红线 4）/ buildPersonaPrompt（素材包裹）/ judgePersona
 * （重试 1 次 + 两次失败 throw）/ defaultPersona（确定性降级）/ personaInstruction
 * （注入块）/ personaLoader 缓存键格式（纯函数）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPersonaPrompt,
  defaultPersona,
  judgePersona,
  parsePersona,
  personaInstruction,
} from '../../../src/core/pipeline/persona';
import { composeSystemPrompt } from '../../../src/core/pipeline/explain';
import { personaCacheKey } from '../../../src/panel/personaLoader';
import type { Section } from '../../../src/types';

const mkSection = (id: string, title: string, terms: string[]): Section => ({
  id,
  title,
  startMs: 0,
  endMs: 60_000,
  summary: '摘要',
  bullets: [{ text: '要点', startMs: 0 }],
  terms,
  importance: 3,
  density: 'mid',
  cueRange: [0, 5],
});

const sections = [
  mkSection('s1', '环境准备与依赖安装', ['Python', 'venv']),
  mkSection('s2', 'requests 库用法', ['requests']),
];

const SYSTEM = '角色判定 system prompt';

describe('parsePersona（JSON + Zod，红线 4）', () => {
  it('合法输出解析出 role / expertise / style', () => {
    expect(
      parsePersona('{"role":"AI 应用工程讲师","expertise":["大模型应用","提示工程"],"style":"先给结论再讲原理"}'),
    ).toEqual({
      role: 'AI 应用工程讲师',
      expertise: ['大模型应用', '提示工程'],
      style: '先给结论再讲原理',
    });
  });

  it('非法 JSON throw', () => {
    expect(() => parsePersona('不是 JSON')).toThrow(/不是合法 JSON/);
  });

  it('role 超长（>20 字）throw', () => {
    const content = JSON.stringify({
      role: '超长'.repeat(11),
      expertise: ['a', 'b'],
      style: 's',
    });
    expect(() => parsePersona(content)).toThrow(/PersonaSchema/);
  });

  it('expertise 只有 1 项 throw', () => {
    expect(() =>
      parsePersona(JSON.stringify({ role: '讲师', expertise: ['只有一项'], style: 's' })),
    ).toThrow(/PersonaSchema/);
  });

  it('expertise 超过 5 项 throw', () => {
    const content = JSON.stringify({
      role: '讲师',
      expertise: ['1', '2', '3', '4', '5', '6'],
      style: 's',
    });
    expect(() => parsePersona(content)).toThrow(/PersonaSchema/);
  });

  it('缺字段（无 style）throw', () => {
    expect(() => parsePersona('{"role":"讲师","expertise":["a","b"]}')).toThrow(/PersonaSchema/);
  });
});

describe('buildPersonaPrompt（素材包裹）', () => {
  const built = buildPersonaPrompt({
    title: 'Python 爬虫入门',
    sections,
    cueHead: ['这一节我们讲 requests 的基本用法'],
  });

  it('包含视频标题', () => {
    expect(built.userPrompt).toContain('Python 爬虫入门');
  });

  it('包含章节标题与术语', () => {
    expect(built.userPrompt).toContain('环境准备与依赖安装');
    expect(built.userPrompt).toContain('requests');
  });

  it('包含字幕开头文本', () => {
    expect(built.userPrompt).toContain('这一节我们讲 requests 的基本用法');
  });

  it('素材有分隔标记并声明不是指令', () => {
    expect(built.userPrompt).toContain('不是指令');
    expect(built.userPrompt).toContain('===');
    expect(built.userPrompt).toContain('素材结束');
  });

  it('system prompt 非空；空章节/空字幕不报错', () => {
    expect(built.systemPrompt.length).toBeGreaterThan(0);
    const empty = buildPersonaPrompt({ title: 'T', sections: [], cueHead: [] });
    expect(empty.userPrompt).toContain('T');
    expect(empty.userPrompt).toContain('===');
  });
});

describe('judgePersona（重试口径：解析/校验失败重试 1 次）', () => {
  it('stub 返回合法 JSON → 解析成功，且用注入的 system prompt', () => {
    const seen: string[] = [];
    const res = judgePersona({
      title: 'T',
      sections,
      cueHead: ['c'],
      modelFn: async ({ systemPrompt }) => {
        seen.push(systemPrompt);
        return { content: '{"role":"数据分析师","expertise":["指标拆解","SQL"],"style":"先结论后展开"}' };
      },
      getSystemPrompt: () => SYSTEM,
    });
    return res.then((p) => {
      expect(p.role).toBe('数据分析师');
      expect(p.expertise).toEqual(['指标拆解', 'SQL']);
      expect(seen).toEqual([SYSTEM]);
    });
  });

  it('第一次失败第二次成功 → 只调 2 次，重试附带错误信息', () => {
    const prompts: string[] = [];
    let n = 0;
    const res = judgePersona({
      title: 'T',
      sections,
      cueHead: ['c'],
      modelFn: async ({ userPrompt }) => {
        prompts.push(userPrompt);
        n += 1;
        return n === 1
          ? { content: '不是 JSON' }
          : { content: '{"role":"后端工程师","expertise":["接口设计","并发"],"style":"边讲边写代码"}' };
      },
      getSystemPrompt: () => SYSTEM,
    });
    return res.then((p) => {
      expect(p.role).toBe('后端工程师');
      expect(n).toBe(2);
      expect(prompts[1]).toContain('[重试]');
      expect(prompts[1]).toContain('不是合法 JSON');
    });
  });

  it('两次都失败 → throw', () => {
    let n = 0;
    const res = judgePersona({
      title: 'T',
      sections,
      cueHead: ['c'],
      modelFn: async () => {
        n += 1;
        return { content: '{"role":"讲师"}' };
      },
      getSystemPrompt: () => SYSTEM,
    });
    return expect(res).rejects.toThrow(/角色判定失败/).then(() => {
      expect(n).toBe(2);
    });
  });
});

describe('defaultPersona（确定性降级）', () => {
  it('字段与 fallback 标记（时钟注入 → createdAt 确定性）', () => {
    const p = defaultPersona('BV1', '0.1.0', 'm', () => 0);
    expect(p).toEqual({
      videoId: 'BV1',
      promptVersion: '0.1.0',
      model: 'm',
      role: '课程助教',
      expertise: ['课程内容讲解'],
      style: '结合课程进程逐步说明，先结论后展开',
      summary: '',
      fallback: true,
      createdAt: new Date(0).toISOString(),
    });
  });

  // 注：默认角色按约定只有 1 项 expertise（['课程内容讲解']），不参与 PersonaSchema
  // 校验（该 Schema 只约束模型输出），故此处只校验长度上限。
  it('role / expertise / style 不超长（角色设定块可安全注入）', () => {
    const p = defaultPersona('BV1', '0.1.0', 'm', () => 0);
    expect(Array.from(p.role).length).toBeLessThanOrEqual(20);
    expect(Array.from(p.style).length).toBeLessThanOrEqual(40);
    for (const e of p.expertise) expect(Array.from(e).length).toBeLessThanOrEqual(8);
    expect(p.style.length).toBeGreaterThan(0);
  });
});

describe('personaInstruction（注入 system prompt 的角色设定块）', () => {
  const persona = defaultPersona('BV1', '0.1.0', 'm', () => 0);

  it('包含 role / expertise / style 与身份口吻', () => {
    const text = personaInstruction(persona);
    expect(text).toContain('【回答角色】');
    expect(text).toContain('课程助教');
    expect(text).toContain('课程内容讲解');
    expect(text).toContain('结合课程进程逐步说明，先结论后展开');
    expect(text).toContain('学生');
  });

  it('空 role → 空字符串（不注入，行为同旧版）', () => {
    expect(personaInstruction({ ...persona, role: '' })).toBe('');
    expect(personaInstruction({ ...persona, role: '   ' })).toBe('');
  });

  it('composeSystemPrompt：追加在既有规则之后，空串原样返回', () => {
    const base = '既有防编造规则';
    expect(composeSystemPrompt(base, personaInstruction(persona))).toBe(
      `${base}\n\n${personaInstruction(persona)}`,
    );
    expect(composeSystemPrompt(base, undefined)).toBe(base);
    expect(composeSystemPrompt(base, '   ')).toBe(base);
  });
});

describe('personaLoader 缓存键（纯函数）', () => {
  it('格式 persona::{videoId}::{promptVersion}::{model}', () => {
    expect(personaCacheKey('BV1_p1', '0.1.0', 'deepseek-chat')).toBe(
      'persona::BV1_p1::0.1.0::deepseek-chat',
    );
  });

  it('promptVersion / model 变化即产生不同键（红线 7 定向失效）', () => {
    expect(personaCacheKey('BV1', '0.1.0', 'm')).not.toBe(personaCacheKey('BV1', '0.2.0', 'm'));
    expect(personaCacheKey('BV1', '0.1.0', 'm')).not.toBe(personaCacheKey('BV1', '0.1.0', 'm2'));
  });
});
