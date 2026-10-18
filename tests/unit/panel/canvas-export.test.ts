/**
 * 画布多格式导出（SPEC-17 配套）：SVG 规范化 / PDF 字节结构校验。
 * 栅格化（canvas）依赖真实浏览器环境，不在 jsdom 单测覆盖——由真机冒烟兜底。
 */
import { describe, expect, it } from 'vitest';
import {
  ensureStandaloneSvg,
  jpegBytesToPdf,
  svgIntrinsicSize,
} from '../../../src/panel/canvasExport';

describe('ensureStandaloneSvg（独立打开兜底）', () => {
  it('补 xmlns 与显式尺寸（viewBox 推导）', () => {
    const out = ensureStandaloneSvg('<svg viewBox="0 0 640 480"><g/></svg>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).toMatch(/width="640"/);
    expect(out).toMatch(/height="480"/);
  });

  it('已有 xmlns/width/height 不重复补；缺 viewBox 回落默认尺寸', () => {
    const out = ensureStandaloneSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><g/></svg>',
    );
    expect((out.match(/xmlns=/g) ?? []).length).toBe(1);
    expect(out).toContain('width="800"');
    const fallback = ensureStandaloneSvg('<svg><g/></svg>');
    expect(fallback).toContain('width="1200"');
    expect(fallback).toContain('height="800"');
  });

  it('svgIntrinsicSize 读取显式尺寸', () => {
    expect(svgIntrinsicSize(ensureStandaloneSvg('<svg viewBox="0 0 300 200"/>'))).toEqual({
      width: 300,
      height: 200,
    });
  });
});

describe('jpegBytesToPdf（零依赖 PDF 封装）', () => {
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 0xff, 0xd9]);

  it('PDF 结构合法：头 / DCTDecode / xref 偏移可回指', async () => {
    const blob = jpegBytesToPdf(fakeJpeg, 1200, 800);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Filter /DCTDecode');
    expect(text).toContain('/Width 1200 /Height 800');
    expect(text.endsWith('%%EOF')).toBe(true);
    // startxref 回指的偏移处必须正好是 xref 表
    const xrefPos = Number(text.match(/startxref\n(\d+)\n/)?.[1] ?? -1);
    expect(xrefPos).toBeGreaterThan(0);
    expect(text.slice(xrefPos, xrefPos + 4)).toBe('xref');
    // xref 首条目指向 1 0 obj 的真实位置
    const firstObjOffset = Number(text.match(/\n(\d{10}) 00000 n \n/)?.[1] ?? -1);
    expect(text.slice(firstObjOffset, firstObjOffset + 6)).toBe('1 0 ob');
    // JPEG 字节流原样嵌入（流内容与源一致）
    const streamStart = text.indexOf('stream\n') + 'stream\n'.length;
    expect(Array.from(bytes.slice(streamStart, streamStart + fakeJpeg.length))).toEqual([
      ...fakeJpeg,
    ]);
  });
});
