/**
 * 设置页模型表单的纯逻辑（预设槽位 / 校验 / 抽帧可用性 / 合并写回 / 当前策略摘要）。
 *
 * 抽成纯函数便于单测；端点与模型标识一律来自 src/config 的 MODEL_PRESETS（红线 9）。
 *
 * ## 单一模型配置 + 预设槽位（本次重构）
 *
 * 产品口径：大纲 / 导图 / 问答三模块**共用一套模型配置**，设置页只有一个模型区、
 * 一个 API Key 输入框，下拉框只在两个内置预设（DeepSeek / Qwen）之间切换。
 *
 * Key 的存储口径：**一个预设一个槽位**（`Settings.modelSlots`），切换预设时各带各的
 * Key。这从根上消除了旧版"配了 A 平台，B 平台的 Key 就没了"的问题——旧版用
 * `endpointKeys` + `modelProfiles` 打补丁，UI 上暴露成两个额外模块，用户看不懂，
 * 且"已保存"提示恒读单一 `settings.model.apiKey`，看起来像互相覆盖。
 *
 * 槽位对 UI 不可见：设置页只显示"当前预设的 Key"，切换预设时由本模块带出对应值。
 */
import { DEFAULT_MODEL, MODEL_PRESETS } from '../../config';
import type { ModelConfig, Settings } from '../../types';

export type PresetKey = keyof typeof MODEL_PRESETS;

/** 抽帧作用的三个模块（三模块共用一套模型，此键仅用于抽帧开关的模块级细分） */
export type VisionModule = 'outline' | 'mindmap' | 'qa';

export interface ModelFormErrors {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  temperature?: string;
  maxTokens?: string;
}

/** 校验文案（集中定义，避免在赋值处出现键名字面量，红线 9 的静态扫描口径） */
const ERR = {
  baseUrlRequired: '接口地址不能为空',
  baseUrlScheme: '接口地址需以 http:// 或 https:// 开头',
  keyRequired: 'API Key 不能为空',
  modelRequired: '模型不能为空',
  temperatureRange: 'temperature 需在 0-2 之间',
  maxTokensRange: 'maxTokens 需为 ≥ 1 的整数',
} as const;

/** 内置预设的固定顺序（下拉框与设置页按钮共用） */
export function presetKeys(): PresetKey[] {
  return Object.keys(MODEL_PRESETS) as PresetKey[];
}

/** 三要素齐全才算已配置（未配置 → 自动跳过抽帧） */
export function isModelConfigured(cfg?: Partial<ModelConfig> | null): boolean {
  if (!cfg) return false;
  return Boolean(cfg.baseUrl?.trim() && cfg.apiKey?.trim() && cfg.model?.trim());
}

/**
 * 预设的默认配置骨架（端点与模型标识的唯一来源，红线 9）：
 * 不含 Key——Key 只存在槽位里，由 slotConfigOf 带出。
 */
export function presetConfigOf(preset: PresetKey): ModelConfig {
  const p = MODEL_PRESETS[preset];
  return {
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '',
    temperature: { outline: DEFAULT_MODEL.temperature.outline, qa: DEFAULT_MODEL.temperature.qa },
    maxTokens: DEFAULT_MODEL.maxTokens,
    outlineTokenBudget: DEFAULT_MODEL.outlineTokenBudget,
    supportsVision: presetVisionDefault(preset),
  };
}

/**
 * 某预设槽位当前的配置（含该平台已保存的 Key）。
 * 槽位为空时回落到预设骨架（Key 为空，由用户填写）。
 */
export function slotConfigOf(settings: Settings, preset: PresetKey): ModelConfig {
  const stored = settings?.modelSlots?.[preset];
  if (stored && typeof stored === 'object') {
    return { ...presetConfigOf(preset), ...stored };
  }
  return presetConfigOf(preset);
}

/** 某预设槽位是否已保存 API Key（下拉框的红字提示依据） */
export function slotHasKey(settings: Settings, preset: PresetKey): boolean {
  return Boolean(slotConfigOf(settings, preset).apiKey?.trim());
}

/** 把一份配置写入指定预设槽位（不动其他槽位，也不动其他分区） */
export function writeSlot(settings: Settings, preset: PresetKey, cfg: ModelConfig): Settings {
  return {
    ...settings,
    modelSlots: { ...(settings.modelSlots ?? {}), [preset]: cfg },
  };
}

