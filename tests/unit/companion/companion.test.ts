/**
 * SPEC-16 单测：companion HTTP 行为——与扩展 obsidian sink 协议兼容。
 * 真实起服务（随机端口 + 临时目录），逐分支覆盖。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, safeVaultPath, type CompanionServer } from '../../../companion/src/companion';

let svc: CompanionServer;
let base: string;
let auth: Record<string, string>;

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-companion-'));
  svc = createServer({ port: 0, dir, key: 'test-key-1234567890' });
  await new Promise<void>((resolve) => svc.server.listen(0, '127.0.0.1', resolve));
  const addr = svc.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  auth = { Authorization: 'Bearer test-key-1234567890', 'Content-Type': 'text/markdown;charset=utf-8' };
});

afterEach(async () => {
  await svc.close();
  fs.rmSync(svc.dir, { recursive: true, force: true });
});

describe('safeVaultPath（路径安全，防目录穿越）', () => {
  it('根目录 / 尾斜杠 → 空串；正常路径逐段解码', () => {
    expect(safeVaultPath('/')).toBe('');
    expect(safeVaultPath('///')).toBe('');
    expect(safeVaultPath('/视频笔记/BV1xx/test.md')).toBe('视频笔记/BV1xx/test.md');
  });
  it('.. / 空段 / 反斜杠 / 非法编码 → null', () => {
    expect(safeVaultPath('/../etc/passwd')).toBeNull();
    expect(safeVaultPath('/a/../../b')).toBeNull();
    expect(safeVaultPath('/a//b')).toBeNull();
    expect(safeVaultPath('/a\\b')).toBeNull();
    expect(safeVaultPath('/%zz-bad')).toBeNull();
  });
});

describe('companion HTTP（Local REST API 子集）', () => {
  it('PUT 写入（自动建父目录）→ GET 读回内容一致', async () => {
    const put = await fetch(`${base}/vault/${encodeURIComponent('视频笔记')}/${encodeURIComponent('BV1.md')}`, {
      method: 'PUT',
      headers: auth,
      body: '# 标题\n正文',
    });
    expect(put.status).toBe(200);
    const got = await fetch(`${base}/vault/${encodeURIComponent('视频笔记')}/${encodeURIComponent('BV1.md')}`, {
      headers: { Authorization: auth.Authorization },
    });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('# 标题\n正文');
    // 落盘验证：md 文件在数据目录
    const onDisk = fs.readFileSync(path.join(svc.dir, '视频笔记', 'BV1.md'), 'utf8');
    expect(onDisk).toBe('# 标题\n正文');
  });

  it('GET /vault/ → { files: [...] }（测试连接的兼容形状）', async () => {
    await fetch(`${base}/vault/${encodeURIComponent('术语')}/${encodeURIComponent('类比推理.md')}`, {
      method: 'PUT',
      headers: auth,
      body: '术语卡',
    });
    const res = await fetch(`${base}/vault/`, { headers: { Authorization: auth.Authorization } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { files: string[] };
    expect(data.files).toContain('术语');
    expect(data.files).not.toContain('.vsc-key');
  });

  it('鉴权失败 → 401；未带 Key 一律拒绝', async () => {
    const res = await fetch(`${base}/vault/`);
    expect(res.status).toBe(401);
  });

  it('GET 不存在的文件 → 404 带路径', async () => {
    const res = await fetch(`${base}/vault/${encodeURIComponent('不存在.md')}`, {
      headers: { Authorization: auth.Authorization },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('不存在.md');
  });

  it('目录穿越 → 400（即使通过 URL 编码）', async () => {
    const res = await fetch(`${base}/vault/%2e%2e%2fsecret`, {
      headers: { Authorization: auth.Authorization },
    });
    expect(res.status).toBe(400);
  });

  it('非 /vault 路径 → 404；不支持的动词 → 405', async () => {
    expect((await fetch(`${base}/`, { headers: { Authorization: auth.Authorization } })).status).toBe(404);
    expect(
      (await fetch(`${base}/vault/${encodeURIComponent('a.md')}`, {
        method: 'DELETE',
        headers: { Authorization: auth.Authorization },
      })).status,
    ).toBe(405);
  });
});
