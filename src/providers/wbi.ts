/**
 * B 站 wbi 签名（SPEC-02 子任务 2.2，TECH-DESIGN §7.1）。
 *
 * 算法为 B 站前端公开的 mixin key 方案：
 * 1. nav 接口返回的 `wbi_img.img_url` / `sub_url` 尾段各取一个 key；
 * 2. imgKey + subKey（共 64 字符）按 MIXIN_KEY_ENC_TAB 重排，取前 32 位 = mixinKey（按日缓存，见 bilibili.ts）；
 * 3. 请求参数按 key 字典序排序、过滤 value 中 `!'()*` 字符、urlencode、追加 wts，
 *    `w_rid = md5(query + mixinKey)`。
 *
 * 本文件全部为纯函数：同步、无网络、无 chrome.* 依赖，可单测（A3）。
 */

/** 混淆表：mixinKey[i] = (imgKey + subKey)[MIXIN_KEY_ENC_TAB[i]] */
export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;

/** 拼接 imgKey + subKey（共 64 字符），按混淆表重排，取前 32 位 */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let key = '';
  for (let i = 0; i < 32; i++) {
    key += raw[MIXIN_KEY_ENC_TAB[i]];
  }
  return key;
}

/**
 * wbi 参数签名。
 *
 * @param params   业务参数（value 中 `!'()*` 会被过滤，与 B 站前端行为一致）
 * @param mixinKey getMixinKey 产物（32 字符）
 * @param wts      秒级时间戳
 * @returns 完整 query string：`k1=v1&k2=v2&...&wts=...&w_rid=<md5 hex>`
 */
export function signWbiParams(
  params: Record<string, string | number>,
  mixinKey: string,
  wts: number,
): string {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) merged[k] = String(v);
  merged['wts'] = String(wts);

  const query = Object.keys(merged)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(merged[k].replace(/[!'()*]/g, ''))}`)
    .join('&');

  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

// ---------------------------------------------------------------------------
// md5（同步、纯 TS）
// ---------------------------------------------------------------------------

/**
 * 同步 md5，输出 32 位小写 hex。
 *
 * 为什么手写：Web Crypto 的 SubtleCrypto.digest 是异步接口，无法用于同步签名；
 * 项目约定不为此引入新依赖。实现遵循 RFC 1321，参考 Joseph Myers 的
 * public-domain JavaScript md5（http://www.myersdaily.org/joseph/javascript/md5.js）
 * 的算法结构改写为 Uint8Array/DataView 字节序处理。正确性由 RFC 1321
 * 测试向量单测保证（见 tests/unit/providers/wbi.test.ts）。
 */

/** 每轮循环左移位数（RFC 1321） */
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/** 常量表 T[i] = floor(abs(sin(i+1)) * 2^32)，十六进制写死避免浮点误差（RFC 1321） */
const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
  0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
  0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
  0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
  0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
  0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
  0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
  0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
  0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
] as const;

/** UTF-8 编码（手动实现，避免依赖编码器环境差异） */
function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i);
    if (c === undefined) continue;
    if (c > 0xffff) i++; // 代理对消耗两个 code unit
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

const rotl = (x: number, c: number): number => ((x << c) | (x >>> (32 - c))) | 0;

/** md5(input) → 32 位小写十六进制摘要 */
export function md5(input: string): string {
  const msg = utf8Bytes(input);
  const len = msg.length;
  const bitLen = len * 8;

  // 填充至 56 (mod 64) + 8 字节小端位长度
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + MD5_K[i] + m[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, MD5_S[i])) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  // md5 摘要按 a/b/c/d 寄存器的小端字节序输出
  const hexWordLE = (w: number): string => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hexWordLE(a0) + hexWordLE(b0) + hexWordLE(c0) + hexWordLE(d0);
}
