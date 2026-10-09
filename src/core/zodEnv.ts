/**
 * zod 运行环境初始化（MV3 扩展页 CSP 适配）。
 *
 * 背景：zod v4 的对象 schema（`$ZodObject`）在**实例化时**会读取
 * `util.allowsEval.value` 来决定是否启用 JIT 快路径；该探测的实现是
 * `new Function("")`（见 node_modules/zod/v4/core/util.js）。
 * MV3 扩展页的 CSP 为 `script-src 'self'`，禁止 eval / new Function，
 * 浏览器因此打印：
 *   "Content Security Policy of your site blocks the use of `eval` in JavaScript"
 * zod 内部 try/catch 吞掉该异常并回退到非 JIT 解析，**功能完全不受影响，只是控制台噪音**。
 *
 * 修复：置 `jitless = true`。两重保险——
 *   ① `jit = !globalConfig.jitless` 为 false 时，`jit && allowsEval.value` 短路，探测不执行；
 *   ② 即便被访问，`allowsEval()` 自身也会因 `globalConfig.jitless` 直接返回 false，不碰 eval。
 *
 * 时序要求：schema 在模块顶层就已实例化（如 `pipeline/types.ts` 的 OutlineChunkSchema），
 * 因此本模块必须**先于任何 zod schema 模块求值**——由 `panel/main.tsx` 的首行 import 保证。
 */
import * as z from 'zod';

/** zod 把全局配置挂在 `globalThis.__zod_globalConfig` 上；先预置再走官方 API，双写确保生效 */
const globalRef = globalThis as typeof globalThis & {
  __zod_globalConfig?: Record<string, unknown>;
};
globalRef.__zod_globalConfig = { ...(globalRef.__zod_globalConfig ?? {}), jitless: true };
z.config({ jitless: true });
