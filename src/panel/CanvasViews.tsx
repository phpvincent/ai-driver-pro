/**
 * 自由画布视图（SPEC-13）：AI 思维导图（markmap 渲染层级 Markdown）与 AI 流程图（mermaid）。
 *
 * 用户决策：不再强制"节点可跳播"——画布交给模型自由发挥，组件只负责
 * 缓存读取 / 生成 / 渲染 / 缩放平移 / 失败重试。
 */
import { useEffect, useRef, useState } from 'react';
import type { Markmap } from 'markmap-view';
import type { CanvasKind } from '../core/pipeline/freeCanvas';
import type { Section } from '../types';
import {
  generateCanvasFor,
  getCanvasCached,
  getCanvasInflight,
  isCanvasBusy,
  subscribeCanvasBusy,
  type CanvasRecord,
} from './canvasLoader';
import { canvasDownloadFileName, matchNodeAnchorMs } from '../core/pipeline/freeCanvas';
import { downloadTextFile } from '../platform/files';
import {
  CANVAS_EXPORT_FORMATS,
  exportCanvasAsFormat,
  type CanvasExportFormat,
} from './canvasExport';
import { GenerationProgress } from './GenerationProgress';

export const AI_MINDMAP_HINT = '让 AI 按知识逻辑自由梳理整节课（不按时间堆砌，层级由内容决定）';
export const AI_FLOW_HINT = '让 AI 自由绘制知识逻辑流程图（因果 / 步骤 / 分支 / 循环，形态由内容决定）';

interface CanvasPanelProps {
  kind: CanvasKind;
  videoId?: string;
  sections: Section[];
  videoTitle: string;
  modelReady: boolean;
  onOpenSettings?: () => void;
  /** SPEC-17：流程图节点点击 → 跳转到对应播放节点（毫秒） */
  onRequestSeek?: (ms: number) => void;
}

