/**
 * 多轮对话记忆（SPEC-14）：模块级 store——"切换即卸载"的 Tab 容器里长任务
 * 状态必须外置（切 Tab 再回来不再失忆）。
 *
 * 结构（对齐成熟 agent 的三段式记忆）：
 * - sessionSummary：被挤出窗口的旧轮，合并成的会话摘要（滚动）
 * - turns：最近 N 轮原文（问题原文 + 回答要点摘要，digest 口径不变）
 *
 * 压缩：溢出时先尝试一次 flash 小调用把「旧摘要 + 被挤出轮」合并成新摘要；
 * 失败降级为文本追加（信息不丢，只是变长）。压缩是后台异步的，不阻塞问答。
 */

/** 窗口内保留的轮数（超出进入会话摘要） */
export const DIALOGUE_MAX_TURNS = 5;

/** 会话摘要的字符上限（降级追加路径的硬顶，防无限膨胀） */
export const SUMMARY_MAX_CHARS = 600;

/**
 * store 视频数上限（SPEC-21 R3）：单条目内有界（5 轮/600 字），但视频数量原本无界。
 * Map 保插入序，访问时 re-insert 实现 LRU；超限挤出最久未访问。
 */
export const DIALOGUE_MAX_VIDEOS = 20;

export interface DialogueTurn {
  q: string;
  a: string;
}

interface VideoMemory {
  summary: string;
  turns: DialogueTurn[];
}

const store = new Map<string, VideoMemory>();

function mem(videoId: string): VideoMemory {
  let m = store.get(videoId);
  if (m) {
    // LRU：命中提到末尾（Map 保插入序，delete+set = move to end）
    store.delete(videoId);
  } else {
    m = { summary: '', turns: [] };
    while (store.size >= DIALOGUE_MAX_VIDEOS) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }
  store.set(videoId, m);
  return m;
}

/** 当前记忆快照（摘要 + 窗口内轮次）；拷贝返回防外部篡改 */
export function getDialogue(videoId: string): { summary: string; turns: DialogueTurn[] } {
  const m = mem(videoId);
  return { summary: m.summary, turns: m.turns.map((t) => ({ ...t })) };
}

/** 重建记忆（ChatTab 挂载时从 store 或 qaHistory 恢复） */
export function setDialogue(videoId: string, turns: DialogueTurn[], summary = ''): void {
  // 经 mem() 走 LRU 入口（SPEC-21 R3：直接 store.set 会绕过容量上限）
  const m = mem(videoId);
  m.summary = summary;
  m.turns = turns.map((t) => ({ ...t }));
}

/** 清空该视频记忆（换视频） */
export function clearDialogue(videoId: string): void {
  store.delete(videoId);
}

/** 全局清空（单测隔离用） */
export function resetDialogueStore(): void {
  store.clear();
}

/** 估算 token（中文 ≈ 0.6 token/字的保守近似，仅用于触发阈值判断） */
export function estTokensOf(text: string): number {
  return Math.ceil(text.length * 0.6);
}

/**
 * 追加一轮：先压入窗口；溢出则挤出最旧轮并返回待压缩内容
 * （调用方决定用模型压缩还是降级拼接；压缩完成后调 completeCompact 落盘）。
 */
export function appendTurn(
  videoId: string,
  turn: DialogueTurn,
): { evicted: DialogueTurn | null; summary: string } {
  const m = mem(videoId);
  m.turns.push({ ...turn });
  let evicted: DialogueTurn | null = null;
  if (m.turns.length > DIALOGUE_MAX_TURNS) {
    evicted = m.turns.shift() ?? null;
  }
  return { evicted, summary: m.summary };
}

/** 压缩完成：落盘新摘要（null = 降级路径由调用方自行拼接后传入） */
export function completeCompact(videoId: string, newSummary: string): void {
  const m = mem(videoId);
  m.summary = newSummary.slice(0, SUMMARY_MAX_CHARS);
}

/** 降级拼接（模型压缩失败时）：旧摘要 + 被挤出轮 → 追加式摘要（信息不丢） */
export function fallbackCompact(summary: string, evicted: DialogueTurn): string {
  const line = `Q：${evicted.q} A：${evicted.a}`;
  const next = summary.length === 0 ? line : `${summary}；${line}`;
  // 超硬顶时保尾（最新信息优先保留）
  return next.length > SUMMARY_MAX_CHARS ? `…${next.slice(next.length - SUMMARY_MAX_CHARS + 1)}` : next;
}

/** 生成压缩 prompt（导出供单测）：把旧摘要与挤出轮合并成新会话摘要 */
export function buildCompactPrompt(summary: string, evicted: DialogueTurn): string {
  const prev = summary.length > 0 ? `已有会话摘要：\n${summary}\n\n` : '';
  return `${prev}本轮被挤出记忆窗口的对话：\nQ：${evicted.q}\nA：${evicted.a}\n\n请把以上内容合并为一段不超过 200 字的会话摘要（学生问过什么、已获得哪些关键结论），只输出摘要正文，不要任何前后缀。`;
}

// ---------------------------------------------------------------------------
// 模型压缩（loader 层；ChatTab 保持不 import chrome.* 的契约）
// ---------------------------------------------------------------------------

import { chatCompletion } from '../core/harness/modelClient';
import { MSG } from '../messages';
import { resolveModel } from './settings/modelForm';
import type { Settings } from '../types';

/**
 * 滚动压缩（SPEC-14）：被挤出窗口的旧轮 → 当前模型小调用合并进会话摘要；
 * 模型未配置/任何失败 → 降级文本追加（信息不丢）。后台异步，不阻塞问答。
 */
export async function compactDialogue(
  videoId: string,
  prevSummary: string,
  evicted: DialogueTurn,
): Promise<void> {
  try {
    const settings = (await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS })) as Settings | null;
    const model = settings ? resolveModel(settings) : null;
    if (!model?.apiKey) {
      completeCompact(videoId, fallbackCompact(prevSummary, evicted));
      return;
    }
    const out = await chatCompletion({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.model,
      temperature: 0.2,
      // 800：思考模型（deepseek-flash 等）会先消耗推理 token 才写正文，
      // 300 会被 reasoning 全部吃光导致正文为空（2026-10-13 实测：finish_reason=length、
      // reasoning_tokens=300、content=""→降级）。摘要上限 200 字，800 给思考留了余量。
      maxTokens: 800,
      // 内部维护性调用：禁用思考（用户设置只该影响用户可见的生成；这里烧思考预算纯浪费）。
      // 端点不识别该字段时会被忽略，maxTokens 余量兜底。
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: '你是会话记录压缩器，只输出合并后的摘要正文。' },
        { role: 'user', content: buildCompactPrompt(prevSummary, evicted) },
      ],
      label: 'dialogue-compact',
    });
    const text = out.content.trim();
    completeCompact(videoId, text.length > 0 ? text : fallbackCompact(prevSummary, evicted));
  } catch {
    completeCompact(videoId, fallbackCompact(prevSummary, evicted));
  }
}
