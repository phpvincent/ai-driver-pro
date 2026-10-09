/**
 * 数据备份与恢复（SPEC-10 10.5）：用户价值数据一键导出 / 导入。
 *
 * - 导出：五 store（outlines / qaHistory / notes / terms / usage）全量读出，
 *   记录自带键推导（键由记录内容唯一确定），格式 `vsc-backup` v1；
 *   subtitles 可重新拉取、logs / traces 是调试数据，不进备份；
 * - 导入：逐条 put（同 key 覆盖、不删既有数据）；单条失败跳过并计数，
 *   不整批失败（红线 8 精神）；
 * - 键推导单一事实源 keyOf(store, record)，导出与导入共用，防两侧漂移。
 */
import { DB } from '../config';
import { createSubtitleDb, outlineCacheKey, type DbLike } from '../storage/db';
import type { OutlineNote, OutlineRecord, QaRecord, TermCard } from '../types';
import type { UsageRecord } from '../core/metrics/usage';
import { downloadTextFile } from '../platform/files';

/** 模块级单例 DB（惰性 open 由 db 层内部保证幂等） */
const db = createSubtitleDb();

/** 备份覆盖的用户价值数据 store（subtitles 可重拉、logs/traces 调试数据，不含） */
export const BACKUP_STORES = [
  'outlines',
  'qaHistory',
  'notes',
  'terms',
  'usage',
] as const;

export type BackupStore = (typeof BACKUP_STORES)[number];

/** 备份文件里的条目：键（导出时由记录内容推导）+ 记录本体 */
export interface BackupEntry {
  key: IDBValidKey;
  value: unknown;
}

export interface VscBackupFile {
  format: 'vsc-backup';
  version: string;
  exportedAt: string;
  data: Record<BackupStore, BackupEntry[]>;
}

/**
 * 记录 → 存储键（单一事实源，导出/导入共用）：
 * - outlines：缓存键 videoId::promptVersion::model（红线 7 口径）
 * - qaHistory / notes：记录 id
 * - terms：[term, videoId]（复合键）
 * - usage：videoId
 */
export function keyOf(store: BackupStore, record: unknown): IDBValidKey | null {
  const r = record as Record<string, unknown> | null;
  if (r == null || typeof r !== 'object') return null;
  switch (store) {
    case 'outlines':
      if (
        typeof r.videoId === 'string' &&
        typeof r.promptVersion === 'string' &&
        typeof r.model === 'string'
      ) {
        return outlineCacheKey(r.videoId, r.promptVersion, r.model);
      }
      return null;
    case 'qaHistory':
    case 'notes':
      return typeof r.id === 'string' ? r.id : null;
    case 'terms':
      return typeof r.term === 'string' && typeof r.videoId === 'string'
        ? [r.term, r.videoId]
        : null;
    case 'usage':
      return typeof r.videoId === 'string' ? r.videoId : null;
  }
}

/** 全量导出（五 store；记录为空的 store 也保留空数组，结构稳定） */
export async function exportAllData(
  now: () => Date = () => new Date(),
): Promise<{ json: string; filename: string; counts: Record<BackupStore, number> }> {
  await db.open();
  const data = {} as Record<BackupStore, BackupEntry[]>;
  const counts = {} as Record<BackupStore, number>;
  const buckets: Record<BackupStore, unknown[]> = {
    outlines: (await db.getAll<OutlineRecord>(DB.stores.outlines)) ?? [],
    qaHistory: (await db.getAll<QaRecord>(DB.stores.qaHistory)) ?? [],
    notes: (await db.getAll<OutlineNote>(DB.stores.notes)) ?? [],
    terms: (await db.getAll<TermCard>(DB.stores.terms)) ?? [],
    usage: (await db.getAll<UsageRecord>(DB.stores.usage)) ?? [],
  };
  for (const store of BACKUP_STORES) {
    const entries: BackupEntry[] = [];
    for (const record of buckets[store]) {
      const key = keyOf(store, record);
      if (key !== null) entries.push({ key, value: record });
    }
    data[store] = entries;
    counts[store] = entries.length;
  }
  const file: VscBackupFile = {
    format: 'vsc-backup',
    version: '1.0',
    exportedAt: now().toISOString(),
    data,
  };
  const stamp = now().toISOString().slice(0, 10);
  return {
    json: JSON.stringify(file, null, 2),
    filename: `vsc-backup_${stamp}.json`,
    counts,
  };
}

/** 触发浏览器下载备份文件（platform 层） */
export async function downloadBackup(): Promise<Record<BackupStore, number>> {
  const { json, filename, counts } = await exportAllData();
  downloadTextFile(filename, json);
  return counts;
}

export interface ImportBackupResult {
  imported: Record<BackupStore, number>;
  /** 校验失败被跳过的条目数（脏数据 / 键推导失败） */
  skipped: number;
}

/**
 * 导入备份：逐条 put（同 key 覆盖，不删既有数据）。
 * 非法文件（format/version 不符）throw 由 UI 行内展示；单条失败跳过不阻断。
 */
export async function importBackup(text: string): Promise<ImportBackupResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`备份文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  const obj = raw as Record<string, unknown> | null;
  if (obj == null || typeof obj !== 'object' || obj.format !== 'vsc-backup') {
    throw new Error('不是 vsc-backup 备份文件');
  }
  const major = typeof obj.version === 'string' ? Number(obj.version.split('.')[0]) : NaN;
  if (!Number.isFinite(major) || major > 1) {
    throw new Error(`备份版本不支持（v${String(obj.version)}，本插件支持 v1）`);
  }
  const data = (obj.data ?? {}) as Partial<Record<BackupStore, BackupEntry[]>>;
  await db.open();
  const imported = {} as Record<BackupStore, number>;
  let skipped = 0;
  for (const store of BACKUP_STORES) {
    imported[store] = 0;
    const entries = Array.isArray(data[store]) ? data[store]! : [];
    for (const entry of entries) {
      // 键以备份文件为准（导出时已推导），缺键时按记录内容重推一次
      const key =
        entry && typeof entry === 'object' && 'key' in entry
          ? (entry.key as IDBValidKey)
          : keyOf(store, (entry as BackupEntry | undefined)?.value);
      const value =
        entry && typeof entry === 'object' && 'value' in entry ? (entry as BackupEntry).value : undefined;
      if (key === null || key === undefined || value === undefined) {
        skipped += 1;
        continue;
      }
      try {
        await db.put(DB.stores[store], key, value);
        imported[store] += 1;
      } catch {
        skipped += 1;
      }
    }
  }
  return { imported, skipped };
}
