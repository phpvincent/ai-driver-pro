/**
 * 大纲笔记接线层（SPEC-09 9.3/9.4/9.6 数据侧；UI 见 NotesUi.tsx）。
 *
 * - notes store 读写（9.1 的 db API）+ 重新归位（9.2 reanchor）+ 助教回答
 *   （9.4：explain 区间 = 锚点所在章节）+ 交换格式导入导出组装（9.6/9.5）；
 * - 导入的大纲落在 `videoId::imported::{model}` 键（不被本地 promptVersion
 *   升级误失效，spec §3.4）；outlineLoader.loadOutlineCached 未命中标准键时
 *   回退读 imported 记录；
 * - 红线：本层不写 UI 状态；DB 异常向上抛由调用方行内展示。
 */
import { useCallback, useEffect, useState } from 'react';
import { DB } from '../../config';
import {
  createSubtitleDb,
  deleteNote as dbDeleteNote,
  getOutline,
  listNotesByVideo,
  saveNote,
  saveOutline,
} from '../../storage/db';
import { reanchorNotes } from '../../core/notes/reanchor';
import {
  buildOutlineExport,
  outlineExportFileName,
  type VscOutlineFile,
} from '../../core/exchange/vscOutline';
import { explain } from '../explainLoader';
import { PROMPT_VERSIONS } from '../../prompts';
import { resolveModel } from '../settings/modelForm';
import { MSG } from '../../messages';
import type {
  NoteAnchor,
  NoteAnchorKind,
  NoteAuthor,
  OutlineNote,
  Section,
  VideoMeta,
} from '../../types';
import type { OutlineRecord } from '../../types';

/** 模块级单例 DB（惰性 open 由 db 层内部保证幂等） */
const db = createSubtitleDb();

/** chrome.runtime.sendMessage 安全包装 */
function sendRuntimeMessage(message: unknown): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve(null);
  }
}

// ---------------------------------------------------------------------------
// 笔记 CRUD
// ---------------------------------------------------------------------------

/** 新笔记 id：`n_{36进制时间戳}{随机4位}`（同一毫秒内多创建不碰撞） */
export function newNoteId(now = Date.now()): string {
  return `n_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 创建笔记并落库；返回完整记录 */
export async function createNote(args: {
  videoId: string;
  anchor: NoteAnchor;
  body: string;
  now?: () => Date;
}): Promise<OutlineNote> {
  const ts = (args.now ?? (() => new Date()))().toISOString();
  const note: OutlineNote = {
    id: newNoteId(),
    videoId: args.videoId,
    anchor: args.anchor,
    body: args.body,
    createdAt: ts,
    updatedAt: ts,
    replies: [],
  };
  await saveNote(db, note);
  return note;
}

/** 编辑正文（updatedAt 刷新；replies 原样保留） */
export async function updateNoteBody(
  note: OutlineNote,
  body: string,
  now: () => Date = () => new Date(),
): Promise<OutlineNote> {
  const next: OutlineNote = { ...note, body, updatedAt: new Date(now()).toISOString() };
  await saveNote(db, next);
  return next;
}

/** 追加回复（讨论串；author 区分 self/assistant） */
export async function appendReply(
  note: OutlineNote,
  reply: { author: NoteAuthor; body: string },
  now: () => Date = () => new Date(),
): Promise<OutlineNote> {
  const next: OutlineNote = {
    ...note,
    replies: [
      ...note.replies,
      { id: `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...reply, createdAt: new Date(now()).toISOString() },
    ],
    updatedAt: new Date(now()).toISOString(),
  };
  await saveNote(db, next);
  return next;
}

/** 删除笔记（键 note.id） */
export async function removeNote(noteId: string): Promise<void> {
  await dbDeleteNote(db, noteId);
}

/** 列出某视频全部笔记（createdAt 升序） */
export async function listNotes(videoId: string): Promise<OutlineNote[]> {
  return await listNotesByVideo(db, videoId);
}

// ---------------------------------------------------------------------------
// 重新归位（重生成后调用，9.2 接线）
// ---------------------------------------------------------------------------

/**
 * 重生成后归位：旧锚点按 tMs 重新挂到新大纲，逐条覆盖写回；
 * 返回归位结果（pendingIds=待确认黄点，unanchoredIds=未归位）。
 */
