/**
 * 设置页（单一模型配置口径）：
 * - 挂载读 GET_SETTINGS，无值用当前预设骨架填默认
 * - 保存：校验后经 SET_SETTINGS 持久化（各分区共用 mergeSettings 合并写，互不覆盖）
 * - 测试连接：用当前表单值直接调 chatCompletion（ping, maxTokens 16），期间按钮禁用
 * - apiKey 仅存于表单状态与 storage，任何提示/日志不输出其值
 *
 * 分区顺序：模型配置（含「支持图像输入」声明）→ 当前策略 → 抽帧开关 →
 * Obsidian → 验证期报告。
 *
 * ## 模型配置（大纲 / 导图 / 问答共用一套）
 * 只暴露一个模型区与一个 API Key 输入框；顶部的 DeepSeek / Qwen 按钮与三个 Tab 的
 * 下拉框都是同一件事——切换内置预设。Key **按预设槽位保存**（`Settings.modelSlots`），
 * 切换时各带各的 Key，绝不互踩；用户在某个预设上改了但没保存的内容存在内存草稿里，
 * 切走再切回来不会丢（修复"配了 A 平台，B 平台的 Key 就没了 / 显示被覆盖"的根因）。
 * 端点与模型标识的唯一来源是 src/config 的 MODEL_PRESETS（红线 9）；预设同时按
 * presetVisionDefault 建议「支持图像输入」勾选，用户可自行改。
 *
 * Obsidian 区（SPEC-06）：接口地址 / API Key / 笔记根目录三字段，保存经
 * SET_SETTINGS 只合并 obsidian 段（不动 model），测试连接显示根目录条目数；
 * apiKey 用 password 输入，任何提示不输出明文。
 */
import { useEffect, useRef, useState } from 'react';
import { chatCompletion } from '../../core/harness/modelClient';
import { DEFAULT_MODEL, FRAME_PLAN, MODEL_PRESETS, OBSIDIAN, VISION } from '../../config';
import { ensureHostPermission, originOfBaseUrl } from '../../platform';
import { MSG } from '../../messages';
import { testObsidianConnection } from '../obsidianLoader';
import { downloadBackup, importBackup } from '../dataBackup';
import { readTextFileViaInput } from '../../platform/files';
import {
  activePreset,
  describeModelStrategy,
  maskKey,
  mergeSettings,
  migrateLegacyModelSettings,
  normalizeModelConfig,
  presetConfigOf,
  presetKeys,
  presetShortLabel,
  presetVisionDefault,
  slotConfigOf,
  validateModelForm,
  writeSlot,
  type ModelFormErrors,
  type PresetKey,
  type VisionModule,
} from './modelForm';
import type { ModelConfig, ObsidianConfig, Settings } from '../../types';

interface ModelFormState {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperatureOutline: string;
  temperatureQa: string;
  maxTokens: string;
}

/** 未配置时的初始表单（骨架取第一个预设，端点与模型标识来自 src/config） */
const INITIAL_MODEL_FORM: ModelFormState = {
  baseUrl: '',
  apiKey: '',
  model: '',
  temperatureOutline: String(DEFAULT_MODEL.temperature.outline),
  temperatureQa: String(DEFAULT_MODEL.temperature.qa),
  maxTokens: String(DEFAULT_MODEL.maxTokens),
};

interface ObsidianFormState {
  baseUrl: string;
  apiKey: string;
  rootDir: string;
  /** 暂时停用（SPEC-10 二轮冒烟：关掉后存入走本地 .md 下载，凭据保留） */
  enabled: boolean;
}

/** 未配置时的回填默认：只带接口地址默认值（OBSIDIAN.baseUrl，红线 9 的唯一来源） */
const INITIAL_OBSIDIAN_FORM: ObsidianFormState = {
  baseUrl: OBSIDIAN.baseUrl,
  apiKey: '',
  rootDir: '',
  enabled: true,
};

/** 抽帧模块开关（未配置视为开启） */
const INITIAL_VISION_MODULES: Record<VisionModule, boolean> = {
  outline: true,
  mindmap: true,
  qa: true,
};

const VISION_MODULE_LABELS: Record<VisionModule, string> = {
  outline: '大纲',
  mindmap: '导图',
  qa: '问答',
};

type Feedback = { kind: 'ok' | 'error'; text: string } | null;

