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
  // 显式像素尺寸：mermaid 恒输出 width="100%"（非像素）——会被栅格化锁死在 100px。
  // 非像素或缺失 → 一律用 viewBox（或默认）重写为像素。
  const wMatch = out.match(/(<svg\b[^>]*?)\s(width)="([^"]*)"/);
  const hMatch = out.match(/(<svg\b[^>]*?)\s(height)="([^"]*)"/);
  const wOk = wMatch ? attrPixels(wMatch[3]) !== null : false;
  const hOk = hMatch ? attrPixels(hMatch[3]) !== null : false;
  if (wOk && hOk) return out;
  const vb = out.match(/<svg\b[^>]*\bviewBox="([\d.,\s-]+)"/)?.[1];
  const nums = vb ? vb.split(/[,\s]+/).map(Number) : [];
  const w = !wOk && nums.length === 4 && nums[2] > 0 ? Math.ceil(nums[2]) : 1200;
  const h = !hOk && nums.length === 4 && nums[3] > 0 ? Math.ceil(nums[3]) : 800;
  return rewriteSvgSize(out, w, h);
}

/** 重写 SVG 的 width/height 为指定像素（缺失则补；保留其余属性） */
export function rewriteSvgSize(svg: string, w: number, h: number): string {
  let out = svg;
  const wMatch = out.match(/(<svg\b[^>]*?)\s(width)="([^"]*)"/);
  const hMatch = out.match(/(<svg\b[^>]*?)\s(height)="([^"]*)"/);
  out = wMatch
    ? out.replace(wMatch[0], `${wMatch[1]} width="${w}"`)
    : out.replace(/<svg\b/, `<svg width="${w}"`);
  out = hMatch
    ? out.replace(hMatch[0], `${hMatch[1]} height="${h}"`)
    : out.replace(/<svg\b/, `<svg height="${h}"`);
  return out;
}

