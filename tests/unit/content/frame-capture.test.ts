/**
 * 关键帧抽取单测：纯函数（computeCanvasSize / toBase64） + 抽帧编排（假 video + 注入绘制）
 * + CAPTURE_FRAMES 消息监听（假 chrome.runtime）。全部不发真实网络请求、不依赖 jsdom。
 */
import { describe, expect, it } from 'vitest';
import {
  captureFrameAt,
  captureFrames,
  isCaptureInProgress,
  scanFrames,
  computeCanvasSize,
  registerFrameCaptureHandler,
  toBase64,
  type DrawToDataUrl,
  type HTMLVideoElementLike,
} from '../../../src/content/frameCapture';
import { DEFAULT_MAX_FRAMES } from '../../../src/content/frameCapture';
import { FRAME_PLAN } from '../../../src/config';
import { MSG } from '../../../src/messages';

// ---------- 假 video ----------

/** 抽帧所需的最小 video 假实现：可控制是否自动触发 seeked */
class FakeVideo implements HTMLVideoElementLike {
  duration = 120;
  videoWidth: number;
  videoHeight: number;
  paused = true;
  /** currentTime 被赋值的次数与最后一次赋值 */
  seekCount = 0;
  /** 赋值后是否同步触发 seeked（false 模拟 seek 卡住 → 走超时） */
  autoSeek: boolean;
  /** 模拟真实播放器的关键帧吸附：赋值后 currentTime 实际落点偏移（秒） */
  snapOffsetSec: number;
  private time = 0;
  private listeners = new Map<string, Array<() => void>>();

  constructor(
    opts: { width?: number; height?: number; autoSeek?: boolean; snapOffsetSec?: number } = {},
  ) {
    this.videoWidth = opts.width ?? 1920;
    this.videoHeight = opts.height ?? 1080;
    this.autoSeek = opts.autoSeek ?? true;
    this.snapOffsetSec = opts.snapOffsetSec ?? 0;
  }

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.time = value + this.snapOffsetSec;
    this.seekCount += 1;
    if (this.autoSeek) this.fire('seeked');
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }

  fire(type: string): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l();
  }

  /** 记录暂停/恢复调用，供"抽帧期间暂停"的用例断言 */
  pauseCalls = 0;
  playCalls = 0;
  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }
}

/** 记录入参的假绘制函数 */
function fakeDraw(
  impl?: (video: HTMLVideoElementLike, width: number, height: number, quality: number) => string,
): { draw: DrawToDataUrl; calls: Array<{ width: number; height: number; quality: number }> } {
  const calls: Array<{ width: number; height: number; quality: number }> = [];
  const draw: DrawToDataUrl = (video, width, height, quality) => {
    calls.push({ width, height, quality });
    return impl ? impl(video, width, height, quality) : 'data:image/jpeg;base64,QUJDRA==';
  };
  return { draw, calls };
}

// ---------- computeCanvasSize ----------

describe('computeCanvasSize（保持比例 / 最长边上限 / 最小 16）', () => {
  it('横屏 1920x1080 → 512x288', () => {
    expect(computeCanvasSize(1920, 1080, 512)).toEqual({ width: 512, height: 288 });
  });

  it('竖屏 1080x1920 → 288x512', () => {
    expect(computeCanvasSize(1080, 1920, 512)).toEqual({ width: 288, height: 512 });
  });

  it('正方形 512x512 → 512x512', () => {
    expect(computeCanvasSize(512, 512, 512)).toEqual({ width: 512, height: 512 });
  });

  it('已小于 maxSize 时不放大（320x240 → 320x240）', () => {
    expect(computeCanvasSize(320, 240, 512)).toEqual({ width: 320, height: 240 });
  });

  it('自定义 maxSize=256：最长边为 256 且比例保持', () => {
    const size = computeCanvasSize(1920, 1080, 256);
    expect(size.width).toBe(256);
    expect(size.height).toBe(144);
    expect(size.width / size.height).toBeCloseTo(1920 / 1080, 2);
  });

  it('极小尺寸 8x8 → 补到 16x16', () => {
    expect(computeCanvasSize(8, 8, 512)).toEqual({ width: 16, height: 16 });
  });

  it('非法尺寸（0 / NaN / 负数）→ 16x16 兜底', () => {
    expect(computeCanvasSize(0, 0, 512)).toEqual({ width: 16, height: 16 });
    expect(computeCanvasSize(Number.NaN, 1080, 512)).toEqual({ width: 16, height: 16 });
    expect(computeCanvasSize(-10, -10, 512)).toEqual({ width: 16, height: 16 });
  });

  it('极端宽高比：缩到最长边后短边兜底 ≥16，不为 0', () => {
    const size = computeCanvasSize(1920, 18, 512);
    expect(size.width).toBe(512);
    expect(size.height).toBeGreaterThanOrEqual(16);
  });

  it('maxSize 非法 → 回落默认 896（代码小字可读）', () => {
    expect(computeCanvasSize(1920, 1080, 0)).toEqual({ width: 896, height: 504 });
    expect(computeCanvasSize(1920, 1080, Number.NaN)).toEqual({ width: 896, height: 504 });
  });
});

