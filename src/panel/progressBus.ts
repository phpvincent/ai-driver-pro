/**
 * 生成进度总线（SPEC-12）：panel 内轻量 pub/sub，串联三个进度源与两个消费 UI。
 *
 * 设计约束：
 * - 红线 1：纯同步、无副作用；同事件序列对所有订阅者一致
 * - 进度是**非关键路径**——总线任何异常不得影响生成主流程（发布侧 try/catch 由调用方自理）
 *
 * 三个发布源：
 * - content scanFrames（经 background 广播 + App 转发）：stage='scan'，done/total=已扫/总点数
 * - outlineLoader 分块循环：stage='outline'，label「第 x/N 块」
 * - mindmapLoader 生成主链：stage='mindmap'，阶段序推进
 * 消费者：OutlineTab loading 态 / MindmapTab generating 态（按 videoId 过滤）
 */

export type GenStage = 'scan' | 'outline' | 'mindmap';

export interface GenProgress {
  videoId: string;
  stage: GenStage;
  done: number;
  total: number;
  /** 人读标签（如「第 3/8 块」「抽帧规划」） */
  label?: string;
}

type Listener = (p: GenProgress) => void;

const listeners = new Set<Listener>();

/** 订阅全部进度事件；返回退订函数 */
export function subscribeProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 发布进度（同步扇出；订阅者异常互不影响） */
export function publishProgress(p: GenProgress): void {
  for (const l of [...listeners]) {
    try {
      l(p);
    } catch {
      /* 单个订阅者异常不阻断其余 */
    }
  }
}

/**
 * 订阅指定视频的进度（hook 便捷封装）：回调收到的是该 videoId 的最新事件。
 * 退订函数语义同 subscribeProgress。
 */
export function subscribeProgressForVideo(videoId: string, listener: Listener): () => void {
  const wrapped: Listener = (p) => {
    if (p.videoId === videoId) listener(p);
  };
  return subscribeProgress(wrapped);
}

/** 测试辅助：清空全部订阅者 */
export function resetProgressBus(): void {
  listeners.clear();
}