/** SVG 属性值 → 像素数；百分比/auto/非法值返回 null（"100%" 是 mermaid 默认） */
function attrPixels(v: string): number | null {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (v.trim().endsWith('%')) return null;
  return Math.round(n);
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
  // SVG 声明尺寸即目标分辨率（调用方已烘焙/已缩放）；实体归一防 XML 拒载
  const sizedSvg = xmlSafeSvg(svg);
  const { width: targetW, height: targetH } = svgIntrinsicSize(sizedSvg);
  // 编码阶梯（2026-10-19 用户实测 percent 编码在部分 SVG 上拒载）：
  // ① percent-encoded data URL（同源安全，不 taint canvas——html-to-image 同路径）
  // ② base64 data URL（规避 percent 编码对特殊字符的兼容坑）
  // ③ blob: URL（最后手段——foreignObject 场景可能 taint，到 toBlob 才会暴露）
  const candidates: Array<() => string> = [
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedSvg)}`,
    () => `data:image/svg+xml;base64,${svgToBase64(sizedSvg)}`,
    () => URL.createObjectURL(new Blob([sizedSvg], { type: 'image/svg+xml;charset=utf-8' })),
  ];
  let img: HTMLImageElement | null = null;
  let lastError = '所有编码方式均加载失败';
  for (const make of candidates) {
    const src = make();
    try {
      img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('load-failed'));
        el.src = src;
      });
      break;
    } catch {
      lastError = diagnoseSvgFailure(sizedSvg);
    } finally {
      if (src.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(src), 5_000);
    }
  }
  {
    if (!img) {
      throw new Error(
        `图片转换失败：${lastError}。请改用 SVG 格式下载，或重新生成导图后重试。`,
      );
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前环境不支持画布导出（未取到 2D 上下文）');
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, targetW, targetH); // 1:1：文字已在目标分辨率排版
    const canvasW = targetW;
    const canvasH = targetH;
    const blob = await new Promise<Blob | null>((resolve, reject) => {
      try {
        canvas.toBlob(resolve, opts.type, opts.quality ?? 0.92);
      } catch (err) {
        // SecurityError: canvas 被 taint（foreignObject + 非 data 源等场景）→ 给用户可读出路
        reject(
          new Error(
            `位图导出失败（${err instanceof Error ? err.message : String(err)}）。请改用 SVG 格式，或重新生成导图后重试。`,
          ),
        );
      }
    });
    if (!blob) throw new Error('位图编码失败（画布尺寸可能超出浏览器上限），请改用 SVG 格式');
    return { blob, width: canvasW, height: canvasH };
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

/**
 * XML 实体归一：mermaid 11 的标签渲染会把空格写成 &nbsp;（HTML 命名实体，
 * **XML 非法**）——SVG-as-image 按 XML 解析 → parsererror → 三种编码全部拒载。
 * 解码所有非 XML 五实体为真实字符（\u00A0 等在 XML 文本节点中合法）。
 */
export function xmlSafeSvg(svg: string): string {
  const decode = document.createElement('textarea');
  return svg.replace(/&[a-zA-Z][a-zA-Z0-9]*;/g, (ent) => {
    if (/^&(amp|lt|gt|quot|apos);$/.test(ent)) return ent; // XML 五实体合法
    decode.innerHTML = ent;
    return decode.value;
  });
}

/** SVG 拒载原因诊断（自动检查，不猜）：XML 合法性 / foreignObject 存在性 */
function diagnoseSvgFailure(svg: string): string {
  try {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) {
      return 'SVG 内容不是合法 XML（节点文字含未转义的特殊字符）';
    }
  } catch {
    /* DOMParser 不可用（极旧环境）→ 沿用通用文案 */
  }
  if (svg.includes('<foreignObject')) {
    return '导图含富文本节点（foreignObject），当前浏览器拒绝将其栅格化';
  }
  return '浏览器无法把当前导图渲染为位图（所有编码方式均拒载）';
}

/** SVG 字符串 → base64（分块处理，防大字符串 String.fromCharCode(...arr) 溢出） */
function svgToBase64(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  const CHUNK = 8_192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * markmap 等 foreignObject SVG 的自包含化（Chromium SVG-as-image 硬要求）：
 * 克隆 SVG，把 foreignObject 内每个元素的计算样式（getComputedStyle.cssText）
 * 内联为 style 属性——序列化产物不依赖页面 CSS，浏览器才肯把它当图片加载栅格化。
 * 这是 html-to-image / dom-to-image 系列库的同一原理。
 */
export function inlineSvgStyles(
  svgEl: SVGSVGElement,
  targetW?: number,
  targetH?: number,
): string {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const srcFos = Array.from(svgEl.querySelectorAll('foreignObject'));
  clone.querySelectorAll('foreignObject').forEach((fo, i) => {
    const srcEls = Array.from(srcFos[i]?.querySelectorAll<HTMLElement>('*') ?? []);
    Array.from(fo.querySelectorAll<HTMLElement>('*')).forEach((el, j) => {
      const srcEl = srcEls[j];
      if (!srcEl) return;
      try {
        const css = getComputedStyle(srcEl).cssText;
        if (css) el.setAttribute('style', css);
      } catch {
        /* 计算样式取不到（罕见）→ 保留原样 */
      }
    });
  });
  // 显式像素尺寸：markmap 的 svg 宽高多为 100%/样式化——栅格化会被锁死在 100px
  // （用户实测"清晰度很差"的根因）。优先目标尺寸，回落 viewBox/实测。
  const vb = (svgEl.getAttribute('viewBox') ?? '').split(/[,\s]+/).map(Number);
  const baseW = attrPixels(svgEl.getAttribute('width') ?? '') ?? Math.ceil(svgEl.clientWidth || 1200);
  const baseH = attrPixels(svgEl.getAttribute('height') ?? '') ?? Math.ceil(svgEl.clientHeight || 800);
  const w = targetW ?? (vb.length === 4 && Number.isFinite(vb[2]) && vb[2] > 0 ? Math.ceil(vb[2]) : baseW ?? 1200);
  const h = targetH ?? (vb.length === 4 && Number.isFinite(vb[3]) && vb[3] > 0 ? Math.ceil(vb[3]) : baseH ?? 800);
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  // markmap 无 viewBox：内容经根 g 的 translate+scale 缩进容器——画布放大后
  // transform 必须同步放大，否则内容仍按原比例挤在左上角（"横向被压缩"根因）。
  const factor = baseW > 0 ? w / baseW : 1;
  if (Math.abs(factor - 1) > 0.01) {
    const g = clone.querySelector('g');
    const tf = g?.getAttribute('transform');
    if (tf) {
      const m = tf.match(/translate\(\s*([-.\d]+)[,\s]+([-.\d]+)\s*\)\s*(?:scale\(\s*([-.\d]+)\s*\))?/);
      if (m && g) {
        const tx = Number(m[1]) * factor;
        const ty = Number(m[2]) * factor;
        const k = Number(m[3] ?? 1) * factor;
        g.setAttribute('transform', `translate(${tx},${ty}) scale(${k})`);
      }
    }
  }
  return new XMLSerializer().serializeToString(clone);
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

/**
 * 按格式导出。svgEl = 渲染画布里的**存活 SVG 元素**（推荐）：走自包含化
 * （foreignObject 内联计算样式——Chromium SVG-as-image 硬要求）；无元素时用
 * svg 字符串兜底。PNG 默认白底（思维导图深色文字在透明底上看不清）。
 */
export async function exportCanvasAsFormat(args: {
  /** 渲染画布中的存活 SVG 元素（markmap / mermaid 均可） */
  svgEl?: SVGSVGElement | null;
  /** 兜底 SVG 字符串（无存活元素时） */
  svg?: string;
  format: CanvasExportFormat;
  fileName: string;
  /** 超采样倍率（默认 2；小容器导图建议 3） */
  scale?: number;
}): Promise<void> {
  const { format, fileName } = args;
  const scale = args.scale ?? 2;
  // 目标尺寸 = 基数（元素实测/声明）× scale，保底 2000px 宽
  const baseW =
    (args.svgEl ? attrPixels(args.svgEl.getAttribute('width') ?? '') : null) ??
    (args.svgEl?.clientWidth ?? 0) ??
    0;
  const baseH =
    (args.svgEl ? attrPixels(args.svgEl.getAttribute('height') ?? '') : null) ??
    (args.svgEl?.clientHeight ?? 0) ??
    0;
  const targetW = Math.max(2000, Math.round(baseW * scale));
  const targetH = Math.max(1, Math.round(targetW * (baseH / (baseW || 1))));
  const raw = args.svgEl
    ? inlineSvgStyles(args.svgEl, targetW, targetH)
    : rewriteSvgSize(ensureStandaloneSvg(args.svg ?? ''), targetW, targetH);
  const svg = ensureStandaloneSvg(xmlSafeSvg(raw));
  if (format === 'svg') {
    downloadBlobFile(`${fileName}.svg`, new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    return;
  }
  if (format === 'png') {
    const { blob } = await svgToRaster(svg, { type: 'image/png', background: '#ffffff', scale });
    downloadBlobFile(`${fileName}.png`, blob);
    return;
  }
  // JPG / PDF：白底栅格化（导图透明背景直接压 JPG 会黑底）
  const raster = await svgToRaster(svg, {
    type: 'image/jpeg',
    background: '#ffffff',
    scale,
  });
  if (format === 'jpg') {
    downloadBlobFile(`${fileName}.jpg`, raster.blob);
    return;
  }
  const jpegBytes = new Uint8Array(await raster.blob.arrayBuffer());
  downloadBlobFile(`${fileName}.pdf`, jpegBytesToPdf(jpegBytes, raster.width, raster.height));
}