// ---------- toBase64 ----------

describe('toBase64（去 data URI 前缀）', () => {
  it('正常 JPEG dataURL → 取 base64 部分', () => {
    expect(toBase64('data:image/jpeg;base64,QUJDRA==')).toBe('QUJDRA==');
  });

  it('png dataURL 同样去前缀', () => {
    expect(toBase64('data:image/png;base64,AAAABB')).toBe('AAAABB');
  });

  it('空串 → ""', () => {
    expect(toBase64('')).toBe('');
  });

  it('非法：只有前缀没有 base64 段 → ""', () => {
    expect(toBase64('data:image/jpeg;base64')).toBe('');
  });

  it('非法：非 base64 字符 → ""', () => {
    expect(toBase64('not a data url!!')).toBe('');
  });

  it('无前缀的裸 base64 → 原样返回', () => {
    expect(toBase64('QUJDRA==')).toBe('QUJDRA==');
  });
});

// ---------- captureFrameAt ----------

describe('captureFrameAt（seek → 绘制 → base64）', () => {
  it('抽帧成功：尺寸/质量入参、actualMs 由 video.currentTime 换算', async () => {
    const video = new FakeVideo();
    const { draw, calls } = fakeDraw();
    const frame = await captureFrameAt(video, 30_000, { drawToDataUrl: draw });
    expect(frame).toEqual({ targetMs: 30_000, actualMs: 30_000, dataBase64: 'QUJDRA==' });
    expect(calls[0]).toEqual({ width: 896, height: 504, quality: 0.75 });
    expect(video.seekCount).toBe(1);
  });

  it('自定义 maxSize / quality 透传到绘制', async () => {
    const video = new FakeVideo({ width: 1280, height: 720 });
    const { draw, calls } = fakeDraw();
    await captureFrameAt(video, 1_000, { drawToDataUrl: draw, maxSize: 256, quality: 0.5 });
    expect(calls[0]).toEqual({ width: 256, height: 144, quality: 0.5 });
  });

  it('actualMs 取实际落点：关键帧吸附到 30.004s → 30004', async () => {
    const video = new FakeVideo({ snapOffsetSec: 0.004 });
    const { draw } = fakeDraw();
    const frame = await captureFrameAt(video, 30_000, { drawToDataUrl: draw });
    expect(frame.targetMs).toBe(30_000);
    expect(frame.actualMs).toBe(30_004);
  });

  it('seek 超时（seeked 不触发）仍尝试抽帧', async () => {
    const video = new FakeVideo({ autoSeek: false });
    const { draw } = fakeDraw();
    const frame = await captureFrameAt(video, 12_000, { drawToDataUrl: draw, timeoutMs: 10 });
    expect(frame.dataBase64).toBe('QUJDRA==');
    expect(frame.targetMs).toBe(12_000);
  });

  it('videoWidth 为 0（元数据未就绪）→ 画布兜底 16x16，不 throw', async () => {
    const video = new FakeVideo({ width: 0, height: 0 });
    const { draw, calls } = fakeDraw();
    const frame = await captureFrameAt(video, 5_000, { drawToDataUrl: draw });
    expect(calls[0]).toEqual({ width: 16, height: 16, quality: 0.75 });
    expect(frame.dataBase64).toBe('QUJDRA==');
  });

  it('绘制异常 → throw（由调用方决定丢弃该帧）', async () => {
    const video = new FakeVideo();
    const { draw } = fakeDraw(() => {
      throw new Error('canvas tainted');
    });
    await expect(captureFrameAt(video, 1_000, { drawToDataUrl: draw })).rejects.toThrow(
      'canvas tainted',
    );
  });
});

// ---------- captureFrames ----------

