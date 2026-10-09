/**
 * 截断 JSON 修复（纯函数，零依赖）。
 *
 * 背景：结构化输出（大纲 / 概念图 / 问答 JSON）常见失败不是"模型乱说"，而是
 * **输出在末尾被截断**——最外层的 `}` 或某个数组元素只输出了一半。此时
 * `JSON.parse` 报 `Expected ',' or '}' ... at position N`，而重试一次往往还是同样的截断
 * （同样的 prompt、同样的长度上限），于是整条链路降级，用户只看到"生成失败"。
 *
 * 修法：先严格解析；失败则在不改变内容语义的前提下**补齐缺失的闭合括号**；
 * 若中途有写了一半的元素，则回退到最后一个完整元素再补齐。修复后的文本仍需过
 * Zod 校验——丢弃后的结构若不满足 Schema（如 stages 少于 3 个），该失败仍会如实报出。
 *
 * 红线 1：全程确定性字符串运算，不调用模型、无随机；同输入必得同输出。
 */

/** 尝试解析；成功返回 true */
function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 去掉末尾的悬挂逗号（截断常停在 `...,` 上） */
function stripTrailingComma(text: string): string {
  return text.replace(/[ \t\r\n]*,$/, '');
}

/**
 * 计算补齐闭合括号所需的字符串（如 `]}`）。
 * 字符串未闭合 / 括号不匹配时返回 null（无法只靠补括号修复）。
 */
function missingClosers(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const top = stack.pop();
      if (!top) return null;
      if ((top === '{' ? '}' : ']') !== ch) return null;
    }
  }
  if (inString) return null;
  return stack
    .reverse()
    .map((c) => (c === '{' ? '}' : ']'))
    .join('');
}

/**
 * 修复被截断的 JSON：返回可解析的文本；无法修复返回 null。
 *
 * 两级策略：
 * 1. 只补闭合括号（保留全部已输出内容）——应对"缺最外层 }"这类最常见的截断；
 * 2. 逐个回退到前一个完整元素（丢弃写了一半的那个）再补齐——应对元素中途截断。
 */
export function repairTruncatedJson(raw: string): string | null {
  const text = (typeof raw === 'string' ? raw : '').trim();
  if (text === '') return null;
  if (parses(text)) return text;

  // ① 直接补齐
  const closers = missingClosers(text);
  if (closers !== null) {
    const fixed = `${stripTrailingComma(text)}${closers}`;
    if (parses(fixed)) return fixed;
  }

  // ② 回退到最近的完整元素（从后往前找字符串外的 } / ]）
  const cutPoints: number[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && (ch === '}' || ch === ']')) cutPoints.push(i + 1);
  }
  for (let k = cutPoints.length - 1; k >= 0; k -= 1) {
    const cut = text.slice(0, cutPoints[k]);
    const rest = missingClosers(cut);
    if (rest === null) continue;
    const fixed = `${stripTrailingComma(cut)}${rest}`;
    if (parses(fixed)) return fixed;
  }
  return null;
}

/**
 * 宽松解析：先严格解析，失败再尝试修复。
 *
 * @returns `{ value, repaired }`；无法解析时返回 null（由调用方决定报错文案）
 */
export function parseJsonLoose(raw: string): { value: unknown; repaired: boolean } | null {
  const text = (typeof raw === 'string' ? raw : '').trim();
  if (text === '') return null;
  try {
    return { value: JSON.parse(text) as unknown, repaired: false };
  } catch {
    /* 落到修复路径 */
  }
  const fixed = repairTruncatedJson(text);
  if (fixed === null) return null;
  try {
    return { value: JSON.parse(fixed) as unknown, repaired: true };
  } catch {
    return null;
  }
}

/** 错误信息里追加"已尝试修复"的说明，避免用户以为没做任何补救 */
export function withRepairHint(message: string, attempted: boolean): string {
  return attempted ? `${message}（已尝试修复被截断的输出后仍不满足要求）` : message;
}
