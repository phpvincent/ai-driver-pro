/**
 * 大纲交换格式 `vsc-outline` v1（SPEC-09 9.5，spec §3.1 / §3.4）。
 *
 * **对外契约**：一旦发布只增不改，不兼容变更必须升主版本号。
 * 权威文档：docs/EXCHANGE-FORMAT.md（A7 单测锁定文档示例能过本校验器，
 * 防止文档与实现漂移）。
 *
 * - 导出：本地大纲（含可选笔记）→ VscOutlineFile，派生字段（score /
 *   density / cueRange / approximate）不导出，导入端用本地字幕重算；
 * - 校验顺序（spec §3.4）：JSON 合法 → format/version → checksum →
 *   结构（zod，未知字段忽略=向前兼容）→ 视频身份（platform+bvid+page
 *   三者相等才算同一视频）→ 时间戳覆盖率（<90% 仅警告，不拒绝）；
 * - checksum：sha256，覆盖除自身外的全部内容；规范化序列化 = 键按
 *   码元排序的稳定 stringify（两侧键序无关，确定性）。
 *
 * 零 chrome.* 依赖（红线 11）；crypto.subtle 为 Web 标准 API。
 */
import { z } from 'zod';
import type { OutlineNote, Section, VideoMeta } from '../../types';
import { bulletIdOf } from '../notes/reanchor';

export const VSC_OUTLINE_FORMAT = 'vsc-outline';
/** 本插件支持的主版本号；文件主版本更高时拒绝导入并提示升级（spec §3.1） */
export const VSC_OUTLINE_SUPPORTED_MAJOR = 1;

// ---------------------------------------------------------------------------
// 数据形状（与 docs/EXCHANGE-FORMAT.md 逐字段一致）
// ---------------------------------------------------------------------------

export interface VscExchangeBullet {
  id: string;
  text: string;
  startMs: number;
}

export interface VscExchangeSection {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  summary: string;
  bullets: VscExchangeBullet[];
  terms: string[];
  importance: number;
}

export interface VscExchangeNote {
  id: string;
  anchor: {
    kind: 'section' | 'bullet' | 'time';
    sectionId: string | null;
    bulletId?: string | null;
    tMs: number;
  };
  body: string;
  createdAt: string;
  updatedAt: string;
  replies: Array<{ id: string; author: 'self' | 'assistant'; body: string; createdAt: string }>;
  importedFrom?: { exporter: string; exportedAt: string };
}

export interface VscOutlineFile {
  format: typeof VSC_OUTLINE_FORMAT;
  version: string;
  exportedAt: string;
  exporter: { app: string; appVersion: string };
  video: {
    platform: 'bilibili';
    bvid: string;
    page: number;
    cid: number;
    title: string;
    durationMs: number;
    url: string;
  };
  outline: { promptVersion: string; model: string; sections: VscExchangeSection[] };
  notes: VscExchangeNote[];
  checksum: string;
}

// ---------------------------------------------------------------------------
// 校验 Schema（红线 4 精神：结构化数据过 zod；非 strict = 未知字段忽略）
// ---------------------------------------------------------------------------

const VscFileSchema = z.object({
  format: z.literal(VSC_OUTLINE_FORMAT),
  version: z.string().regex(/^\d+\.\d+$/, 'version 必须是 "主.次" 形式'),
  exportedAt: z.string().min(1),
  exporter: z.object({ app: z.string().min(1), appVersion: z.string().min(1) }),
  video: z.object({
    platform: z.literal('bilibili'),
    bvid: z.string().min(1),
    page: z.number().int().positive(),
    cid: z.number(),
    title: z.string(),
    durationMs: z.number().int().nonnegative(),
    url: z.string(),
  }),
  outline: z.object({
    promptVersion: z.string().min(1),
    model: z.string().min(1),
    sections: z
      .object({
        id: z.string().min(1),
        title: z.string().min(1),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        summary: z.string(),
        bullets: z.array(
          z.object({
            id: z.string().min(1),
            text: z.string().min(1),
            startMs: z.number().int().nonnegative(),
          }),
        ),
        terms: z.array(z.string()),
        importance: z.number().int().min(1).max(5),
      })
      .array()
      .min(1),
  }),
  notes: z
    .object({
      id: z.string().min(1),
      anchor: z.object({
        kind: z.enum(['section', 'bullet', 'time']),
        sectionId: z.string().nullable(),
        bulletId: z.string().nullable().optional(),
        tMs: z.number().int().nonnegative(),
      }),
      body: z.string(),
      createdAt: z.string().min(1),
      updatedAt: z.string().min(1),
      replies: z.array(
        z.object({
          id: z.string().min(1),
          author: z.enum(['self', 'assistant']),
          body: z.string(),
          createdAt: z.string().min(1),
        }),
      ),
      importedFrom: z.object({ exporter: z.string().min(1), exportedAt: z.string().min(1) }).optional(),
    })
    .array(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'checksum 必须是 sha256:<64位小写十六进制>'),
});