/** 画布面板：缓存 → 生成按钮 → 渲染；失败显示原因 + 重试 */
export function CanvasPanel({
  kind,
  videoId,
  sections,
  videoTitle,
  modelReady,
  onOpenSettings,
  onRequestSeek,
}: CanvasPanelProps) {
  const [rec, setRec] = useState<CanvasRecord | null>(null);
  const [busy, setBusy] = useState(false);
  /** 跨画布互斥：任一画布生成中（含本面板），生成按钮禁用 */
  const [canvasBusy, setCanvasBusyState] = useState(isCanvasBusy());
  useEffect(() => {
    setCanvasBusyState(isCanvasBusy());
    return subscribeCanvasBusy(() => setCanvasBusyState(isCanvasBusy()));
  }, []);
  /** 已渲染的 SVG（下载用）：两种画布都保留**存活元素**（自包含化导出） */
  const markmapSvgRef = useRef<SVGSVGElement | null>(null);
  const mermaidSvgElRef = useRef<SVGSVGElement | null>(null);
  const [mermaidSvg, setMermaidSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 渲染层错误（mermaid 运行时渲染失败，罕见：parse 已过） */
  const [renderError, setRenderError] = useState<string | null>(null);
  /** 下载菜单展开中（聚合：图片四格式 + 源码，单按钮入口） */
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);

  useEffect(() => {
    setRec(null);
    setError(null);
    setRenderError(null);
    if (!videoId) return;
    let cancelled = false;
    // 视图切换保活：该画布有在途生成 → 恢复"生成中"，完成后直接展示新图
    const inflight = getCanvasInflight(kind, videoId);
    if (inflight) {
      setBusy(true);
      inflight
        .then((r) => {
          if (!cancelled) setRec(r);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
      return () => {
        cancelled = true;
      };
    }
    void getCanvasCached(kind, videoId).then((r) => {
      if (!cancelled && r) setRec(r);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, videoId]);

  const generate = () => {
    if (!videoId || sections.length === 0 || busy || isCanvasBusy()) return;
    setBusy(true);
    setError(null);
    setRenderError(null);
    generateCanvasFor(kind, videoId, sections, videoTitle)
      .then((r) => setRec(r))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  if (sections.length === 0) {
    return (
      <div className="tab-placeholder cm-gate">
        <p>请先在「大纲」Tab 生成大纲，AI 才有素材作图</p>
      </div>
    );
  }

  const toolbar = (
    <div className="canvas-toolbar">
      <span className="canvas-badge">AI 自由作图</span>
      {modelReady && (
        <button
          type="button"
          className="btn"
          onClick={generate}
          disabled={busy || canvasBusy}
          title={canvasBusy && !busy ? '另一画布正在生成（抽帧需互斥，避免画面来回跳）' : undefined}
        >
          {busy ? '生成中…' : canvasBusy ? '另一画布生成中…' : rec ? '重新生成' : '生成'}
        </button>
      )}
      {!modelReady && onOpenSettings && (
        <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
          先去配置模型
        </button>
      )}
      {rec && !busy && (
        <>
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="btn"
              disabled={exportBusy}
              aria-expanded={menuOpen}
              title="下载当前导图：PNG/JPG/PDF/SVG 或源码"
              onClick={() => setMenuOpen((v) => !v)}
            >
              {exportBusy ? '导出中…' : '下载 ▾'}
            </button>
            {menuOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  zIndex: 30,
                  minWidth: 190,
                  padding: 4,
                  background: '#fff',
                  border: '1px solid #e5e6eb',
                  borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(29,33,41,.12)',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {CANVAS_EXPORT_FORMATS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className="btn"
                    style={{ justifyContent: 'flex-start', border: 'none', textAlign: 'left' }}
                    onClick={() => {
                      setMenuOpen(false);
                      const svgEl =
                        kind === 'mindmap' ? markmapSvgRef.current : mermaidSvgElRef.current;
                      if (!svgEl && !mermaidSvg) return;
                      setExportBusy(true);
                      void exportCanvasAsFormat({
                        svgEl,
                        svg: mermaidSvg,
                        format: f.value,
                        fileName: canvasDownloadFileName(videoTitle, kind, ''),
                        // 思维导图在小侧边栏里 fit，基数小 → 3 倍超采样保清晰
                        scale: kind === 'mindmap' ? 3 : 2,
                      })
                        .catch((err: unknown) =>
                          setError(err instanceof Error ? err.message : String(err)),
                        )
                        .finally(() => setExportBusy(false));
                    }}
                  >
                    {f.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn"
                  style={{ justifyContent: 'flex-start', border: 'none', textAlign: 'left' }}
                  title={kind === 'mindmap' ? '层级 Markdown 源码（可再编辑 / 导入导图工具）' : 'Mermaid 源码（可在支持 Mermaid 的编辑器再编辑）'}
                  onClick={() => {
                    setMenuOpen(false);
                    const ext = kind === 'mindmap' ? 'md' : 'mmd';
                    downloadTextFile(canvasDownloadFileName(videoTitle, kind, ext), rec.code, 'text/plain');
                  }}
                >
                  {kind === 'mindmap' ? '源码（Markdown）' : '源码（Mermaid）'}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div className="canvas-panel">
      {toolbar}
      {busy && videoId && (
        <div style={{ padding: '0 16px' }}>
          <GenerationProgress videoId={videoId} />
        </div>
      )}
      {error && !busy && (
        <div className="canvas-error">
          <span>{error}</span>
          <button type="button" className="btn" onClick={generate}>
            重试
          </button>
        </div>
      )}
      {renderError && !busy && (
        <div className="canvas-error">
          <span>渲染失败：{renderError}</span>
          <button type="button" className="btn" onClick={generate}>
            重新生成
          </button>
        </div>
      )}
      {rec && !busy ? (
        kind === 'mindmap' ? (
          <MarkmapCanvas markdown={rec.code} svgElRef={markmapSvgRef} />
        ) : (
          <MermaidCanvas
            code={rec.code}
            svgElRef={mermaidSvgElRef}
            onNodeClick={(nodeText) => {
              // SPEC-17：节点文字 ↔ 章节确定性匹配 → 跳播（匹配不上不响应，宁可不跳不错跳）
              const ms = matchNodeAnchorMs(nodeText, sections);
              if (ms !== null) onRequestSeek?.(ms);
            }}
            onRenderError={setRenderError}
            onSvgHtml={setMermaidSvg}
          />
        )
      ) : (
        !busy &&
        !error && (
          <div className="tab-placeholder cm-gate">
            <p>{kind === 'mindmap' ? AI_MINDMAP_HINT : AI_FLOW_HINT}</p>
            {modelReady && (
              <button type="button" className="btn btn-primary" onClick={generate}>
                生成
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}

/** 层级 Markdown → markmap（可折叠 / 缩放 / 平移，markmap 原生）；svgElRef 供外层下载 SVG */
export function MarkmapCanvas({
  markdown,
  svgElRef,
}: {
  markdown: string;
  svgElRef?: { current: SVGSVGElement | null };
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | null>(null);

  useEffect(
    () => () => {
      mmRef.current?.destroy();
      mmRef.current = null;
      if (svgElRef) svgElRef.current = null;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [lib, view] = await Promise.all([import('markmap-lib'), import('markmap-view')]);
      if (cancelled || !svgRef.current) return;
      const { root } = new lib.Transformer().transform(markdown);
      if (!mmRef.current) {
        mmRef.current = view.Markmap.create(
          svgRef.current,
          { initialExpandLevel: -1, maxWidth: 260, spacingVertical: 8, spacingHorizontal: 80, duration: 300 },
          root,
        );
      } else {
        mmRef.current.setData(root);
      }
      void mmRef.current.fit();
      if (svgElRef) svgElRef.current = svgRef.current;
    })().catch(() => {
      /* 渲染失败静默：数据已过结构校验，极少发生 */
    });
    return () => {
      cancelled = true;
    };
  }, [markdown]);

  return (
    <div className="mindmap-container canvas-surface">
      <svg className="markmap" ref={svgRef} />
    </div>
  );
}

let mermaidSeq = 0;

/** Mermaid 流程图 → SVG 画布（滚轮缩放 + 拖拽平移 + 适配按钮） */
export function MermaidCanvas({
  code,
  svgElRef,
  onNodeClick,
  onRenderError,
  onSvgHtml,
}: {
  code: string;
  /** 渲染产物的存活 SVG 元素（导出自包含化用） */
  svgElRef?: { current: SVGSVGElement | null };
  /** 节点被点击（回调拿到节点文字；锚点匹配由外层做） */
  onNodeClick?: (nodeText: string) => void;
  onRenderError?: (msg: string | null) => void;
  /** 渲染成功的 svg 字符串（外层下载 SVG 用） */
  onSvgHtml?: (svg: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { default: mermaid } = await import('mermaid');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          primaryColor: '#e8f3ff',
          primaryBorderColor: '#165dff',
          primaryTextColor: '#1f2329',
          lineColor: '#4e5969',
          fontSize: '14px',
        },
        // htmlLabels:false → 纯 SVG text 标签（无 foreignObject）：位图导出不再 taint canvas，
        // 且 SVG 文件在任何渲染器中样式一致
        flowchart: { curve: 'basis', htmlLabels: false, padding: 12 },
      });
      const id = `vsc-mmd-${++mermaidSeq}`;
      const { svg: out } = await mermaid.render(id, code);
      if (!cancelled) {
        setSvg(out);
        onSvgHtml?.(out);
        setScale(1);
        setOffset({ x: 0, y: 0 });
        onRenderError?.(null);
        // 存活 SVG 元素挂到外层（导出自包含化用；由下方 useEffect 同步兜底）
      }
    })().catch((err: unknown) => {
      if (!cancelled) onRenderError?.(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // 渲染产物注入 DOM 后同步挂 ref（导出用；比 rAF 可靠，避免点下载时还没取到）
  useEffect(() => {
    if (!svgElRef) return;
    svgElRef.current = hostRef.current?.querySelector('svg') ?? null;
  }, [svg, svgElRef]);

  // 滚轮缩放必须用原生非 passive 监听：React 的 onWheel 是 passive 的，
  // 里面调 preventDefault 会报 "Unable to preventDefault inside passive event listener"
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handler = (e: WheelEvent): void => {
      e.preventDefault();
      setScale((s) => Math.min(4, Math.max(0.2, s * (e.deltaY < 0 ? 1.1 : 0.9))));
    };
    host.addEventListener('wheel', handler, { passive: false });
    return () => host.removeEventListener('wheel', handler);
  }, []);

  return (
    <div className="canvas-surface mermaid-surface">
      <div className="canvas-zoom">
        <button type="button" className="btn" onClick={() => setScale((s) => Math.min(4, s * 1.2))}>
          ＋
        </button>
        <button type="button" className="btn" onClick={() => setScale((s) => Math.max(0.2, s / 1.2))}>
          －
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          适配
        </button>
      </div>
      <div
        className="mermaid-viewport"
        ref={hostRef}
        onMouseDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onMouseMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
        }}
        onMouseUp={() => {
          dragRef.current = null;
        }}
        onMouseLeave={() => {
          dragRef.current = null;
        }}
        onClick={(e) => {
          // SPEC-17 节点点击跳播：把节点文字交给外层做章节匹配
          if (!onNodeClick) return;
          const g = (e.target as Element).closest('g.node');
          if (!g) return;
          const text = (g.textContent ?? '').trim();
          if (text) onNodeClick(text);
        }}
      >
        <div
          className="mermaid-stage"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          // mermaid securityLevel=strict 输出已净化的 SVG
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
