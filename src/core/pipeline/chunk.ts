/**
 * 字幕切片（TECH-DESIGN §5.1 步骤 2）：
 * 按 Cue 累计字符切块（单条 Cue 权重 = text.length + 1），切点必须落在 Cue 边界；
 * 相邻块重叠：下一块从上一块末尾往前取累计 ≥ overlapChars 的整条 Cue 开始。
 */
import { OUTLINE } from '../../config';
import type { Cue } from '../../types';

export interface ChunkOptions {
  targetChars?: number;
  overlapChars?: number;
}

/** 单条 Cue 的字符权重：正文长度 + 1（换行/分隔开销） */
const cueWeight = (cue: Cue): number => cue.text.length + 1;

export function chunkCues(cues: Cue[], opts: ChunkOptions = {}): Cue[][] {
  const target = opts.targetChars ?? OUTLINE.chunkTargetChars;
  const overlap = opts.overlapChars ?? OUTLINE.chunkOverlapChars;
  if (cues.length === 0) return [];

  const chunks: Cue[][] = [];
  /** 上一块最后一条 Cue 的下标；-1 表示还没有块 */
  let prevEnd = -1;

  for (;;) {
    // 下一块起点：从上一块末尾往前取累计 ≥ overlap 的整条 Cue（不切开任何一条）
    let start: number;
    if (prevEnd < 0) {
      start = 0;
    } else {
      start = prevEnd;
      let overlapAcc = 0;
      while (start > 0 && overlapAcc < overlap) {
        overlapAcc += cueWeight(cues[start]);
        if (overlapAcc < overlap) start -= 1;
      }
    }

    // 累计到 target（或 Cue 用尽）即闭合；
    // 至少推进到 prevEnd + 1：保证每块含上一块之后的新 Cue，不会死循环，
    // 也保证单条超长 Cue 不被切断（它只会整条出现在块中）
    let end = start;
    let acc = cueWeight(cues[start]);
    while (end + 1 < cues.length && (acc < target || end <= prevEnd)) {
      end += 1;
      acc += cueWeight(cues[end]);
    }

    chunks.push(cues.slice(start, end + 1));
    prevEnd = end;
    if (prevEnd >= cues.length - 1) break;
  }

  return chunks;
}
