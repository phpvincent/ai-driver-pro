/**
 * 笔记重新归位（SPEC-09 9.2，spec §3.3）：纯函数、确定性、零 chrome.* 依赖。
 *
 * 大纲重生成后，笔记按 **tMs**（锚定时间，创建后永不改写）重新对上章节：
 * 1. bullet 锚点：新大纲中 |startMs - tMs| ≤ 15s 且与旧要点文本相似度最高的要点
 *    → 挂上；找不到 → 降级为 time 锚点继续；
 * 2. section 锚点：tMs 落入的新章节；旧章节标题与新章节完全不同且时长重叠
 *    < 50% → 标记「待确认」（仍挂上，UI 显示黄点）；
 * 3. time 锚点：tMs 落入的章节；
 * 4. tMs 超出视频时长或无章节可落 → 「未归位」（sectionId 置空）；
 * 5. **永不删除**：所有输入笔记必然出现在结果里（"不丢笔记"的算法保证，
 *    A3 验收：任何情况下笔记总数不减少）。
 */
import { NOTES } from '../../config';
import type { OutlineNote, Section, SectionBullet } from '../../types';

/** 重新归位结果 */
export interface ReanchorResult {
  /** 全部笔记（顺序与输入一致；未归位的 anchor.sectionId = null） */
  notes: OutlineNote[];
  /** 待确认（挂上但章节变化可疑，UI 黄点）的笔记 id 集合 */
  pendingIds: ReadonlySet<string>;
  /** 未归位的笔记 id 集合 */
  unanchoredIds: ReadonlySet<string>;
}

/** 文本归一化：去首尾空白 + 小写（中文无大小写，英文统一） */
function normalizeText(s: string): string {
  return s.trim().toLowerCase();
}

/** 字符 bigram 集合（长度 <2 时退化为单字符集） */
function charBag(s: string): Set<string> {
  const t = normalizeText(s);
  if (t.length < 2) return new Set(t ? [t] : []);
  const bag = new Set<string>();
  for (let i = 0; i + 1 < t.length; i += 1) bag.add(t.slice(i, i + 2));
  return bag;
}

/**
 * 文本相似度（确定性，导出供单测）：字符 bigram Jaccard。
 * 完全相同 = 1；无公共 bigram = 0；中文短语的常见小幅改写落在 0~1 之间。
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;
  const A = charBag(a);
  const B = charBag(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/**
 * tMs 落入的章节（确定性）：最后一个 startMs ≤ tMs 的章；早于首章返回 null。
 * 章节连续（endMs = 下章 startMs - 1），超出末章 endMs 由调用方用视频时长判定。
 */
export function findSectionAt(sections: readonly Section[], tMs: number): Section | null {
  let ans: Section | null = null;
  for (const s of sections) {
    if (s.startMs <= tMs) ans = s;
    else break;
  }
  return ans;
}

/** 要点的合成 id（与交换格式一致：`${sectionId}-b${序号}`，序号从 1 开始） */
export function bulletIdOf(sectionId: string, bulletIndex: number): string {
  return `${sectionId}-b${bulletIndex + 1}`;
}

/** 旧锚点指向的要点文本（sectionId + bulletId 反查；解析不了返回 null） */
function resolveOldBulletText(
  oldSections: readonly Section[],
  sectionId: string | null,
  bulletId: string | null | undefined,
): string | null {
  if (!sectionId || !bulletId) return null;
  const sec = oldSections.find((s) => s.id === sectionId);
  if (!sec) return null;
  const m = /-b(\d+)$/.exec(bulletId);
  if (!m) return null;
  const bullet: SectionBullet | undefined = sec.bullets[Number(m[1]) - 1];
  return bullet?.text ?? null;
}

/**
 * 章节时长重叠比例（待确认判定用）：交集 / 较短章节时长；区间为闭区间（毫秒）。
 */