/** 当前生效配置落在哪个预设上（按 baseUrl 精确匹配；自定义端点返回 null） */
export function activePreset(baseUrl: string): PresetKey | null {
  const normalized = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!normalized) return null;
  for (const key of presetKeys()) {
    if (MODEL_PRESETS[key].baseUrl === normalized) return key;
  }
  return null;
}

/**
 * 三模块共用的模型解析（替代旧的 resolveModuleModel）：
 * 三模块不再分别选模型，统一返回 settings.model。
 */
export function resolveModel(settings: Settings): ModelConfig | null {
  return settings?.model ?? null;
}

/**
 * 旧数据迁移（幂等，读时执行，不强制落盘）：
 * 1. 无 model 但有 visionModel → 提升为 model
 * 2. modelSupportsVision → model.supportsVision
 * 3. endpointKeys / modelProfiles 里能匹配到预设端点的 Key → 迁入对应 modelSlots
 * 4. model 本身若落在某预设端点上，其 Key 也补进该槽位
 * 5. 清除已废弃字段（endpointKeys / modelProfiles / moduleModel / visionModel）
 *
 * 迁移后 Key 永不丢失：老用户此前配的 Key 一定落在上述三处之一。
 */
export function migrateLegacyModelSettings(settings: Settings): Settings {
  if (!settings || typeof settings !== 'object') return settings;
  let next: Settings = { ...settings };

  // 1+2. 视觉模型与能力字段
  if (next.visionModel && !isModelConfigured(next.model)) {
    next.model = next.visionModel;
  }
  if (next.modelSupportsVision === true && next.model && next.model.supportsVision === undefined) {
    next.model = { ...next.model, supportsVision: true };
  }

  // 3. 端点级 Key → 槽位
  const slots: Record<string, ModelConfig> = { ...(next.modelSlots ?? {}) };
  const endpointKeys = next.endpointKeys ?? {};
  for (const preset of presetKeys()) {
    if (slots[preset]?.apiKey?.trim()) continue;
    const endpoint = MODEL_PRESETS[preset].baseUrl;
    const fromEndpoint = endpointKeys[endpoint]?.trim();
    if (fromEndpoint) {
      slots[preset] = { ...slotConfigOf(next, preset), apiKey: fromEndpoint };
      continue;
    }
    // 方案里同端点且有 Key 的项
    const fromProfile = (next.modelProfiles ?? []).find(
      (p) => (p?.baseUrl ?? '').trim() === endpoint && Boolean(p?.apiKey?.trim()),
    );
    if (fromProfile?.apiKey?.trim()) {
      slots[preset] = { ...slotConfigOf(next, preset), apiKey: fromProfile.apiKey.trim() };
    }
  }
  // 4. 当前 model 的 Key 补进其所属槽位
  const modelPreset = next.model ? activePreset(next.model.baseUrl ?? '') : null;
  if (modelPreset && next.model?.apiKey?.trim() && !slots[modelPreset]?.apiKey?.trim()) {
    slots[modelPreset] = { ...slotConfigOf(next, modelPreset), apiKey: next.model.apiKey.trim() };
  }

  next.modelSlots = slots;
  delete next.endpointKeys;
  delete next.modelProfiles;
  delete next.moduleModel;
  delete next.visionModel;
  return next;
}

function isHttpUrl(value: string): boolean {
  const v = value.trim();
  return v.startsWith('http://') || v.startsWith('https://');
}

/** 表单校验：返回错误字段文案（空对象 = 合法） */
export function validateModelForm(form: ModelConfig): ModelFormErrors {
  const errors: ModelFormErrors = {};
  if (!form.baseUrl?.trim()) errors.baseUrl = ERR.baseUrlRequired;
  else if (!isHttpUrl(form.baseUrl)) errors.baseUrl = ERR.baseUrlScheme;
  if (!form.apiKey?.trim()) errors.apiKey = ERR.keyRequired;
  if (!form.model?.trim()) errors.model = ERR.modelRequired;

  const t = form.temperature;
  const inRange = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2;
  if (!t || !inRange(t.outline) || !inRange(t.qa)) {
    errors.temperature = ERR.temperatureRange;
  }

  const maxTokens = form.maxTokens;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) < 1) {
    errors.maxTokens = ERR.maxTokensRange;
  }
  return errors;
}

