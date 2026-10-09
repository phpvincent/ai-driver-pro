/**
 * Cue 规范化（SPEC-02 子任务 2.1）。
 *
 * 管线顺序：丢弃无效项 → 合并过短相邻段 → 语气词过滤 →
 * rolling caption 去重（保留时间戳，逻辑移植自 ai-knowlage
 * `_normalize_subtitle_text`）→ index 重排。全部纯函数，无 chrome.* 依赖。
 */
import type { Cue } from '../../types';
import { SUBTITLE } from '../../config';

/** 相邻两条 Cue 间隙小于该值视为"时间相邻"，可参与短段合并 */
const MERGE_GAP_MS = 500;

/**
 * 纯语气词词表：段文本仅由这些词条（可重复、可组合）组成时整段丢弃。
 * 词表为模块常量，便于后续按需扩充。
 */
const FILLER_WORDS: readonly string[] = [
  '嗯',
  '啊',
  '呃',
  '哦',
  '哈',
  '唉',
  '诶',
  '就是',
  '然后',
  '那个',
];

/** 判定前先剔除空白与常见中英文标点，避免 "嗯，啊" 这类被误保留 */
const IGNORED_CHARS_RE = /[\s，。、！？；：,.!?;:…~～—-]/g;

/** 判断文本是否完全由词表语气词拼接而成（如 "嗯嗯啊"、"就是然后"） */
function isFillerOnly(text: string): boolean {
  const stripped = text.replace(IGNORED_CHARS_RE, '');
  if (stripped === '') return false;
  // DP：reachable[i] = 前 i 个字符可由词表拼出
  const n = stripped.length;
  const reachable = new Array<boolean>(n + 1).fill(false);
  reachable[0] = true;
  for (let i = 0; i < n; i++) {
    if (!reachable[i]) continue;
    for (const word of FILLER_WORDS) {
      if (stripped.startsWith(word, i)) {
        reachable[i + word.length] = true;
      }
    }
  }
  return reachable[n];
}

/** 无效项：text 空/纯空白、startMs<0、endMs<=startMs */
function isValidCue(cue: Cue): boolean {
  return (
    typeof cue.text === 'string' &&
    cue.text.trim() !== '' &&
    Number.isFinite(cue.startMs) &&
    cue.startMs >= 0 &&
    Number.isFinite(cue.endMs) &&
    cue.endMs > cue.startMs
  );
}

/**
 * 合并过短相邻段：时长 < SUBTITLE.mergeShorterThanMs 且与下一条间隙
 * < MERGE_GAP_MS → 吸收下一条（text 拼接、endMs 取后者）。链式进行：
 * 合并结果仍过短时继续吸收，直到时长达标或不再相邻。
 */
function mergeShortCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const last = out[out.length - 1];
    if (
      last !== undefined &&
      last.endMs - last.startMs < SUBTITLE.mergeShorterThanMs &&
      cue.startMs - last.endMs < MERGE_GAP_MS
    ) {
      last.text += cue.text;
      last.endMs = cue.endMs;
      if (cue.approximate) last.approximate = true;
    } else {
      out.push({ ...cue });
    }
  }
  return out;
}

/**
 * Cue 规范化（纯函数）：
 * 1. 丢弃无效项（空文本 / startMs<0 / endMs<=startMs）
 * 2. 合并 <800ms 且与下一条相邻（间隙 <500ms）的短段
 * 3. 丢弃纯语气词段
 * 4. rolling caption 去重：与前一条 text 完全相同 → 丢弃（时间戳保留在幸存条上）
 * 5. index 重排为 0..n-1
 *
 * 空输入或全部被过滤 → 返回 []。不改变输入数组（浅拷贝每条输出）。
 */
export function normalizeCues(cues: Cue[]): Cue[] {
  if (!Array.isArray(cues)) return [];

  // 1. 丢弃无效项
  const valid = cues.filter(isValidCue);

  // 2. 合并过短相邻段
  const merged = mergeShortCues(valid);

  // 3. 语气词过滤
  const noFiller = merged.filter((cue) => !isFillerOnly(cue.text));

  // 4. rolling caption 去重
  const deduped: Cue[] = [];
  for (const cue of noFiller) {
    const last = deduped[deduped.length - 1];
    if (last !== undefined && last.text === cue.text) continue;
    deduped.push(cue);
  }

  // 5. index 重排
  return deduped.map((cue, i) => ({ ...cue, index: i }));
}
