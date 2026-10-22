/**
 * SPEC-21 并发与内存边界加固单测：
 * R1 genMutex 真互斥、R2 索引写串行、R3 dialogueMemory LRU。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { withGenMutex, isGenBusy, resetGenMutexForTest } from '../../../src/panel/genMutex';
import {
  DIALOGUE_MAX_VIDEOS,
  getDialogue,
  appendTurn,
  setDialogue,
  resetDialogueStore,
} from '../../../src/panel/dialogueMemory';

describe('R1：genMutex 真互斥（排队串行）', () => {
  beforeEach(() => {
    resetGenMutexForTest();
  });

  it('并发 2 个任务串行执行，期间 isGenBusy 恒 true', async () => {
    const order: string[] = [];
    let busyDuringA = false;
    let busyDuringB = false;
    const a = withGenMutex(async () => {
      order.push('A-start');
      busyDuringA = isGenBusy();
      await new Promise((r) => setTimeout(r, 30));
      order.push('A-end');
    });
    const b = withGenMutex(async () => {
      order.push('B-start');
      busyDuringB = isGenBusy();
      await new Promise((r) => setTimeout(r, 10));
      order.push('B-end');
    });
    await Promise.all([a, b]);
    // A 全程完成（含 end）后 B 才 start —— 严格串行
    expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end']);
    expect(busyDuringA).toBe(true);
    expect(busyDuringB).toBe(true);
    expect(isGenBusy()).toBe(false);
  });

  it('任务抛错后锁释放，后续任务可继续', async () => {
    const failing = withGenMutex(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('boom');
    });
    const next = withGenMutex(async () => 'ok');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(isGenBusy()).toBe(false);
  });

  it('单任务立即执行（不被自己的历史卡死）', async () => {
    const result = await withGenMutex(async () => 42);
    expect(result).toBe(42);
    expect(isGenBusy()).toBe(false);
  });
});

describe('R3：dialogueMemory LRU 上限', () => {
  beforeEach(() => {
    resetDialogueStore();
  });

  it(`写入 ${DIALOGUE_MAX_VIDEOS + 5} 个视频后容量不超上限，最旧被挤出`, () => {
    for (let i = 0; i < DIALOGUE_MAX_VIDEOS + 5; i += 1) {
      setDialogue(`vid-${i}`, [{ q: `q${i}`, a: `a${i}` }]);
    }
    // 最旧的 vid-0..vid-4 被挤出
    expect(getDialogue('vid-0').turns).toHaveLength(0); // 重建为空（被挤出）
    // 最新的仍保留
    expect(getDialogue(`vid-${DIALOGUE_MAX_VIDEOS + 4}`).turns[0]!.q).toBe(`q${DIALOGUE_MAX_VIDEOS + 4}`);
  });

  it('LRU：访问过的视频不被挤出，未访问的最旧先出', () => {
    // 填满 20 个
    for (let i = 0; i < DIALOGUE_MAX_VIDEOS; i += 1) {
      setDialogue(`vid-${i}`, [{ q: `q${i}`, a: `a${i}` }]);
    }
    // 访问 vid-0 使其变为"最近使用"
    getDialogue('vid-0');
    // 再写 1 个 → 应挤出 vid-1（最久未访问），而非 vid-0
    setDialogue('newest', [{ q: 'n', a: 'n' }]);
    expect(getDialogue('vid-0').turns[0]!.q).toBe('q0'); // 保住了
    expect(getDialogue('vid-1').turns).toHaveLength(0); // 被挤出
  });

  it('appendTurn 正常工作（LRU 不影响单视频轮次逻辑）', () => {
    appendTurn('v1', { q: 'q1', a: 'a1' });
    appendTurn('v1', { q: 'q2', a: 'a2' });
    expect(getDialogue('v1').turns).toHaveLength(2);
  });
});
