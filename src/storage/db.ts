/**
 * IndexedDB 封装（SPEC-02 子任务 2.3，TECH-DESIGN §4.6 缓存结构）。
 *
 * 两层结构：
 * - `DbLike`：面向接口的最小数据库契约（open/get/put），高层 API 与
 *   瀑布（waterfall.ts）均依赖此接口，单测注入内存实现即可覆盖；
 * - `createSubtitleDb`：基于全局 / 注入 IDBFactory 的默认实现。open 惰性
 *   且幂等（成功后复用连接，factory.open 只调用一次），get/put 内部保证
 *   已 open；open 失败后清空缓存允许重试。
 *
 * 高层 API getSubtitle / saveSubtitle 仅操作 DB.stores.subtitles（键 videoId）。
 * 红线 8 的兜底在调用方（waterfall）：本模块异常向上传播，不在 DB 层吞错。
 */
import type { OutlineNote, OutlineRecord, QaRecord, SubtitleRecord } from '../types';
import type { UsageRecord } from '../core/metrics/usage';
import type { LlmLogEntry } from '../core/metrics/llmLog';
import { DB } from '../config';

/** 最小数据库契约：注入点，单测用内存实现替换 */
export interface DbLike {
  open(): Promise<void>;
  get<T>(store: string, key: IDBValidKey): Promise<T | undefined>;
  put(store: string, key: IDBValidKey, value: unknown): Promise<void>;
  /** 全量读取某 store（SPEC-05 追加：qaHistory 无索引前缀扫描，靠 get 全量 + 过滤） */
  getAll<T>(store: string): Promise<T[]>;
  /** 删除某 store 的单个键（LLM 交互日志清空用） */
  delete(store: string, key: IDBValidKey): Promise<void>;
}

/** IDBRequest → Promise */
function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

/**
 * 默认 DbLike 实现：打开 DB.name 并确保全部 store 存在
 * （onupgradeneeded 只在首次建库时实际建 store）。
 * idbFactory 缺省用全局 indexedDB；注入 factory 供单测。
 */
export function createSubtitleDb(idbFactory?: IDBFactory): DbLike {
  const factory: IDBFactory | undefined =
    idbFactory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  let openPromise: Promise<IDBDatabase> | null = null;

  const ensureOpen = (): Promise<IDBDatabase> => {
    if (openPromise === null) {
      openPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (factory === undefined) {
          reject(new Error('indexedDB unavailable'));
          return;
        }
        // 版本号：v2 起新增 usage（验证期埋点）store；v3 起新增 logs（LLM 交互日志）；
        // v4 起新增 notes（SPEC-09 大纲笔记）。升级时为已存在的库补建缺失 store
        // （onupgradeneeded 只在版本变化时触发）
        const req = factory.open(DB.name, 4);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const storeName of Object.values(DB.stores)) {
            if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error(`open db ${DB.name} failed`));
      });
      // open 失败后清空缓存，允许下次操作重试（否则一次失败会永久卡死）
      openPromise.catch(() => {
        openPromise = null;
      });
    }
    return openPromise;
  };

  return {
    async open(): Promise<void> {
      await ensureOpen();
    },
    async get<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
      const db = await ensureOpen();
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      return await requestToPromise<T | undefined>(req);
    },
    async put(store: string, key: IDBValidKey, value: unknown): Promise<void> {
      const db = await ensureOpen();
      const req = db.transaction(store, 'readwrite').objectStore(store).put(value, key);
      await requestToPromise(req);
    },
    async getAll<T>(store: string): Promise<T[]> {
      const db = await ensureOpen();
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      return await requestToPromise<T[]>(req);
    },
    async delete(store: string, key: IDBValidKey): Promise<void> {
      const db = await ensureOpen();
      const req = db.transaction(store, 'readwrite').objectStore(store).delete(key);
      await requestToPromise(req);
    },
  };
}

/** 读字幕缓存，未命中返回 null */
export async function getSubtitle(db: DbLike, videoId: string): Promise<SubtitleRecord | null> {
  await db.open();
  const rec = await db.get<SubtitleRecord>(DB.stores.subtitles, videoId);
  return rec ?? null;
}

/**
 * 写字幕缓存（键 videoId，store 取 DB 常量）。
 * fetchedAt 由本层以注入时钟统一盖章（默认 Date.now），
 * 保证缓存时间戳来源唯一且可确定性单测。
 */
export async function saveSubtitle(
  db: DbLike,
  rec: SubtitleRecord,
  now: () => number = Date.now,
): Promise<void> {
  await db.open();
  const record: SubtitleRecord = { ...rec, fetchedAt: new Date(now()).toISOString() };
  await db.put(DB.stores.subtitles, rec.videoId, record);
}

/** 大纲缓存键：[videoId, promptVersion, model]（红线 7：prompt/模型升级定向失效） */
export function outlineCacheKey(videoId: string, promptVersion: string, model: string): string {
  return `${videoId}::${promptVersion}::${model}`;
}

/** 读大纲缓存，未命中返回 null */
export async function getOutline(
  db: DbLike,
  videoId: string,
  promptVersion: string,
  model: string,
): Promise<OutlineRecord | null> {
  await db.open();
  const rec = await db.get<OutlineRecord>(
    DB.stores.outlines,
    outlineCacheKey(videoId, promptVersion, model),
  );
  return rec ?? null;
}

