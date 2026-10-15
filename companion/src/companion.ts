/**
 * 视频学习副驾 · 本地知识库 companion（SPEC-16）。
 *
 * 零依赖本地 HTTP 服务：替代 Obsidian Local REST API 插件的运行时依赖——
 * 扩展通过同一套协议（Local REST API 子集）读写个人知识库：
 *   - GET  /vault/            → 根目录列表 { files: [...] }（测试连接）
 *   - GET  /vault/{path}      → 读文件
 *   - PUT  /vault/{path}      → 写文件（自动创建父目录）
 *   - Bearer <key> 鉴权；仅监听 127.0.0.1（不出本机）
 *
 * 数据目录默认 ~/vsc-knowledge（VSC_KNOWLEDGE_DIR 环境变量可覆盖），
 * 全部内容是 md / json 文件——Obsidian 用户可直接 Open folder as vault 接管。
 *
 * 分发：bun compile 打成单二进制（Windows/macOS），用户下载双击即运行。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_PORT = 28123;
export const DEFAULT_HOST = '127.0.0.1';
export const KEY_FILE = '.vsc-key';

/** 数据目录：环境变量优先，默认 ~/vsc-knowledge */
export function dataDir(): string {
  const fromEnv = process.env.VSC_KNOWLEDGE_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), 'vsc-knowledge');
}

/** 取（或首次生成）API Key：存在数据目录 .vsc-key；启动时打印供用户粘贴到扩展 */
export function ensureApiKey(dir: string): string {
  const keyPath = path.join(dir, KEY_FILE);
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* 首次启动：不存在或不可读 → 生成 */
  }
  const key = `vsc-${randomBytes(18).toString('hex')}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  return key;
}

/** 鉴权：Authorization: Bearer <key> 完全匹配 */
export function isAuthorized(req: http.IncomingMessage, key: string): boolean {
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${key}`;
}

/**
 * vault 路径安全解析：逐段 decodeURIComponent 后拒绝 `..`、空段与绝对段
 * （防目录穿越；与扩展 obsidianUrl 的"逐段编码"对称）。
 * 返回 null = 非法路径；'' = 根目录。
 */
export function safeVaultPath(rawPathAfterVault: string): string | null {
  const trimmed = rawPathAfterVault.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  const segments: string[] = [];
  for (const seg of trimmed.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (decoded.length === 0 || decoded === '.' || decoded === '..') return null;
    if (decoded.includes('\0') || decoded.includes('/') || decoded.includes('\\')) return null;
    segments.push(decoded);
  }
  return segments.join('/');
}

/** 根目录列表：Local REST API 兼容形状 { files: [...] }（只列一层，含目录） */
export function listRoot(dir: string): { files: string[] } {
  try {
    const names = fs.readdirSync(dir).filter((n) => n !== KEY_FILE);
    return { files: names.sort() };
  } catch {
    return { files: [] };
  }
}

export interface CompanionServer {
  server: http.Server;
  /** 测试用：本次实例实际使用的 key 与数据目录 */
  key: string;
  dir: string;
  port: number;
  close: () => Promise<void>;
}

/** 起服务（导出供测试注入端口/目录；二进制入口用 start() 默认值） */
export function createServer(opts: {
  port?: number;
  dir?: string;
  key?: string;
  host?: string;
}): CompanionServer {
  const dir = opts.dir ?? dataDir();
  const key = opts.key ?? ensureApiKey(dir);
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;

  const server = http.createServer((req, res) => {
    const send = (status: number, body: string, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    };
    const url = req.url ?? '/';
    const afterVault = url.startsWith('/vault') ? url.slice('/vault'.length) : null;
    if (afterVault === null || (url !== '/vault' && !url.startsWith('/vault/'))) {
      send(404, JSON.stringify({ error: 'not found（只提供 /vault/* 接口）' }));
      return;
    }
    if (!isAuthorized(req, key)) {
      send(401, JSON.stringify({ error: '鉴权失败：请在扩展设置粘贴 companion 启动时打印的 API Key' }));
      return;
    }
    const vaultPath = safeVaultPath(afterVault);
    if (vaultPath === null) {
      send(400, JSON.stringify({ error: '非法路径' }));
      return;
    }
    const abs = vaultPath.length === 0 ? dir : path.join(dir, ...vaultPath.split('/'));

    if (req.method === 'GET' && vaultPath.length === 0) {
      send(200, JSON.stringify(listRoot(dir)));
      return;
    }
    if (req.method === 'GET') {
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch {
        send(404, JSON.stringify({ error: `文件不存在：${vaultPath}` }));
        return;
      }
      send(200, content, vaultPath.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
      return;
    }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, Buffer.concat(chunks));
          send(200, JSON.stringify({ ok: true }));
        } catch (err) {
          send(500, JSON.stringify({ error: `写入失败：${err instanceof Error ? err.message : String(err)}` }));
        }
      });
      return;
    }
    send(405, JSON.stringify({ error: `不支持的请求方法：${req.method ?? '?'}` }));
  });

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

  return { server, key, dir, port, close };
}

/** 二进制入口：默认参数起服务并打印使用指引 */
export function start(): void {
  const dir = dataDir();
  const key = ensureApiKey(dir);
  const { server } = createServer({ dir, key });
  server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
    console.log('========================================');
    console.log(' 视频学习副驾 · 本地知识库服务已启动');
    console.log('----------------------------------------');
    console.log(` 数据目录：${dir}`);
    console.log('   （装了 Obsidian？直接「打开文件夹为仓库」即可浏览这些笔记）');
    console.log(` 接口地址：http://${DEFAULT_HOST}:${DEFAULT_PORT}`);
    console.log(' API Key（粘贴到扩展 设置 → 知识库同步）：');
    console.log(`   ${key}`);
    console.log('----------------------------------------');
    console.log(' 保持本窗口开启即可；关闭窗口 = 停止服务');
    console.log('========================================');
  });
  // 打包成二进制后进程随窗口关闭退出；直接 node 运行时 Ctrl+C 退出
  process.on('SIGINT', () => {
    server.close(() => process.exit(0));
  });
}

// bun/node 直跑入口（`if (import.meta.main)` bun 语义；node 下回退检查）
const isMain =
  typeof (import.meta as { main?: boolean }).main === 'boolean'
    ? (import.meta as { main?: boolean }).main === true
    : process.argv[1]?.endsWith('companion.ts') === true ||
      process.argv[1]?.endsWith('companion.js') === true ||
      process.argv[1]?.endsWith('companion') === true;
if (isMain) start();
