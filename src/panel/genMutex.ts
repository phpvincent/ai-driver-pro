/**
 * 生成互斥锁（2026-10-12；SPEC-21 改真互斥）：所有需要在对同一视频上 seek 抽帧的
 * 生成任务（大纲 / 思维导图画布 / 流程图画布）共用一把锁——**同一时刻只允许一个
 * 任务跑**，后来者排队等待，避免视频画面被两个抽帧任务来回拉动。
 *
 * 状态存模块级（Tab 切换即卸载的容器里长任务状态必须外置）。
 *
 * SPEC-21 R1 修复：旧实现只是忙标志（`setGenActive(true)` 不挡并发），跨任务
 * （大纲↔画布）可同时进入、先完成者还提前清标志。改为 promise 链排队：
 * 进入 = 追加到链尾，退出 = 释放链节——严格串行。
 */
let genActive = false;
const listeners = new Set<() => void>();

/** 排队链尾（promise 链：每个入队者 await 前一个释放） */
let queueTail: Promise<void> = Promise.resolve();

/** 是否有任一生成任务（大纲 / 画布）正在运行 */
export function isGenBusy(): boolean {
  return genActive;
}

/** 订阅互斥状态变化（返回取消订阅函数） */
export function subscribeGenBusy(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * 任务运行期间占用互斥锁（SPEC-21 真互斥）：
 * - 空闲 → 立即执行；
 * - 忙 → **排队等待**前一个释放（不是放行并发，也不是抛错）；
 * - 任务抛错 → 锁照常释放，后续任务继续（错误由调用方捕获）。
 */
export async function withGenMutex<T>(task: () => Promise<T>): Promise<T> {
  // 本任务的"准入凭证"：前一个任务释放后 resolve
  let release: () => void = () => undefined;
  const admission = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = queueTail;
  // 链尾推进：无论本任务成败，都必须 release 以免卡死后来者
  queueTail = prev.then(() => admission);
  await prev;

  setGenActive(true);
  try {
    return await task();
  } finally {
    setGenActive(false);
    release();
  }
}

function setGenActive(v: boolean): void {
  if (genActive === v) return;
  genActive = v;
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 订阅者异常不影响其他订阅者 */
    }
  }
}

/** 仅测试用：清空排队链（隔离用例间状态） */
export function resetGenMutexForTest(): void {
  queueTail = Promise.resolve();
  genActive = false;
}
