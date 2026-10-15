/**
 * manifest.json 快照测试 —— TECH-DESIGN §9 的可执行版本。
 * 期望值硬编码，manifest 与设计文档任何一方漂移都会在此失败。
 *
 * 注：读文件用 vite 原生 import.meta.glob(raw)（vitest 走 vite 转换管线）；
 * 工程未装 @types/node 且 tsconfig 不在本任务允许修改清单，node:fs 无法通过 tsc。
 */
import { describe, expect, it } from 'vitest';

const manifestFiles = import.meta.glob('../../manifest.json', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const manifest = JSON.parse(manifestFiles['../../manifest.json']) as Record<string, unknown>;

describe('manifest.json（TECH-DESIGN §9 可执行快照）', () => {
  it('基础字段', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('视频学习副驾');
    expect(manifest.version).toBe('0.1.0');
    expect(manifest.description).toBe('B 站视频学习副驾：带时间戳的字幕、大纲、导图与上下文问答');
  });

  it('permissions 与 §9 完全一致', () => {
    expect(manifest.permissions).toEqual(['storage', 'sidePanel', 'tabs']);
  });

  it('host_permissions 与 §9 一致（含已支持的模型端点域名）', () => {
    expect(manifest.host_permissions).toEqual([
      'https://www.bilibili.com/*',
      'https://api.bilibili.com/*',
      'https://*.hdslb.com/*',
      'https://api.deepseek.com/*',
      'http://127.0.0.1:27123/*',
      // 本地知识库 companion（SPEC-16）
      'http://127.0.0.1:28123/*',
      'https://maas.qianwenaiapi.com/*',
      // 内置公开资料检索（DuckDuckGo，免 Key）
      'https://api.duckduckgo.com/*',
    ]);
  });

  it('optional_host_permissions 支持任意 https/http（SPEC-08 8.3：自定义端点按 origin 动态申请）', () => {
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  it('content_scripts：仅 B 站视频页，IIFE 单文件，document_idle', () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['https://www.bilibili.com/video/*'],
        js: ['content.js'],
        run_at: 'document_idle',
      },
    ]);
  });

  it('background：ES module Service Worker（构建产物以 dist 为根，路径不带 dist/ 前缀）', () => {
    expect(manifest.background).toEqual({ service_worker: 'background.js', type: 'module' });
  });

  it('side_panel 与 action', () => {
    expect(manifest.side_panel).toEqual({ default_path: 'panel.html' });
    // SPEC-10：CWS 上架补 icons 与最低内核（sidePanel 需 114+）
    expect(manifest.icons).toEqual({
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    });
    expect(manifest.minimum_chrome_version).toBe('114');
    expect(manifest.action).toEqual({
      default_title: '打开视频学习副驾',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    });
  });
});
