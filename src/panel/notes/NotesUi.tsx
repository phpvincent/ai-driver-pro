/**
 * 大纲笔记 UI（SPEC-09 9.3/9.4，二轮反馈改版）：
 * - 输入与展示走**弹窗**（居中大对话框，替代窄边栏内联小输入框）；
 *   列表里只留紧凑卡片（时间 + 粒度 + 单行摘要 + 展开入口）；
 * - NoteModal 三态：create（大输入框）/ edit（改正文）/ view（全文 + 讨论串
 *   + 回复框 + 请助教回答 + 编辑/删除）；
 * - 数据经 useNotes hook 注入，组件本身无 DB / 模型依赖（renderToString 可测）。
 */
import { useState } from 'react';
import type { NoteAnchor, OutlineNote, Section } from '../../types';
import type { NotesState } from './notesLoader';
import { formatTimestamp } from '../SubtitleTab';
import './notes.css';

/** 弹窗请求（OutlineTab 持有状态，三种锚点入口 / 卡片展开共用） */
export interface NoteEditorRequest {
  mode: 'create' | 'edit' | 'view';
  /** create 必带：锚点（整章 / 要点 / 时间点） */
  anchor?: NoteAnchor;
  /** edit / view 必带 */
  note?: OutlineNote;
  /** 弹窗标题里的锚点描述（如 `整章 · 图形推理` / `要点 · 先观察再推理` / `时间点 03:12`） */
  contextLabel: string;
}

/** 讨论串作者徽标 */
function authorBadge(author: OutlineNote['replies'][number]['author']): string {
  return author === 'assistant' ? '助教' : '我';
}

/** 锚点粒度文案 */
export function anchorKindLabel(kind: NoteAnchor['kind']): string {
  return kind === 'section' ? '整章' : kind === 'bullet' ? '要点' : '时间点';
}

/** 紧凑笔记卡：单行摘要 + 展开 / 删除（编辑与讨论串进弹窗） */
export function NoteThread({
  note,
  pending,
  onOpen,
  onRemove,
  onSeek,
}: {
  note: OutlineNote;
  /** 待确认（重生成归位后章节变化可疑）→ 黄点 */
  pending?: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onSeek?: (ms: number) => void;
}) {
  const preview = note.body.split('\n')[0] ?? '';
  return (
    <div className={`vnote${pending ? ' vnote-pending' : ''}`}>
      <div className="vnote-head">
        {pending && (
          <span className="vnote-pending-dot" title="重生成后章节变化可疑，请确认归位是否正确">
            ●
          </span>
        )}
        <button
          type="button"
          className="vnote-time"
          title={`跳到 ${formatTimestamp(note.anchor.tMs)}`}
          onClick={() => onSeek?.(note.anchor.tMs)}
        >
          [{formatTimestamp(note.anchor.tMs)}]
        </button>
        <span className="vnote-kind">{anchorKindLabel(note.anchor.kind)}</span>
        {note.importedFrom && (
          <span className="vnote-imported" title={`来自 ${note.importedFrom.exporter} 的导出`}>
            导入
          </span>
        )}
        {note.replies.length > 0 && (
          <span className="vnote-reply-count" title="讨论串回复数">
            💬{note.replies.length}
          </span>
        )}
        <span className="vnote-actions">
          <button type="button" className="vnote-act vnote-act-danger" title="删除笔记" onClick={onRemove}>
            ✕
          </button>
        </span>
      </div>
      <p className="vnote-body" title="点击展开笔记与讨论串" onClick={onOpen}>
        {preview}
      </p>
    </div>
  );
}

/**
 * 笔记弹窗（居中大对话框）：create/edit = 大输入框；view = 全文 + 讨论串
 * + 回复框 + 请助教回答。view 模式实时读 state.notes（助教回答追加后可见）。
 */
