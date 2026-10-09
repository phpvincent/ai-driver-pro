/**
 * LLM 交互日志的面板侧落库层（接线 core/metrics/llmLog ↔ storage/db）。
 *
 * 职责：
 * - 订阅核心日志流，逐条写入 IndexedDB（超出 DB.logKeep 的最旧条目顺带清理）；
 * - 提供读取 / 清空给「LLM 交互日志」视图；
 * - 记录开关（settings.llmLogEnabled，默认开启）：关闭后不再落库，
 *   控制台镜像仍在（不占存储，也避免字幕报文长期留在本地）。
 *
 * 落库失败一律静默：日志是诊断辅助，绝不能影响主流程（红线 8 精神）。
 */
import { DB } from '../config';
import { subscribeLlmLog, type LlmLogEntry } from '../core/metrics/llmLog';
import { MSG } from '../messages';
import { clearLlmLogs as clearInDb, createSubtitleDb, listLlmLogs, saveLlmLog } from '../storage/db';

/** 模块级单例 DB */
const db = createSubtitleDb();

/** chrome.runtime.sendMessage 的安全包装 */
function sendRuntimeMessage(message: unknown): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve(null);
  }
}

/** 是否已开启落库（未配置视为开启） */
async function isEnabled(): Promise<boolean> {
  try {
    const settings = (await sendRuntimeMessage({ type: MSG.GET_SETTINGS })) as
      | { llmLogEnabled?: boolean }
      | null;
    return settings?.llmLogEnabled !== false;
  } catch {
    return true;
  }
}

/** 超出保留条数时删除最旧的（listLlmLogs 已按时间倒序） */
async function trimOverflow(): Promise<void> {
  try {
    const all = await listLlmLogs(db);
    for (const old of all.slice(DB.logKeep)) {
      await db.delete(DB.stores.logs, old.id);
    }
  } catch {
    /* 裁剪失败不影响使用 */
  }
}

/** 订阅并落库（幂等：模块只初始化一次） */
let wired = false;
export function wireLlmLogPersistence(): void {
  if (wired) return;
  wired = true;
  subscribeLlmLog((entry) => {
    // entry = null 表示内存被清空，落库侧无需处理
    if (!entry) return;
    void (async () => {
      if (!(await isEnabled())) return;
      try {
        await saveLlmLog(db, entry);
        await trimOverflow();
      } catch {
        /* 落库失败静默 */
      }
    })();
  });
}

/** 读取日志（新→旧） */
export async function loadLlmLogs(): Promise<LlmLogEntry[]> {
  try {
    return await listLlmLogs(db);
  } catch {
    return [];
  }
}

/** 清空库内日志 */
export async function clearLlmLogStore(): Promise<void> {
  try {
    await clearInDb(db);
  } catch {
    /* 清库失败忽略 */
  }
}

/** 写入开关（只合并 llmLogEnabled 一个键，不动其他分区） */
export async function setLlmLogEnabled(enabled: boolean): Promise<boolean> {
  try {
    const settings = (await sendRuntimeMessage({ type: MSG.GET_SETTINGS })) as
      | Record<string, unknown>
      | null;
    const next = { ...(settings ?? {}), llmLogEnabled: enabled };
    const response = (await sendRuntimeMessage({ type: MSG.SET_SETTINGS, payload: next })) as
      | { ok?: boolean }
      | null;
    return response?.ok === true;
  } catch {
    return false;
  }
}

/** 读取开关（未配置视为开启） */
export async function getLlmLogEnabled(): Promise<boolean> {
  return await isEnabled();
}