/** chrome.runtime.sendMessage 的安全包装：上下文失效时静默返回 null */
function sendRuntimeMessage(message: unknown): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(message);
  } catch {
    return Promise.resolve(null);
  }
}

function formToModelConfig(form: ModelFormState, outlineTokenBudget: number): ModelConfig {
  return {
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    model: form.model.trim(),
    temperature: { outline: Number(form.temperatureOutline), qa: Number(form.temperatureQa) },
    maxTokens: Number(form.maxTokens),
    outlineTokenBudget,
  };
}

/** ModelConfig → 表单（切换预设 / 载入时用） */
function configToForm(cfg: ModelConfig): ModelFormState {
  return {
    baseUrl: cfg.baseUrl ?? '',
    apiKey: cfg.apiKey ?? '',
    model: cfg.model ?? '',
    temperatureOutline: String(cfg.temperature?.outline ?? DEFAULT_MODEL.temperature.outline),
    temperatureQa: String(cfg.temperature?.qa ?? DEFAULT_MODEL.temperature.qa),
    maxTokens: String(cfg.maxTokens ?? DEFAULT_MODEL.maxTokens),
  };
}

/** 校验结果里取第一条错误文案（表单逐字段提示之外给一行总提示） */
function firstError(errors: ModelFormErrors | Record<string, string | undefined>): string | null {
  for (const value of Object.values(errors)) {
    if (value) return value;
  }
  return null;
}

