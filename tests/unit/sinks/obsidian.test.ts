/**
 * Obsidian sink 单测（SPEC-06 子任务 6.1，A3/A4）。
 *
 * 请求经 ObsidianFetch 注入：不依赖全局 fetch、不发真实网络请求。
 * 红线 9：本文件不写端点或密钥字面量，baseUrl 一律用构造出的假地址。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  getNote,
  obsidianUrl,
  putNote,
  testConnection,
  type ObsidianConfig,
  type ObsidianFetch,
} from '../../../src/sinks/obsidian';

/** 测试用假地址（非真实端点；红线 9） */
const BASE = 'http://example.invalid:27124';

const cfg = (over: Partial<ObsidianConfig> = {}): ObsidianConfig => ({
  baseUrl: BASE,
  apiKey: 'test-key',
  rootDir: '视频学习副驾',
  ...over,
});

/** 构造假 Response（状态码 + 可选 body 与 json 支持） */
function res(status: number, body = '', json?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => json,
  } as unknown as Response;
}

/** 记录调用并回放固定响应的假 fetch */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: ObsidianFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  };
  return { fn, calls };
}

describe('obsidianUrl（路径逐段编码）', () => {
  it('baseUrl 去尾斜杠后拼 /vault/', () => {
    expect(obsidianUrl(`${BASE}/`, 'a/b.md')).toBe(`${BASE}/vault/a/b.md`);
  });

  it('多段路径保留 / 分隔符', () => {
    expect(obsidianUrl(BASE, '视频笔记/BV1/标题.md')).toBe(
      `${BASE}/vault/${encodeURIComponent('视频笔记')}/${encodeURIComponent('BV1')}/${encodeURIComponent('标题.md')}`,
    );
  });

  it('中文与空格逐段编码', () => {
    const url = obsidianUrl(BASE, '术语/A B 概念.md');
    expect(url).toContain(encodeURIComponent('A B 概念.md'));
    expect(url).not.toContain(' ');
  });

  it('空路径 → 根目录（/vault/）', () => {
    expect(obsidianUrl(BASE, '')).toBe(`${BASE}/vault/`);
  });

  it('多余斜杠被忽略（不产生空段）', () => {
    expect(obsidianUrl(BASE, '/术语//A.md')).toBe(
      `${BASE}/vault/${encodeURIComponent('术语')}/${encodeURIComponent('A.md')}`,
    );
  });
});

describe('putNote（写入）', () => {
  it('PUT + Bearer 鉴权 + markdown 内容类型 + body 为笔记正文', async () => {
    const { fn, calls } = mockFetch(() => res(200, 'ok'));
    await putNote(cfg(), fn, '术语/A.md', '# A\n正文');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${BASE}/vault/${encodeURIComponent('术语')}/${encodeURIComponent('A.md')}`);
    expect(calls[0].init?.method).toBe('PUT');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
    expect(headers['Content-Type']).toContain('text/markdown');
    expect(calls[0].init?.body).toBe('# A\n正文');
  });

  it('204 视为成功（不抛错）', async () => {
    const { fn } = mockFetch(() => res(204, ''));
    await expect(putNote(cfg(), fn, 'a.md', 'x')).resolves.toBeUndefined();
  });

  it('401 → throw 且提示检查 API Key', async () => {
    const { fn } = mockFetch(() => res(401, 'unauthorized'));
    await expect(putNote(cfg(), fn, 'a.md', 'x')).rejects.toThrow(/401/);
    await expect(putNote(cfg(), fn, 'a.md', 'x')).rejects.toThrow(/API Key/);
  });

  it('500 → throw 且摘要含状态码', async () => {
    const { fn } = mockFetch(() => res(500, 'boom'));
    await expect(putNote(cfg(), fn, 'a.md', 'x')).rejects.toThrow(/500/);
  });

  it('404 → throw 且提示检查根目录', async () => {
    const { fn } = mockFetch(() => res(404, 'not found'));
    await expect(putNote(cfg(), fn, 'a.md', 'x')).rejects.toThrow(/根目录/);
  });

  it('连接拒绝 → throw 且提示确认 Obsidian 已启动并开启 HTTP 模式', async () => {
    const fn: ObsidianFetch = () => Promise.reject(new Error('fetch failed'));
    await expect(putNote(cfg(), fn, 'a.md', 'x')).rejects.toThrow(/无法连接知识库/);
    await expect(putNote(cfg(), fn, 'a.md', 'x')).rejects.toThrow(/HTTP 模式/);
  });

  it('错误摘要截断长响应正文（不吞整页 HTML）', async () => {
    const { fn } = mockFetch(() => res(500, 'x'.repeat(500)));
    await expect(putNote(cfg(), fn, 'a.md', 'x')).rejects.toThrow(/…/);
  });
});

describe('getNote（读取）', () => {
  it('GET 并返回正文文本', async () => {
    const { fn, calls } = mockFetch(() => res(200, '{"version":1,"entries":[]}'));
    await expect(getNote(cfg(), fn, '视频学习副驾/_meta/index.json')).resolves.toBe(
      '{"version":1,"entries":[]}',
    );
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].url).toContain(encodeURIComponent('_meta'));
  });

  it('404 → throw（调用方决定是否降级）', async () => {
    const { fn } = mockFetch(() => res(404, 'missing'));
    await expect(getNote(cfg(), fn, '_meta/index.json')).rejects.toThrow(/404/);
  });

  it('连接拒绝 → throw 且带操作指引', async () => {
    const fn: ObsidianFetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(getNote(cfg(), fn, 'a.md')).rejects.toThrow(/已启动/);
  });
});

describe('testConnection（连通性自检）', () => {
  it('成功：返回根目录条目列表', async () => {
    const { fn, calls } = mockFetch(() => res(200, '', { files: ['视频笔记', '术语'] }));
    await expect(testConnection(cfg(), fn)).resolves.toEqual({
      ok: true,
      rootEntries: ['视频笔记', '术语'],
    });
    expect(calls[0].url).toBe(`${BASE}/vault/`);
  });

  it('files 字段缺失 → rootEntries 为空数组（仍判定连通）', async () => {
    const { fn } = mockFetch(() => res(200, '', {}));
    await expect(testConnection(cfg(), fn)).resolves.toEqual({ ok: true, rootEntries: [] });
  });

  it('401 → throw（引导检查 API Key）', async () => {
    const { fn } = mockFetch(() => res(401, 'nope'));
    await expect(testConnection(cfg(), fn)).rejects.toThrow(/API Key/);
  });

  it('连接拒绝 → throw（引导确认已启动 + HTTP 模式）', async () => {
    const fn: ObsidianFetch = vi.fn(() => Promise.reject(new Error('Failed to fetch')));
    await expect(testConnection(cfg(), fn)).rejects.toThrow(/HTTP 模式/);
  });

  it('证书失败（网络层异常）→ 归入无法连接分支', async () => {
    const fn: ObsidianFetch = () => Promise.reject(new Error('certificate has expired'));
    await expect(testConnection(cfg(), fn)).rejects.toThrow(/无法连接知识库/);
  });
});
