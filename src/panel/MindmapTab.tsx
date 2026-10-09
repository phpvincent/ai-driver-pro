/**
 * 导图 Tab（SPEC-04 四次迭代：概念图 v3 = 知识流程图，竖向阶段流）：
 * - 概念图（默认视图）：props.conceptMap.stages（缓存/生成）或本地术语关联图降级；
 *   竖向阶段流程（窄边栏唯一主轴，体现"概念属于阶段，阶段构成流程"）：
 *   阶段块（阶段头 = 步骤圆徽 1/2/3… + 阶段名 + 概念数）→ 阶段间连接
 *   （竖线 + 下箭头 kp-connector，最后阶段无）→ 阶段内概念行（rail 贯穿）；
 * - 概念行：概念名粗体（点击跳 primaryAnchorTMs = 得分最高章节起点）+
 *   重要度文字徽标（核心/重要/常用/了解）+ 主锚 chip 实心强调（cm-chip-primary，
 *   anchors[0]）+ 次锚 chips 次级样式（其余锚按时间升序）+ details 折叠
 *   （grid 0fr/1fr 过渡）；
 * - 降级横幅（degraded=true）：黄底"模型生成失败，当前为术语关联图（降级）"
 *   + 重试按钮（调 props.generateConceptMap），消除静默降级；
 * - 概念跟随：matchConcepts 精确匹配（概念 label 归一化后 ∈ 当前章节 terms，
 *   且该 section 覆盖 positionMs；不命中不亮）→ .concept-active 高亮
 *   （过渡动画）+ 滚出可视区时平滑滚动；命中概念所在阶段块 stage-current 加重；
 * - 章节时间轴（次要视图）：markmap 实现整体保留为 ChronoView。
 * 组件完全 props 驱动。降级判定双手段并存（types.ts 不得加字段）：
 * props.degraded（App 生成 catch 路径设置）+ model='term-index' 约定
 * （isTermIndexData）。markmap 仅由 ChronoView 的 effect 内动态 import
 * （概念视图不加载引擎）。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Markmap } from 'markmap-view';
import type { ConceptMapData, ConceptItem, ConceptStage, ConceptFlow, Section } from '../types';
import { buildTermIndexMap } from '../core/pipeline/conceptMap';
import { formatTimestamp } from './SubtitleTab';
import { ModelPicker } from './ModelPicker';
import { GenerationBanner } from './GenerationBanner';
import './mindmap.css';

export interface MindmapTabProps {
  /** 单测/深链注入的初始视图（默认流程图） */
  initialView?: 'flow' | 'concept' | 'chrono';
  /** 大纲章节（空数组 = 未生成，显示引导） */
  sections?: Section[];
  /** 视频标题（概念图生成入参） */
  videoTitle?: string;
  /** 当前播放位置（毫秒） */
  positionMs?: number;
  /** 节点点击跳播（App 传：发 MSG.SEEK） */
  onRequestSeek?: (ms: number) => void;
  /** 模型是否就绪（未配置时概念图生成按钮转为设置引导） */
  modelReady?: boolean;
  /** 打开设置页（模型未配置引导） */
  onOpenSettings?: () => void;
  /** 关系边独立生成（冒烟 3b 二轮）：App 闭包（含 videoId），成功后更新 conceptMap 状态 */
  generateFlows?: () => Promise<ConceptFlow[]>;
  /** 生成概念图（注入 mindmapLoader.generateConceptMap 的包装；未接线时组件降级为本地术语图） */
  generateConceptMap?: (sections: Section[], videoTitle: string) => Promise<void>;
  /** 缓存命中的概念图（App 注入，stages 阶段流） */
  conceptMap?: ConceptMapData | null;
  /** 生成中（骨架动画） */
  generating?: boolean;
  /** conceptMap 为降级术语关联图（App 生成 catch 路径设置；与 model 约定双手段并存） */
  degraded?: boolean;
  /** 生成失败的具体原因（App catch 后经 describeConceptMapFailure 传入）；不传则展示通用文案 */
  degradedText?: string;
  /** 无大纲时引导去大纲 Tab 生成（可选） */
  onGoOutline?: () => void;
}

// ---------------------------------------------------------------------------
// ChronoView（章节时间轴，原 markmap 实现，代码整体保留）
// ---------------------------------------------------------------------------

/** 根节点文案（父 agent 接线时可扩展为视频标题，本期固定） */
export const MINDMAP_ROOT_TEXT = '大纲';
/** 阶段色带的配色档数（按顺序轮换，纯展示用） */
export const STAGE_HUE_COUNT = 5;

/** 空大纲引导文案 */
export const MINDMAP_EMPTY_TEXT = '请先生成大纲';

/** 空大纲引导按钮文案 */
export const MINDMAP_EMPTY_ACTION_TEXT = '去生成大纲';

/**
 * 章节节点标题（markdown `## ` 后的内容）：
 * `{mm:ss} {title}（{score}分）`；score 缺省时无分后缀（避免 `(undefined分)`）；
 * 高密度章节追加【高密】醒目标记（SPEC-04 §1）。
 */
export function sectionHeadingText(section: Section): string {
  const scoreSuffix = section.score != null ? `（${section.score}分）` : '';
  const densitySuffix = section.density === 'high' ? '【高密】' : '';
  return `${formatTimestamp(section.startMs)} ${section.title}${scoreSuffix}${densitySuffix}`;
}

/**
 * 章节节点的稳定匹配前缀（`{mm:ss} {title}`）：
 * 播放跟随高亮时用它对 markmap 节点做文本匹配（不含 score/密度后缀，
 * 避免 html 渲染差异导致匹配失败）。
 */
