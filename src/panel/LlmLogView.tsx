/**
 * LLM 交互日志视图（验证期报告 → LLM 交互日志子模块）。
 *
 * 展示与大模型交互的报文留痕：**错误信息优先**——失败条目红色高亮并默认展开
 * 响应报文，便于定位 401 / 超时 / 输出为空 / Schema 之外的异常。
 *
 * 数据经 props 注入（App 接 llmLogStore），本组件不直接 import storage；
 * 落库开关由组件自管（经 GET_SETTINGS / SET_SETTINGS，与 ModelPicker 同风格）。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  THUMB_MAX,
  isThumbnailsEnabled,
  setThumbnailsEnabled,
  type LlmLogEntry,
} from '../core/metrics/llmLog';
import { formatMmSs } from '../core/context/compiler';
import { estimateCostCny, formatCny, summarizeCost } from '../core/metrics/cost';
import {
  getLlmLogEnabled,
  loadLlmLogs,
  clearLlmLogStore,
  setLlmLogEnabled,
} from './llmLogStore';

/** 状态标记（导出供测试） */
export const LLM_LOG_OK_MARK = '成功';
export const LLM_LOG_FAIL_MARK = '失败';
/** 空态文案 */
export const LLM_LOG_EMPTY_TEXT = '暂无交互日志；生成大纲 / 导图或发起提问后即可看到报文留痕';

/** 时间显示：HH:MM:SS（本地时区） */
export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 帧时间点摘要：`[00:12,03:40,...]`（无帧时为空串） */
export function frameTimes(e: LlmLogEntry): string {
  const frames = e.frames ?? [];
  if (frames.length === 0) return '';
  const labels = frames.slice(0, 6).map((f) => (f.tMs >= 0 ? formatMmSs(f.tMs) : '?'));
  const more = frames.length > 6 ? ` +${frames.length - 6}` : '';
  return ` [${labels.join(', ')}${more}]`;
}

/** 单行摘要：`模型@主机 · 耗时 · 输入/输出字符 · 状态码` */
export function summarizeEntry(e: LlmLogEntry): string {
  const bits = [
    `${e.model}@${e.endpointHost}`,
    `${e.durationMs}ms`,
    `in ${e.inputChars} / out ${e.outputChars} 字`,
  ];
  if (e.images && e.images > 0) bits.push(`${e.images} 帧${frameTimes(e)}`);
  if (typeof e.status === 'number') bits.push(`HTTP ${e.status}`);
  // finish_reason=length 是输出被截断的直接证据（撞到 maxTokens）
  if (e.finishReason === 'length') bits.push('输出被截断(length)');
  else if (e.finishReason) bits.push(`结束:${e.finishReason}`);
  if (typeof e.inputTokens === 'number') bits.push(`token ${e.inputTokens}/${e.outputTokens ?? 0}`);
  // 单条费用（有价格表才显示；冒烟 10-09：费用要能看到，不用去翻报告）
  const cny = estimateCostCny(e.model, e.inputTokens ?? 0, e.outputTokens ?? 0);
  if (typeof e.inputTokens === 'number' && cny !== null) bits.push(`≈¥${cny.toFixed(4)}`);
  return bits.join(' · ');
}

/** 头部 token/费用汇总（SPEC-10 10.8 补充：费用在日志页直接可见） */
export function LLMLogCostSummary({ entries }: { entries: LlmLogEntry[] }): React.ReactNode {
  const withTokens = entries.filter((e) => typeof e.inputTokens === 'number');
  const sum = summarizeCost(
    entries.map((e) => ({ model: e.model, inputTokens: e.inputTokens, outputTokens: e.outputTokens })),
  );
  const inTok = entries.reduce((n, e) => n + (e.inputTokens ?? 0), 0);
  const outTok = entries.reduce((n, e) => n + (e.outputTokens ?? 0), 0);
  const costText =
    sum.totalCny === null
      ? `费用合计未知（含无价格表模型）`
      : `费用估算约 ¥${formatCny(sum.totalCny)}`;
  return (
    <>
      {` · token ${inTok}/${outTok} · ${costText}`}
      {entries.length > 0 && withTokens.length === 0 && (
        <span className="llm-log-usage-missing">（当前网关未返回 usage，token 无法统计——费用估算为 0）</span>
      )}
    </>
  );
}