/** 写大纲缓存（含 chunkState 断点，供续跑；fetchedAt 由本层盖章） */
export async function saveOutline(
  db: DbLike,
  rec: OutlineRecord,
  now: () => number = Date.now,
): Promise<void> {
  await db.open();
  const record: OutlineRecord = { ...rec, createdAt: new Date(now()).toISOString() };
  await db.put(DB.stores.outlines, outlineCacheKey(rec.videoId, rec.promptVersion, rec.model), record);
}

// ---------------------------------------------------------------------------
// qaHistory（SPEC-05 追加）：键 id（QaRecord.id）；qaHistory 量级低（每视频几十条），
// listQaByVideo 用全量 getAll + 过滤，不建 IDB 索引。
// ---------------------------------------------------------------------------

/** 写问答记录（键 rec.id，store 取 DB.stores.qaHistory） */
export async function saveQaRecord(db: DbLike, rec: QaRecord): Promise<void> {
  await db.open();
  await db.put(DB.stores.qaHistory, rec.id, rec);
}

/** 按视频列出问答记录（createdAt 升序；无记录返回空数组） */
export async function listQaByVideo(db: DbLike, videoId: string): Promise<QaRecord[]> {
  await db.open();
  const all = await db.getAll<QaRecord>(DB.stores.qaHistory);
  return all
    .filter((r) => r.videoId === videoId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

// ---------------------------------------------------------------------------
// usage（SPEC-07 追加）：键 videoId，值为 UsageRecord（纯本地使用统计，不上报）。
// listAllUsage 与 qaHistory 同法：全量 getAll + 过滤（量级低，不建索引）。
// ---------------------------------------------------------------------------

/** 读使用统计，未命中返回 null */
export async function getUsage(db: DbLike, videoId: string): Promise<UsageRecord | null> {
  await db.open();
  const rec = await db.get<UsageRecord>(DB.stores.usage, videoId);
  return rec ?? null;
}

/** 写使用统计（键 rec.videoId；时间戳由调用方的注入时钟在 applyUsageEvent 时写入） */
export async function saveUsage(db: DbLike, rec: UsageRecord): Promise<void> {
  await db.open();
  await db.put(DB.stores.usage, rec.videoId, rec);
}

/** 全量列出使用统计（过滤掉非 UsageRecord 的脏数据） */
export async function listAllUsage(db: DbLike): Promise<UsageRecord[]> {
  await db.open();
  const all = await db.getAll<UsageRecord>(DB.stores.usage);
  return all.filter(
    (r): r is UsageRecord =>
      typeof r === 'object' && r !== null && typeof (r as UsageRecord).videoId === 'string',
  );
}

// ---------------------------------------------------------------------------
// logs（LLM 交互日志）：键 entry.id；量级受 DB.logKeep 约束（写入侧裁剪）。
// ---------------------------------------------------------------------------

/** 写一条 LLM 交互日志 */
export async function saveLlmLog(db: DbLike, entry: LlmLogEntry): Promise<void> {
  await db.open();
  await db.put(DB.stores.logs, entry.id, entry);
}

/**
 * 列出 LLM 交互日志（按时间倒序，新在前）；超过 DB.logKeep 的部分顺带清掉
 * （日志只用于近期排障，不长期堆积）。脏数据（无 id/at）过滤。
 */
export async function listLlmLogs(db: DbLike): Promise<LlmLogEntry[]> {
  await db.open();
  const all = await db.getAll<LlmLogEntry>(DB.stores.logs);
  const clean = all.filter(
    (e): e is LlmLogEntry =>
      typeof e === 'object' &&
      e !== null &&
      typeof e.id === 'string' &&
      typeof e.at === 'string',
  );
  const sorted = [...clean].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return sorted.slice(0, DB.logKeep);
}

/** 清空 LLM 交互日志（逐条删除键） */
export async function clearLlmLogs(db: DbLike): Promise<void> {
  await db.open();
  const all = await db.getAll<LlmLogEntry>(DB.stores.logs);
  for (const entry of all) {
    if (entry && typeof entry.id === 'string') {
      await db.delete(DB.stores.logs, entry.id);
    }
  }
}

// ---------------------------------------------------------------------------
// notes（SPEC-09 9.1 追加）：键 note.id，值 OutlineNote。
// 笔记与大纲**解耦存储**：大纲重生成不触碰本 store——这是"不丢笔记"的根本
// 保证（spec §3.5）。与 qaHistory 同法：量级低（每视频几十条），
// listNotesByVideo 用全量 getAll + 过滤，不建 IDB 索引（设计稿的"索引
// videoId"简化为过滤，沿用既有先例；见 SPEC-09 执行记录的范围说明）。
// ---------------------------------------------------------------------------

/** 写笔记（新增或整体更新：编辑正文 / 追加回复都整条覆盖写） */
export async function saveNote(db: DbLike, note: OutlineNote): Promise<void> {
  await db.open();
  await db.put(DB.stores.notes, note.id, note);
}

/** 删除单条笔记（键 note.id） */
export async function deleteNote(db: DbLike, noteId: string): Promise<void> {
  await db.open();
  await db.delete(DB.stores.notes, noteId);
}

/** 列出某视频的全部笔记（createdAt 升序，稳定顺序；无笔记返回空数组） */
export async function listNotesByVideo(db: DbLike, videoId: string): Promise<OutlineNote[]> {
  await db.open();
  const all = await db.getAll<OutlineNote>(DB.stores.notes);
  return all
    .filter(
      (n): n is OutlineNote =>
        typeof n === 'object' && n !== null && n.videoId === videoId && typeof n.id === 'string',
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
