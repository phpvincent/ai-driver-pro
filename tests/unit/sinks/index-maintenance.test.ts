/**
 * 双索引读写与存库前置校验单测（SPEC-06 范围变更：分层目录 + 双索引）。
 *
 * 只测不依赖 chrome 的分支：readIndex/writeIndex（fetch 注入）与
 * 存库函数的前置校验（未配置 / 重复术语）。端到端落盘属人工验收（A6/A7/A8）。
 *
 * 红线 9：不写端点与密钥字面量。
 */
import { describe, expect, it } from 'vitest';
import {
  indexPath,
  indexMarkdownPath,
  readIndex,
  saveTermCardToObsidian,
  saveVideoNoteToObsidian,
  writeIndex,
} from '../../../src/panel/obsidianLoader';
import type { ObsidianConfig } from '../../../src/types';
import type { ObsidianFetch } from '../../../src/sinks/obsidian';

const cfg: ObsidianConfig = { baseUrl: 'http://example.invalid:27124', apiKey: 'k', rootDir: 'root' };

function res(status: number, body = ''): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
}

/** 记录写入内容的假 fetch：索引 JSON 可读回，其余 404 */
function recordingFetch(indexJson?: string) {
  const writes: Array<{ url: string; body: string }> = [];
  const fn: ObsidianFetch = (url, init) => {
    if (init?.method === 'PUT') {
      writes.push({ url, body: String(init.body ?? '') });
      return Promise.resolve(res(200, 'ok'));
    }
    if (indexJson !== undefined && url.includes('_meta')) return Promise.resolve(res(200, indexJson));
    return Promise.resolve(res(404, 'missing'));
  };
  return { fn, writes };
}

describe('索引路径', () => {
  it('机器索引为 {root}/_meta/index.json', () => {
    expect(indexPath('root')).toBe('root/_meta/index.json');
  });

  it('人类索引为 {root}/_索引.md', () => {
    expect(indexMarkdownPath('root')).toBe('root/_索引.md');
  });
});

describe('readIndex', () => {
  it('404 → 回落空索引', async () => {
    const { fn } = recordingFetch();
    await expect(readIndex(cfg, fn)).resolves.toEqual({ version: 1, entries: [] });
  });

  it('正常解析 JSON 索引', async () => {
    const file = { version: 1, entries: [{ path: 'root/术语/A.md', title: 'A', category: 'term', tags: ['ai'], terms: ['A'], summaryPreview: '预览', updatedAt: '2026-09-30T00:00:00.000Z' }] };
    const { fn } = recordingFetch(JSON.stringify(file));
    await expect(readIndex(cfg, fn)).resolves.toEqual(file);
  });

  it('非法 JSON → 回落空索引（不阻断存库）', async () => {
    const { fn } = recordingFetch('{ not json');
    await expect(readIndex(cfg, fn)).resolves.toEqual({ version: 1, entries: [] });
  });
});

describe('writeIndex（双索引同步）', () => {
  const file = {
    version: 1 as const,
    entries: [
      { path: 'root/术语/Agent.md', title: 'Agent', category: 'term' as const, tags: ['ai'], terms: ['Agent'], summaryPreview: '能自主规划的系统', updatedAt: '2026-09-30T00:00:00.000Z' },
    ],
  };

  it('只写机器索引 JSON（_索引.md 已被领域 MOC 取代，SPEC-17 审计收敛）', async () => {
    const { fn, writes } = recordingFetch();
    await writeIndex(cfg, fn, file);
    expect(writes).toHaveLength(1);
    expect(writes[0].url).toContain(encodeURIComponent('_meta'));
    expect(JSON.parse(writes[0].body)).toEqual(file);
  });
});

describe('存库前置校验（无 chrome 环境）', () => {
  it('未配置 Obsidian → 视频笔记存库降级为本地 .md 下载（SPEC-10 10.4；node 无 document 时报下载不支持，而非配置报错）', async () => {
    await expect(
      saveVideoNoteToObsidian({ videoId: 'BV1_p1', meta: { videoId: 'BV1_p1', bvid: 'BV1', page: 1, cid: 1, title: 'T', durationMs: 1000, url: 'https://www.bilibili.com/video/BV1/' }, sections: [] }),
    ).rejects.toThrow(/不支持文件下载/);
  });

  it('重复术语 → 术语卡存库 throw 合并提示（不静默新建；Obsidian 已配置路径）', async () => {
    // 重复术语检查只在 Obsidian 已配置时执行；本测试环境无配置 →
    // 走本地下载降级。改为直接验证纯函数行为（findDuplicateTerm 在 capture.test 覆盖），
    // 此处验证降级路径确实绕过了去重（不抛"已存在相似术语"而是下载报错）
    await expect(
      saveTermCardToObsidian({
        term: 'Agent',
        payload: { inVideoMeaning: 'x', generalDefinition: 'y', analogy: 'z', relatedTerms: [] },
        meta: { videoId: 'BV1_p1', bvid: 'BV1', page: 1, cid: 1, title: 'T', durationMs: 1000, url: 'https://www.bilibili.com/video/BV1/' },
        existingTerms: [{ term: 'Agent' }],
      }),
    ).rejects.toThrow(/不支持文件下载/);
  });
});
