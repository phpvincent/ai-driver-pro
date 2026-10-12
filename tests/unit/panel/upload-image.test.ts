import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import {
  UPLOAD_MAX_IMAGES,
  UPLOAD_MAX_SIDE,
  attachmentLabel,
  compressImageFile,
  fitSize,
  uploadCaption,
  uploadQuestionNote,
  validateUploadFile,
} from '../../../src/panel/uploadImage';
import { ChatTab, digestSegmentAnswer } from '../../../src/panel/ChatTab';

describe('validateUploadFile', () => {
  it('合法图片通过', () => {
    expect(validateUploadFile({ type: 'image/png', size: 1000 }, 0)).toBeNull();
  });
  it('数量 / 格式 / 大小超限给出明确原因', () => {
    expect(validateUploadFile({ type: 'image/png', size: 1 }, UPLOAD_MAX_IMAGES)).toContain('最多');
    expect(validateUploadFile({ type: 'application/pdf', size: 1, name: 'a.pdf' }, 0)).toContain('不支持');
    expect(validateUploadFile({ type: 'image/jpeg', size: 20 * 1024 * 1024 }, 0)).toContain('过大');
  });
});

describe('fitSize：等比缩放到最长边 1280，不放大', () => {
  it('大图缩小', () => {
    expect(fitSize(4000, 3000)).toEqual({ width: UPLOAD_MAX_SIDE, height: 960 });
    expect(fitSize(1000, 4000)).toEqual({ width: 320, height: UPLOAD_MAX_SIDE });
  });
  it('小图保持原样；非法尺寸兜底', () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(0, Number.NaN)).toEqual({ width: 1, height: 1 });
  });
});

describe('提示文本', () => {
  it('uploadCaption 与课程画面区分（不是课程画面）', () => {
    const c = uploadCaption(0, 2, '题目.png');
    expect(c).toContain('学生上传的图片 1/2');
    expect(c).toContain('「题目.png」');
    expect(c).toContain('不是课程画面');
  });
  it('uploadQuestionNote：先复述题意、结合课程方法、看不清要指出', () => {
    expect(uploadQuestionNote(0)).toBe('');
    const n = uploadQuestionNote(2);
    expect(n).toContain('2 张图片');
    expect(n).toContain('复述题意');
    expect(n).toContain('不要臆测');
    expect(n).toContain('coveredByVideo');
  });
  it('attachmentLabel', () => {
    expect(attachmentLabel(0)).toBe('');
    expect(attachmentLabel(3)).toContain('3 张');
  });
});

describe('compressImageFile（注入解码）', () => {
  it('缩放后编码为 JPEG base64', async () => {
    const seen: Array<[number, number]> = [];
    const img = await compressImageFile({ name: 'q.png' } as File, 'id1', async () => ({
      width: 2560,
      height: 1440,
      draw: (w, h) => {
        seen.push([w, h]);
        return 'data:image/jpeg;base64,QUJD';
      },
    }));
    expect(seen).toEqual([[1280, 720]]);
    expect(img).toMatchObject({ id: 'id1', name: 'q.png', dataBase64: 'QUJD', mime: 'image/jpeg', width: 1280 });
  });
  it('编码失败 → throw', async () => {
    await expect(
      compressImageFile({ name: 'x' } as File, 'id', async () => ({ width: 1, height: 1, draw: () => '' })),
    ).rejects.toThrow('编码失败');
  });
});

describe('ChatTab 上传入口渲染', () => {
  it('模型支持多模态：显示图片按钮与粘贴提示', () => {
    const html = renderToString(createElement(ChatTab, { videoId: 'BV1', modelReady: true, visionReady: true, explain: async () => ({}) as never }));
    expect(html).toContain('chat-upload-btn');
    expect(html).toContain('附件');
    expect(html).toContain('可粘贴截图或拖入代码文件');
  });
  it('不支持多模态：按钮仍在但提示需切换模型', () => {
    const html = renderToString(createElement(ChatTab, { videoId: 'BV1', modelReady: true, visionReady: false, explain: async () => ({}) as never }));
    // 文本附件任何模型可用：按钮无多模态门槛；图片不支持在添加时提示
    expect(html).toContain('附件');
    expect(html).toContain('可拖入代码 / 笔记文件');
  });
});


describe('digestSegmentAnswer（多轮记忆摘要）', () => {
  it('取前 3 条要点、每条截 40 字、以；连接', () => {
    expect(digestSegmentAnswer({ keyPoints: ['a', 'b', 'c', 'd'] })).toBe('a；b；c');
    expect(digestSegmentAnswer({ keyPoints: ['x'.repeat(60)] })).toHaveLength(40);
  });
  it('无要点时回落正文前 80 字（压缩空白）', () => {
    expect(digestSegmentAnswer({ answer: '  第一步  做 X。\n第二步 做 Y。' })).toBe('第一步 做 X。 第二步 做 Y。');
    expect(digestSegmentAnswer({ answer: '长'.repeat(200) })).toHaveLength(80);
  });
});
