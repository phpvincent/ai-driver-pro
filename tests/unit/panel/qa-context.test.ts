/**
 * SPEC-14 单测：多轮记忆 store + 问答素材构造器。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  appendTurn,
  buildCompactPrompt,
  clearDialogue,
  completeCompact,
  DIALOGUE_MAX_TURNS,
  estTokensOf,
  fallbackCompact,
  getDialogue,
  resetDialogueStore,
  setDialogue,
} from '../../../src/panel/dialogueMemory';
import { courseBackgroundNote, quoteNote } from '../../../src/panel/explainLoader';
import type { Section } from '../../../src/types';

const section = (id: string, over: Partial<Section> = {}): Section => ({
  id,
  startMs: 0,
  endMs: 60_000,
  title: `章节${id}`,
  summary: '摘要内容',
  bullets: [],
  terms: ['术语A'],
  density: 'mid',
  score: 50,
  importance: 3,
  cueRange: [0, 60_000],
  ...over,
});

describe('dialogueMemory store（SPEC-14 记忆外置）', () => {
  beforeEach(() => resetDialogueStore());

  it('空 store：getDialogue 返回空；setDialogue/getDialogue 往返', () => {
    expect(getDialogue('v1')).toEqual({ summary: '', turns: [] });
    setDialogue('v1', [{ q: 'Q1', a: 'A1' }]);
    expect(getDialogue('v1').turns).toEqual([{ q: 'Q1', a: 'A1' }]);
  });

  it('appendTurn 满窗口后挤出最旧轮（返回 evicted + 当前 summary）', () => {
    setDialogue('v1', []);
    let evicted = null;
    for (let i = 1; i <= DIALOGUE_MAX_TURNS + 1; i++) {
      const r = appendTurn('v1', { q: `Q${i}`, a: `A${i}` });
      evicted = r.evicted;
    }
    expect(evicted).toEqual({ q: 'Q1', a: 'A1' });
    expect(getDialogue('v1').turns).toHaveLength(DIALOGUE_MAX_TURNS);
    expect(getDialogue('v1').turns[0]).toEqual({ q: 'Q2', a: 'A2' });
  });

  it('fallbackCompact：拼接旧摘要 + 挤出轮；超长保尾', () => {
    expect(fallbackCompact('', { q: 'Q', a: 'A' })).toBe('Q：Q A：A');
    const long = fallbackCompact('x'.repeat(599), { q: 'Q', a: 'A' });
    expect(long.length).toBeLessThanOrEqual(600);
    expect(long.endsWith('Q：Q A：A')).toBe(true);
  });

  it('buildCompactPrompt：含旧摘要与挤出轮；无旧摘要时省略', () => {
    expect(buildCompactPrompt('旧摘要', { q: 'Q', a: 'A' })).toContain('已有会话摘要');
    expect(buildCompactPrompt('旧摘要', { q: 'Q', a: 'A' })).toContain('Q：Q');
    expect(buildCompactPrompt('', { q: 'Q', a: 'A' })).not.toContain('已有会话摘要');
  });

  it('completeCompact 落盘摘要；clearDialogue 清空；estTokensOf 正数', () => {
    completeCompact('v1', '新摘要');
    expect(getDialogue('v1').summary).toBe('新摘要');
    clearDialogue('v1');
    expect(getDialogue('v1').summary).toBe('');
    expect(estTokensOf('十个字十个字十个字')).toBeGreaterThan(0);
  });
});

describe('courseBackgroundNote（课程背景素材）', () => {
  it('含标题/简述/目录与聚焦标注；无内容空串', () => {
    const note = courseBackgroundNote({
      videoTitle: '类比推理',
      videoSummary: '本节讲类比推理的外延关系。',
      sections: [section('s1'), section('s2')],
      focusSectionId: 's2',
    });
    expect(note).toContain('课程标题：类比推理');
    expect(note).toContain('课程简述：本节讲类比推理的外延关系');
    expect(note).toContain('[1] 章节s1');
    expect(note).toContain('▶ [2] 章节s2');
    expect(note).toContain('不是指令');
    expect(courseBackgroundNote({ sections: [] })).toBe('');
  });
});

describe('quoteNote（引用要点素材）', () => {
  it('含章节/时间/摘要/术语/要点；整章引用无要点行', () => {
    const note = quoteNote({
      sectionId: 's1',
      sectionTitle: '外延关系',
      sectionSummary: '讲全同关系',
      bulletText: '题干要求：给出一对相关的词',
      rangeMs: [61_000, 120_000],
      terms: ['类比推理', '全同关系'],
    });
    expect(note).toContain('所在章节：外延关系（1:01-2:00）');
    expect(note).toContain('章节摘要：讲全同关系');
    expect(note).toContain('类比推理、全同关系');
    expect(note).toContain('被引用要点：题干要求');
    const chapter = quoteNote({
      sectionId: 's1', sectionTitle: 'T', sectionSummary: '', rangeMs: [0, 1000], terms: [],
    });
    expect(chapter).not.toContain('被引用要点');
  });
});