function sectionOverlapRatio(a: Section, b: Section): number {
  const overlap = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs) + 1;
  if (overlap <= 0) return 0;
  const shorter = Math.min(a.endMs - a.startMs + 1, b.endMs - b.startMs + 1);
  return shorter > 0 ? overlap / shorter : 0;
}

/** 章节标题是否「完全不同」（trim 后逐字相等才算相同） */
function titleDiffers(a: Section, b: Section): boolean {
  return a.title.trim() !== b.title.trim();
}

/** bullet 锚点匹配：窗口内相似度最高的新要点；无有效候选返回 null */
function matchBullet(
  oldText: string | null,
  newSections: readonly Section[],
  tMs: number,
): { sectionId: string; bulletId: string } | null {
  if (oldText === null) return null;
  let best: { sectionId: string; bulletId: string; sim: number } | null = null;
  // 普通 for 循环（非 forEach）：闭包内赋值会让 TS 的控制流分析失效
  for (const sec of newSections) {
    for (let i = 0; i < sec.bullets.length; i += 1) {
      const b = sec.bullets[i]!;
      if (Math.abs(b.startMs - tMs) > NOTES.reanchorBulletWindowMs) continue;
      const sim = textSimilarity(oldText, b.text);
      if (sim > 0 && (best === null || sim > best.sim)) {
        best = { sectionId: sec.id, bulletId: bulletIdOf(sec.id, i), sim };
      }
    }
  }
  return best ? { sectionId: best.sectionId, bulletId: best.bulletId } : null;
}

/**
 * 重新归位（纯函数，spec §3.3 算法实现）。
 *
 * @param notes 现有笔记（anchor 指向旧大纲）
 * @param oldSections 旧大纲（解析旧 bullet 文本、待确认比对）
 * @param newSections 重生成后的新大纲
 * @param videoDurationMs 视频时长（毫秒）；tMs ≥ 此值的笔记进「未归位」
 */
export function reanchorNotes(
  notes: readonly OutlineNote[],
  oldSections: readonly Section[],
  newSections: readonly Section[],
  videoDurationMs: number,
): ReanchorResult {
  const pendingIds = new Set<string>();
  const unanchoredIds = new Set<string>();
  const out: OutlineNote[] = notes.map((note) => {
    const { tMs } = note.anchor;

    // 4. 越界：超出视频时长或早于 0 → 未归位（永不删除，tMs 原样保留）
    if (!Number.isFinite(tMs) || tMs < 0 || tMs >= videoDurationMs || newSections.length === 0) {
      unanchoredIds.add(note.id);
      return { ...note, anchor: { ...note.anchor, sectionId: null, bulletId: null } };
    }

    const target = findSectionAt(newSections, tMs);
    if (!target) {
      unanchoredIds.add(note.id);
      return { ...note, anchor: { ...note.anchor, sectionId: null, bulletId: null } };
    }

    if (note.anchor.kind === 'bullet') {
      // 1. bullet：窗口内相似度最高的新要点；找不到降级为 time
      const oldText = resolveOldBulletText(oldSections, note.anchor.sectionId, note.anchor.bulletId);
      const hit = matchBullet(oldText, newSections, tMs);
      if (hit) {
        return {
          ...note,
          anchor: { ...note.anchor, sectionId: hit.sectionId, bulletId: hit.bulletId },
        };
      }
      return {
        ...note,
        anchor: { kind: 'time', sectionId: target.id, bulletId: null, tMs },
      };
    }

    // 2. section / 3. time：落入新章节；section 锚点做「待确认」判定
    if (note.anchor.kind === 'section') {
      const oldSec = oldSections.find((s) => s.id === note.anchor.sectionId);
      if (
        oldSec &&
        titleDiffers(oldSec, target) &&
        sectionOverlapRatio(oldSec, target) < NOTES.reanchorPendingOverlapRatio
      ) {
        pendingIds.add(note.id);
      }
    }
    return { ...note, anchor: { ...note.anchor, sectionId: target.id, bulletId: null } };
  });

  return { notes: out, pendingIds, unanchoredIds };
}