export async function reanchorAfterRegenerate(args: {
  videoId: string;
  oldSections: Section[];
  newSections: Section[];
  durationMs: number;
}): Promise<{ notes: OutlineNote[]; pendingIds: ReadonlySet<string>; unanchoredIds: ReadonlySet<string> }> {
  const notes = await listNotesByVideo(db, args.videoId);
  if (notes.length === 0) {
    return { notes, pendingIds: new Set(), unanchoredIds: new Set() };
  }
  const result = reanchorNotes(notes, args.oldSections, args.newSections, args.durationMs);
  for (const note of result.notes) {
    await saveNote(db, note);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 请助教回答（9.4：区间 = 锚点所在章节）
// ---------------------------------------------------------------------------

/** 从本地章节解析笔记的提问区间：优先锚点章节，退化按 tMs 落章 */
function rangeOfNote(note: OutlineNote, sections: Section[]): [number, number] | null {
  const byId = sections.find((s) => s.id === note.anchor.sectionId);
  if (byId) return [byId.startMs, byId.endMs];
  const at = sections.find((s) => s.startMs <= note.anchor.tMs && note.anchor.tMs < s.endMs);
  return at ? [at.startMs, at.endMs] : null;
}

/**
 * 「请助教回答」：笔记正文作为问题、区间 = 锚点所在章节，走既有 explain
 * 管线（知识库 / 公开资料 / 画面全链路 + qaHistory 落库）；回答作为
 * author=assistant 的回复追加进讨论串，返回更新后的笔记。
 */
export async function askAssistantForNote(
  note: OutlineNote,
  sections: Section[],
): Promise<OutlineNote> {
  const rangeMs = rangeOfNote(note, sections);
  const res = await explain({
    question: note.body,
    rangeMs,
    positionMs: note.anchor.tMs,
  });
  const body =
    res.answer?.answer?.trim() ||
    (res.answer?.keyPoints?.length ? res.answer.keyPoints.join('；') : '') ||
    '（模型未返回有效回答，可重试）';
  return await appendReply(note, { author: 'assistant', body });
}

// ---------------------------------------------------------------------------
// 导出（9.6 出口；格式本体在 core/exchange，9.5）
// ---------------------------------------------------------------------------

async function readSettings(): Promise<Record<string, unknown>> {
  const response = await sendRuntimeMessage({ type: MSG.GET_SETTINGS });
  const stored = (response ?? {}) as Record<string, unknown>;
  return stored && typeof stored === 'object' ? stored : {};
}

/**
 * 解析当前大纲的 promptVersion/model（导出元信息）：
 * 优先标准缓存记录，miss 时找 imported 记录（`videoId::imported::` 前缀，取最新）。
 */
export async function getOutlineExportMeta(
  videoId: string,
): Promise<{ promptVersion: string; model: string } | null> {
  const settings = await readSettings();
  const model = resolveModel(settings as never);
  if (model?.apiKey) {
    try {
      const cached = await getOutline(db, videoId, PROMPT_VERSIONS.outline, model.model);
      if (cached && cached.sections.length > 0) {
        return { promptVersion: cached.promptVersion, model: cached.model };
      }
    } catch {
      /* 读失败继续找 imported */
    }
  }
  try {
    const all = await db.getAll<OutlineRecord>(DB.stores.outlines);
    const imported = all
      .filter((r) => r && r.videoId === videoId)
      .filter((r) => typeof r.promptVersion === 'string' && typeof r.model === 'string')
      .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1));
    if (imported.length > 0) {
      return { promptVersion: imported[0]!.promptVersion, model: imported[0]!.model };
    }
  } catch {
    /* 无 imported 记录 */
  }
  return null;
}

/** 导出大纲（含可选笔记）为交换文件 + 建议文件名 */
export async function exportOutlineFile(args: {
  videoId: string;
  meta: VideoMeta;
  sections: Section[];
  includeNotes: boolean;
  appVersion?: string;
}): Promise<{ json: string; filename: string }> {
  const [meta, notes] = await Promise.all([
    getOutlineExportMeta(args.videoId),
    args.includeNotes ? listNotesByVideo(db, args.videoId) : Promise.resolve([]),
  ]);
  const file = await buildOutlineExport({
    meta: args.meta,
    promptVersion: meta?.promptVersion ?? 'unknown',
    model: meta?.model ?? 'unknown',
    sections: args.sections,
    notes,
    appVersion: args.appVersion ?? '0.1.0',
  });
  return {
    json: JSON.stringify(file, null, 2),
    filename: outlineExportFileName(args.meta.title, args.meta.bvid, args.meta.page),
  };
}