export function sectionHeadingPrefix(section: Section): string {
  return `${formatTimestamp(section.startMs)} ${section.title}`;
}

/**
 * 组装导图 Markdown（纯函数）：
 * `# 大纲` → 每章 `## {mm:ss} {title}（{score}分）` → 每要点 `### {mm:ss} {text}`。
 * 时间戳即跳播锚点（组装用吸附后 startMs，红线 2）。
 */
export function buildMindmapMarkdown(sections: Section[]): string {
  const lines: string[] = [`# ${MINDMAP_ROOT_TEXT}`];
  for (const section of sections) {
    lines.push(`## ${sectionHeadingText(section)}`);
    for (const bullet of section.bullets) {
      lines.push(`### ${formatTimestamp(bullet.startMs)} ${bullet.text}`);
    }
  }
  return lines.join('\n');
}

/** 开头 `mm:ss` 提取（分钟可为累计值如 61:11；秒必须 00-59；0 是合法值） */
const NODE_TIMESTAMP_RE = /^\s*(\d+):([0-5]\d)(?!\d)/;

/**
 * 从 markmap 节点文本提取开头时间戳 → 毫秒；无时间戳返回 null。
 * 纯函数（节点 DOM 的 textContent 作为输入），供事件委托与单测复用。
 */
export function parseNodeTimestamp(text: string): number | null {
  const m = NODE_TIMESTAMP_RE.exec(text);
  if (!m) return null;
  const ms = (Number(m[1]) * 60 + Number(m[2])) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 当前章节下标查找（二分，sections 按 startMs 严格递增）：
 * 命中 startMs<=pos<endMs 的章；间隙取最后 startMs<=pos 者（超过末章 endMs 仍停留末章）；
 * 空数组或 pos 早于首章返回 -1。
 */
export function findActiveSectionIndex(sections: Section[], positionMs: number): number {
  if (sections.length === 0) return -1;
  let lo = 0;
  let hi = sections.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sections[mid].startMs <= positionMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 概念跟随的归一化（trim + 小写，两侧同规则才能精确相等） */
const normalizeTerm = (s: string): string => s.trim().toLowerCase();

/**
 * 概念跟随命中（纯函数，导出供单测；三级匹配，2026-10-09 冒烟三轮）：
 * 精确相等在真实视频几乎不亮（概念名是"定义判断读题方法"，术语是"定义判断"），
 * 全 substring 又会"亮起好多个"。分级规则（归一化后）：
 * ① label 与术语精确相等 → 命中；
 * ② 术语 ⊆ label 且术语 ≥3 字、覆盖 label ≥50% → 命中（概念是术语的展开表述）；
 * ③ label ⊆ 章节标题 且 label ≥3 字、覆盖标题 ≥40% → 命中（标题点名主题）。
 * 反向（label ⊆ 术语）不参与：短概念被长术语吞掉是历史"亮起好多个"的主因。
 * 返回命中的概念 label 列表（去重，遍历顺序稳定）。
 */
export function matchConcepts(
  sections: Section[],
  positionMs: number,
  stages: ConceptStage[],
): string[] {
  const idx = findActiveSectionIndex(sections, positionMs);
  if (idx < 0) return [];
  const sec = sections[idx];
  const terms = sec.terms.map(normalizeTerm).filter((t) => t.length > 0);
  const title = normalizeTerm(sec.title);
  const out: string[] = [];
  for (const stage of stages) {
    for (const c of stage.concepts) {
      const label = normalizeTerm(c.label);
      if (!label || out.includes(c.label)) continue;
      const hit =
        terms.some((t) => t === label || (t.length >= 3 && t.length / label.length >= 0.5 && label.includes(t))) ||
        (title.length > 0 && label.length >= 3 && label.length / title.length >= 0.4 && title.includes(label));
      if (hit) out.push(c.label);
    }
  }
  return out;
}

/** 锚点时间格式：`mm:ss`（endMs 给出时 `mm:ss-mm:ss` 区间） */
export function formatRange(startMs: number, endMs?: number): string {
  return endMs != null && Number.isFinite(endMs)
    ? `${formatTimestamp(startMs)}-${formatTimestamp(endMs)}`
    : formatTimestamp(startMs);
}

/**
 * 重要度文字徽标（替换无语义圆点）：
 * >=5 核心 / >=4 重要 / >=3 常用 / 其他 了解。
 */
export function importanceBadge(importance: number): string {
  if (importance >= 5) return '核心';
  if (importance >= 4) return '重要';
  if (importance >= 3) return '常用';
  return '了解';
}

/**
 * 降级数据判定（ConceptMapData 无 degraded 字段的约定手段，导出供单测）：
 * termIndexFallback 产物 model='term-index'。
 */
export function isTermIndexData(data: ConceptMapData): boolean {
  return data.model === 'term-index';
}

/** 概念最早出现时间（rail 圆点语义；无锚返回 null） */
function earliestAnchorMs(concept: ConceptItem): number | null {
  if (concept.anchors.length === 0) return null;
  return Math.min(...concept.anchors.map((a) => a.tMs));
}

/** 空大纲引导（独立导出：不依赖 markmap/DOM，renderToString 可测） */
export function MindmapEmptyGuide({ onGoOutline }: { onGoOutline?: () => void }) {
  return (
    <div className="tab-placeholder mindmap-empty">
      <p>{MINDMAP_EMPTY_TEXT}</p>
      {onGoOutline && (
        <button type="button" className="btn btn-primary" onClick={onGoOutline}>
          {MINDMAP_EMPTY_ACTION_TEXT}
        </button>
      )}
    </div>
  );
}

/** 章节时间轴视图（原 markmap 实现，SPEC-04 验收后保留为次要视图） */
export function ChronoView({
  sections,
  positionMs = 0,
  onRequestSeek,
}: {
  sections: Section[];
  positionMs?: number;
  onRequestSeek?: (ms: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | null>(null);
  /** markmap 实例绑定的 svg（sections 空→非空切换后 svg 重建，旧实例需销毁重建） */
  const mmSvgRef = useRef<SVGSVGElement | null>(null);
  /** 最新 ref：onRequestSeek 由父组件每次渲染重建时不影响已绑定的事件委托 */
  const onRequestSeekRef = useRef(onRequestSeek);
  onRequestSeekRef.current = onRequestSeek;
  /** 最近一次滚动/高亮过的 activeIndex，防止每次 positionMs 更新都触发动作抖动 */
  const lastActiveRef = useRef(-1);

  const markdown = useMemo(() => buildMindmapMarkdown(sections), [sections]);
  const activeIndex = findActiveSectionIndex(sections, positionMs);
  /** 实际完成 markmap setData 的 markdown（跟随高亮需等树渲染完成后再查 DOM） */
  const [renderedMarkdown, setRenderedMarkdown] = useState('');

  // 组件卸载：销毁 markmap 实例（释放 d3 zoom 监听）
  useEffect(
    () => () => {
      mmRef.current?.destroy();
      mmRef.current = null;
      mmSvgRef.current = null;
    },
    [],
  );

  // 大纲变化 → 重新 transform + setData + fit（markmap 动态 import，见文件头注释）
  useEffect(() => {
    if (sections.length === 0) return;
    let cancelled = false;
    (async () => {
      const [lib, view] = await Promise.all([import('markmap-lib'), import('markmap-view')]);
      if (cancelled) return;
      const svgEl = svgRef.current;
      if (!svgEl) return;
      const { root } = new lib.Transformer().transform(markdown);
      // sections 空→非空切换后 svg 已重建，旧实例指向已卸载节点，需销毁重建
      if (mmRef.current && mmSvgRef.current !== svgEl) {
        mmRef.current.destroy();
        mmRef.current = null;
        mmSvgRef.current = null;
      }
      let mm = mmRef.current;
      if (!mm) {
        mm = view.Markmap.create(
          svgEl,
          {
            initialExpandLevel: -1,
            maxWidth: 220,
            spacingVertical: 10,
            spacingHorizontal: 96,
            duration: 0,
          },
          root,
        );
        mmRef.current = mm;
        mmSvgRef.current = svgEl;
        mm.fit();
      } else {
        mm.setData(root);
        mm.fit();
      }
      setRenderedMarkdown(markdown);
    })().catch(() => {
      // markmap 渲染失败静默（保持空视图，不阻塞其他 Tab）
    });
    return () => {
      cancelled = true;
    };
  }, [markdown, sections.length]);

  // 节点点击跳播：svg 容器事件委托（markmap 节点为 g，文本在 text / foreignObject 中，
  // 统一取 g.textContent；折叠圆点 circle 走 markmap 默认行为不跳播）
  useEffect(() => {
    if (sections.length === 0) return;
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest('circle')) return;
      const g = target.closest('g');
      if (!g) return;
      const ts = parseNodeTimestamp(g.textContent ?? '');
      if (ts !== null) onRequestSeekRef.current?.(ts);
    };
    el.addEventListener('click', handler);
    return () => el.removeEventListener('click', handler);
  }, [sections.length]);

  // 播放跟随：高亮当前章节节点（文本匹配章节标题前缀）+ 滚出可视区时聚焦
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const nodes = Array.from(svg.querySelectorAll('g'));
    if (activeIndex < 0) {
      for (const g of nodes) {
        g.classList.remove('mm-active');
      }
      lastActiveRef.current = -1;
      return;
    }
    const prefix = sectionHeadingPrefix(sections[activeIndex]);
    const matches = nodes.filter((g) => (g.textContent ?? '').includes(prefix));
    for (const g of nodes) {
      g.classList.toggle('mm-active', matches.includes(g));
    }
    const target: Element | null = matches[0] ?? null;
    const changed = lastActiveRef.current !== activeIndex;
    lastActiveRef.current = activeIndex;
    // 高亮目标变化才判断是否需要滚动（避免每次 positionMs 更新都滚动抖动）
    const container = containerRef.current;
    if (changed && target && container) {
      const rect = target.getBoundingClientRect();
      const view = container.getBoundingClientRect();
      if (rect.bottom < view.top || rect.top > view.bottom) {
        target.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex, renderedMarkdown, sections]);

  if (sections.length === 0) {
    return <MindmapEmptyGuide />;
  }

  return (
    <div className="mindmap-container" ref={containerRef}>
      <svg className="markmap" ref={svgRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 概念图视图（概念图 v3：竖向阶段流程，HTML/CSS，无 SVG）
// ---------------------------------------------------------------------------

/** 概念图标签与引导文案（导出供单测断言） */
export const CONCEPT_VIEW_LABEL = '概念图';
export const CHRONO_VIEW_LABEL = '时间轴';
export const CONCEPT_GENERATE_TEXT = '生成知识图';
export const CONCEPT_GENERATING_TEXT = '正在生成概念知识图…';
export const CONCEPT_MODEL_HINT = '需先配置模型：到 DeepSeek / 阿里云百炼创建 API Key，在设置页粘贴并测试连接（只需一次；右上角「？」有完整帮助）';
export const CONCEPT_OPEN_SETTINGS_TEXT = '去设置';
/** 降级横幅文案（模型生成失败 → 术语关联图，显式告知不再静默） */
export const CONCEPT_DEGRADED_TEXT = '模型生成失败，当前为术语关联图（降级）';
/** 未接线模型路径的本地降级横幅文案 */
export const CONCEPT_FALLBACK_HINT = '模型生成未接线，已降级为本地术语关联图';
/** 降级横幅重试按钮文案 */
export const CONCEPT_RETRY_TEXT = '重试';
/** 细节折叠切换文案（▸ 收起态 / ▾ 展开态） */
export const CONCEPT_DETAILS_TOGGLE_TEXT = '细节 ▸';
export const CONCEPT_DETAILS_TOGGLE_OPEN_TEXT = '细节 ▾';
/** 主锚 chip 的无障碍/测试语义标记 */
export const PRIMARY_CHIP_CLASS = 'cm-chip-primary';

// ---------------------------------------------------------------------------
// 流程图视图（冒烟 3b：draw.io 式逻辑流程，阶段为列、概念为节点、flows 为边）
// ---------------------------------------------------------------------------

export const FLOW_VIEW_LABEL = '流程图';

/** 流程布局常量（纯展示） */
const FLOW_NODE_W = 150;
const FLOW_NODE_H = 44;
const FLOW_NODE_GAP = 12;
const FLOW_COL_GAP = 56;
const FLOW_PAD = 14;
const FLOW_HEADER_H = 34;

export interface FlowNode {
  id: string;
  label: string;
  importance: number;
  /** 跳播时间（primaryAnchorTMs；无锚 -1） */
  tMs: number;
  stageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowLayout {
  nodes: FlowNode[];
  width: number;
  height: number;
}

/**
 * 流程布局（纯函数，确定性）：阶段为列（按讲解推进从左到右），概念在列内按
 * 模型输出顺序（即讲解顺序）自上而下。同列节点等宽等高，位置由序号决定。
 * 宽度额外预留右侧余量：同列顺序边/回流边在最后一列右缘外绕行
 * （flowEdgeGeometry 的 mx = 右缘 + colGap/2），不预留会被 svg 裁掉（实测 bug）。
 */
export function layoutConceptFlow(stages: ConceptStage[]): FlowLayout {
  const nodes: FlowNode[] = [];
  let maxRows = 1;
  stages.forEach((stage, si) => {
    stage.concepts.forEach((c, ci) => {
      nodes.push({
        id: c.id,
        label: c.label,
        importance: c.importance,
        tMs: c.primaryAnchorTMs,
        stageIndex: si,
        x: FLOW_PAD + si * (FLOW_NODE_W + FLOW_COL_GAP),
        y: FLOW_PAD + FLOW_HEADER_H + ci * (FLOW_NODE_H + FLOW_NODE_GAP),
        w: FLOW_NODE_W,
        h: FLOW_NODE_H,
      });
    });
    maxRows = Math.max(maxRows, stage.concepts.length);
  });
  return {
    nodes,
    width:
      FLOW_PAD * 2 +
      stages.length * FLOW_NODE_W +
      Math.max(0, stages.length - 1) * FLOW_COL_GAP +
      // 右侧绕行余量：gutter 中点 colGap/2 + lane 错开 14px + 画布内边距
      FLOW_COL_GAP / 2 +
      14 +
      FLOW_PAD,
    height: FLOW_PAD * 2 + FLOW_HEADER_H + maxRows * (FLOW_NODE_H + FLOW_NODE_GAP) - FLOW_NODE_GAP,
  };
}

/** 圆角正交路径：依次经过拐点，拐角用二次曲线（r=7）圆滑 */
function orthogonalPath(points: Array<{ x: number; y: number }>, r = 7): string {
  if (points.length < 2) return '';
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const corner = points[i]!;
    const next = points[i + 1]!;
    // 拐点处向两边各收 r，走二次贝塞尔圆角
    const rIn = Math.min(r, Math.abs(corner.x - prev.x) + Math.abs(corner.y - prev.y)) / 2;
    const rOut = Math.min(r, Math.abs(next.x - corner.x) + Math.abs(next.y - corner.y)) / 2;
    const toCornerX = Math.sign(corner.x - prev.x) * Math.min(rIn, Math.abs(corner.x - prev.x));
    const toCornerY = Math.sign(corner.y - prev.y) * Math.min(rIn, Math.abs(corner.y - prev.y));
    const fromCornerX = Math.sign(next.x - corner.x) * Math.min(rOut, Math.abs(next.x - corner.x));
    const fromCornerY = Math.sign(next.y - corner.y) * Math.min(rOut, Math.abs(next.y - corner.y));
    d += ` L ${corner.x - toCornerX} ${corner.y - toCornerY}`;
    d += ` Q ${corner.x} ${corner.y}, ${corner.x + fromCornerX} ${corner.y + fromCornerY}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

export interface FlowEdgeGeom {
  d: string;
  /** 边标签锚点（竖直段中点；无竖直段时为水平段中点） */
  labelX: number;
  labelY: number;
}

/**
 * 边几何（正交路由，冒烟 3b 二轮）：**边只走列间空隙（gutter）**，
 * 不再穿节点——旧版贝塞尔会被中间列的节点盖住（节点后绘制）。
 * - 相邻列：源右缘 → gutter → 目标左缘；
 * - 跨列：源右缘 → 源列右侧第一条 gutter → 竖直到目标行 → 目标左缘；
 * - 同列：绕右侧（底线出、右侧回）。
 * 标签锚点 = gutter 竖直段的中点。
 */
export function flowEdgeGeometry(
  a: FlowNode,
  b: FlowNode,
  opts: { kind: 'flow' | 'seq'; colGap: number; lane?: number },
): FlowEdgeGeom {
  const y1 = a.y + a.h / 2;
  const y2 = b.y + b.h / 2;
  const sameColumn = a.stageIndex === b.stageIndex;
  if (sameColumn) {
    // 同列：右缘出 → 右侧绕行 → 底部入
    const mx = Math.max(a.x, b.x) + a.w + opts.colGap / 2;
    const points = [
      { x: a.x + a.w, y: y1 },
      { x: mx, y: y1 },
      { x: mx, y: b.y + b.h + 10 },
      { x: b.x + b.w / 2, y: b.y + b.h + 10 },
      { x: b.x + b.w / 2, y: b.y + b.h },
    ];
    return { d: orthogonalPath(points), labelX: mx, labelY: (y1 + b.y + b.h) / 2 };
  }
  // gutter：源列右缘与下一列左缘之间的空隙中点（相邻与跨列都用它，保证在空隙里）。
  // 同源多条边按 lane 在 gutter 内错开（±14px），避免竖线重叠。
  const laneOffset = (opts.lane ?? 0) * 14;
  const gutterX = a.x + a.w + opts.colGap / 2 + laneOffset;
  const points =
    Math.abs(y1 - y2) < 2
      ? [
          { x: a.x + a.w, y: y1 },
          { x: b.x, y: y2 },
        ]
      : [
          { x: a.x + a.w, y: y1 },
          { x: gutterX, y: y1 },
          { x: gutterX, y: y2 },
          { x: b.x, y: y2 },
        ];
  return {
    d: orthogonalPath(points),
    labelX: gutterX,
    labelY: (y1 + y2) / 2 - 5,
  };
}

/** 流程图视图：节点 = 概念（点击跳播），边 = 模型 flows + 阶段内顺序边 */
function ConceptFlowView({
  stages,
  flows,
  activeLabels,
  onRequestSeek,
  degraded,
  degradedText,
  onRetry,
  onGenerateFlows,
}: {
  stages: ConceptStage[];
  flows: ConceptFlow[] | undefined;
  activeLabels: ReadonlySet<string>;
  onRequestSeek?: (ms: number) => void;
  degraded?: boolean;
  degradedText?: string;
  onRetry?: () => void;
  /** 关系边独立生成（冒烟 3b 二轮：与概念图分开，省 token）；未注入时只提示 */
  onGenerateFlows?: () => Promise<unknown>;
}) {
  const [generatingFlows, setGeneratingFlows] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutConceptFlow(stages), [stages]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  // 模型 flows（端点必须能解析到节点）+ 阶段内顺序边（虚线，弱化）
  const edges = useMemo(() => {
    const out: Array<{ key: string; d: string; label?: string; kind: 'flow' | 'seq'; labelX: number; labelY: number }> = [];
    const laneByFrom = new Map<string, number>();
    for (const f of flows ?? []) {
      const a = nodeById.get(f.fromId);
      const b = nodeById.get(f.toId);
      if (!a || !b) continue;
      const lane = laneByFrom.get(f.fromId) ?? 0;
      laneByFrom.set(f.fromId, lane + 1);
      const geom = flowEdgeGeometry(a, b, { kind: 'flow', colGap: FLOW_COL_GAP, lane });
      out.push({
        key: `${f.fromId}->${f.toId}:${f.label ?? ''}`,
        d: geom.d,
        label: f.label,
        kind: 'flow',
        labelX: geom.labelX,
        labelY: geom.labelY,
      });
    }
    for (const stage of stages) {
      for (let i = 0; i + 1 < stage.concepts.length; i++) {
        const a = nodeById.get(stage.concepts[i]!.id);
        const b = nodeById.get(stage.concepts[i + 1]!.id);
        if (!a || !b) continue;
        const geom = flowEdgeGeometry(a, b, { kind: 'seq', colGap: FLOW_COL_GAP });
        out.push({
          key: `seq-${a.id}-${b.id}`,
          d: geom.d,
          kind: 'seq',
          labelX: geom.labelX,
          labelY: geom.labelY,
        });
      }
    }
    return out;
  }, [flows, nodeById, stages]);

  // 活动概念跟随：高亮节点滚入可视区
  const lastActiveKeyRef = useRef('');
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || activeLabels.size === 0) return;
    const key = [...activeLabels].sort().join('|');
    if (key === lastActiveKeyRef.current) return;
    lastActiveKeyRef.current = key;
    const target = container.querySelector('.cmf-node.active');
    if (target) {
      const rect = target.getBoundingClientRect();
      const view = container.getBoundingClientRect();
      if (rect.bottom < view.top || rect.top > view.bottom) {
        target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    }
  }, [activeLabels]);

  const flowCount = (flows ?? []).length;
  return (
    <div className="cm-container">
      {(degraded || (flowCount === 0 && !generatingFlows)) && (
        <div className={`cm-degraded-banner${degraded ? '' : ' cmf-hint-banner'}`} role="status">
          <span className="cm-degraded-text">
            {degraded
              ? (degradedText ?? CONCEPT_DEGRADED_TEXT)
              : '还没有逻辑关系边——生成一次（独立小请求，只传概念清单，很省 token）即可看到 draw.io 式流程'}
            {flowError ? `：${flowError}` : ''}
          </span>
          {!degraded && onGenerateFlows && (
            <button
              type="button"
              className="cm-retry-btn"
              disabled={generatingFlows}
              onClick={() => {
                setGeneratingFlows(true);
                setFlowError(null);
                onGenerateFlows()
                  .catch((err: unknown) => setFlowError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setGeneratingFlows(false));
              }}
            >
              {generatingFlows ? '生成中…' : '生成关系边'}
            </button>
          )}
          {degraded && onRetry && (
            <button type="button" className="cm-retry-btn" onClick={onRetry}>
              {CONCEPT_RETRY_TEXT}
            </button>
          )}
        </div>
      )}
      <div className="cmf-flow-scroll" ref={scrollRef}>
        <svg
          className="cmf-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label="知识流程图"
        >
          <defs>
            <marker id="cmf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="cmf-arrow-head" />
            </marker>
            <marker id="cmf-arrow-seq" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="cmf-arrow-head-seq" />
            </marker>
          </defs>

          {/* 阶段列头 */}
          {stages.map((stage, si) => (
            <g key={stage.id} className="cmf-stage-head">
              <rect
                x={FLOW_PAD + si * (FLOW_NODE_W + FLOW_COL_GAP)}
                y={FLOW_PAD}
                width={FLOW_NODE_W}
                height={26}
                rx={6}
                className={`cmf-stage-rect hue-${si % STAGE_HUE_COUNT}`}
              />
              <text
                x={FLOW_PAD + si * (FLOW_NODE_W + FLOW_COL_GAP) + FLOW_NODE_W / 2}
                y={FLOW_PAD + 17}
                textAnchor="middle"
                className="cmf-stage-text"
              >
                {`${si + 1}. ${stage.label}`.slice(0, 14)}
              </text>
            </g>
          ))}

          {/* 边（先画，节点覆盖其上） */}
          {edges.map((e) => (
            <g key={e.key} className={`cmf-edge ${e.kind}`}>
              <path d={e.d} markerEnd={e.kind === 'flow' ? 'url(#cmf-arrow)' : 'url(#cmf-arrow-seq)'} />
              {e.label && (
                <text className="cmf-edge-label" x={e.labelX} y={e.labelY} textAnchor="middle">
                  {e.label}
                </text>
              )}
            </g>
          ))}

          {/* 节点 */}
          {layout.nodes.map((n) => {
            const active = activeLabels.has(normalizeTerm(n.label));
            return (
              <g
                key={n.id}
                className={`cmf-node imp-${n.importance}${active ? ' active' : ''}`}
                onClick={() => {
                  if (n.tMs >= 0) onRequestSeek?.(n.tMs);
                }}
              >
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={8} className="cmf-node-rect" />
                <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle" className="cmf-node-text">
                  {n.label.slice(0, 11)}
                </text>
                <title>{n.tMs >= 0 ? `${n.label}（点击跳播到 ${mmssLabel(n.tMs)}）` : n.label}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** 流程图节点标题里的 mm:ss（独立小函数，避免依赖 compiler 的导出面） */
function mmssLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** 概念图视图（竖向阶段流程；stages 由调用方决定来源：缓存、App 降级或本地降级） */
function ConceptView({
  stages,
  sections,
  positionMs,
  onRequestSeek,
  degraded,
  degradedText,
  onRetry,
}: {
  stages: ConceptStage[];
  sections: Section[];
  positionMs: number;
  onRequestSeek?: (ms: number) => void;
  /** 降级横幅开关（仅 degraded=true 时渲染，黄底） */
  degraded?: boolean;
  degradedText?: string;
  onRetry?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  /** 展开细节区的概念 id（默认全部收起） */
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set());
  /** 首次挂载新图时重置折叠态 */
  const stagesKeyRef = useRef('');
  const stagesKey = stages.map((s) => s.id).join(',');
  if (stagesKeyRef.current !== stagesKey) {
    stagesKeyRef.current = stagesKey;
    if (openDetails.size > 0) setOpenDetails(new Set());
  }

  // 概念跟随：命中 label 集合（精确匹配，归一化后比较）
  const activeLabels = useMemo(
    () => new Set(matchConcepts(sections, positionMs, stages).map((l) => l.toLowerCase())),
    [sections, positionMs, stages],
  );
  const lastActiveKeyRef = useRef('');

  // 高亮变化且概念行滚出可视区时平滑滚动聚焦
  useEffect(() => {
    const container = containerRef.current;
    if (!container || activeLabels.size === 0) return;
    const key = [...activeLabels].sort().join('|');
    if (key === lastActiveKeyRef.current) return;
    lastActiveKeyRef.current = key;
    const target = container.querySelector('.cm-concept.concept-active');
    if (target) {
      const rect = target.getBoundingClientRect();
      const view = container.getBoundingClientRect();
      if (rect.bottom < view.top || rect.top > view.bottom) {
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }, [activeLabels]);

  const toggleDetails = (id: string) => {
    setOpenDetails((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 当前阶段高亮：播放位置命中的概念所在阶段块加重（stage-current）
  const activeStageIds = useMemo(() => {
    const ids = new Set<string>();
    for (const stage of stages) {
      for (const c of stage.concepts) {
        if (activeLabels.has(normalizeTerm(c.label))) {
          ids.add(stage.id);
          break;
        }
      }
    }
    return ids;
  }, [stages, activeLabels]);

  // 阶段顺序 = 模型输出的讲解推进顺序（确定性：不重排）
  return (
    <div className="cm-container" ref={containerRef}>
      <div className="cm-summary-bar" role="status">
        <span className="cm-summary-item">
          <b>{stages.length}</b> 阶段
        </span>
        <span className="cm-summary-sep" aria-hidden="true" />
        <span className="cm-summary-item">
          <b>{stages.reduce((n, s) => n + s.concepts.length, 0)}</b> 概念
        </span>
        <span className="cm-summary-sep" aria-hidden="true" />
        <span className="cm-summary-item">
          <b>{stages.reduce((n, s) => n + s.concepts.reduce((m, c) => m + c.anchors.length, 0), 0)}</b> 处可跳播
        </span>
      </div>
      {degraded && (
        <div className="cm-degraded-banner" role="status">
          <span className="cm-degraded-text">{degradedText ?? CONCEPT_DEGRADED_TEXT}</span>
          {onRetry && (
            <button type="button" className="cm-retry-btn" onClick={onRetry}>
              {CONCEPT_RETRY_TEXT}
            </button>
          )}
        </div>
      )}
      {stages.map((stage, si) => (
        <Fragment key={stage.id}>
          {/* 阶段间连接：竖线 + 下箭头（首阶段无），体现推进 */}
          {si > 0 && <div className="kp-connector" aria-hidden="true" />}
          <section
            className={`cm-stage${activeStageIds.has(stage.id) ? ' stage-current' : ''}`}
          >
            <header className="cm-stage-header">
              <span className={`cm-stage-step stage-hue-${si % STAGE_HUE_COUNT}`}>{si + 1}</span>
              <span className="cm-stage-title">{stage.label}</span>
              <span className="cm-stage-count">{`${stage.concepts.length} 概念`}</span>
            </header>
            <div className="cm-stage-body">
              {stage.concepts.map((concept) => {
                const active = activeLabels.has(normalizeTerm(concept.label));
                const open = openDetails.has(concept.id);
                const earliest = earliestAnchorMs(concept);
                const [primary, ...rest] = concept.anchors;
                return (
                  <div
                    key={concept.id}
                    className={`cm-concept imp-${concept.importance}${active ? ' concept-active' : ''}`}
                  >
                    {/* rail 节点圆点：有语义——该概念最早锚点时间，hover 显示；无锚不渲染 */}
                    {earliest !== null && (
                      <span
                        className="cm-rail-dot"
                        title={`首次出现 ${formatTimestamp(earliest)}`}
                      />
                    )}
                    <div className="cm-concept-main">
                      <button
                        type="button"
                        className="cm-concept-label"
                        disabled={concept.anchors.length === 0}
                        title={
                          primary
                            ? `跳播到 ${formatRange(concept.primaryAnchorTMs)}（主锚）`
                            : undefined
                        }
                        onClick={() => {
                          if (concept.anchors.length > 0) {
                            onRequestSeek?.(concept.primaryAnchorTMs);
                          }
                        }}
                      >
                        {concept.label}
                      </button>
                      <span
                        className="cm-importance-badge"
                        data-importance={concept.importance}
                      >
                        {importanceBadge(concept.importance)}
                      </span>
                    </div>
                    {concept.anchors.length > 0 && (
                      <div className="cm-chips">
                        {/* 主锚 chip：实心强调（anchors[0] = 得分最高章节） */}
                        {primary && (
                          <button
                            key={`${concept.id}-primary`}
                            type="button"
                            className={`cm-chip ${PRIMARY_CHIP_CLASS}`}
                            title={`主锚（重点章节）${formatRange(primary.tMs)}`}
                            onClick={() => onRequestSeek?.(primary.tMs)}
                          >
                            {`[${formatTimestamp(primary.tMs)}]`}
                          </button>
                        )}
                        {/* 次锚 chips：次级样式，按时间升序 */}
                        {rest.map((a, i) => (
                          <button
                            key={`${concept.id}-a${i}`}
                            type="button"
                            className="cm-chip"
                            title={`跳播到 ${formatRange(a.tMs)}`}
                            onClick={() => onRequestSeek?.(a.tMs)}
                          >
                            {`[${formatTimestamp(a.tMs)}]`}
                          </button>
                        ))}
                      </div>
                    )}
                    {concept.details.length > 0 && (
                      <>
                        <button
                          type="button"
                          className="cm-details-toggle"
                          aria-expanded={open}
                          onClick={() => toggleDetails(concept.id)}
                        >
                          {open ? CONCEPT_DETAILS_TOGGLE_OPEN_TEXT : CONCEPT_DETAILS_TOGGLE_TEXT}
                        </button>
                        {/* 细节折叠：常驻渲染 + grid 0fr/1fr 过渡（参考 outline-regen-collapse） */}
                        <div className={`cm-details-collapse${open ? ' open' : ''}`}>
                          <ul className="cm-details">
                            {concept.details.map((d, i) => (
                              <li key={`${concept.id}-d${i}`}>{d}</li>
                            ))}
                          </ul>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </Fragment>
      ))}
    </div>
  );
}

/** 生成中骨架动画 */
function ConceptSkeleton() {
  return (
    <div className="cm-skeleton" aria-label="概念图生成中">
      <div className="cm-skeleton-bar" />
      <div className="cm-skeleton-row">
        <div className="cm-skeleton-bar" />
        <div className="cm-skeleton-bar" />
      </div>
      <div className="cm-skeleton-row">
        <div className="cm-skeleton-bar" />
        <div className="cm-skeleton-bar" />
        <div className="cm-skeleton-bar" />
      </div>
      <p className="cm-skeleton-text">正在生成概念知识图…</p>
    </div>
  );
}

/**
 * 组件完全 props 驱动（App.tsx 接线由父 agent 完成）。
 * 现有 props（sections/positionMs/onRequestSeek/onGoOutline）保持可选 + 默认值，
 * 新增 props（videoTitle/modelReady/onOpenSettings/generateConceptMap/conceptMap/generating/degraded）
 * 全可选：未接线时概念图视图自动降级为本地术语关联图（零模型）。
 */
export function MindmapTab(props: MindmapTabProps) {
  const {
    sections = [],
    videoTitle = '',
    positionMs = 0,
    onRequestSeek,
    modelReady = false,
    onOpenSettings,
    generateFlows,
    generateConceptMap,
    conceptMap = null,
    generating = false,
    degraded = false,
    /** 生成失败的具体原因（App 捕获后传入）；缺省时展示通用降级文案 */
    degradedText,
    onGoOutline,
  } = props;

  // initialView：单测注入列表/时间轴视图（默认流程图，冒烟 3b）
  const [view, setView] = useState<'flow' | 'concept' | 'chrono'>(props.initialView ?? 'flow');

  // 未接线模型路径时：本地术语关联图（零模型确定性降级，红线 1）
  const fallbackMap = useMemo(() => {
    if (conceptMap || generateConceptMap) return null;
    if (sections.length === 0) return null;
    return buildTermIndexMap(sections);
  }, [conceptMap, generateConceptMap, sections]);

  const handleGenerate = () => {
    if (!generateConceptMap || sections.length === 0) return;
    void generateConceptMap(sections, videoTitle).catch(() => {
      /* 生成失败由父组件状态呈现；组件不重复处理 */
    });
  };

  // 降级判定双手段并存：props.degraded（App 生成 catch 路径设置）优先，
  // model='term-index' 约定兜底（types.ts 的 ConceptMapData 无字段）
  const mapDegraded = degraded || (conceptMap != null && isTermIndexData(conceptMap));

  const showEmptyGuide = (view === 'concept' || view === 'flow') && sections.length === 0 && !conceptMap;

  return (
    <div className="mindmap-tab">
      <div className="mm-view-switch" role="tablist">
        <button
          type="button"
          className={`mm-view-btn${view === 'flow' ? ' active' : ''}`}
          onClick={() => setView('flow')}
        >
          {FLOW_VIEW_LABEL}
        </button>
        <button
          type="button"
          className={`mm-view-btn${view === 'concept' ? ' active' : ''}`}
          onClick={() => setView('concept')}
        >
          {CONCEPT_VIEW_LABEL}
        </button>
        <button
          type="button"
          className={`mm-view-btn${view === 'chrono' ? ' active' : ''}`}
          onClick={() => setView('chrono')}
        >
          {CHRONO_VIEW_LABEL}
        </button>
        {/* 重新生成入口：有缓存时也允许重抽（用户要求） */}
        {generateConceptMap && sections.length > 0 && (
          <button type="button" className="btn" onClick={handleGenerate} disabled={generating}>
            {generating ? '生成中…' : conceptMap ? '重新生成' : CONCEPT_GENERATE_TEXT}
          </button>
        )}
        {/* 模型选择（margin-left:auto 靠右；select 不参与 tablist 语义） */}
        <ModelPicker onOpenSettings={onOpenSettings} />
        <GenerationBanner module="mindmap" />
      </div>

      {showEmptyGuide && <MindmapEmptyGuide onGoOutline={onGoOutline} />}

      {view === 'flow' && !showEmptyGuide && (
        <div className="mm-view-body">
          {conceptMap ? (
            <ConceptFlowView
              stages={conceptMap.stages}
              flows={conceptMap.flows}
              onGenerateFlows={generateFlows}
              activeLabels={(() => {
                // 与列表视图同一跟随口径（matchConcepts），此处内联避免提升 hook
                const labels = matchConcepts(sections, positionMs, conceptMap.stages);
                return new Set(labels.map((l) => l.toLowerCase()));
              })()}
              onRequestSeek={onRequestSeek}
              degraded={mapDegraded}
              degradedText={degradedText ?? CONCEPT_DEGRADED_TEXT}
              onRetry={generateConceptMap ? handleGenerate : undefined}
            />
          ) : generating ? (
            <ConceptSkeleton />
          ) : (
            <div className="tab-placeholder cm-gate">
              <p>基于大纲重组为逻辑流程（概念节点 + 关系边）</p>
            </div>
          )}
        </div>
      )}

      {view === 'concept' && !showEmptyGuide && (
        <div className="mm-view-body">
          {conceptMap ? (
            <ConceptView
              stages={conceptMap.stages}
              sections={sections}
              positionMs={positionMs}
              onRequestSeek={onRequestSeek}
              degraded={mapDegraded}
              degradedText={degradedText ?? CONCEPT_DEGRADED_TEXT}
              onRetry={generateConceptMap ? handleGenerate : undefined}
            />
          ) : generating ? (
            <ConceptSkeleton />
          ) : generateConceptMap ? (
            modelReady ? (
              <div className="tab-placeholder cm-gate">
                <p>基于大纲重组为知识流程（阶段 → 概念 → 细节）</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleGenerate}
                >
                  {CONCEPT_GENERATE_TEXT}
                </button>
              </div>
            ) : (
              <div className="tab-placeholder cm-gate">
                <p>{CONCEPT_MODEL_HINT}</p>
                {onOpenSettings && (
                  <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
                    {CONCEPT_OPEN_SETTINGS_TEXT}
                  </button>
                )}
              </div>
            )
          ) : fallbackMap ? (
            <ConceptView
              stages={fallbackMap.stages}
              sections={sections}
              positionMs={positionMs}
              onRequestSeek={onRequestSeek}
              degraded
              degradedText={CONCEPT_FALLBACK_HINT}
            />
          ) : (
            <MindmapEmptyGuide onGoOutline={onGoOutline} />
          )}
        </div>
      )}

      {view === 'chrono' && (
        <div className="mm-view-body">
          <ChronoView sections={sections} positionMs={positionMs} onRequestSeek={onRequestSeek} />
        </div>
      )}
    </div>
  );
}
