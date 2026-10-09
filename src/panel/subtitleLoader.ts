/**
 * 字幕瀑布接线层（SPEC-02 2.3/2.4 由父 agent 接线）。
 * 组装真实依赖：fetchBiliSubtitles（B 站通道）+ createSubtitleDb（IndexedDB）+
 * runSubtitleWaterfall（编排）。panel 侧唯一字幕数据入口。
 */
import { fetchBiliSubtitles } from '../providers/bilibili';
import { runSubtitleWaterfall } from '../providers/waterfall';
import { createSubtitleDb, getSubtitle, saveSubtitle } from '../storage/db';
import type { Cue, FetchResult, VideoMeta } from '../types';

/** 模块级单例 DB（惰性 open 由 db 层内部保证幂等） */
const db = createSubtitleDb();

export function loadSubtitles(videoId: string, meta: VideoMeta): Promise<FetchResult> {
  return runSubtitleWaterfall(
    {
      videoId,
      bvid: meta.bvid,
      page: meta.page,
      meta,
    },
    {
      fetchBili: ({ bvid, page }) => fetchBiliSubtitles({ bvid, page }),
      getSubtitle: (vid) => getSubtitle(db, vid),
      saveSubtitle: (rec) => saveSubtitle(db, rec),
    },
  );
}

/** 手动粘贴：复用瀑布的手动直达通道（成功结果由瀑布落缓存） */
export function loadSubtitlesManual(
  videoId: string,
  meta: VideoMeta,
  manualText: string,
): Promise<FetchResult> {
  return runSubtitleWaterfall(
    {
      videoId,
      bvid: meta.bvid,
      page: meta.page,
      meta,
      manualText,
    },
    {
      fetchBili: ({ bvid, page }) => fetchBiliSubtitles({ bvid, page }),
      getSubtitle: (vid) => getSubtitle(db, vid),
      saveSubtitle: (rec) => saveSubtitle(db, rec),
    },
  );
}

// ---------------------------------------------------------------------------
// AI 字幕顺句（SPEC-08 8.5）：手动触发，仅 bili_ai 来源；结果落缓存，可切回原文
// ---------------------------------------------------------------------------

import { chatCompletion } from '../core/harness/modelClient';
import { punctuateCues } from '../core/subtitle/punctuate';
import { getSubtitlePunctuateSystemPrompt, PROMPT_VERSIONS } from '../prompts';
import { resolveModel } from './settings/modelForm';
import { MSG } from '../messages';
import type { Settings } from '../types';

/** 读设置（与各 loader 同款的最小实现） */
async function fetchSettings(): Promise<Settings> {
  // background 对 GET_SETTINGS 直接返回 settings 对象本身（不是 {settings} 包一层）
  const res = (await chrome.runtime.sendMessage({ type: MSG.GET_SETTINGS })) as Settings | null;
  return (res ?? {}) as Settings;
}

export interface PunctuateResult {
  cues: Cue[];
  /** 是否已处于整理后状态 */
  punctuated: boolean;
  /** 模型块数与回落块数（0 回落 = 全部通过校验） */
  chunks: number;
  fallbackChunks: number;
}

/** 读取某视频的顺句状态（字幕 Tab 初始化按钮用） */
export async function getPunctuateState(videoId: string): Promise<boolean> {
  const rec = await getSubtitle(db, videoId).catch(() => null);
  return rec?.punctuated?.promptVersion === PROMPT_VERSIONS.subtitlePunctuate;
}

/** 整理字幕：模型给 ASR 字幕加标点 / 改同音错字；时间戳与句数不可变（核心层校验） */
export async function punctuateSubtitles(videoId: string): Promise<PunctuateResult> {
  const rec = await getSubtitle(db, videoId).catch(() => null);
  if (!rec) throw new Error('未找到字幕缓存，请先加载字幕');
  if (rec.source !== 'bili_ai') throw new Error('仅 AI 字幕需要整理（UP 主字幕已有标点）');
  // 幂等：已按当前 promptVersion 整理过 → 直接返回
  if (rec.punctuated?.promptVersion === PROMPT_VERSIONS.subtitlePunctuate) {
    return { cues: rec.cues, punctuated: true, chunks: 0, fallbackChunks: 0 };
  }
  const settings = await fetchSettings();
  const model = resolveModel(settings);
  if (!model?.apiKey) throw new Error('模型未配置：请先在设置页配置模型');
  const { cues, chunks, fallbackChunks } = await punctuateCues(
    rec.cues,
    ({ systemPrompt, userPrompt }) =>
      chatCompletion({
        baseUrl: model.baseUrl,
        apiKey: model.apiKey,
        model: model.model,
        temperature: 0.1,
        maxTokens: Math.min(model.maxTokens, 4_096),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        responseFormatJson: true,
        thinking: { type: 'disabled' },
        label: 'punctuate',
      }).then((r) => ({ content: r.content })),
    getSubtitlePunctuateSystemPrompt,
  );
  await saveSubtitle(db, {
    ...rec,
    cues,
    punctuated: { promptVersion: PROMPT_VERSIONS.subtitlePunctuate, rawCues: rec.punctuated?.rawCues ?? rec.cues },
  });
  return { cues, punctuated: true, chunks, fallbackChunks };
}

/** 切回 ASR 原文（整理结果丢弃） */
export async function restoreRawSubtitles(videoId: string): Promise<Cue[]> {
  const rec = await getSubtitle(db, videoId).catch(() => null);
  if (!rec?.punctuated) throw new Error('当前字幕不是整理后的状态');
  const rawCues = rec.punctuated.rawCues;
  const { punctuated: _drop, ...rest } = rec;
  await saveSubtitle(db, { ...rest, cues: rawCues });
  return rawCues;
}
