/**
 * AI 字幕顺句（SPEC-08 8.5）：给无标点的 ASR 字幕加标点、改同音错字。
 *
 * 铁的约束（红线 5"字幕解析禁止丢弃时间戳"的顺句版）：
 * - **数量 / 顺序 / i 值逐一相等**，否则整块回落原文；
 * - **startMs / endMs / index 一律原样保留**，只替换 text；
 * - 单句除标点外的**改动字数 > 原文 30%** 视为越权改写，该句保留原文；
 * - 模型不可用 / 失败 / 任何校验不过 → 原文返回，绝不抛错中断。
 *
 * 纯函数（分块 / 构造 / 校验 / 合并）+ 注入式 modelFn，零 chrome.* 依赖。
 */
import { z } from 'zod';
import { PUNCTUATE } from '../../config';
import { parseJsonLoose } from '../pipeline/jsonRepair';
import type { Cue } from '../../types';

/** 模型输出 Schema：{"lines":[{"i":0,"t":"…"}]} */
export const PunctuateLinesSchema = z.object({
  lines: z.array(z.object({ i: z.number().int(), t: z.string() })),
});

export type PunctuateModelFn = (req: { systemPrompt: string; userPrompt: string }) => Promise<{ content: string }>;

/** 按累计字符数分块（不拆散单条 Cue；块间无重叠） */
export function chunkCuesForPunctuate(cues: Cue[], maxChars: number = PUNCTUATE.chunkChars): Cue[][] {
  const chunks: Cue[][] = [];
  let cur: Cue[] = [];
  let used = 0;
  for (const c of cues) {
    const cost = c.text.length + 1;
    if (cur.length > 0 && used + cost > maxChars) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(c);
    used += cost;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/** 单块的用户消息：逐行 {"i":…,"t":"…"}（i 用 Cue.index，全局唯一） */
export function buildPunctuateUserPrompt(chunk: Cue[]): string {
  const lines = chunk.map((c) => JSON.stringify({ i: c.index, t: c.text }));
  return ['以下待整理字幕：', ...lines].join('\n');
}

/**
 * 校验并应用单块输出（纯函数）：
 * - i 集合与输入完全一致（不重不漏）→ 应用；
 * - 任一句越权改写（去标点后字符差 > 30%）→ 该句保留原文；
 * - i 不匹配 / 解析失败 → 整块保留原文（返回 fallback = true 供统计）。
 */
export function applyPunctuateChunk(content: string, chunk: Cue[]): { cues: Cue[]; fallback: boolean } {
  const original = chunk.map((c) => ({ ...c }));
  const loose = parseJsonLoose(content);
  const parsed = PunctuateLinesSchema.safeParse(loose ? loose.value : safeJson(content));
  if (!parsed.success) return { cues: original, fallback: true };
  const byIndex = new Map(chunk.map((c) => [c.index, c]));
  const seen = new Set<number>();
  for (const line of parsed.data.lines) {
    if (seen.has(line.i)) return { cues: original, fallback: true };
    seen.add(line.i);
  }
  if (seen.size !== chunk.length || chunk.some((c) => !seen.has(c.index))) {
    return { cues: original, fallback: true };
  }
  const textByIndex = new Map(parsed.data.lines.map((l) => [l.i, l.t]));
  const out = chunk.map((c) => {
    const t = textByIndex.get(c.index) ?? '';
    // 只允许换 text；index/startMs/endMs 原样（结构上就不可能被模型改到）
    return { ...c, text: acceptable(c.text, t) ? t : c.text };
  });
  return { cues: out, fallback: false };
}

/**
 * 单句可接受性：去掉标点与空白后，字符差异 ≤ 原文长度的 30%。
 * 同音错字（1~2 字替换）远低于该阈值；整句改写必然超过。
 */
export function acceptable(original: string, revised: string): boolean {
  if (revised.length === 0) return false;
  const a = stripPunct(original);
  const b = stripPunct(revised);
  if (a === b) return true;
  if (a.length === 0) return false;
  const diff = levenshtein(a, b);
  // 分母取 max(4, len)：两三字的超短句允许 1 个同音字替换（1/2=50% 会误杀）
  return diff / Math.max(4, a.length) <= PUNCTUATE.maxChangeRatio;
}

/** 去掉中英文标点与空白（只比较"内容字"） */
function stripPunct(s: string): string {
  return s.replace(/[\s，。、；：？！""''（）()\[\]【】《》…—·,.:;?!~'"-]/g, '');
}

/** 编辑距离（短句够用；ASR 句长通常 < 40 字） */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

/**
 * 整段顺句（顺序逐块调用，成本可控且失败互不影响）。
 * 返回整理后的 cues（任何失败处保留原文）与统计信息。
 */
export async function punctuateCues(
  cues: Cue[],
  modelFn: PunctuateModelFn,
  getSystemPrompt: () => string,
  chunkChars: number = PUNCTUATE.chunkChars,
): Promise<{ cues: Cue[]; chunks: number; fallbackChunks: number }> {
  const chunks = chunkCuesForPunctuate(cues, chunkChars);
  const out: Cue[] = [];
  let fallbackChunks = 0;
  const systemPrompt = getSystemPrompt();
  for (const chunk of chunks) {
    try {
      const { content } = await modelFn({ systemPrompt, userPrompt: buildPunctuateUserPrompt(chunk) });
      const applied = applyPunctuateChunk(content, chunk);
      if (applied.fallback) fallbackChunks += 1;
      out.push(...applied.cues);
    } catch {
      fallbackChunks += 1;
      out.push(...chunk);
    }
  }
  return { cues: out, chunks: chunks.length, fallbackChunks };
}

function safeJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}
