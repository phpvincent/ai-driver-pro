/**
 * 生成互斥锁（2026-10-12）：所有需要在对同一视频上 seek 抽帧的生成任务
 * （大纲 / 思维导图画布 / 流程图画布）共用一把互斥锁——同时只允许一个
 * 任务跑，避免视频画面被两个抽帧任务来回拉动。
 *
 * 状态存模块级（Tab 切换即卸载的容器里长任务状态必须外置）。
 */
let genActive = false;
const listeners = new Set<() => void>();

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

/** 任务运行期间占用互斥锁（幂等；嵌套/重入安全——引用计数不引入，锁只表达"有任务在跑"） */
export async function withGenMutex<T>(task: () => Promise<T>): Promise<T> {
  setGenActive(true);
  try {
    return await task();
  } finally {
    setGenActive(false);
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
