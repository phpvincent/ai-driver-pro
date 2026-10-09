/**
 * 问答 Tab 的图片上传（题目截图 / 手写草稿 / 报错截图）。
 *
 * 与视频抽帧的区别：
 * - 语义不同：这是**学生带来的题目**，不是课程画面——提示词里要单独标注，并切换为"先读题再作答"；
 * - 门控不同：只要模型支持多模态就发送，不受"结合画面（抽帧）"开关约束——用户显式上传，意图明确；
 * - 分辨率更高：题目截图常含公式、小字号代码，最长边 1280px（视频帧是 896px）。
 *
 * 纯函数（校验 / 尺寸 / 说明文本）可单测；压缩依赖浏览器 canvas，注入式。
 */

/** 单次提问最多附带几张图 */
export const UPLOAD_MAX_IMAGES = 4;
/** 原始文件大小上限（压缩前）：防止误选超大照片卡死面板 */
export const UPLOAD_MAX_FILE_BYTES = 15 * 1024 * 1024;
/** 压缩后最长边：题目小字 / 公式在 1280px 下仍可稳定识别 */
export const UPLOAD_MAX_SIDE = 1280;
/** JPEG 质量（只影响体积，不影响 token） */
export const UPLOAD_QUALITY = 0.85;

const ACCEPTED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];
export const UPLOAD_ACCEPT = ACCEPTED_MIME.join(',');

export interface UploadedImage {
  id: string;
  /** 文件名（展示用） */
  name: string;
  /** 压缩后的 JPEG base64（不含 data: 前缀） */
  dataBase64: string;
  mime: 'image/jpeg';
  width: number;
  height: number;
}

/** 文件校验：返回错误文案；通过返回 null */
export function validateUploadFile(
  file: { type: string; size: number; name?: string },
  existingCount: number,
): string | null {
  if (existingCount >= UPLOAD_MAX_IMAGES) return `最多附带 ${UPLOAD_MAX_IMAGES} 张图片`;
  if (!ACCEPTED_MIME.includes(file.type)) return `不支持的图片格式：${file.type || file.name || '未知'}`;
  if (file.size > UPLOAD_MAX_FILE_BYTES) return `图片过大（>${Math.round(UPLOAD_MAX_FILE_BYTES / 1024 / 1024)}MB）`;
  return null;
}

/** 等比缩放到最长边 ≤ maxSide（不放大） */
export function fitSize(width: number, height: number, maxSide = UPLOAD_MAX_SIDE): { width: number; height: number } {
  const w = Number.isFinite(width) && width > 0 ? width : 1;
  const h = Number.isFinite(height) && height > 0 ? height : 1;
  const longest = Math.max(w, h);
  if (longest <= maxSide) return { width: Math.round(w), height: Math.round(h) };
  const f = maxSide / longest;
  return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round(h * f)) };
}

/** 发给模型时紧贴每张上传图前的说明（与视频帧的【画面 i/N】区分开） */
export function uploadCaption(index: number, total: number, name: string): string {
  const label = name ? `「${name.slice(0, 40)}」` : '';
  return `【学生上传的图片 ${index + 1}/${total}${label}】这是学生自己带来的题目或截图，不是课程画面。`;
}

/**
 * 问题文本的附加说明：告诉模型本轮带了上传图、该如何对待。
 * 放在用户问题之后，由 explain 层拼进 question（不改动 prompt 文件）。
 */
export function uploadQuestionNote(count: number): string {
  if (count <= 0) return '';
  return (
    `\n\n（学生附带了 ${count} 张图片，见【学生上传的图片】。请先读懂图片中的题目/内容并在 answer 开头简要复述题意，` +
    '再结合这节课讲过的方法给出解题思路与步骤；图片中看不清的部分请明确指出，不要臆测。' +
    '若题目与这节课无关，coveredByVideo 取 false 并按公开知识解答。）'
  );
}

/** 用户消息气泡的附件提示 */
export function attachmentLabel(count: number): string {
  return count > 0 ? `📎 ${count} 张图片` : '';
}

/**
 * 浏览器压缩：File → 等比缩放到 1280 → JPEG。
 * 注入点 decode 便于单测；默认用 createImageBitmap + canvas。
 */
export async function compressImageFile(
  file: File,
  id: string,
  decode: (file: File) => Promise<{ width: number; height: number; draw: (w: number, h: number) => string }> = defaultDecode,
): Promise<UploadedImage> {
  const img = await decode(file);
  const size = fitSize(img.width, img.height);
  const dataUrl = img.draw(size.width, size.height);
  const idx = dataUrl.indexOf(';base64,');
  const dataBase64 = idx >= 0 ? dataUrl.slice(idx + ';base64,'.length) : '';
  if (!dataBase64) throw new Error('图片编码失败');
  return { id, name: file.name, dataBase64, mime: 'image/jpeg', width: size.width, height: size.height };
}

async function defaultDecode(file: File): Promise<{ width: number; height: number; draw: (w: number, h: number) => string }> {
  const bitmap = await createImageBitmap(file);
  return {
    width: bitmap.width,
    height: bitmap.height,
    draw: (w, h) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas 不可用');
      // 透明 PNG 转 JPEG 会变黑底：先铺白
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();
      return canvas.toDataURL('image/jpeg', UPLOAD_QUALITY);
    },
  };
}
