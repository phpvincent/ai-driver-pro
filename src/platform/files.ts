/**
 * 文件能力适配（宪法红线 11；SPEC-09 9.6）。
 *
 * 下载用 Web 标准的 Blob + <a download>（Chromium / Firefox 均支持），
 * 不依赖 chrome.downloads——能力不存在时（极端环境）抛错由调用方行内展示，
 * 绝不静默失败。纯 DOM API，无 chrome.* 调用。
 */

/**
 * 触发浏览器下载一个文本文件。
 * @param filename 建议文件名（含扩展名）
 * @param text 文件内容（UTF-8）
 * @param mime MIME 类型，默认 application/json
 */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'application/json',
): void {
  if (typeof document === 'undefined') {
    throw new Error('当前环境不支持文件下载（未找到 document）');
  }
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 释放 objectURL：延后一拍，避免个别内核在 click 事件内就回收
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 读取用户选择的文本文件（交换格式导入用）。
 * 返回 { name, text }；取消选择（无文件）返回 null；读取失败 reject。
 */
export function readTextFileViaInput(
  accept = '.json,application/json',
): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const cleanup = () => {
      input.remove();
    };
    const finish = (r: { name: string; text: string } | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        finish({ name: file.name, text: String(reader.result ?? '') });
      };
      reader.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`读取文件失败：${file.name}`));
      };
      reader.readAsText(file, 'utf-8');
    });
    // 取消选择：change 不触发，focus 回到页面后再延迟判定（无 cancel 事件可依赖）
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => {
          if (!settled && (input.files?.length ?? 0) === 0) finish(null);
        }, 500);
      },
      { once: true },
    );
    input.click();
  });
}
