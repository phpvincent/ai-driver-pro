/**
 * 进度总线单测（SPEC-12 A1）+ scanFrames 进度节流（A2，见 frame-capture.test 追加）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishProgress,
  resetProgressBus,
  subscribeProgress,
  subscribeProgressForVideo,
} from '../../../src/panel/progressBus';

afterEach(() => {
  resetProgressBus();
});

describe('progressBus（pub/sub，SPEC-12 A1）', () => {
  it('发布 → 订阅者收到同一事件', () => {
    const cb = vi.fn();
    subscribeProgress(cb);
    publishProgress({ videoId: 'BV1_p1', stage: 'outline', done: 3, total: 8, label: '字幕分块 3/8' });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ videoId: 'BV1_p1', stage: 'outline', done: 3, total: 8, label: '字幕分块 3/8' });
  });

  it('多个订阅者各自收到；退订后不再收', () => {
    const a = vi.fn();
    const b = vi.fn();
    const off = subscribeProgress(a);
    subscribeProgress(b);
    publishProgress({ videoId: 'v', stage: 'scan', done: 5, total: 100 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    off();
    publishProgress({ videoId: 'v', stage: 'scan', done: 10, total: 100 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('subscribeForVideo：只收目标 videoId 的事件', () => {
    const cb = vi.fn();
    subscribeProgressForVideo('BV1_p1', cb);
    publishProgress({ videoId: 'BV2_p1', stage: 'mindmap', done: 1, total: 4 });
    publishProgress({ videoId: 'BV1_p1', stage: 'mindmap', done: 2, total: 4 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'BV1_p1', done: 2 }));
  });

  it('单个订阅者抛错不影响其余订阅者（进度非关键路径）', () => {
    const bad = vi.fn(() => {
      throw new Error('subscriber bug');
    });
    const good = vi.fn();
    subscribeProgress(bad);
    subscribeProgress(good);
    expect(() => publishProgress({ videoId: 'v', stage: 'scan', done: 1, total: 2 })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('发布中退订自身不影响本次其余扇出（快照迭代）', () => {
    const seen: number[] = [];
    let offSelf: () => void;
    const self = vi.fn(() => {
      seen.push(1);
      offSelf();
    });
    const other = vi.fn(() => seen.push(2));
    offSelf = subscribeProgress(self);
    subscribeProgress(other);
    publishProgress({ videoId: 'v', stage: 'outline', done: 1, total: 1 });
    expect(seen).toEqual([1, 2]);
  });

  it('resetProgressBus 清空后发布无人接收', () => {
    const cb = vi.fn();
    subscribeProgress(cb);
    resetProgressBus();
    publishProgress({ videoId: 'v', stage: 'scan', done: 1, total: 1 });
    expect(cb).not.toHaveBeenCalled();
  });
});
