/**
 * 侧边栏 React 挂载入口（React 18 createRoot）。
 *
 * 首行必须是 zodEnv：它在 zod 被任何 schema 模块使用前关闭 JIT，
 * 否则 zod 会用 `new Function` 探测 eval，触发扩展页的 CSP 报错。
 */
import '../core/zodEnv';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}
