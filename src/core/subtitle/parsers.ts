/**
 * 字幕格式解析器（SPEC-02 子任务 2.1）。
 *
 * 四种输入（B 站字幕 JSON / SRT / VTT / 纯文本）统一输出 Cue[]。
 * 全部为纯函数，无 chrome.* 依赖；除 parsePlainText（估算）外，
 * 每条输出 Cue 均携带真实 startMs/endMs（红线 5：禁止丢弃时间戳）。
 */
import type { Cue } from '../../types';
import { SUBTITLE } from '../../config';

/** 纯文本估算速率可被调用方覆盖 */
export interface PlainTextOptions {
  charsPerSecond?: number;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 统一换行符后按一个及以上空行切块，丢弃空白块 */
function splitBlocks(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
}

/** SRT 时间戳：HH:MM:SS,mmm（毫秒分隔符也接受 `.`） */
const SRT_TIME_RE = /^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/;

function parseSrtTimestamp(raw: string): number | null {
  const m = SRT_TIME_RE.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/** VTT 时间戳：[HH:]MM:SS.mmm（容错也接受 `,`） */
const VTT_TIME_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/;

function parseVttTimestamp(raw: string): number | null {
  const m = VTT_TIME_RE.exec(raw.trim());
  if (!m) return null;
  const h = m[1] !== undefined ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/** 从时间行 `A --> B [settings]` 提取毫秒区间；非法返回 null */
function parseArrowLine(
  line: string,
  parseTimestamp: (s: string) => number | null,
): { startMs: number; endMs: number } | null {
  const arrow = line.indexOf('-->');
  if (arrow === -1) return null;
  const left = line.slice(0, arrow).trim().split(/\s+/)[0];
  // 右侧可能带 VTT cue settings（align:start 等），只取第一个 token
  const right = line.slice(arrow + 3).trim().split(/\s+/)[0];
  const startMs = parseTimestamp(left);
  const endMs = parseTimestamp(right);
  if (startMs === null || endMs === null) return null;
  return { startMs, endMs };
}

interface TimedBlock {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * 解析单个 cue 块：定位含 `-->` 的时间行（之前的行视为序号/cue id，忽略），
 * 其后的行拼为正文。返回 null 表示该块不含合法时间行。
 */
function parseTimedBlock(
  block: string,
  parseTimestamp: (s: string) => number | null,
  stripInlineTags: boolean,
): TimedBlock | null {
  const lines = block.split('\n');
  let time: { startMs: number; endMs: number } | null = null;
  let timeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseArrowLine(lines[i], parseTimestamp);
    if (parsed) {
      time = parsed;
      timeIdx = i;
      break;
    }
  }
  if (!time || timeIdx === -1) return null;
  let textLines = lines.slice(timeIdx + 1);
  if (stripInlineTags) {
    textLines = textLines.map((line) => line.replace(/<[^>]*>/g, ''));
  }
  const text = textLines.join('\n').trim();
  return { startMs: time.startMs, endMs: time.endMs, text };
}

// ---------------------------------------------------------------------------
// 1. B 站字幕 JSON
// ---------------------------------------------------------------------------

/** `{body: [{from, to, content}, ...]}`，from/to 秒可为小数 */
export function parseBiliSubtitle(json: unknown): Cue[] {
  if (typeof json !== 'object' || json === null) return [];
  const body = (json as { body?: unknown }).body;
  if (!Array.isArray(body)) return [];
  const cues: Cue[] = [];
  for (const item of body) {
    if (typeof item !== 'object' || item === null) continue;
    const { from, to, content } = item as { from?: unknown; to?: unknown; content?: unknown };
    if (typeof content !== 'string') continue;
    const text = content.trim();
    if (text === '') continue;
    if (typeof from !== 'number' || !Number.isFinite(from)) continue;
    if (typeof to !== 'number' || !Number.isFinite(to)) continue;
    cues.push({
      index: cues.length,
      startMs: Math.round(from * 1000),
      endMs: Math.round(to * 1000),
      text,
    });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// 2. SRT
// ---------------------------------------------------------------------------

/** 标准 SRT：序号行可选、`HH:MM:SS,mmm --> HH:MM:SS,mmm`、正文一到多行、块间空行 */
export function parseSrt(text: string): Cue[] {
  if (typeof text !== 'string') return [];
  const cues: Cue[] = [];
  for (const block of splitBlocks(text)) {
    const parsed = parseTimedBlock(block, parseSrtTimestamp, false);
    if (!parsed || parsed.text === '') continue;
    cues.push({
      index: cues.length,
      startMs: parsed.startMs,
      endMs: parsed.endMs,
      text: parsed.text,
    });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// 3. WebVTT
// ---------------------------------------------------------------------------

/** 以这些 token 开头的块（WEBVTT 头 / NOTE / STYLE / REGION）整块跳过 */
const VTT_SKIP_BLOCK_RE = /^(WEBVTT|NOTE|STYLE|REGION)\b/;

/** WEBVTT：跳过头与 NOTE/STYLE/REGION 块，清除 `<...>` 行内标签，接受无小时格式 */
export function parseVtt(text: string): Cue[] {
  if (typeof text !== 'string') return [];
  const cues: Cue[] = [];
  for (const block of splitBlocks(text)) {
    if (VTT_SKIP_BLOCK_RE.test(block)) continue;
    const parsed = parseTimedBlock(block, parseVttTimestamp, true);
    if (!parsed || parsed.text === '') continue;
    cues.push({
      index: cues.length,
      startMs: parsed.startMs,
      endMs: parsed.endMs,
      text: parsed.text,
    });
  }
  return cues;
}

// ---------------------------------------------------------------------------
// 4. 纯文本（时间估算）
// ---------------------------------------------------------------------------

/**
 * 无时间戳文本按字数速率估算：先按换行/句号分段，每段一条 Cue；
 * startMs 按累计字数推算，段间严格连续（第 n 条 startMs = 第 n-1 条 endMs）。
 * 每条 Cue 标记 approximate: true（红线 5：估算时间必须显式声明）。
 */
export function parsePlainText(text: string, opts?: PlainTextOptions): Cue[] {
  const charsPerSecond = opts?.charsPerSecond ?? SUBTITLE.manualCharsPerSecond;
  if (typeof text !== 'string' || text.trim() === '') return [];
  if (typeof charsPerSecond !== 'number' || !Number.isFinite(charsPerSecond) || charsPerSecond <= 0) {
    return [];
  }
  const segments = text
    .replace(/\r\n?/g, '\n')
    .split(/[\n。]/)
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '');
  if (segments.length === 0) return [];

  // 累计字数边界：cum[i] = 前 i 段总字数；时间取 round 保证段间无缝衔接
  const cum: number[] = [0];
  for (const seg of segments) cum.push(cum[cum.length - 1] + seg.length);
  const toMs = (chars: number): number => Math.round((chars / charsPerSecond) * 1000);

  return segments.map((seg, i) => ({
    index: i,
    startMs: toMs(cum[i]),
    endMs: toMs(cum[i + 1]),
    text: seg,
    approximate: true,
  }));
}

// ---------------------------------------------------------------------------
// 5. 自动检测
// ---------------------------------------------------------------------------

/** WEBVTT 头 → VTT；含 ` --> ` → SRT；否则按纯文本估算 */
export function detectAndParse(text: string): Cue[] {
  if (typeof text !== 'string') return [];
  const stripped = text.replace(/^\uFEFF/, '');
  if (/^\s*WEBVTT/.test(stripped)) return parseVtt(stripped);
  if (stripped.includes(' --> ')) return parseSrt(stripped);
  return parsePlainText(stripped);
}