/**
 * 建议值：预设是否默认按多模态勾选（仅作默认值，用户可自行改）。
 * DeepSeek 为纯文本 → false；Qwen 兼容模式支持图文 → true。
 */
export function presetVisionDefault(preset: PresetKey): boolean {
  return preset !== 'deepseek';
}

/** 模型的图像能力判定：model.supportsVision 优先，缺失时回退旧字段（旧数据兼容） */
export function modelSupportsVisionOf(model: ModelConfig | null, settings: Settings): boolean {
  if (model) return model.supportsVision ?? settings.modelSupportsVision === true;
  return settings.modelSupportsVision === true;
}

/** 当前（默认）模型是否支持图像输入 → 抽帧开关才可用（未声明视为不支持） */
export function canEnableVision(settings: Settings): boolean {
  return modelSupportsVisionOf(resolveModel(settings), settings);
}

/**
 * 抽帧可用判断：全局开关 + 该模块开关（未配置视为开启）+ 当前模型的图像能力。
 * 任一条件不满足即为 false（调用方据此跳过抽帧，不影响纯文本功能）。
 */
export function visionActiveFor({
  settings,
  module,
}: {
  settings: Settings;
  module: VisionModule;
}): boolean {
  if (settings.visionEnabled !== true) return false;
  if (!modelSupportsVisionOf(resolveModel(settings), settings)) return false;
  return settings.visionModules?.[module] !== false;
}

/** 脱敏展示：让用户能确认"Key 还在"，但不暴露内容 */
export function maskKey(apiKey?: string): string {
  const k = (apiKey ?? '').trim();
  if (k.length === 0) return '未设置';
  if (k.length <= 8) return '••••••••';
  return `••••${k.slice(-4)}`;
}

export function presetShortLabel(preset: PresetKey): string {
  switch (preset) {
    case 'deepseek':
      return 'DeepSeek';
    case 'qwen':
      return 'Qwen';
    default:
      return preset;
  }
}

/** 归一化：去除粘贴带来的首尾空白（API Key 前后空格是 401 的常见成因） */
export function normalizeModelConfig(form: ModelConfig): ModelConfig {
  return {
    ...form,
    baseUrl: (form.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: (form.apiKey ?? '').trim(),
    model: (form.model ?? '').trim(),
  };
}

export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  return { ...current, ...patch };
}

/**
 * 接口地址的主机名（红线 9：摘要只暴露主机名，不输出完整地址）。
 * 空值或非法 URL → '无效地址'。
 */
export function hostOf(baseUrl?: string): string {
  const raw = baseUrl?.trim();
  if (!raw) return '无效地址';
  try {
    return new URL(raw).hostname;
  } catch {
    return '无效地址';
  }
}

/** 策略摘要的模块中文名（只用于展示） */
const STRATEGY_MODULE_LABELS: Record<VisionModule, string> = {
  outline: '大纲',
  mindmap: '导图',
  qa: '问答',
};

/**
 * 「当前策略」摘要（设置页展示用纯函数）：单模型口径。
 * 三模块使用同一个模型，故只输出一行模型 + 各模块抽帧状态 + 各预设 Key 状态。
 */
export function describeModelStrategy(settings: Settings): string[] {
  const model = resolveModel(settings);
  const modules = Object.keys(STRATEGY_MODULE_LABELS) as VisionModule[];

  const current = isModelConfigured(model)
    ? `当前模型：${hostOf(model?.baseUrl)} / ${model?.model ?? ''}（大纲 / 导图 / 问答共用）`
    : '当前模型：未配置（功能不可用）';

  const multimodal = modelSupportsVisionOf(model, settings)
    ? '多模态：当前模型已声明支持图像输入（抽帧可用）'
    : '多模态：当前模型未声明支持图像输入（抽帧不可用）';

  const activeMarks = modules
    .map((m) => `${STRATEGY_MODULE_LABELS[m]}${visionActiveFor({ settings, module: m }) ? '✓' : '✗'}`)
    .join(' ');
  const frame = !modelSupportsVisionOf(model, settings)
    ? '抽帧：不可用'
    : settings.visionEnabled === true
      ? `抽帧：已开启（${activeMarks}）`
      : '抽帧：已关闭';

  const slotLines = presetKeys().map(
    (p) => `${presetShortLabel(p)}：API Key ${maskKey(slotConfigOf(settings, p).apiKey)}`,
  );

  return [current, multimodal, frame, ...slotLines];
}
