/**
 * 生成进度条（SPEC-12）：消费 progressBus，按 videoId 过滤。
 * 无进度事件时返回 null（退化为原有文案，兼容关闭抽帧/纯文本路径）。
 */
import { useEffect, useState } from 'react';
import { subscribeProgressForVideo, type GenProgress } from './progressBus';

export function GenerationProgress({ videoId }: { videoId: string }) {
  const [p, setP] = useState<GenProgress | null>(null);
  useEffect(() => subscribeProgressForVideo(videoId, setP), [videoId]);
  if (!p || !(p.total > 0) || !(p.done > 0)) return null;
  // 全局百分比优先（SPEC-12 二轮）；缺省回落 done/total
  const pct =
    typeof p.pct === 'number' && p.pct >= 0
      ? Math.min(100, Math.round(p.pct))
      : Math.min(100, Math.round((p.done / p.total) * 100));
  const label = p.label ?? `${p.done}/${p.total}`;
  return (
    <div className="gen-progress" role="status" aria-label="生成进度">
      <div className="gen-progress-bar">
        <div className="gen-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="gen-progress-label">{label} · {pct}%</span>
    </div>
  );
}