describe('captureFrames（批量 / 截断 / 单帧失败跳过）', () => {
  it('多目标按序返回，targetMs 与输入一致', async () => {
    const video = new FakeVideo();
    const { draw } = fakeDraw();
    const frames = await captureFrames(video, [1_000, 2_000, 3_000], { drawToDataUrl: draw });
    expect(frames.map((f) => f.targetMs)).toEqual([1_000, 2_000, 3_000]);
    expect(frames.every((f) => f.dataBase64 === 'QUJDRA==')).toBe(true);
  });

  it('maxFrames 截断：超过部分不抽', async () => {
    const video = new FakeVideo();
    const { draw, calls } = fakeDraw();
    const frames = await captureFrames(video, [1_000, 2_000, 3_000], {
      drawToDataUrl: draw,
      maxFrames: 2,
    });
    expect(frames).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it('默认上限跟随目标数：规划 10 帧就抽 10 帧（兜底上限 48）', async () => {
    const video = new FakeVideo();
    const { draw } = fakeDraw();
    const targets = Array.from({ length: 10 }, (_, i) => i * 1_000);
    const frames = await captureFrames(video, targets, { drawToDataUrl: draw });
    expect(frames).toHaveLength(10);
  });

  it('超过兜底上限（48）才截断', async () => {
    const video = new FakeVideo();
    const { draw } = fakeDraw();
    const targets = Array.from({ length: 60 }, (_, i) => i * 1_000);
    const frames = await captureFrames(video, targets, { drawToDataUrl: draw });
    expect(frames).toHaveLength(48);
  });

  it('兜底上限 ≥ 导图帧预算硬上限（否则长视频规划的帧在 content 侧被截断）', () => {
    expect(DEFAULT_MAX_FRAMES).toBeGreaterThanOrEqual(FRAME_PLAN.mindmap.hardMax);
  });

  it('抽帧期间先暂停，结束后恢复原播放状态', async () => {
    const video = new FakeVideo();
    video.paused = false; // 正在播放
    const { draw } = fakeDraw();
    const seen: boolean[] = [];
    const spyDraw = (...args: Parameters<typeof draw>) => {
      seen.push(video.paused);
      return draw(...args);
    };
    await captureFrames(video, [1_000, 2_000], { drawToDataUrl: spyDraw });
    // 抽帧过程中一直处于暂停态
    expect(seen).toEqual([true, true]);
    // 抽完恢复播放（pause 一次、play 一次）
    expect(video.pauseCalls).toBe(1);
    expect(video.playCalls).toBe(1);
    expect(video.paused).toBe(false);
  });

  it('单帧失败跳过，其余帧照常返回（不整体失败）', async () => {
    const video = new FakeVideo();
    const { draw } = fakeDraw((_v, _w, _h) => {
      if (Math.round(video.currentTime * 1000) === 2_000) throw new Error('boom');
      return 'data:image/jpeg;base64,T0s=';
    });
    const frames = await captureFrames(video, [1_000, 2_000, 3_000], { drawToDataUrl: draw });
    expect(frames.map((f) => f.targetMs)).toEqual([1_000, 3_000]);
  });

  it('空 targets → []', async () => {
    const video = new FakeVideo();
    const { draw, calls } = fakeDraw();
    await expect(captureFrames(video, [], { drawToDataUrl: draw })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

// ---------- CAPTURE_FRAMES 消息监听 ----------

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

function installFakeChrome(): Listener[] {
  const listeners: Listener[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onMessage: {
        addListener: (listener: Listener) => {
          listeners.push(listener);
        },
      },
    },
  };
  return listeners;
}

/** 假 document：让默认绘制路径（canvas → toDataURL）在 Node 下可跑 */
function installFakeDocument(): Array<{ width: number; height: number }> {
  const canvases: Array<{ width: number; height: number }> = [];
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => undefined }),
        toDataURL: () => 'data:image/jpeg;base64,RkFM',
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  return canvases;
}

describe('registerFrameCaptureHandler（CAPTURE_FRAMES）', () => {
  it('videoId 一致 → 返回 frames 且异步响应（return true）', async () => {
    const listeners = installFakeChrome();
    const canvases = installFakeDocument();
    const video = new FakeVideo();
    registerFrameCaptureHandler(() => 'BV1xx_p1', () => video);
    const responses: unknown[] = [];
    const ret = listeners[0]?.(
      { type: MSG.CAPTURE_FRAMES, payload: { videoId: 'BV1xx_p1', targetsMs: [1_000, 2_000] } },
      {},
      (r) => responses.push(r),
    );
    expect(ret).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(responses).toHaveLength(1);
    const frames = (responses[0] as { frames: Array<{ dataBase64: string }> }).frames;
    expect(frames).toHaveLength(2);
    expect(frames[0]?.dataBase64).toBe('RkFM');
    expect(canvases[0]).toMatchObject({ width: 896, height: 504 });
  });

  it('payload.maxSize 透传到画布尺寸', async () => {
    const listeners = installFakeChrome();
    const canvases = installFakeDocument();
    registerFrameCaptureHandler(() => 'BV1xx_p1', () => new FakeVideo({ width: 1280, height: 720 }));
    const responses: unknown[] = [];
    listeners[0]?.(
      {
        type: MSG.CAPTURE_FRAMES,
        payload: { videoId: 'BV1xx_p1', targetsMs: [1_000], maxSize: 320 },
      },
      {},
      (r) => responses.push(r),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(canvases[0]).toMatchObject({ width: 320, height: 180 });
  });

  it('videoId 不一致 → { frames: [] }，不抽帧', async () => {
    const listeners = installFakeChrome();
    const video = new FakeVideo();
    registerFrameCaptureHandler(() => 'BV1xx_p1', () => video);
    const responses: unknown[] = [];
    listeners[0]?.(
      { type: MSG.CAPTURE_FRAMES, payload: { videoId: 'BV_other_p1', targetsMs: [1_000] } },
      {},
      (r) => responses.push(r),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(responses[0]).toEqual({ frames: [] });
    expect(video.seekCount).toBe(0);
  });

  it('无 video → { frames: [] }，不 throw', async () => {
    const listeners = installFakeChrome();
    registerFrameCaptureHandler(() => 'BV1xx_p1', () => null);
    const responses: unknown[] = [];
    listeners[0]?.(
      { type: MSG.CAPTURE_FRAMES, payload: { videoId: 'BV1xx_p1', targetsMs: [1_000] } },
      {},
      (r) => responses.push(r),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(responses[0]).toEqual({ frames: [] });
  });

  it('非 CAPTURE_FRAMES 消息不处理（不响应、不拦截）', () => {
    const listeners = installFakeChrome();
    registerFrameCaptureHandler(() => 'BV1xx_p1', () => new FakeVideo());
    const responses: unknown[] = [];
    const ret = listeners[0]?.({ type: 'player/seek', payload: { videoId: 'BV1xx_p1' } }, {}, (r) =>
      responses.push(r),
    );
    expect(ret).toBeUndefined();
    expect(responses).toHaveLength(0);
  });
  it('抽帧结束回到原始播放位置（避免画面停在最后一帧）', async () => {
    const video = new FakeVideo({ autoSeek: true });
    video.currentTime = 42; // 用户当前位置
    const { draw } = fakeDraw();
    const frames = await captureFrames(video, [10_000, 20_000], { drawToDataUrl: draw });
    expect(frames.length).toBe(2);
    // 抽完回到用户原来的位置（42s），而不是停在最后一个抽帧点
    expect(video.currentTime).toBe(42);
  });

  it('原本暂停 → 抽帧后仍暂停；恢复失败不影响已抽到的帧', async () => {
    const video = new FakeVideo({ autoSeek: true });
    video.paused = true;
    const { draw } = fakeDraw();
    await captureFrames(video, [10_000], { drawToDataUrl: draw });
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(0);
  });
});

// ---------- scanFrames（SPEC-11 A5：轻量扫描） ----------

describe('scanFrames（轻量扫描 / 预算截断 / 播放状态恢复）', () => {
  /** 注入版描述：按点时间返回可区分的 dhash 与清晰度 */
  const fakeDescribe = (video: HTMLVideoElementLike): { dhash: string; sharpness: number } => ({
    dhash: video.currentTime < 5 ? '0000000000000000' : 'ffffffffffffffff', // currentTime 是秒：2s→A 页，6s→B 页
    sharpness: Math.round(video.currentTime * 10),
  });

  it('空点集 → 空样本（零 seek）', async () => {
    const v = new FakeVideo();
    const out = await scanFrames(v, [], { describeScan: fakeDescribe });
    expect(out).toEqual([]);
    expect(v.seekCount).toBe(0);
  });

  it('非法点（负数 / NaN）被过滤；合法点全部扫到且顺序保留', async () => {
    const v = new FakeVideo();
    const out = await scanFrames(v, [-1000, 2000, Number.NaN, 6000], {
      budgetMs: 60_000,
      describeScan: fakeDescribe,
    });
    expect(out.map((x) => x.tMs)).toEqual([2000, 6000]);
    expect(out[0]!.dhash).toBe('0000000000000000');
    expect(out[1]!.dhash).toBe('ffffffffffffffff');
  });

  it('预算耗尽即停（budgetMs < 0 → 首点前即超时，返回空）', async () => {
    const v = new FakeVideo();
    const out = await scanFrames(v, [1000, 2000, 3000], {
      budgetMs: -1,
      describeScan: fakeDescribe,
    });
    expect(out).toEqual([]);
  });

  it('扫描后恢复原播放位置；进行中标志复位', async () => {
    const v = new FakeVideo({ autoSeek: true });
    v.currentTime = 42;
    let sawInProgress = false;
    const describe = (video: HTMLVideoElementLike): { dhash: string; sharpness: number } => {
      sawInProgress = sawInProgress || isCaptureInProgress();
      return fakeDescribe(video);
    };
    const out = await scanFrames(v, [1000, 2000], {
      budgetMs: 60_000,
      describeScan: describe,
    });
    expect(out).toHaveLength(2);
    expect(sawInProgress).toBe(true);
    expect(isCaptureInProgress()).toBe(false);
    expect(v.currentTime).toBeCloseTo(42, 1);
  });
});
