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
import { canvasDownloadFileName } from '../core/pipeline/freeCanvas';
import { downloadTextFile } from '../platform/files';
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
}

/** 画布面板：缓存 → 生成按钮 → 渲染；失败显示原因 + 重试 */
export function CanvasPanel({ kind, videoId, sections, videoTitle, modelReady, onOpenSettings }: CanvasPanelProps) {
  const [rec, setRec] = useState<CanvasRecord | null>(null);
  const [busy, setBusy] = useState(false);
  /** 跨画布互斥：任一画布生成中（含本面板），生成按钮禁用 */
  const [canvasBusy, setCanvasBusyState] = useState(isCanvasBusy());
  useEffect(() => {
    setCanvasBusyState(isCanvasBusy());
    return subscribeCanvasBusy(() => setCanvasBusyState(isCanvasBusy()));
  }, []);
  /** 已渲染的 SVG（下载用）：思维导图=svg 元素引用，流程图=svg 字符串 */
  const markmapSvgRef = useRef<SVGSVGElement | null>(null);
  const [mermaidSvg, setMermaidSvg] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 渲染层错误（mermaid 运行时渲染失败，罕见：parse 已过） */
  const [renderError, setRenderError] = useState<string | null>(null);

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
          <button
            type="button"
            className="btn"
            title="下载为 SVG 图片（可直接插入文档 / 分享）"
            onClick={() => {
              let svg =
                kind === 'mindmap' && markmapSvgRef.current
                  ? new XMLSerializer().serializeToString(markmapSvgRef.current)
                  : mermaidSvg;
              if (!svg) return;
              if (kind === 'mindmap') {
                // 独立文件可打开的兜底：无显式尺寸时按 viewBox（或默认）补 width/height
                const el = markmapSvgRef.current;
                if (el && !el.getAttribute('width')) {
                  const vb = el.getAttribute('viewBox')?.split(/[,\s]+/).map(Number);
                  const w = vb && vb.length === 4 ? Math.ceil(vb[2]!) : 1200;
                  const h = vb && vb.length === 4 ? Math.ceil(vb[3]!) : 800;
                  svg = svg.replace(/<svg\b/, `<svg width="${w}" height="${h}"`);
                }
              }
              downloadTextFile(canvasDownloadFileName(videoTitle, kind, 'svg'), svg, 'image/svg+xml');
            }}
          >
            下载 SVG
          </button>
          <button
            type="button"
            className="btn"
            title={kind === 'mindmap' ? '下载层级 Markdown 源码（可再编辑 / 导入导图工具）' : '下载 Mermaid 源码（可在支持 Mermaid 的编辑器再编辑）'}
            onClick={() => {
              const ext = kind === 'mindmap' ? 'md' : 'mmd';
              downloadTextFile(canvasDownloadFileName(videoTitle, kind, ext), rec.code, 'text/plain');
            }}
          >
            下载源码
          </button>
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
          <MermaidCanvas code={rec.code} onRenderError={setRenderError} onSvgHtml={setMermaidSvg} />
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
  onRenderError,
  onSvgHtml,
}: {
  code: string;
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
        flowchart: { curve: 'basis', htmlLabels: true, padding: 12 },
      });
      const id = `vsc-mmd-${++mermaidSeq}`;
      const { svg: out } = await mermaid.render(id, code);
      if (!cancelled) {
        setSvg(out);
        onSvgHtml?.(out);
        setScale(1);
        setOffset({ x: 0, y: 0 });
        onRenderError?.(null);
      }
    })().catch((err: unknown) => {
      if (!cancelled) onRenderError?.(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

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
