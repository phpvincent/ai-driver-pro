/**
 * 画布导出（SPEC-17 配套）：SVG → PNG / JPG / PDF，多格式下载。
 *
 * 为什么原来只有 SVG：markmap / mermaid 的原生产物就是 SVG，序列化即得，零转换。
 * 但 SVG 通用性差（微信预览 / 部分手机相册 / Word 插图经常打不开）——本模块补齐：
 * - PNG：2 倍超采样（清晰度），保留透明背景，文档插图首选
 * - JPG：白底（导图 SVG 默认透明，直接压缩会糊成黑底），分享兼容性最好
 * - PDF：**零依赖手写封装**（JPEG 字节流经 DCTDecode 直嵌 PDF，无需 jsPDF ~350KB）
 *
 * 纯浏览器端（canvas + Blob），无网络请求；失败 throw 由调用方展示。
 */

export type CanvasExportFormat = 'png' | 'jpg' | 'pdf' | 'svg';

export const CANVAS_EXPORT_FORMATS: ReadonlyArray<{
  value: CanvasExportFormat;
  label: string;
}> = [
  { value: 'png', label: 'PNG（通用·清晰）' },
  { value: 'jpg', label: 'JPG（白底·兼容）' },
  { value: 'pdf', label: 'PDF（打印/分享）' },
  { value: 'svg', label: 'SVG（矢量·可缩放）' },
];

/** 独立文件可打开的兜底：无 width/height 时按 viewBox 补齐 + 补 xmlns（<img> 加载需要显式尺寸） */
export function ensureStandaloneSvg(svg: string): string {
  let out = svg;
  if (!/<svg\b[^>]*\bxmlns=/.test(out)) {
    out = out.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!/<svg\b[^>]*\bwidth=/.test(out)) {
    const vb = out.match(/<svg\b[^>]*\bviewBox="([\d.,\s-]+)"/)?.[1];
    const nums = vb ? vb.split(/[,\s]+/).map(Number) : [];
    const w = nums.length === 4 && nums[2] > 0 ? Math.ceil(nums[2]) : 1200;
    const h = nums.length === 4 && nums[3] > 0 ? Math.ceil(nums[3]) : 800;
    out = out.replace(/<svg\b/, `<svg width="${w}" height="${h}"`);
  }
  return out;
}

/** 解析 SVG 显式尺寸（ensureStandaloneSvg 之后必有） */
export function svgIntrinsicSize(svg: string): { width: number; height: number } {
  const w = Number(svg.match(/<svg\b[^>]*\bwidth="(\d+)/)?.[1] ?? 1200);
  const h = Number(svg.match(/<svg\b[^>]*\bheight="(\d+)/)?.[1] ?? 800);
  return { width: Math.max(1, w), height: Math.max(1, h) };
}

/**
 * SVG → 位图（canvas 超采样栅格化）。
 * background 传色值（如 '#ffffff'）则填充（JPG 必须；PNG 不填=保留透明）。
 */
export async function svgToRaster(
  svg: string,
  opts: { type: 'image/png' | 'image/jpeg'; scale?: number; background?: string; quality?: number },
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = opts.scale ?? 2;
  const { width, height } = svgIntrinsicSize(svg);
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(
          new Error(
            '图片转换失败：浏览器无法把当前导图渲染为位图（复杂样式所致）。请改用 SVG 格式下载。',
          ),
        );
      el.src = blobUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale) || width * scale;
    canvas.height = Math.round(img.naturalHeight * scale) || height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持画布导出（未取到 2D 上下文）');
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, opts.type, opts.quality ?? 0.92),
    );
    if (!blob) throw new Error('位图编码失败（画布尺寸可能超出浏览器上限），请改用 SVG 格式');
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * JPEG 字节流 → PDF（**零依赖手写**）：JPEG 经 /Filter /DCTDecode 直接嵌入——
 * PDF 规范允许此法，无需任何第三方库。px → pt 按 0.75 折算（96dpi → 72dpi）。
 */
export function jpegBytesToPdf(jpeg: Uint8Array, pxWidth: number, pxHeight: number): Blob {
  const w = Math.max(1, Math.round(pxWidth * 0.75));
  const h = Math.max(1, Math.round(pxHeight * 0.75));
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Uint8Array): void => {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  push('%PDF-1.4\n');
  offsets[1] = length;
  push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  offsets[2] = length;
  push(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
  offsets[3] = length;
  push(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  );
  offsets[4] = length;
  push(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pxWidth} /Height ${pxHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push('\nendstream\nendobj\n');
  const content = `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`;
  offsets[5] = length;
  push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  const xrefPos = length;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

/** 二进制 Blob 下载（与 platform/files 的 downloadTextFile 同款兜件） */
export function downloadBlobFile(filename: string, blob: Blob): void {
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持文件下载（未找到 document）');
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** 按格式导出（SVG 源串须已经过 ensureStandaloneSvg） */
export async function exportCanvasAsFormat(args: {
  svg: string;
  format: CanvasExportFormat;
  fileName: string;
}): Promise<void> {
  const { svg, format, fileName } = args;
  if (format === 'svg') {
    downloadBlobFile(`${fileName}.svg`, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    return;
  }
  if (format === 'png') {
    const { blob } = await svgToRaster(svg, { type: 'image/png' });
    downloadBlobFile(`${fileName}.png`, blob);
    return;
  }
  // JPG / PDF：白底栅格化（导图透明背景直接压 JPG 会黑底）
  const raster = await svgToRaster(svg, { type: 'image/jpeg', background: '#ffffff' });
  if (format === 'jpg') {
    downloadBlobFile(`${fileName}.jpg`, raster.blob);
    return;
  }
  const jpegBytes = new Uint8Array(await raster.blob.arrayBuffer());
  downloadBlobFile(`${fileName}.pdf`, jpegBytesToPdf(jpegBytes, raster.width, raster.height));
}
