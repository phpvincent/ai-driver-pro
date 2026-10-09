/**
 * 播放器控制：跳播 / 暂停 / 恢复（panel 经 background 转发到 content）。
 * 红线 10：本文件禁止 import 模型配置 / 密钥 / 模型调用模块（messages 契约可以）。
 */
import { MSG, type RuntimeMessage } from '../messages';
import type { VideoId } from '../types';

/**
 * 注册播放器控制消息监听。
 * @param getVideoId 当前 videoId（由 bilibili.ts 维护）
 * @param getVideo 当前 <video> 元素
 */
export function initPlayer(
  getVideoId: () => VideoId | null,
  getVideo: () => HTMLVideoElement | null,
): void {
  chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
    if (message.type !== MSG.SEEK && message.type !== MSG.PAUSE && message.type !== MSG.RESUME) {
      return;
    }
    const videoId = getVideoId();
    const video = getVideo();
    // 校验目标视频与当前一致才执行
    if (!videoId || !video) return;
    if (message.payload.videoId !== videoId) return;
    switch (message.type) {
      case MSG.SEEK:
        video.currentTime = message.payload.targetMs / 1000;
        break;
      case MSG.PAUSE:
        video.pause();
        break;
      case MSG.RESUME:
        void video.play().catch(() => {
          // 自动播放策略拒绝等场景静默
        });
        break;
    }
  });
}
