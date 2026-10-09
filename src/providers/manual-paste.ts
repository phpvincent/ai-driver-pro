/**
 * 手动粘贴通道（SPEC-02 子任务 2.3，TECH-DESIGN §7.1）。
 *
 * 纯函数：detectAndParse（2.1）自动识别 SRT / VTT / 纯文本并解析，
 * 再经 normalizeCues 规范化（去重 / 合并 / 语气词过滤）。
 * cues 为空（无法解析或全部被过滤）返回 no_subtitle 语义的 FetchResult；
 * 非空返回 manual_pasted。永不 throw（红线 8）。
 */
import type { FetchResult } from '../types';
import { detectAndParse } from '../core/subtitle/parsers';
import { normalizeCues } from '../core/subtitle/normalize';

export function manualPaste(rawText: string): FetchResult {
  const cues = normalizeCues(detectAndParse(rawText));
  if (cues.length === 0) {
    return { cues: [], status: 'no_subtitle', error: '无法解析粘贴内容' };
  }
  return { cues, status: 'manual_pasted', source: 'manual' };
}