// ---------------------------------------------------------------------------
// 稳定序列化与 checksum（确定性：键按码元排序，与文件内键序无关）
// ---------------------------------------------------------------------------

/** 递归稳定 stringify：对象键排序（码元序）、数组保序、原始值走 JSON.stringify */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** sha256 十六进制（Web 标准 crypto.subtle；Node ≥19 与浏览器均可用） */
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 计算交换文件的 checksum（覆盖除 checksum 自身外的全部内容）。
 * 防御：若传入对象自带 `checksum` 键（常见调用疏漏），计算前剔除——
 * 哈希永远不含 checksum 自身。
 */
export async function computeChecksum(file: Omit<VscOutlineFile, 'checksum'>): Promise<string> {
  const { checksum: _ignore, ...rest } = file as Partial<VscOutlineFile>;
  return `sha256:${await sha256Hex(stableStringify(rest))}`;
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export interface BuildOutlineExportInput {
  meta: VideoMeta;
  promptVersion: string;
  model: string;
  sections: Section[];
  /** 可选：不携带笔记时传空数组（spec §3.1：notes 可为空数组） */
  notes: OutlineNote[];
  appVersion: string;
  now?: () => Date;
}

/** 导出文件名：`{标题}.{bvid}_p{page}.vsc-outline.json`（标题做文件系统安全化） */
export function outlineExportFileName(title: string, bvid: string, page: number): string {
  const safe = title
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/[._]+$/, '')
    .slice(0, 50);
  const base = safe.length > 0 ? safe : 'outline';
  return `${base}.${bvid}_p${page}.vsc-outline.json`;
}

/** 本地 Section → 交换格式（派生字段 score/density/cueRange 不导出；要点补合成 id） */
function toExchangeSection(section: Section): VscExchangeSection {
  return {
    id: section.id,
    title: section.title,
    startMs: section.startMs,
    endMs: section.endMs,
    summary: section.summary,
    bullets: section.bullets.map((b, i) => ({
      id: bulletIdOf(section.id, i),
      text: b.text,
      startMs: b.startMs,
    })),
    terms: [...section.terms],
    importance: section.importance,
  };
}

/** 本地 OutlineNote → 交换格式笔记 */
function toExchangeNote(note: OutlineNote): VscExchangeNote {
  return {
    id: note.id,
    anchor: {
      kind: note.anchor.kind,
      sectionId: note.anchor.sectionId,
      ...(note.anchor.bulletId != null ? { bulletId: note.anchor.bulletId } : {}),
      tMs: note.anchor.tMs,
    },
    body: note.body,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    replies: note.replies.map((r) => ({ ...r })),
    ...(note.importedFrom ? { importedFrom: { ...note.importedFrom } } : {}),
  };
}

/** 组装交换文件（含 checksum；幂等输入 → 字段级相同输出，仅 exportedAt 随时钟） */
export async function buildOutlineExport(input: BuildOutlineExportInput): Promise<VscOutlineFile> {
  const file: Omit<VscOutlineFile, 'checksum'> = {
    format: VSC_OUTLINE_FORMAT,
    version: '1.0',
    exportedAt: (input.now ?? (() => new Date()))().toISOString(),
    exporter: { app: 'video-study-copilot', appVersion: input.appVersion },
    video: {
      platform: 'bilibili',
      bvid: input.meta.bvid,
      page: input.meta.page,
      cid: input.meta.cid,
      title: input.meta.title,
      durationMs: input.meta.durationMs,
      url: input.meta.url,
    },
    outline: {
      promptVersion: input.promptVersion,
      model: input.model,
      sections: input.sections.map(toExchangeSection),
    },
    notes: input.notes.map(toExchangeNote),
  };
  return { ...file, checksum: await computeChecksum(file) };
}

// ---------------------------------------------------------------------------
// 导入校验（spec §3.4 顺序；拒绝给原因，覆盖率不足仅警告）
// ---------------------------------------------------------------------------

export type OutlineImportRejection = {
  ok: false;
  /** 拒绝阶段：json / format / version / checksum / structure / video-mismatch */
  stage: 'json' | 'format' | 'version' | 'checksum' | 'structure' | 'video-mismatch';
  message: string;
};

export type OutlineImportSuccess = {
  ok: true;
  file: VscOutlineFile;
  /** 非阻断警告（如时间戳覆盖率不足：字幕版本可能不同） */
  warnings: string[];
};

