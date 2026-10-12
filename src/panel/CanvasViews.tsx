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
import { generateCanvasFor, getCanvasCached, type CanvasRecord } from './canvasLoader';
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
  const [error, setError] = useState<string | null>(null);
  /** 渲染层错误（mermaid 运行时渲染失败，罕见：parse 已过） */
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    setRec(null);
    setError(null);
    setRenderError(null);
    if (!videoId) return;
    let cancelled = false;
    void getCanvasCached(kind, videoId).then((r) => {
      if (!cancelled && r) setRec(r);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, videoId]);

  const generate = () => {
    if (!videoId || sections.length === 0 || busy) return;
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
      {modelReady ? (
        <button type="button" className="btn" onClick={generate} disabled={busy}>
          {busy ? '生成中…' : rec ? '重新生成' : '生成'}
        </button>
      ) : (
        onOpenSettings && (
          <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
            先去配置模型
          </button>
        )
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
          <MarkmapCanvas markdown={rec.code} />
        ) : (
          <MermaidCanvas code={rec.code} onRenderError={setRenderError} />
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

/** 层级 Markdown → markmap（可折叠 / 缩放 / 平移，markmap 原生） */
export function MarkmapCanvas({ markdown }: { markdown: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const mmRef = useRef<Markmap | null>(null);

  useEffect(
    () => () => {
      mmRef.current?.destroy();
      mmRef.current = null;
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
export function MermaidCanvas({ code, onRenderError }: { code: string; onRenderError?: (msg: string | null) => void }) {
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

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.min(4, Math.max(0.2, s * (e.deltaY < 0 ? 1.1 : 0.9))));
  };

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
        onWheel={onWheel}
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
