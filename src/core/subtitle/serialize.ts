/**
 * 字幕序列化器（SPEC-04 范围变更三次迭代：字幕下载）。
 *
 * Cue[] → SRT / 纯文本，全部纯函数、无 DOM 依赖（浏览器下载壳在 SubtitleTab，
 * 单测只覆盖本文件）。红线 5：序列化保留时间戳——SRT 的 from/to 完整来自
 * Cue.startMs/endMs；approximate 的时间照常输出（SRT 无 approximate 概念）。
 */
import type { Cue } from '../../types';

/** ms → SRT 时间戳 `HH:MM:SS,mmm`（非有限值/负数按 0 处理；小时位不封顶） */
function formatSrtTime(ms: number): string {
  const clamped = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  const h = Math.floor(clamped / 3_600_000);
  const rest = clamped % 3_600_000;
  const min = Math.floor(rest / 60_000);
  const sec = Math.floor((rest % 60_000) / 1000);
  const milli = rest % 1000;
  return (
    `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` +
    `:${String(sec).padStart(2, '0')},${String(milli).padStart(3, '0')}`
  );
}

/** ms → `mm:ss`（分钟累计不进位到小时；0/非法值 → 00:00。与 SubtitleTab 展示格式一致） */
export function formatMmSs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * 标准 SRT 序列化：序号行（1 起连续）、`HH:MM:SS,mmm --> HH:MM:SS,mmm`、
 * 文本行（Cue.text 原样，多行文本保留换行）、块间空行；空 cues 返回空串。
 */
export function toSrt(cues: Cue[]): string {
  const blocks = cues.map(
    (cue, i) =>
      `${i + 1}\n${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}\n${cue.text}`,
  );
  return blocks.join('\n\n');
}

/** 纯文本序列化：每行 `[mm:ss] text`；空 cues 返回空串 */
export function toPlainText(cues: Cue[]): string {
  return cues.map((cue) => `[${formatMmSs(cue.startMs)}] ${cue.text}`).join('\n');
}
