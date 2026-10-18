/**
 * 临时诊断脚本（跑完即删）：本地复现扩展的两条画布导出管线，
 * 找出 ①流程图 SVG XML 非法的具体字符 ②思维导图横向压缩的尺寸来源。
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
// 挂全局（mermaid/markmap 需要）
for (const k of ['window', 'document', 'navigator', 'getComputedStyle', 'DOMParser', 'XMLSerializer', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'CSSStyleSheet', 'StyleSheet', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  try {
    // @ts-expect-error 诊断脚本
    Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
  } catch {
    /* 只读属性跳过 */
  }
}

// DOMParser 'image/svg+xml' 解析 + 错误定位
function xmlCheck(svg: string): { ok: boolean; detail: string } {
  const doc = new dom.window.DOMParser().parseFromString(svg, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (!err) return { ok: true, detail: '' };
  const text = err.textContent ?? '';
  const lineM = text.match(/line[: ]+(\d+)/i);
  const colM = text.match(/column[: ]+(\d+)/i);
  let detail = text.slice(0, 200);
  if (lineM) {
    const lines = svg.split('\n');
    const ln = Number(lineM[1]);
    const snippet = lines[ln - 1] ?? '';
    const col = colM ? Number(colM[1]) : 0;
    detail += `\n>>> 行${ln} 列${col} 附近：${snippet.slice(Math.max(0, col - 60), col + 60)}`;
    // 找出该行的可疑实体/字符
    const entities = snippet.match(/&[a-zA-Z]+;/g);
    if (entities) detail += `\n>>> 该行命名实体：${[...new Set(entities)].join(' ')}`;
  }
  return { ok: false, detail };
}

// mermaid 布局依赖的 SVG 几何 API（jsdom 无布局引擎 → 打桩）
dom.window.SVGElement.prototype.getBBox = function () {
  return { x: 0, y: 0, width: 120, height: 24 };
};
dom.window.SVGElement.prototype.getCTM = function () {
  return dom.window.SVGElement.prototype.getScreenCTM();
};
dom.window.SVGElement.prototype.getScreenCTM = function () {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse: () => this };
};
dom.window.HTMLElement.prototype.scrollIntoView = function () {};
dom.window.Element.prototype.scrollIntoView = function () {};
dom.window.SVGElement.prototype.getComputedTextLength = function () {
  return (this.textContent ?? '').length * 7;
};
for (const ctor of ['SVGTextContentElement', 'SVGTextElement', 'SVGGraphicsElement']) {
  const C = (dom.window as unknown as Record<string, undefined | { prototype: Record<string, unknown> }>)[ctor];
  if (!C) continue;
  C.prototype.getComputedTextLength = function () {
    return (this.textContent ?? '').length * 7;
  };
  C.prototype.getNumberOfChars = function () {
    return (this.textContent ?? '').length;
  };
  C.prototype.getSubStringLength = function () {
    return (this.textContent ?? '').length * 7;
  };
  C.prototype.getBBox = dom.window.SVGElement.prototype.getBBox;
}

async function main(): Promise<void> {
  // ---------- ① 流程图（mermaid 11.17.2，与 MermaidCanvas 同配置） ----------
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
    flowchart: { curve: 'basis', htmlLabels: false, padding: 12 },
  });
  // 模拟模型输出（洗碗机主题 + 常见特殊字符 & 引号 括号）
  const flowCode = `flowchart TD
    A(["选购流程开始"]) --> B{"预算是否明确"}
    B -->|"是，2000-7000元"| C["核心指标：洗净比&容量"]
    B -->|"否，先看需求"| D["按人数定容量：4-13套"]
    C --> E["能效等级：一级优先"]
    D --> E
    E --> F(["结论：一线品牌 15套一级能效"])`;
  const { svg: flowSvg } = await mermaid.render('diag-flow', flowCode);
  console.log('=== ① 流程图 SVG 头部 ===');
  console.log(flowSvg.slice(0, 240));
  const xml1 = xmlCheck(flowSvg);
  console.log('原始渲染 → XML:', xml1.ok ? '合法' : `非法！${xml1.detail}`);

  // 模拟扩展管线：innerHTML 注入 → 存活元素 → inlineSvgStyles 等价（XMLSerializer）
  dom.window.document.body.innerHTML = flowSvg;
  const live = dom.window.document.querySelector('svg');
  if (live) live.setAttribute('width', '2000'), live.setAttribute('height', '3200');
  const serialized = new dom.window.XMLSerializer().serializeToString(live!);
  const xml2 = xmlCheck(serialized);
  console.log('存活元素序列化 → XML:', xml2.ok ? '合法' : `非法！${xml2.detail}`);

  // ---------- ② 思维导图（markmap）尺寸机制 ----------
  const { Transformer } = await import('markmap-lib');
  const { Markmap } = await import('markmap-view');
  const md = '# 洗碗机选购\n## 预算分段\n### 2000-3000\n### 3000-5000\n## 核心参数\n### 洗净比\n### 容量套数';
  const container = dom.window.document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 546 });
  Object.defineProperty(container, 'clientHeight', { value: 921 });
  dom.window.document.body.appendChild(container);
  const svgEl = dom.window.document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  container.appendChild(svgEl);
  const { root } = new Transformer().transform(md);
  const mm = Markmap.create(svgEl, { initialExpandLevel: -1, maxWidth: 260, spacingVertical: 8, spacingHorizontal: 80, duration: 0 }, root);
  mm.fit();
  await new Promise((r) => setTimeout(r, 400));
  console.log('\n=== ② 思维导图 SVG 尺寸机制 ===');
  console.log('width attr:', svgEl.getAttribute('width'), '| height attr:', svgEl.getAttribute('height'));
  console.log('viewBox:', svgEl.getAttribute('viewBox'));
  console.log('style:', (svgEl.getAttribute('style') ?? '').slice(0, 120));
  const g = svgEl.querySelector('g');
  console.log('根 g transform:', g?.getAttribute('transform') ?? '(无)');
  const serialized2 = new dom.window.XMLSerializer().serializeToString(svgEl);
  console.log('序列化长度:', serialized2.length);
  console.log('含 foreignObject:', serialized2.includes('<foreignObject'));
}

main().catch((e) => {
  console.error('诊断失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
