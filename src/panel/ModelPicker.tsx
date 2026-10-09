/**
 * 模型选择器（与设置页「模型配置」深度绑定）：
 * 下拉只在内置预设（DeepSeek / Qwen）之间切换，选项即设置页里那两个模型，
 * 切一个等于三个 Tab 一起切（大纲 / 导图 / 问答共用一套配置）。
 *
 * - 选项与 Key 状态来自 `Settings.modelSlots`（每个预设各存各的 Key，互不覆盖）；
 * - 支持图像输入的预设标红（`picker-opt-vision`），提示可用于抽帧；
 * - 未配置 API Key → 红色提示 + 「去设置」入口，不静默回退；
 * - 实测保存：切换即写入 settings.model（该预设槽位已保存的完整配置）。
 *
 * 自包含组件：自管理状态，不需要父组件传数据；三个 Tab 各挂一个。
 */
import { useEffect, useState } from 'react';
import { MSG } from '../messages';
import {
  activePreset,
  migrateLegacyModelSettings,
  presetKeys,
  presetShortLabel,
  presetVisionDefault,
  slotConfigOf,
  slotHasKey,
  type PresetKey,
} from './settings/modelForm';
import type { Settings } from '../types';

export interface PickerOption {
  /** 内置预设键（deepseek / qwen） */
  value: PresetKey;
  label: string;
  /** 该预设是否已保存 API Key（红色提示依据） */
  hasKey: boolean;
  /** 该预设是否支持图像输入（下拉项标红） */
  vision: boolean;
}

export interface ModelPickerProps {
  /** 未配置 Key 时的「去设置」入口（由各 Tab 透传 App 的 onOpenSettings） */
  onOpenSettings?: () => void;
}

/** 未配置 Key 时的提示文案（导出供测试） */
export const PICKER_MISSING_KEY_HINT = '未配置 API Key';

/**
 * 下拉选项（纯函数，导出供测试）：固定为 MODEL_PRESETS 的两个内置预设。
 * label 里带「· 多模态」后缀，hasKey 取该预设槽位的 Key 状态。
 */
export function buildPickerOptions(settings: Settings): PickerOption[] {
  return presetKeys().map((key) => {
    const cfg = slotConfigOf(settings, key);
    const vision = cfg.supportsVision ?? presetVisionDefault(key);
    return {
      value: key,
      label: vision ? `${presetShortLabel(key)} · 多模态` : presetShortLabel(key),
      hasKey: slotHasKey(settings, key),
      vision,
    };
  });
}

/** 当前生效配置落在哪个预设上（自定义端点 → null，下拉显示为未选中） */
export function currentPresetOf(settings: Settings): PresetKey | null {
  return activePreset(settings.model?.baseUrl ?? '');
}

/** chrome.runtime.sendMessage 的安全包装：上下文失效时静默返回 null */
function sendRuntimeMessage(message: unknown): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve(null);
  }
}

/** 读取整份 settings（GET_SETTINGS）；异常时返回空对象 */
function fetchSettings(): Promise<Settings> {
  return sendRuntimeMessage({ type: MSG.GET_SETTINGS })
    .then((response) => {
      const stored = (response ?? {}) as Settings;
      return stored && typeof stored === 'object' ? migrateLegacyModelSettings(stored) : {};
    })
    .catch(() => ({}));
}

export function ModelPicker({ onOpenSettings }: ModelPickerProps) {
  const [options, setOptions] = useState<PickerOption[]>([]);
  const [selected, setSelected] = useState<PresetKey | ''>('');

  useEffect(() => {
    let cancelled = false;
    fetchSettings()
      .then((stored) => {
        if (cancelled) return;
        setOptions(buildPickerOptions(stored));
        setSelected(currentPresetOf(stored) ?? '');
      })
      .catch(() => {
        /* 未读到设置时保持空选项 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 切换预设：把该槽位已保存的配置整体写为当前生效模型（含它自己的 Key）。
   * 只写 model 一个键，不动其他分区，也不覆盖另一预设的 Key。
   */
  const handleChange = (value: string) => {
    const preset = value as PresetKey;
    setSelected(preset);
    fetchSettings()
      .then((stored) => {
        const next: Settings = { ...stored, model: slotConfigOf(stored, preset) };
        return sendRuntimeMessage({ type: MSG.SET_SETTINGS, payload: next }).then(
          (response: unknown) => {
            if ((response as { ok?: boolean } | null)?.ok === true) {
              setOptions(buildPickerOptions(next));
            }
          },
        );
      })
      .catch(() => {
        /* 写失败静默（下次挂载重新读取） */
      });
  };

  const matched = options.find((o) => o.value === selected);
  /** 未保存过任何配置（自定义端点或空）时，下拉显示为空选中 */
  const displayOptions =
    selected && !matched
      ? [...options, { value: selected, label: selected, hasKey: false, vision: false }]
      : options;
  const missingKey = Boolean(selected) && (matched ? !matched.hasKey : true);

  return (
    <div className="model-picker">
      <label className="model-picker-field">
        <span>模型：</span>
        <select
          className="model-picker-select"
          value={selected}
          onChange={(e) => handleChange(e.target.value)}
        >
          {!selected && <option value="">（未选择）</option>}
          {displayOptions.map((o) => (
            <option
              key={o.value}
              value={o.value}
              className={o.vision ? 'picker-opt-vision' : undefined}
            >
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {missingKey && (
        <span className="model-picker-missing">
          {PICKER_MISSING_KEY_HINT}
          {onOpenSettings && (
            <button type="button" className="btn" onClick={onOpenSettings}>
              去设置
            </button>
          )}
        </span>
      )}
    </div>
  );
}
