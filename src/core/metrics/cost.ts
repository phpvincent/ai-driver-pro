/**
 * 费用估算（SPEC-10 10.8，纯函数）：token × 预设价格表 → 估算人民币费用。
 *
 * - 价格口径见 config PRICING（官方公示价，元/百万 token，估算）；
 * - 模型名前缀匹配；命中不到价格表的模型只计 token（unknownTokens）；
 * - 仅用于展示"大约花了多少钱"，不作为计费依据。
 */
import { PRICING } from '../../config';

/** 模型名 → 单价；不在价格表返回 null */
export function priceOf(model: string): { inputPerM: number; outputPerM: number } | null {
  const name = (model ?? '').trim().toLowerCase();
  if (!name) return null;
  for (const preset of PRICING.presets) {
    if (name.startsWith(preset.prefix)) {
      return { inputPerM: preset.inputPerM, outputPerM: preset.outputPerM };
    }
  }
  return null;
}

/** 单模型费用（元）；无价格返回 null */
export function estimateCostCny(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = priceOf(model);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.inputPerM + (outputTokens / 1_000_000) * price.outputPerM;
}

/** 交互日志条目的最小形状（费用聚合用） */
export interface CostLogEntry {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** 按模型聚合的 token 与费用 */
export interface ModelCostRow {
  model: string;
  input: number;
  output: number;
  /** 元；null = 无价格（自定义模型） */
  costCny: number | null;
}

export interface CostSummary {
  rows: ModelCostRow[];
  /** 合计费用（元）；含无价格模型时为 null（只展示已知部分会误导） */
  totalCny: number | null;
  /** 无价格模型的 token 总量（提示"未估算"） */
  unknownTokens: number;
}

/** 聚合费用（纯函数；按模型名分组，组内 token 累加） */
export function summarizeCost(logs: readonly CostLogEntry[]): CostSummary {
  const byModel = new Map<string, ModelCostRow>();
  for (const e of logs) {
    const name = (e.model ?? '').trim() || '(未知模型)';
    const row = byModel.get(name) ?? { model: name, input: 0, output: 0, costCny: null };
    row.input += e.inputTokens ?? 0;
    row.output += e.outputTokens ?? 0;
    byModel.set(name, row);
  }
  const rows = [...byModel.values()].map((row) => ({
    ...row,
    costCny: estimateCostCny(row.model, row.input, row.output),
  }));
  let total: number | null = 0;
  let unknownTokens = 0;
  for (const row of rows) {
    if (row.costCny === null) {
      total = null;
      unknownTokens += row.input + row.output;
    } else if (total !== null) {
      total += row.costCny;
    }
  }
  return { rows, totalCny: total, unknownTokens };
}

/** 费用展示文案（元，两位小数；<0.01 显示"<0.01"） */
export function formatCny(cny: number): string {
  if (cny > 0 && cny < 0.01) return '<0.01';
  return cny.toFixed(2);
}
