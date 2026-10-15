/**
 * SPEC-16 六轮单测：笔记讨论串上下文组装——
 * 最后一条用户追问为主问题，前序内容转多轮记忆。
 */
import { describe, expect, it } from 'vitest';
import { buildThreadContext } from '../../../src/panel/notes/notesLoader';
import type { OutlineNote } from '../../../src/types';

function note(replies: Array<{ author: 'self' | 'assistant'; body: string }>): OutlineNote {
  return {
    id: 'n_test',
    videoId: 'BV1_p1',
    anchor: { kind: 'bullet', sectionId: 's1', tMs: 0 },
    body: '路由配置文件有强制的格式吧',
    createdAt: '2026-10-15T00:00:00Z',
    updatedAt: '2026-10-15T00:00:00Z',
    replies: replies.map((r, i) => ({
      id: `r_${i}`,
      author: r.author,
      body: r.body,
      createdAt: '2026-10-15T00:00:01Z',
    })),
  };
}

describe('buildThreadContext（讨论串 → 主问题 + 多轮记忆）', () => {
  it('无回复：笔记正文即问题，history 为空', () => {
    const ctx = buildThreadContext(note([]));
    expect(ctx.question).toBe('路由配置文件有强制的格式吧');
    expect(ctx.history).toEqual([]);
  });

  it('有用户追问：最后一条追问为主，前序问答对转 history', () => {
    const ctx = buildThreadContext(
      note([
        { author: 'assistant', body: '助教第一答 [04:12]' },
        { author: 'self', body: '我路由文件不叫这个名字可以吗' },
      ]),
    );
    expect(ctx.question).toBe('我路由文件不叫这个名字可以吗');
    expect(ctx.history).toEqual([
      { q: '路由配置文件有强制的格式吧', a: '助教第一答 [04:12]' },
    ]);
  });

  it('多轮追问：笔记正文与各轮问答按序入 history', () => {
    const ctx = buildThreadContext(
      note([
        { author: 'assistant', body: '答1' },
        { author: 'self', body: '追问1' },
        { author: 'assistant', body: '答2' },
        { author: 'self', body: '追问2' },
      ]),
    );
    expect(ctx.question).toBe('追问2');
    expect(ctx.history).toEqual([
      { q: '路由配置文件有强制的格式吧', a: '答1' },
      { q: '追问1', a: '答2' },
    ]);
  });

  it('用户连续追问（中间无助教回答）：改口的旧问丢弃、最新问为主', () => {
    const ctx = buildThreadContext(
      note([
        { author: 'self', body: '第一问' },
        { author: 'self', body: '第二问（改口）' },
      ]),
    );
    expect(ctx.question).toBe('第二问（改口）');
    // 未被回答的用户追问不成对入 history（用户的话不能当 answer）
    expect(ctx.history).toEqual([]);
  });

  it('追问已被回答后再点助教 = 重试最后追问（question 仍是它，已答不入 history）', () => {
    const ctx = buildThreadContext(
      note([
        { author: 'assistant', body: '答1' },
        { author: 'self', body: '追问1' },
        { author: 'assistant', body: '答2（最新）' },
      ]),
    );
    expect(ctx.question).toBe('追问1');
    expect(ctx.history).toEqual([{ q: '路由配置文件有强制的格式吧', a: '答1' }]);
  });
});