export function NoteModal({
  req,
  busyId,
  state,
  onSeek,
  onClose,
}: {
  req: NoteEditorRequest;
  busyId: string | null;
  state: NotesState;
  onSeek?: (ms: number) => void;
  onClose: () => void;
}) {
  const live = req.note ? (state.notes.find((n) => n.id === req.note!.id) ?? req.note) : null;
  const [text, setText] = useState(req.mode === 'edit' ? (req.note?.body ?? '') : '');
  const [replyText, setReplyText] = useState('');
  const title =
    req.mode === 'create' ? '新建笔记' : req.mode === 'edit' ? '编辑笔记' : '笔记与讨论串';
  const busy = live ? busyId === live.id : false;

  const submitCreate = () => {
    if (!req.anchor || !text.trim()) return;
    void state.addNote(req.anchor, text).then(onClose);
  };
  const submitEdit = () => {
    if (!live || !text.trim()) return;
    void state.updateBody(live, text).then(onClose);
  };

  return (
    <div className="vnote-overlay" onClick={onClose}>
      {/* 阻止冒泡：点遮罩关闭，点对话框不关 */}
      <div className="vnote-modal" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="vnote-modal-head">
          <span className="vnote-modal-title">{title}</span>
          <span className="vnote-modal-context">{req.contextLabel}</span>
          <button type="button" className="vnote-act" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        {(req.mode === 'create' || req.mode === 'edit') && (
          <div className="vnote-modal-body">
            <textarea
              className="vnote-textarea vnote-textarea-lg"
              rows={9}
              autoFocus
              placeholder="用 Markdown 记下你的理解、疑问或易错点…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="vnote-modal-btns">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!text.trim()}
                onClick={req.mode === 'create' ? submitCreate : submitEdit}
              >
                保存
              </button>
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
            </div>
          </div>
        )}

        {req.mode === 'view' && live && (
          <div className="vnote-modal-body">
            <div className="vnote-head">
              <button
                type="button"
                className="vnote-time"
                title={`跳到 ${formatTimestamp(live.anchor.tMs)}`}
                onClick={() => onSeek?.(live.anchor.tMs)}
              >
                [{formatTimestamp(live.anchor.tMs)}]
              </button>
              <span className="vnote-kind">{anchorKindLabel(live.anchor.kind)}</span>
              {live.importedFrom && (
                <span className="vnote-imported" title={`来自 ${live.importedFrom.exporter} 的导出`}>
                  导入
                </span>
              )}
              <span className="vnote-modal-btns-inline">
                <button type="button" className="vnote-act" onClick={() => setText(live.body) /* 进编辑态：切内容 + 模式重开 */}>
                  ✎
                </button>
                <button
                  type="button"
                  className="vnote-act vnote-act-danger"
                  title="删除笔记"
                  onClick={() => {
                    if (window.confirm('删除这条笔记？（含讨论串，不可恢复）')) {
                      void state.remove(live).then(onClose);
                    }
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
            {text ? (
              <div className="vnote-modal-body">
                <textarea
                  className="vnote-textarea vnote-textarea-lg"
                  rows={7}
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <div className="vnote-modal-btns">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!text.trim()}
                    onClick={() => void state.updateBody(live, text.trim()).then(() => setText(''))}
                  >
                    保存修改
                  </button>
                  <button type="button" className="btn" onClick={() => setText('')}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <p className="vnote-fullbody">{live.body}</p>
            )}
            {live.replies.length > 0 && (
              <ul className="vnote-replies">
                {live.replies.map((r) => (
                  <li key={r.id} className={`vnote-reply${r.author === 'assistant' ? ' is-assistant' : ''}`}>
                    <span className="vnote-reply-author">{authorBadge(r.author)}：</span>
                    <span className="vnote-reply-body">{r.body}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="vnote-modal-reply">
              <textarea
                className="vnote-textarea"
                rows={3}
                placeholder="回复这条笔记…"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
              />
              <div className="vnote-modal-btns">
                <button
                  type="button"
                  className="btn"
                  disabled={!replyText.trim()}
                  onClick={() => {
                    if (replyText.trim()) {
                      void state.reply(live, replyText.trim()).then(() => setReplyText(''));
                    }
                  }}
                >
                  发送回复
                </button>
                <button
                  type="button"
                  className="btn vnote-ask"
                  disabled={busy}
                  title="把笔记转成问答（区间 = 锚点所在章节），回答追加为助教回复"
                  onClick={() => void state.askAssistant(live)}
                >
                  {busy ? '助教回答中…' : '请助教回答'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** 某章节的笔记区块（OutlineTab 的 SectionCard 尾部渲染；新建走弹窗） */
export function SectionNotes({
  section,
  notes,
  pendingIds,
  state,
  onSeek,
  onOpenEditor,
}: {
  section: Section;
  notes: OutlineNote[];
  pendingIds: ReadonlySet<string> | null;
  state: NotesState;
  onSeek?: (ms: number) => void;
  onOpenEditor: (req: NoteEditorRequest) => void;
}) {
  return (
    <div className="vnote-section">
      <div className="vnote-section-head">
        <span className="vnote-section-count">{notes.length > 0 ? `${notes.length} 条笔记` : ''}</span>
        <button
          type="button"
          className="vnote-add-btn"
          title="对整章记一条笔记"
          onClick={() =>
            onOpenEditor({
              mode: 'create',
              anchor: { kind: 'section', sectionId: section.id, tMs: section.startMs },
              contextLabel: `整章 · ${section.title}`,
            })
          }
        >
          + 笔记
        </button>
      </div>
      {notes.map((n) => (
        <NoteThread
          key={n.id}
          note={n}
          pending={pendingIds?.has(n.id) ?? false}
          onOpen={() =>
            onOpenEditor({
              mode: 'view',
              note: n,
              contextLabel: `${anchorKindLabel(n.anchor.kind)} · ${formatTimestamp(n.anchor.tMs)}`,
            })
          }
          onRemove={() => {
            if (window.confirm('删除这条笔记？（含讨论串，不可恢复）')) void state.remove(n);
          }}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}

/** 未归位笔记区（重生成后对不上的笔记集中展示，不丢弃） */
export function UnanchoredNotes({
  notes,
  state,
  onSeek,
  onOpenEditor,
}: {
  notes: OutlineNote[];
  state: NotesState;
  onSeek?: (ms: number) => void;
  onOpenEditor: (req: NoteEditorRequest) => void;
}) {
  if (notes.length === 0) return null;
  return (
    <div className="vnote-unanchored">
      <p className="vnote-unanchored-title">未归位的笔记（{notes.length}）</p>
      <p className="vnote-unanchored-hint">
        这些笔记的时间点在当前大纲中找不到落点；重新生成大纲后会再次尝试归位，笔记永不删除。
      </p>
      {notes.map((n) => (
        <NoteThread
          key={n.id}
          note={n}
          onOpen={() =>
            onOpenEditor({
              mode: 'view',
              note: n,
              contextLabel: `${anchorKindLabel(n.anchor.kind)} · ${formatTimestamp(n.anchor.tMs)}`,
            })
          }
          onRemove={() => {
            if (window.confirm('删除这条笔记？（含讨论串，不可恢复）')) void state.remove(n);
          }}
          onSeek={onSeek}
        />
      ))}
    </div>
  );
}
