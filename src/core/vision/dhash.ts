/**
 * 感知哈希 dHash（纯函数，零依赖；content 与 panel 共用）。
 *
 * 做法：画面缩到 9×8 灰度，逐行比较相邻像素明暗 → 64 bit。
 * 对 JPEG 压缩、轻微缩放、光标移动、讲师头像小窗晃动不敏感；
 * 对"换了一页 PPT / 代码滚动了一屏"敏感——正好是教学视频去重需要的粒度。
 *
 * 旧去重用"base64 长度差 < 2%"判断同一画面：长度相近的不同画面会被误删，
 * 同一画面因噪声长度差 > 2% 又删不掉，两头都不可靠。
 */

export const DHASH_W = 9;
export const DHASH_H = 8;

/**
 * 灰度像素（长度 9×8，行优先）→ 16 位十六进制 dHash。
 * 非法输入返回空串（调用方视为"无哈希"，回退时间间隔去重）。
 */
export function dhashFromGray(gray: ArrayLike<number>): string {
  if (!gray || gray.length < DHASH_W * DHASH_H) return '';
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < DHASH_H; y++) {
    for (let x = 0; x < DHASH_W - 1; x++) {
      const left = gray[y * DHASH_W + x]!;
      const right = gray[y * DHASH_W + x + 1]!;
      nibble = (nibble << 1) | (left > right ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

/** RGBA 像素（9×8×4）→ 灰度数组（ITU-R BT.601 亮度） */
export function grayFromRgba(rgba: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    out.push(0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!);
  }
  return out;
}

/** 两个 dHash 的汉明距离；任一为空或长度不同 → Infinity（视为"不同画面"） */
export function hammingDistance(a: string | undefined, b: string | undefined): number {
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    if (Number.isNaN(x)) return Number.POSITIVE_INFINITY;
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}
