/**
 * runOutline 进度钩子单测（父 agent 收尾接线补充；SPEC-12 三轮更新契约）。
 * 断言：模型期每个块完成即触发一次（生成期线性推进，修复"卡在抽帧 30%
 * 突然完成"）；合并后补一次终态（携带合并后的 confirmed 快照）；
 * done 单调递增至 total；回调抛错不阻断 pipeline。
 */
import { describe, expect, it } from 'vitest';
import type { Cue } from '../../../src/types';
import { runOutline, type OutlineModelFn } from '../../../src/core/pipeline/outline';

function makeCues(n: number, textLen = 40): Cue[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    startMs: i * 4000,
    endMs: i * 4000 + 3800,
    text: `${'字'.repeat(textLen)}第${i}句`,
  }));
}

const okModel: OutlineModelFn = async () => ({
  content: JSON.stringify({
    sections: [
      {
        title: `章节标题占位${Math.random().toFixed(0)}`,
        startSec: 0,
        summary: '摘要',
        bullets: [{ text: '要点', startSec: 0 }],
        terms: ['术语A'],
        importance: 3,
      },
    ],
  }),
});

describe('runOutline onProgress', () => {
  it('每个有产出的块触发一次，done 单调递增，confirmed 快照非空', async () => {
    const cues = makeCues(120); // 足够切成多块
    const events: Array<{ done: number; total: number; confirmedLen: number }> = [];
    const result = await runOutline(cues, okModel, {
      onProgress: (confirmed, done, total) => {
        events.push({ done, total, confirmedLen: confirmed.length });
      },
    });
    const doneCount = result.chunkState.filter((s) => s.status === 'done').length;
    expect(doneCount).toBeGreaterThan(1);
    // 模型期逐块一次 + 合并后一次终态
    expect(events.length).toBe(doneCount + 1);
    expect(events[0].done).toBe(1);
    expect(events[events.length - 1].done).toBe(events[events.length - 1].total);
    // 单调非递减（终态事件与最后一个模型事件的 done 相同，均为 total）
    for (let i = 1; i < events.length; i++) {
      expect(events[i].done).toBeGreaterThanOrEqual(events[i - 1].done);
    }
    // 终态事件携带合并后的章节快照
    expect(events[events.length - 1].confirmedLen).toBeGreaterThan(0);
  });

  it('回调抛错不阻断 pipeline（进度提示非关键路径）', async () => {
    const cues = makeCues(120);
    const result = await runOutline(cues, okModel, {
      onProgress: () => {
        throw new Error('callback boom');
      },
    });
    expect(result.sections.length).toBeGreaterThan(0);
    expect(result.failedChunks).toBe(0);
  });

  it('空 cues 不触发回调', async () => {
    let called = 0;
    const result = await runOutline([], okModel, {
      onProgress: () => {
        called += 1;
      },
    });
    expect(result.sections).toHaveLength(0);
    expect(called).toBe(0);
  });
});