export function SettingsPage({
  onClose,
  onOpenValidationReport,
  onOpenLlmLog,
}: {
  onClose: () => void;
  /** SPEC-07：验证期报告入口（父 agent 接线；未传则隐藏该区） */
  onOpenValidationReport?: () => void;
  /** LLM 交互日志入口（验证期报告的子模块；未传则隐藏该按钮） */
  onOpenLlmLog?: () => void;
}) {
  const [form, setForm] = useState<ModelFormState>(INITIAL_MODEL_FORM);
  /** 预算上限不在表单中，读设置时保留已存值 */
  const [outlineTokenBudget, setOutlineTokenBudget] = useState<number>(DEFAULT_MODEL.outlineTokenBudget);
  const [saveFeedback, setSaveFeedback] = useState<Feedback>(null);
  const [testFeedback, setTestFeedback] = useState<Feedback>(null);
  const [testing, setTesting] = useState(false);
  /** 用户声明：当前模型是否支持图像输入（决定抽帧开关是否可用） */
  const [supportsVision, setSupportsVision] = useState(false);
  /** 禁用模型思考过程（默认开启）：结构化任务更快更省，避免思考耗尽输出 token */
  const [disableThinking, setDisableThinking] = useState(true);
  /** 抽帧开关（默认关闭：额外延迟与 token 消耗，且需模型支持图像输入） */
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [visionModules, setVisionModules] = useState<Record<VisionModule, boolean>>(INITIAL_VISION_MODULES);
  const [visionSwitchFeedback, setVisionSwitchFeedback] = useState<Feedback>(null);
  const [visionSwitchSaving, setVisionSwitchSaving] = useState(false);
  /** Obsidian 区表单与提示（与模型区状态独立） */
  const [obsidian, setObsidian] = useState<ObsidianFormState>(INITIAL_OBSIDIAN_FORM);
  /** 问答时检索个人知识库（默认开启，与 Obsidian 配置一起保存） */
  const [knowledgeSearch, setKnowledgeSearch] = useState<boolean>(true);
  const [obsidianFeedback, setObsidianFeedback] = useState<Feedback>(null);
  const [obsidianTesting, setObsidianTesting] = useState(false);
  const [obsidianSaving, setObsidianSaving] = useState(false);
  /** 数据管理（SPEC-10 10.5）：备份/恢复进行中与结果反馈 */
  const [dataBusy, setDataBusy] = useState(false);
  const [dataFeedback, setDataFeedback] = useState<Feedback>(null);

  /** 导出全部数据（五 store → JSON 下载） */
  const handleExportData = async () => {
    setDataBusy(true);
    setDataFeedback(null);
    try {
      const counts = await downloadBackup();
      const parts = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n} 条`);
      setDataFeedback({
        kind: 'ok',
        text: `已导出备份文件${parts.length > 0 ? `（${parts.join('、')}）` : '（暂无数据）'}，请妥善保存`,
      });
    } catch (err) {
      setDataFeedback({
        kind: 'error',
        text: `导出失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setDataBusy(false);
    }
  };

  /** 导入恢复（选备份文件 → 逐条写回，同键覆盖不删除既有数据） */
  const handleImportData = async () => {
    setDataBusy(true);
    setDataFeedback(null);
    try {
      const picked = await readTextFileViaInput('.json,application/json');
      if (!picked) {
        setDataBusy(false);
        return;
      }
      const { imported, skipped } = await importBackup(picked.text);
      const parts = Object.entries(imported)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n} 条`);
      setDataFeedback({
        kind: 'ok',
        text: `导入完成：${parts.length > 0 ? parts.join('、') : '备份中没有数据'}${
          skipped > 0 ? `；跳过 ${skipped} 条无法识别的记录` : ''
        }。刷新面板后生效`,
      });
    } catch (err) {
      setDataFeedback({
        kind: 'error',
        text: `导入失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setDataBusy(false);
    }
  };
  /** 最近一次读到的整份 settings：所有分区的合并写基线（避免分区互相覆盖） */
  const savedRef = useRef<Settings>({});
  /**
   * 各预设的内存草稿：用户改了但没点保存的内容。切换预设时先把当前表单存进来，
   * 切回来原样恢复——未保存的编辑不再被静默清空（旧版 bug 的根因）。
   */
  const draftsRef = useRef<Record<string, ModelFormState>>({});

  useEffect(() => {
    let cancelled = false;
    sendRuntimeMessage({ type: MSG.GET_SETTINGS })
      .then((response: unknown) => {
        if (cancelled) return;
        const raw = (response ?? {}) as Settings & {
          model?: Partial<ModelConfig>;
          obsidian?: Partial<ObsidianConfig>;
        };
        // 旧设置迁移（幂等）：visionModel / modelSupportsVision / endpointKeys /
        // modelProfiles 中的 Key 全部并入 modelSlots，迁移后 Key 不会丢
        const stored = migrateLegacyModelSettings(raw);
        savedRef.current = stored;
        const merged = { ...presetConfigOf('deepseek'), ...(stored.model ?? {}) } as Partial<ModelConfig>;
        const obs = (stored.obsidian ?? {}) as Partial<ObsidianConfig>;
        setObsidian({
          baseUrl: obs.baseUrl || OBSIDIAN.baseUrl,
          apiKey: obs.apiKey ?? '',
          rootDir: obs.rootDir ?? '',
          enabled: obs.enabled !== false,
        });
        setKnowledgeSearch(stored.knowledgeSearch !== false);
        setForm(
          configToForm({
            baseUrl: merged.baseUrl ?? '',
            apiKey: merged.apiKey ?? '',
            model: merged.model ?? '',
            temperature: {
              outline: merged.temperature?.outline ?? DEFAULT_MODEL.temperature.outline,
              qa: merged.temperature?.qa ?? DEFAULT_MODEL.temperature.qa,
            },
            maxTokens: merged.maxTokens ?? DEFAULT_MODEL.maxTokens,
            outlineTokenBudget: DEFAULT_MODEL.outlineTokenBudget,
          }),
        );
        setSupportsVision(stored.model?.supportsVision ?? stored.modelSupportsVision === true);
        setDisableThinking(stored.disableThinking !== false);
        setVisionEnabled(stored.visionEnabled === true);
        setVisionModules({
          outline: stored.visionModules?.outline !== false,
          mindmap: stored.visionModules?.mindmap !== false,
          qa: stored.visionModules?.qa !== false,
        });
        if (typeof merged.outlineTokenBudget === 'number' && merged.outlineTokenBudget > 0) {
          setOutlineTokenBudget(merged.outlineTokenBudget);
        }
      })
      .catch(() => {
        // background 未就绪时保持默认表单
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 读取最新存储：写回必须以存储值为基准，不能用内存快照（会把刚写入的 Key 回滚） */
  const readLatest = async (): Promise<Settings> => {
    try {
      const fresh = (await sendRuntimeMessage({ type: MSG.GET_SETTINGS })) as Settings | null;
      if (fresh && typeof fresh === 'object') return migrateLegacyModelSettings(fresh);
    } catch {
      /* 读取失败时退回内存快照 */
    }
    return savedRef.current;
  };

  const savePatch = (patch: Partial<Settings>): Promise<boolean> => {
    return readLatest().then((latest) => {
      const next = mergeSettings(latest, patch);
      return sendRuntimeMessage({ type: MSG.SET_SETTINGS, payload: next })
        .then((response: unknown) => {
          if ((response as { ok?: boolean } | null)?.ok === true) {
            savedRef.current = next;
            return true;
          }
          return false;
        })
        .catch(() => false);
    });
  };

  const update = (field: keyof ModelFormState) => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setSaveFeedback(null);
  };

  /** 当前表单落在哪个预设上（自定义端点 → null） */
  const currentPreset: PresetKey | null = activePreset(form.baseUrl);

  /**
   * 切换预设：
   * 1. 把当前表单（含未保存的改动）存入内存草稿；
   * 2. 目标预设的内容 = 该预设的草稿 ?? 该预设已保存的槽位配置；
   * 3. 明确告诉用户这次切换带出了什么（不再静默清空 Key）。
   */
  const applyPresetToForm = (preset: PresetKey) => {
    const from = currentPreset;
    if (from) draftsRef.current[from] = form;

    const draft = draftsRef.current[preset];
    const next = draft ?? configToForm(slotConfigOf(savedRef.current, preset));
    setForm(next);
    setSupportsVision(presetVisionDefault(preset));

    const saved = slotConfigOf(savedRef.current, preset).apiKey?.trim();
    setSaveFeedback(
      saved
        ? { kind: 'ok', text: `已切换到 ${presetShortLabel(preset)}，并带出该模型已保存的 API Key` }
        : { kind: 'ok', text: `已切换到 ${presetShortLabel(preset)}：该模型尚未保存 API Key，请填写后保存` },
    );
    setVisionSwitchFeedback(null);
  };

  /**
   * 保存模型配置：写入当前生效模型，并把 Key 同步进所属预设的槽位。
   * Key 属于"这个预设"，不属于某个全局槽位——所以两个模型的 Key 互不干扰。
   */
  const handleSave = () => {
    // 归一化：去掉粘贴带来的首尾空白（Key 前后空格会直接导致 401）
    const model = normalizeModelConfig(formToModelConfig(form, outlineTokenBudget));
    const errors = validateModelForm(model);
    const error = firstError(errors);
    if (error) {
      setSaveFeedback({ kind: 'error', text: error });
      return;
    }
    const preset = activePreset(model.baseUrl);
    // SPEC-08 8.3：非预置端点按 origin 动态申请宿主权限（用户拒绝则不保存，
    // 否则保存的配置一用就被 CORS 拦截，用户无从知道原因）
    if (!preset) {
      const origin = originOfBaseUrl(model.baseUrl);
      if (origin) {
        void ensureHostPermission(origin).then((result) => {
          if (result === 'granted') doSave(model, preset, null);
          else if (result === 'denied')
            doSave(model, preset, '未授予访问权限：生成请求会被浏览器拦截。可在地址栏扩展图标中重新授权，或改用预置端点。');
          else if (result === 'unsupported')
            doSave(model, preset, '当前浏览器不支持按需授权，自定义端点可能被拦截（配置已保存）。');
          else doSave(model, preset, '接口地址无法解析出域名，请检查后重试。');
        });
        return;
      }
    }
    doSave(model, preset, null);
  };

  const doSave = (model: ModelConfig, preset: ReturnType<typeof activePreset>, warning: string | null) => {
    const withVision: ModelConfig = { ...model, supportsVision };
    const patch: Partial<Settings> = preset
      ? { model: withVision, disableThinking, modelSlots: writeSlot(savedRef.current, preset, withVision).modelSlots }
      : { model: withVision, disableThinking };
    // 保存成功即视为该预设不再是草稿
    if (preset) delete draftsRef.current[preset];
    savePatch(patch).then((ok) => {
      if (!ok) {
        setSaveFeedback({ kind: 'error', text: '保存失败：background 未确认' });
        return;
      }
      if (warning) {
        setSaveFeedback({ kind: 'error', text: `已保存（自定义端点），但 ${warning}` });
        return;
      }
      setSaveFeedback(
        preset
          ? { kind: 'ok', text: `已保存到 ${presetShortLabel(preset)}` }
          : { kind: 'ok', text: '已保存（自定义端点）' },
      );
    });
  };

  const handleTestConnection = () => {
    const model = normalizeModelConfig(formToModelConfig(form, outlineTokenBudget));
    const error = firstError(validateModelForm(model));
    if (error) {
      setTestFeedback({ kind: 'error', text: error });
      return;
    }
    setTesting(true);
    setTestFeedback(null);
    chatCompletion({
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      model: model.model,
      temperature: model.temperature.outline,
      // 连通性探测给足余量：推理模型未禁思考时 1 个 token 会被思考吃光导致正文为空
      maxTokens: 16,
      // 探测无条件禁用思考：连通性测试不需要推理，也不依赖用户开关状态
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'ping' }],
    })
      .then(() => {
        setTestFeedback({ kind: 'ok', text: `连接成功（模型 ${model.model}）` });
      })
      .catch((err: unknown) => {
        // 错误摘要理论不含 key，此处再做一层脱敏兜底
        const raw = err instanceof Error ? err.message : String(err);
        setTestFeedback({ kind: 'error', text: raw.split(model.apiKey).join('***') });
      })
      .finally(() => {
        setTesting(false);
      });
  };

  /** 保存抽帧开关（全局 + 三模块）；全局关闭时模块开关不生效；模型未声明多模态时不可保存 */
  const handleSaveVisionSwitch = () => {
    setVisionSwitchSaving(true);
    setVisionSwitchFeedback(null);
    savePatch({ visionEnabled, visionModules: { ...visionModules } })
      .then((ok) => {
        setVisionSwitchFeedback(
          ok ? { kind: 'ok', text: '已保存' } : { kind: 'error', text: '保存失败：background 未确认' },
        );
      })
      .finally(() => setVisionSwitchSaving(false));
  };

  /** Obsidian 表单字段更新（清空该区提示，避免与旧结果混淆） */
  const updateObsidian = (field: keyof ObsidianFormState) => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setObsidian((prev) => ({ ...prev, [field]: e.target.value }));
    setObsidianFeedback(null);
  };

  /** Obsidian 配置校验：三段必填 */
  const validateObsidian = (form: ObsidianFormState): string | null => {
    if (!form.baseUrl.trim()) return 'Obsidian 接口地址不能为空';
    if (!form.apiKey.trim()) return 'Obsidian API Key 不能为空';
    if (!form.rootDir.trim()) return '笔记根目录不能为空';
    return null;
  };

  /** 保存 Obsidian 配置（只合并 obsidian 段，不动 model） */
  const handleSaveObsidian = () => {
    const error = validateObsidian(obsidian);
    if (error) {
      setObsidianFeedback({ kind: 'error', text: error });
      return;
    }
    setObsidianSaving(true);
    setObsidianFeedback(null);
    const cfg: ObsidianConfig = {
      baseUrl: obsidian.baseUrl.trim(),
      apiKey: obsidian.apiKey.trim(),
      rootDir: obsidian.rootDir.trim(),
      enabled: obsidian.enabled,
    };
    // 与 Obsidian 配置一起保存 knowledgeSearch 开关（整份 settings 合并写，不动其他分区）
    savePatch({ obsidian: cfg, knowledgeSearch })
      .then((ok) => {
        setObsidianFeedback(
          ok ? { kind: 'ok', text: '已保存' } : { kind: 'error', text: '保存失败：background 未确认' },
        );
      })
      .finally(() => setObsidianSaving(false));
  };

  /**
   * Obsidian 连通性自检：成功显示根目录条目数，失败显示错误摘要
   * （摘要一律不含 apiKey：sink 层只在 header 携带，错误文案只带状态码）。
   */
  const handleTestObsidian = () => {
    const error = validateObsidian(obsidian);
    if (error) {
      setObsidianFeedback({ kind: 'error', text: error });
      return;
    }
    setObsidianTesting(true);
    setObsidianFeedback(null);
    const cfg: ObsidianConfig = {
      baseUrl: obsidian.baseUrl.trim(),
      apiKey: obsidian.apiKey.trim(),
      rootDir: obsidian.rootDir.trim(),
      enabled: obsidian.enabled,
    };
    testObsidianConnection(cfg)
      .then((res) => {
        setObsidianFeedback({
          kind: 'ok',
          text: `连接成功（根目录 ${res.rootEntries.length} 项）`,
        });
      })
      .catch((err: unknown) => {
        // 兜底脱敏：任何提示均不输出 apiKey 明文
        const raw = err instanceof Error ? err.message : String(err);
        setObsidianFeedback({ kind: 'error', text: raw.split(cfg.apiKey).join('***') });
      })
      .finally(() => setObsidianTesting(false));
  };

  /** 抽帧区是否可用：取决于「支持图像输入」勾选 */
  const visionSwitchUsable = supportsVision;
  /** 当前策略摘要：由表单当前值合成 settings 后交给纯函数 */
  const strategyLines = describeStrategyForForm();

  /** 用当前表单值合成一份临时 settings，交给纯函数算策略摘要（只读展示，不参与保存） */
  function describeStrategyForForm(): string[] {
    const model = normalizeModelConfig(formToModelConfig(form, outlineTokenBudget));
    const temp: Settings = {
      ...savedRef.current,
      model: { ...model, supportsVision },
      visionEnabled,
      visionModules,
    };
    return describeModelStrategy(temp);
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <h3>设置</h3>
        <button type="button" className="btn" onClick={onClose}>
          返回
        </button>
      </header>

      {/* ① 模型配置：一个模型承担大纲 / 导图 / 问答，支持图像输入时一并接收抽帧画面 */}
      <section className="settings-section">
        <h4>模型配置（大纲 / 导图 / 问答）</h4>
        <p className="settings-hint">
          三个模块共用这一套模型配置，在顶部两个模型之间切换即可。
          <strong>每个模型的 API Key 各自保存</strong>，切换时自动带出，互不覆盖；
          改完记得点「保存」。模型名可自填，按厂商文档填写当前可用版本；
          <strong>注意：API Key 必须与所选模型所属平台一致</strong>（DeepSeek 的 Key
          不能打到 Qwen 的网关，反之亦然，混用会返回 401）；填好后先点「测试连接」确认
        </p>
        {/* 冷启动三步引导（SPEC-10 10.1）：第一次配置模型的用户照着走完 */}
        <div className="onboarding-box">
          <b>第一次使用？三步完成配置：</b>
          <ol className="onboarding-steps">
            <li>
              到{' '}
              <a href={MODEL_PRESETS.deepseek.consoleUrl} target="_blank" rel="noreferrer">
                DeepSeek 开放平台
              </a>{' '}
              或{' '}
              <a href={MODEL_PRESETS.qwen.consoleUrl} target="_blank" rel="noreferrer">
                阿里云百炼
              </a>{' '}
              注册并充值（都是几元起充；{MODEL_PRESETS.qwen.costHint}）
            </li>
            <li>在控制台创建一个 API Key，复制后粘贴到下方 Key 输入框</li>
            <li>点「测试连接」确认可用，再点「保存」——完成</li>
          </ol>
        </div>
        <div className="field-row">
          {presetKeys().map((key) => (
            <button
              type="button"
              key={`model-preset-${key}`}
              onClick={() => applyPresetToForm(key)}
              title={MODEL_PRESETS[key].label}
              className={currentPreset === key ? 'btn preset-active' : 'btn'}
            >
              {presetShortLabel(key)}
            </button>
          ))}
        </div>
        <label className="field">
          <span>接口地址</span>
          <input
            type="text"
            placeholder="https://…"
            value={form.baseUrl}
            onChange={update('baseUrl')}
          />
        </label>
        <label className="field">
          <span>
            API Key（{presetShortLabel(currentPreset ?? 'deepseek')} 已保存：
            {maskKey(slotConfigOf(savedRef.current, currentPreset ?? 'deepseek').apiKey)}）
          </span>
          <input
            type="password"
            placeholder="粘贴 API Key"
            value={form.apiKey}
            onChange={update('apiKey')}
          />
        </label>
        <label className="field">
          <span>模型</span>
          <input
            type="text"
            placeholder="模型标识"
            value={form.model}
            onChange={update('model')}
          />
        </label>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={supportsVision}
            onChange={(e) => {
              setSupportsVision(e.target.checked);
              setSaveFeedback(null);
              setVisionSwitchFeedback(null);
            }}
          />
          <span>该模型支持图像输入（多模态，如 Qwen-VL 系列）</span>
        </label>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={disableThinking}
            onChange={(e) => setDisableThinking(e.target.checked)}
          />
          <span>禁用思考过程（推荐：大纲/导图/问答均为结构化任务，思考会消耗输出 token 甚至把正文挤空）</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span>temperature（大纲）</span>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={form.temperatureOutline}
              onChange={update('temperatureOutline')}
            />
          </label>
          <label className="field">
            <span>temperature（问答）</span>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={form.temperatureQa}
              onChange={update('temperatureQa')}
            />
          </label>
        </div>
        <label className="field">
          <span>maxTokens</span>
          <input
            type="number"
            min="1"
            value={form.maxTokens}
            onChange={update('maxTokens')}
          />
        </label>
        <div className="field-row">
          <button type="button" className="btn btn-primary" onClick={handleSave}>
            保存
          </button>
          <button type="button" className="btn" onClick={handleTestConnection} disabled={testing}>
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {saveFeedback && (
          <p className={saveFeedback.kind === 'ok' ? 'settings-hint' : 'settings-hint settings-error'}>
            {saveFeedback.text}
          </p>
        )}
        {testFeedback && (
          <p className={testFeedback.kind === 'ok' ? 'settings-hint' : 'settings-hint settings-error'}>
            {testFeedback.text}
          </p>
        )}
      </section>

      {/* ② 当前策略：读模型区表单当前值，随输入实时更新（只读展示，不参与保存） */}
      <section className="settings-section">
        <h4>当前策略</h4>
        <ul className="settings-hint" style={{ paddingLeft: 18, listStyle: 'disc' }}>
          {strategyLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      {/* ③ 抽帧开关：模型未声明支持图像输入时整区置灰 */}
      <section className="settings-section" style={visionSwitchUsable ? undefined : { opacity: 0.6 }}>
        <h4>抽帧开关（结合视频画面理解）</h4>
        <p className="settings-hint">
          {visionSwitchUsable
            ? '抽帧会增加延迟与 token 消耗；全局关闭时所有模块一律不抽帧。'
            : '当前模型未声明支持图像输入；如需结合画面，请换用多模态模型（如 Qwen-VL 系列）并勾选上方选项。'}
          {visionSwitchUsable
            ? ` 帧数随视频时长增长：导图约 10 分钟 14 帧、30 分钟 27 帧、1 小时及以上 ${FRAME_PLAN.mindmap.hardMax} 帧（知识密集时更多，每章至少首尾两帧）；大纲 ${FRAME_PLAN.outline.min}~${FRAME_PLAN.outline.hardMax} 帧 / 问答 ${FRAME_PLAN.qa.min}~${FRAME_PLAN.qa.hardMax} 帧`
            : ''}
        </p>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={visionSwitchUsable && visionEnabled}
            disabled={!visionSwitchUsable}
            onChange={(e) => {
              setVisionEnabled(e.target.checked);
              setVisionSwitchFeedback(null);
            }}
          />
          <span>让模型结合视频画面理解（抽帧）</span>
        </label>
        {(Object.keys(VISION_MODULE_LABELS) as VisionModule[]).map((module) => (
          <label
            key={`vision-module-${module}`}
            className="field"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <input
              type="checkbox"
              checked={visionSwitchUsable && visionEnabled && visionModules[module]}
              disabled={!visionSwitchUsable || !visionEnabled}
              onChange={(e) => {
                setVisionModules((prev) => ({ ...prev, [module]: e.target.checked }));
                setVisionSwitchFeedback(null);
              }}
            />
            <span>
              {VISION_MODULE_LABELS[module]}
              {visionSwitchUsable && visionEnabled ? '' : '（随全局开关）'}
            </span>
          </label>
        ))}
        <div className="field-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSaveVisionSwitch}
            disabled={visionSwitchSaving || !visionSwitchUsable}
          >
            {visionSwitchSaving ? '保存中…' : '保存'}
          </button>
        </div>
        {visionSwitchFeedback && (
          <p
            className={
              visionSwitchFeedback.kind === 'ok' ? 'settings-hint' : 'settings-hint settings-error'
            }
          >
            {visionSwitchFeedback.text}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h4>Obsidian 配置</h4>
        <label
          className="field"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <input
            type="checkbox"
            checked={obsidian.enabled}
            onChange={(e) => {
              setObsidian({ ...obsidian, enabled: e.target.checked });
              setObsidianFeedback(null);
            }}
          />
          <span>使用 Obsidian 存库（不勾 = 暂时停用：存入将直接下载 .md 到本地，凭据保留不擦除）</span>
        </label>
        <p className="settings-hint">
          Local REST API（HTTP 模式）地址 / 密钥 / 笔记根目录；笔记落在「根目录/视频笔记/」与「根目录/术语/」
        </p>
        <label className="field">
          <span>接口地址</span>
          <input
            type="text"
            placeholder={OBSIDIAN.baseUrl}
            value={obsidian.baseUrl}
            onChange={updateObsidian('baseUrl')}
          />
        </label>
        <label className="field">
          <span>API Key</span>
          <input
            type="password"
            placeholder="粘贴 Local REST API 的 API Key"
            value={obsidian.apiKey}
            onChange={updateObsidian('apiKey')}
          />
        </label>
        <label className="field">
          <span>笔记根目录</span>
          <input
            type="text"
            placeholder="如：视频学习副驾"
            value={obsidian.rootDir}
            onChange={updateObsidian('rootDir')}
          />
        </label>
        <label
          className="field"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
        >
          <input
            type="checkbox"
            checked={knowledgeSearch}
            onChange={(e) => {
              setKnowledgeSearch(e.target.checked);
              setObsidianFeedback(null);
            }}
          />
          <span>问答时检索个人知识库（默认开启）</span>
        </label>
        <div className="field-row">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSaveObsidian}
            disabled={obsidianSaving}
          >
            {obsidianSaving ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={handleTestObsidian}
            disabled={obsidianTesting}
          >
            {obsidianTesting ? '测试中…' : '测试连接'}
          </button>
        </div>
        {obsidianFeedback && (
          <p
            className={
              obsidianFeedback.kind === 'ok' ? 'settings-hint' : 'settings-hint settings-error'
            }
          >
            {obsidianFeedback.text}
          </p>
        )}
      </section>

      {/* SPEC-10 10.5：数据管理（备份与恢复） */}
      <section className="settings-section">
        <h4>数据管理（备份与恢复）</h4>
        <p className="settings-hint">
          你的全部数据（大纲、问答历史、笔记、术语卡、使用统计）只存在本机浏览器里。
          导出为 JSON 文件妥善保存；换电脑或清缓存前先备份，之后可一键导入恢复
        </p>
        <div className="field-row">
          <button type="button" className="btn btn-primary" onClick={() => void handleExportData()} disabled={dataBusy}>
            {dataBusy ? '处理中…' : '导出全部数据'}
          </button>
          <button type="button" className="btn" onClick={() => void handleImportData()} disabled={dataBusy}>
            导入恢复
          </button>
        </div>
        {dataFeedback && (
          <p
            className={
              dataFeedback.kind === 'ok' ? 'settings-hint' : 'settings-hint settings-error'
            }
          >
            {dataFeedback.text}
          </p>
        )}
      </section>

      {/* SPEC-10 10.1/10.2：关于与隐私 */}
      <section className="settings-section">
        <h4>关于与隐私</h4>
        <p className="settings-hint">
          本扩展不设账号、不上传你的任何数据：字幕与笔记存在本机（IndexedDB），模型请求
          用你自己配置的 API Key 直连对应服务商，公开资料检索走 DuckDuckGo。详细说明见
          README 的「隐私与数据」章节
        </p>
        <p className="settings-hint">
          开源仓库：github.com/phpvincent/ai-video-driver · 交换格式契约：docs/EXCHANGE-FORMAT.md
        </p>
      </section>

      {/* SPEC-07：验证期报告入口（仅追加，未接线时整区隐藏） */}
      {onOpenValidationReport && (
        <section className="settings-section">
          <h4>验证期报告</h4>
          <p className="settings-hint">
            统计本机使用数据（大纲/导图跳转、划词与区间提问、字幕命中），生成 Markdown 报告，可存入 Obsidian
          </p>
          <div className="field-row">
            <button type="button" className="btn" onClick={onOpenValidationReport}>
              打开验证期报告
            </button>
          </div>
          <h5 className="settings-subtitle">LLM 交互日志（排障用）</h5>
          <p className="settings-hint">
            记录每次与模型的请求与响应报文（已脱敏 API Key、按长度截断），失败条目带错误原文。
            排查 401、超时、输出为空这类问题时，比控制台更直观
          </p>
          <div className="field-row">
            <button type="button" className="btn" onClick={onOpenLlmLog}>
              打开 LLM 交互日志
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

