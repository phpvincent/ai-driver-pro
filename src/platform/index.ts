/**
 * 浏览器平台适配层（宪法红线 11，SPEC-08 8.3 首次落地）。
 *
 * 规则：**新增**的浏览器平台调用（chrome.* 中除 runtime 消息与 storage 以外的能力）
 * 只允许出现在本目录；业务代码通过这里的函数调用。每个能力对"不存在"都必须有
 * 降级路径（返回 false / null，绝不抛错白屏）。
 *
 * 存量调用（sidePanel / tabs / action）按红线 11 第 ④ 条"触碰对应文件时顺带迁移"，
 * 不做一次性大搬迁。
 */

/**
 * 判断 origin 是否已在 host 权限中（含 optional）。
 * permissions API 不可用（老内核 / 无该权限）时返回 null——调用方按"未知"处理。
 */
export async function hasHostPermission(origin: string): Promise<boolean | null> {
  const perms = (globalThis as { chrome?: { permissions?: ChromePermissionsLike } }).chrome?.permissions;
  if (!perms?.contains) return null;
  try {
    return await perms.contains({ origins: [origin] });
  } catch {
    return null;
  }
}

/**
 * 确保某 origin 可访问：已授权 → granted；未授权 → 弹出申请，由用户决定。
 * - 申请精确到单个 origin（如 https://api.example.com ），不预授权全站通配；
 * - permissions API 不可用 → 'unsupported'（调用方提示无法申请，配置仍可保存，
 *   只是发请求可能被 CORS 拦截——与旧行为一致，不阻断）；
 * - 用户拒绝 → 'denied'。
 */
export async function ensureHostPermission(
  origin: string,
): Promise<'granted' | 'denied' | 'unsupported' | 'invalid'> {
  if (!isValidOrigin(origin)) return 'invalid';
  const perms = (globalThis as { chrome?: { permissions?: ChromePermissionsLike } }).chrome?.permissions;
  if (!perms?.request) return 'unsupported';
  // **先 request**：permissions.request 必须在用户手势上下文的第一个 await 处调用。
  // 之前先 await contains 再 request，手势已失效 → Chrome 静默拒绝、不弹窗（冒烟 8 的根因）。
  // 对已授权的 origin，request 会直接 resolve true，不会重复弹窗。
  try {
    const ok = await perms.request({ origins: [origin] });
    return ok ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}

/** baseUrl → origin（含尾斜杠通配前的协议+域名+端口）；非法返回 null */
export function originOfBaseUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function isValidOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin;
  } catch {
    return false;
  }
}

/** permissions API 的最小形状（避免依赖 dom 类型） */
interface ChromePermissionsLike {
  contains?: (p: { origins: string[] }) => Promise<boolean>;
  request?: (p: { origins: string[] }) => Promise<boolean>;
}
