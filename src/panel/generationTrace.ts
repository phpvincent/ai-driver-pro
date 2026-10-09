/**
 * 生成来源追踪（诚实澄清）：每个模块最近一次生成是由哪个模型完成，
 * 还是走了默认规则兜底（模型不可用）。供各 Tab 顶部的提示条展示。
 *
 * 简单发布/订阅：loader 写入，GenerationBanner 组件订阅刷新。
 */

export interface GenerationSource {
  kind: 'model' | 'fallback';
  /** kind='model' 时的模型名 */
  model?: string;
  /** kind='fallback' 时的原因（如"模型未配置""模型调用失败"） */
  reason?: string;
  at: number;
}

export type GenerationModule = 'outline' | 'mindmap' | 'qa';

const sources = new Map<GenerationModule, GenerationSource>();
const listeners = new Set<() => void>();

export function setGenerationSource(module: GenerationModule, src: Omit<GenerationSource, 'at'>): void {
  sources.set(module, { ...src, at: Date.now() });
  for (const fn of listeners) fn();
}

export function getGenerationSource(module: GenerationModule): GenerationSource | null {
  return sources.get(module) ?? null;
}

export function subscribeGeneration(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 横幅文案（导出供测试） */
export function generationBannerText(src: GenerationSource | null): string | null {
  if (!src) return null;
  if (src.kind === 'model' && src.model) {
    return `本内容由模型「${src.model}」生成`;
  }
  return `本内容由默认规则生成（模型不可用${src.reason ? `：${src.reason}` : ''}）`;
}
