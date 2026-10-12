/**
 * 文本附件 + 角色重判用户补充（2026-10-12）单测。
 */
import { describe, expect, it } from 'vitest';
import {
  isTextUpload,
  textUploadNote,
  validateTextUpload,
  TEXT_UPLOAD_MAX_BYTES,
} from '../../../src/panel/uploadText';
import { buildPersonaPrompt } from '../../../src/core/pipeline/persona';
import type { Section } from '../../../src/types';

describe('isTextUpload（文本附件判定）', () => {
  it('扩展名与 text/* mime 均命中', () => {
    expect(isTextUpload({ type: '', name: 'main.py' })).toBe(true);
    expect(isTextUpload({ type: 'text/plain', name: 'a.txt' })).toBe(true);
    expect(isTextUpload({ type: '', name: 'notes.MD' })).toBe(true); // 大小写不敏感
  });
  it('图片与未知扩展不命中', () => {
    expect(isTextUpload({ type: 'image/png', name: 'a.png' })).toBe(false);
    expect(isTextUpload({ type: '', name: 'a.exe' })).toBe(false);
  });
});

describe('validateTextUpload（大小与数量上限）', () => {
  it('超 512KB 拒绝；数量超 3 拒绝', () => {
    expect(validateTextUpload({ size: TEXT_UPLOAD_MAX_BYTES + 1, name: 'a' }, 0)).toContain('文件过大');
    expect(validateTextUpload({ size: 100, name: 'a' }, 3)).toContain('最多附带 3 个');
    expect(validateTextUpload({ size: 100, name: 'a' }, 2)).toBeNull();
  });
});

describe('textUploadNote（参考资料素材分区）', () => {
  it('空列表空串；有文件时带分隔标记与文件名', () => {
    expect(textUploadNote([])).toBe('');
    const note = textUploadNote([{ name: 'a.py', text: 'print(1)' }]);
    expect(note).toContain('学生上传的参考资料');
    expect(note).toContain('【文件 a.py】');
    expect(note).toContain('print(1)');
    expect(note).toContain('参考资料结束');
  });
});

describe('buildPersonaPrompt userHint（重判角色用户补充）', () => {
  const sections: Section[] = [
    {
      id: 's1', startMs: 0, endMs: 1000, title: 'T', summary: '', density: 'mid',
      bullets: [], terms: [], score: 50, importance: 3, cueRange: [0, 1000],
    },
  ];
  it('不传 hint 行为不变；传入时进入 prompt 且声明用户意图优先', () => {
    const base = buildPersonaPrompt({ title: 't', sections, cueHead: [] });
    expect(base.userPrompt).not.toContain('用户补充的角色期望');
    const withHint = buildPersonaPrompt({
      title: 't', sections, cueHead: [], userHint: '以考研数学老师身份，重讲题套路',
    });
    expect(withHint.userPrompt).toContain('用户指定的角色期望');
    expect(withHint.userPrompt).toContain('考研数学老师');
    expect(withHint.userPrompt).toContain('以此为主');
  });
  it('超长 hint 截断到 500 字', () => {
    const withHint = buildPersonaPrompt({
      title: 't', sections, cueHead: [], userHint: '长'.repeat(600),
    });
    expect(withHint.userPrompt).not.toContain('长'.repeat(501));
  });
});