export function LlmLogView() {
  const [entries, setEntries] = useState<LlmLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [withThumbs, setWithThumbs] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [list, on] = await Promise.all([loadLlmLogs(), getLlmLogEnabled()]);
    setEntries(list);
    setEnabled(on);
    setWithThumbs(isThumbnailsEnabled());
    // 失败条目默认展开（排查时最想先看到的就是它）
    const auto: Record<string, boolean> = {};
    for (const e of list) if (!e.ok) auto[e.id] = true;
    setExpanded(auto);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggleEnabled = async (next: boolean) => {
    setEnabled(next);
    const ok = await setLlmLogEnabled(next);
    setFeedback(ok ? (next ? '已开启记录' : '已停止记录（已有日志保留）') : '保存失败：background 未确认');
  };

  const handleClear = async () => {
    await clearLlmLogStore();
    setEntries([]);
    setFeedback('已清空本地交互日志');
  };

  const handleCopyAll = async () => {
    const text = entries
      .map((e) =>
        [
          `[${formatLogTime(e.at)}] ${e.ok ? LLM_LOG_OK_MARK : LLM_LOG_FAIL_MARK} ${e.label}`,
          summarizeEntry(e),
          e.error ? `错误：${e.error}` : '',
          `--- request ---\n${e.requestPreview}`,
          `--- response ---\n${e.responsePreview}`,
        ]
          .filter((x) => x.length > 0)
          .join('\n'),
      )
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      setFeedback('已复制全部日志到剪贴板');
    } catch {
      setFeedback('复制失败：浏览器未授权剪贴板');
    }
  };

  const failedCount = entries.filter((e) => !e.ok).length;

  return (
    <div className="llm-log">
      <div className="llm-log-bar">
        <span className="llm-log-count">
          共 {entries.length} 条{entries.length > 0 ? `（失败 ${failedCount}）` : ''}
          {entries.length > 0 && (
            <LLMLogCostSummary entries={entries} />
          )}
        </span>
        <label className="llm-log-switch">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void handleToggleEnabled(e.target.checked)}
          />
          <span>记录交互日志</span>
        </label>
        <label className="llm-log-switch">
          <input
            type="checkbox"
            checked={withThumbs}
            onChange={(e) => {
              setWithThumbs(e.target.checked);
              setThumbnailsEnabled(e.target.checked);
              setFeedback(
                e.target.checked
                  ? `已开启：之后的日志会带最多 ${THUMB_MAX} 张缩略图（体积较大，排查完建议关掉）`
                  : '已关闭缩略图（帧数与时间点仍会记录）',
              );
            }}
          />
          <span>保存图像缩略图</span>
        </label>
        <button type="button" className="btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void handleCopyAll()}
          disabled={entries.length === 0}
        >
          复制全部
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void handleClear()}
          disabled={entries.length === 0}
        >
          清空
        </button>
      </div>
      <p className="llm-log-hint">
        记录每次与模型的请求与响应报文（已脱敏 API Key、报文按长度截断）。失败条目默认展开，
        DevTools 控制台同时输出 <code>[vsc][llm]</code> 前缀日志
      </p>
      {feedback && <p className="llm-log-feedback">{feedback}</p>}

      {!loading && entries.length === 0 && <p className="llm-log-empty">{LLM_LOG_EMPTY_TEXT}</p>}

      <ul className="llm-log-list">
        {entries.map((e) => {
          const open = expanded[e.id] === true;
          return (
            <li key={e.id} className={`llm-log-item${e.ok ? '' : ' failed'}`}>
              <div
                className="llm-log-head"
                onClick={() => setExpanded((prev) => ({ ...prev, [e.id]: !open }))}
              >
                <span className={`llm-log-mark${e.ok ? '' : ' fail'}`}>
                  {e.ok ? LLM_LOG_OK_MARK : LLM_LOG_FAIL_MARK}
                </span>
                <span className="llm-log-time">{formatLogTime(e.at)}</span>
                <span className="llm-log-label">{e.label}</span>
                <span className="llm-log-summary">{summarizeEntry(e)}</span>
                <span className="llm-log-toggle">{open ? '收起' : '展开'}</span>
              </div>
              {!e.ok && e.error && <div className="llm-log-error">错误：{e.error}</div>}
              {open && (
                <div className="llm-log-body">
                  <div className="llm-log-block">
                    <div className="llm-log-block-title">请求报文（预览）</div>
                    <pre className="llm-log-pre">{e.requestPreview || '（空）'}</pre>
                  </div>
                  <div className="llm-log-block">
                    <div className="llm-log-block-title">
                      {e.ok ? '响应正文（预览）' : '响应体 / 错误原文'}
                      <button
                        type="button"
                        className="llm-log-copy-one"
                        onClick={() => {
                          void navigator.clipboard
                            ?.writeText(JSON.stringify(e, null, 2))
                            .then(() => setFeedback('已复制本条日志（JSON）'))
                            .catch(() => setFeedback('复制失败：浏览器未授权剪贴板'));
                        }}
                      >
                        复制本条
                      </button>
                    </div>
                    <pre className="llm-log-pre">{e.responsePreview || '（无响应体）'}</pre>
                  </div>
                  {(e.frames?.length ?? 0) > 0 && (
                    <div className="llm-log-block">
                      <div className="llm-log-block-title">
                        本次携带 {e.frames?.length} 帧（时间点 / 体积 / 配对字幕）
                        {e.thumbnails && e.thumbnails.length > 0 ? ' · 含缩略图' : ''}
                      </div>
                      <div className="llm-log-frames">
                        {(e.frames ?? []).map((f, i) => (
                          <div className="llm-log-frame" key={`${e.id}-f-${i}`}>
                            {e.thumbnails?.[i] ? (
                              <img
                                className="llm-log-thumb"
                                src={e.thumbnails[i]}
                                alt={`第 ${i + 1} 帧`}
                              />
                            ) : (
                              <div className="llm-log-thumb empty">无图</div>
                            )}
                            <span className="llm-log-frame-meta">
                              {f.tMs >= 0 ? formatMmSs(f.tMs) : '时间未知'} · {Math.round(f.bytes / 1024)} KB
                            </span>
                            {f.caption && (
                              <span className="llm-log-frame-caption" title={f.caption}>
                                {f.caption}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