export interface ParseOutlineImportOptions {
  /** 本地字幕时间范围 [startMs, endMs]；给出时计算时间戳覆盖率 */
  cueRangeMs?: readonly [number, number] | null;
  /** 覆盖率低于此比例时产生警告（spec §3.4：<90% 警告） */
  coverageWarnRatio?: number;
  /** 二轮冒烟：视频不一致时由用户确认后强制导入（调用方先收到 video-mismatch 拒绝再带此标记重试） */
  allowVideoMismatch?: boolean;
}

/**
 * 解析并校验导入文件。**纯校验**：不落库、不改本地状态（导入 UI 9.6 负责）。
 * 视频身份 = platform + bvid + page 三者相等；cid / durationMs 作辅助提示。
 */
export async function parseOutlineImport(
  text: string,
  localVideo: { bvid: string; page: number; title: string },
  opts: ParseOutlineImportOptions = {},
): Promise<OutlineImportSuccess | OutlineImportRejection> {
  // ① JSON 合法
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      stage: 'json',
      message: `文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, stage: 'json', message: '文件内容不是 JSON 对象' };
  }
  const obj = raw as Record<string, unknown>;

  // ② format / version（主版本高于本地支持 → 拒绝并提示升级）
  if (obj.format !== VSC_OUTLINE_FORMAT) {
    return { ok: false, stage: 'format', message: `不是 ${VSC_OUTLINE_FORMAT} 文件（format=${String(obj.format)}）` };
  }
  const versionMajor = typeof obj.version === 'string' ? Number(obj.version.split('.')[0]) : NaN;
  if (!Number.isFinite(versionMajor)) {
    return { ok: false, stage: 'version', message: 'version 字段缺失或不是 "主.次" 形式' };
  }
  if (versionMajor > VSC_OUTLINE_SUPPORTED_MAJOR) {
    return {
      ok: false,
      stage: 'version',
      message: `文件版本 v${versionMajor} 高于插件支持的 v${VSC_OUTLINE_SUPPORTED_MAJOR}，请升级插件后重试`,
    };
  }

  // ③ checksum（覆盖除自身外的全部内容；发现截断或篡改）
  const claimed = typeof obj.checksum === 'string' ? obj.checksum : '';
  const { checksum: _omit, ...rest } = obj;
  const actual = await computeChecksum(rest as Omit<VscOutlineFile, 'checksum'>);
  if (claimed !== actual) {
    return {
      ok: false,
      stage: 'checksum',
      message: `checksum 不符（文件声明 ${claimed || '(缺失)'}，实际计算 ${actual}）——文件可能被截断或篡改`,
    };
  }

  // ④ 结构（zod；未知字段忽略 = 向前兼容）
  const parsed = VscFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { ok: false, stage: 'structure', message: `文件结构不符合 vsc-outline v1：${issues}` };
  }
  const file = parsed.data as VscOutlineFile;

  // 时间戳覆盖率警告先声明（video-mismatch 强制导入时也要能追加）
  const warnings: string[] = [];
  const cueRange = opts.cueRangeMs ?? null;

  // ⑤ 视频身份（platform + bvid + page 三者相等才算同一视频；
  // 二轮冒烟：不匹配时拒绝并给出两侧信息，调用方确认后可 allowVideoMismatch 强制导入）
  if (file.video.bvid !== localVideo.bvid || file.video.page !== localVideo.page) {
    if (!opts.allowVideoMismatch) {
      return {
        ok: false,
        stage: 'video-mismatch',
        message: `文件对应的是《${file.video.title}》P${file.video.page}，当前是《${localVideo.title}》P${localVideo.page}`,
      };
    }
    warnings.push('视频不一致（已按你的确认强制导入）：超出现频时长的章节与笔记会被自动忽略');
  }

  // ⑥ 时间戳覆盖率（警告，不拒绝）
  if (cueRange) {
    const [lo, hi] = cueRange;
    const stamps = [
      ...file.outline.sections.flatMap((s) => [s.startMs, ...s.bullets.map((b) => b.startMs)]),
      ...file.notes.map((n) => n.anchor.tMs),
    ];
    if (stamps.length > 0) {
      const inRange = stamps.filter((t) => t >= lo && t <= hi).length;
      const ratio = inRange / stamps.length;
      const warnBelow = opts.coverageWarnRatio ?? 0.9;
      if (ratio < warnBelow) {
        warnings.push(
          `仅 ${(ratio * 100).toFixed(0)}% 的时间戳落在本地字幕范围内（低于 ${warnBelow * 100}%），字幕版本可能不同，跳播位置可能有偏差`,
        );
      }
    }
  }

  return { ok: true, file, warnings };
}