// ---------------------------------------------------------------------------
// 导入（9.6 入口；校验在 core/exchange，这里负责落库与冲突处理）
// ---------------------------------------------------------------------------

/** 交换格式 section → 本地 Section（派生字段回填默认值，score/density 由重算覆盖） */
function exchangeSectionToLocal(s: VscOutlineFile['outline']['sections'][number]): Section {
  return {
    id: s.id,
    title: s.title,
    startMs: s.startMs,
    endMs: s.endMs,
    summary: s.summary,
    bullets: s.bullets.map((b) => ({ text: b.text, startMs: b.startMs })),
    terms: [...s.terms],
    importance: s.importance,
    density: 'mid',
    cueRange: [0, 0],
  };
}

/**
 * 导入笔记映射（纯函数，导出供单测）：
 * - 锚点按 tMs 归位到本地章节（oldSections = 文件里的大纲，供 bullet 文本匹配）；
 * - 全部标记 importedFrom（导出方 + 时间）；
 * - id 防碰撞：与本地已有 id 冲突时加序号后缀（不覆盖任何已有笔记）。
 */
export function mapImportedNotes(
  file: VscOutlineFile,
  localSections: Section[],
  durationMs: number,
  existingIds: ReadonlySet<string>,
  /** 二轮冒烟：导入的笔记超出现频时长时直接丢弃（自动忽略），而非进未归位 */
  dropOutOfRange = false,
): { notes: OutlineNote[]; droppedOutOfRange: number } {
  const fileSections = file.outline.sections.map(exchangeSectionToLocal);
  const imported: OutlineNote[] = file.notes.map((n) => ({
    id: n.id,
    videoId: file.video.bvid
      ? `${file.video.bvid}_p${file.video.page}`
      : '',
    anchor: {
      kind: n.anchor.kind,
      sectionId: n.anchor.sectionId,
      ...(n.anchor.bulletId != null ? { bulletId: n.anchor.bulletId } : {}),
      tMs: n.anchor.tMs,
    },
    body: n.body,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    replies: n.replies.map((r) => ({ ...r })),
    importedFrom: { exporter: file.exporter.app, exportedAt: file.exportedAt },
  }));
  const reanchored = reanchorNotes(imported, fileSections, localSections, durationMs);
  const kept = dropOutOfRange
    ? reanchored.notes.filter((n) => n.anchor.tMs < durationMs)
    : reanchored.notes;
  const droppedOutOfRange = reanchored.notes.length - kept.length;
  const used = new Set(existingIds);
  const notes = kept.map((note) => {
    if (!used.has(note.id)) {
      used.add(note.id);
      return note;
    }
    let i = 2;
    let id = `${note.id}~${i}`;
    while (used.has(id)) {
      i += 1;
      id = `${note.id}~${i}`;
    }
    used.add(id);
    return { ...note, id };
  });
  return { notes, droppedOutOfRange };
}

/** 交换格式大纲 → 本地大纲缓存记录（imported 键；不被 promptVersion 升级失效） */
export async function saveImportedOutline(
  videoId: string,
  file: VscOutlineFile,
  now: () => Date = () => new Date(),
): Promise<Section[]> {
  const sections = file.outline.sections.map(exchangeSectionToLocal);
  const rec: OutlineRecord = {
    videoId,
    promptVersion: file.outline.promptVersion,
    model: file.outline.model,
    sections,
    chunkState: [],
    tokenUsage: { input: 0, output: 0 },
    createdAt: new Date(now()).toISOString(),
  };
  // imported 标记进键：`videoId::imported::{model}`（spec §3.4）
  await db.put(DB.stores.outlines, `${videoId}::imported::${file.outline.model}`, rec);
  return sections;
}

/** 导入笔记落库（id 已在 mapImportedNotes 防碰撞） */
export async function saveImportedNotes(notes: OutlineNote[]): Promise<void> {
  for (const n of notes) {
    await saveNote(db, n);
  }
}

/**
 * 导入前的本地备份（spec §3.4：替换前自动备份本地大纲到交换格式文件）。
 * 返回备份 JSON 与文件名（null = 本地无大纲/笔记，无需备份）。
 */
