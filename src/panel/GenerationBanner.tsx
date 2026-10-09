/**
 * 生成来源提示条：诚实展示"本内容由哪个模型生成，或走了默认规则兜底"。
 * 放在各 Tab 内容顶部；未发生过生成时不渲染。
 */
import { useEffect, useState } from 'react';
import {
  generationBannerText,
  getGenerationSource,
  subscribeGeneration,
  type GenerationModule,
} from './generationTrace';

export function GenerationBanner({ module }: { module: GenerationModule }) {
  const [text, setText] = useState<string | null>(() => generationBannerText(getGenerationSource(module)));

  useEffect(() => {
    const update = (): void => setText(generationBannerText(getGenerationSource(module)));
    update();
    return subscribeGeneration(update);
  }, [module]);

  if (!text) return null;
  return <div className="generation-banner">{text}</div>;
}