export async function buildLocalBackup(args: {
  videoId: string;
  meta: VideoMeta;
  sections: Section[];
}): Promise<{ json: string; filename: string } | null> {
  const notes = await listNotesByVideo(db, args.videoId);
  if (args.sections.length === 0 && notes.length === 0) return null;
  const { json, filename } = await exportOutlineFile({
    videoId: args.videoId,
    meta: args.meta,
    sections: args.sections,
    includeNotes: true,
  });
  return { json, filename: `备份_${filename}` };
}

// ---------------------------------------------------------------------------
// useNotes hook（OutlineTab 消费；数据状态与刷新）
// ---------------------------------------------------------------------------

export interface NotesState {
  notes: OutlineNote[];
  /** 锚点落到某章节（sectionId 相等）的笔记，按创建序 */
  notesBySection: (sectionId: string) => OutlineNote[];
  /** 未归位（sectionId=null）的笔记 */
  unanchored: OutlineNote[];
  /** 重生成归位后的待确认 id 集合（UI 黄点；null = 无最近一次归位） */
  pendingIds: ReadonlySet<string> | null;
  reload: () => Promise<void>;
  addNote: (anchor: NoteAnchor, body: string) => Promise<void>;
  updateBody: (note: OutlineNote, body: string) => Promise<void>;
  remove: (note: OutlineNote) => Promise<void>;
  reply: (note: OutlineNote, body: string) => Promise<void>;
  askAssistant: (note: OutlineNote) => Promise<void>;
  /** 重生成后归位（调用方传新旧章节），返回笔记数供确认框用 */
  reanchor: (oldSections: Section[], newSections: Section[], durationMs: number) => Promise<void>;
  /** 「请助教回答」进行中的笔记 id（null = 无） */
  busyId: string | null;
}

/** 大纲 Tab 的笔记状态（videoId 变化自动重载；无视频为空态） */
export function useNotes(videoId: string | null, sections: Section[]): NotesState {
  const [notes, setNotes] = useState<OutlineNote[]>([]);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string> | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!videoId) {
      setNotes([]);
      return;
    }
    try {
      setNotes(await listNotesByVideo(db, videoId));
    } catch (err) {
      console.error('[vsc] notes load failed', err);
    }
  }, [videoId]);

  useEffect(() => {
    setPendingIds(null);
    void reload();
  }, [reload]);

  const addNote = useCallback(
    async (anchor: NoteAnchor, body: string) => {
      if (!videoId || !body.trim()) return;
      const note = await createNote({ videoId, anchor, body: body.trim() });
      setNotes((prev) => [...prev, note]);
    },
    [videoId],
  );

  const updateBody = useCallback(async (note: OutlineNote, body: string) => {
    const next = await updateNoteBody(note, body);
    setNotes((prev) => prev.map((n) => (n.id === next.id ? next : n)));
  }, []);

  const remove = useCallback(async (note: OutlineNote) => {
    await removeNote(note.id);
    setNotes((prev) => prev.filter((n) => n.id !== note.id));
  }, []);

  const reply = useCallback(async (note: OutlineNote, body: string) => {
    if (!body.trim()) return;
    const next = await appendReply(note, { author: 'self', body: body.trim() });
    setNotes((prev) => prev.map((n) => (n.id === next.id ? next : n)));
  }, []);

  const askAssistant = useCallback(
    async (note: OutlineNote) => {
      setBusyId(note.id);
      try {
        const next = await askAssistantForNote(note, sections);
        setNotes((prev) => prev.map((n) => (n.id === next.id ? next : n)));
      } finally {
        setBusyId(null);
      }
    },
    [sections],
  );

  const reanchor = useCallback(
    async (oldSections: Section[], newSections: Section[], durationMs: number) => {
      if (!videoId) return;
      const result = await reanchorAfterRegenerate({
        videoId,
        oldSections,
        newSections,
        durationMs,
      });
      setNotes(result.notes);
      setPendingIds(result.pendingIds);
    },
    [videoId],
  );

  const notesBySection = useCallback(
    (sectionId: string) => notes.filter((n) => n.anchor.sectionId === sectionId),
    [notes],
  );

  return {
    notes,
    notesBySection,
    unanchored: notes.filter((n) => n.anchor.sectionId === null),
    pendingIds,
    reload,
    addNote,
    updateBody,
    remove,
    reply,
    askAssistant,
    reanchor,
    busyId,
  };
}
