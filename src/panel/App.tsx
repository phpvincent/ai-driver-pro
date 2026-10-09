/**
 * 侧边栏根组件：顶部视频信息栏 + 四 Tab（字幕 / 大纲 / 导图 / 问答）+ 设置入口。
 * 消息接线：挂载时发 CURRENT_VIDEO_GET；监听 VIDEO_CHANGED / PLAYBACK_CHANGED 更新状态。
 */
import { useEffect, useRef, useState } from 'react';
import { MSG, type PlaybackPayload, type RuntimeMessage, type VideoInfoPayload } from '../messages';
import type { FetchResult, ModelConfig, VideoMeta } from '../types';
import { ChatTab } from './ChatTab';
import { listQaByVideo } from '../storage/db';
import { MindmapTab } from './MindmapTab';
import { HelpOverlay } from './HelpOverlay';
import { OutlineTab } from './OutlineTab';
import { generateOutline, loadOutlineCached, regenerateOne } from './outlineLoader';
import { SettingsPage } from './settings/SettingsPage';
import { SubtitleTab } from './SubtitleTab';
import { currentVideoIdRef, currentVideoMetaRef, explain as explainFn } from './explainLoader';
import { getLastFramePlan } from './framesClient';
import { saveTermCardToObsidian, saveVideoNoteToObsidian } from './obsidianLoader';
import { applySubjective, applyUsageEvent, createEmptyUsage, type UsageRecord } from '../core/metrics/usage';
import { createSubtitleDb, getSubtitle, getUsage, saveUsage, listAllUsage } from '../storage/db';
import { loadLlmLogs } from './llmLogStore';
import { DB } from '../config';
import { ValidationReportView } from './ValidationReportView';
import { LlmLogView } from './LlmLogView';
import { wireLlmLogPersistence } from './llmLogStore';
import { generatePersona, getPersonaCached } from './personaLoader';
import type { Persona } from '../types';
import {
  describeConceptMapFailure,
  generateConceptMap as genConceptMap,
  getConceptMapCached,
  termIndexFallback,
} from './mindmapLoader';
import type { ConceptMapData, QaRecord } from '../types';
import type { Section } from '../types';
import {
  loadSubtitles as runWaterfall,
  loadSubtitlesManual,
  punctuateSubtitles,
  restoreRawSubtitles,
} from './subtitleLoader';
import { generateConceptFlows } from './mindmapLoader';
import type { ConceptFlow, Cue } from '../types';

type TabKey = 'subtitle' | 'outline' | 'mindmap' | 'chat';

/** 全屏模式：panel.html?view=xxx 单视图渲染（无 Tab 栏） */
function parseStandaloneView(): TabKey | null {
  try {
    const v = new URLSearchParams(window.location.search).get('view');
    return (STANDALONE_VIEWS as readonly string[]).includes(v ?? '') ? (v as TabKey) : null;
  } catch {
    return null;
  }
}

const STANDALONE_VIEWS: readonly TabKey[] = ['subtitle', 'outline', 'mindmap', 'chat'];

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'subtitle', label: '字幕' },
  { key: 'outline', label: '大纲' },
  { key: 'mindmap', label: '导图' },
  { key: 'chat', label: '问答' },
];

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}



/** 问答 Tab 历史恢复（切换 Tab / 重开面板不丢内容） */
async function loadChatHistory(videoId: string): Promise<QaRecord[]> {
  try {
    return await listQaByVideo(db, videoId);
  } catch {
    return [];
  }
}

/** 面板共享 DB 实例（埋点与问答记录读取） */
const db = createSubtitleDb();

async function listAllUsageFromDb(): Promise<UsageRecord[]> {
  try {
    return await listAllUsage(db);
  } catch {
    return [];
  }
}

async function listAllQaFromDb(): Promise<QaRecord[]> {
  try {
    const all = await db.getAll<QaRecord>(DB.stores.qaHistory);
    return Array.isArray(all) ? all : [];
  } catch {
    return [];
  }
}

// LLM 交互日志：订阅核心日志流并落 IndexedDB（幂等，模块级只接一次）
wireLlmLogPersistence();

export function App() {
  const [video, setVideo] = useState<VideoInfoPayload | null>(null);
  const [playback, setPlayback] = useState<PlaybackPayload | null>(null);
  const [tab, setTab] = useState<TabKey>('subtitle');
  /** 帮助浮层（SPEC-10 10.9） */
  const [showHelp, setShowHelp] = useState(false);
  /** 全屏单视图模式（panel.html?view=xxx）；null=普通侧栏模式 */
  const [standaloneView] = useState<TabKey | null>(parseStandaloneView);
  const effectiveTab: TabKey = standaloneView ?? tab;
  const [showSettings, setShowSettings] = useState(false);
  /** 手动粘贴版本号：递增触发 SubtitleTab 重载（key 变化） */
  const [pasteVersion, setPasteVersion] = useState(0);
  /** 大纲章节（OutlineTab 通知；导图/问答消费） */
  const [sections, setSections] = useState<Section[]>([]);
  /** 当前视频字幕（SubtitleTab 上报 / 换视频读缓存；ChatTab 用它吸附回答时间戳） */
  const [cues, setCues] = useState<Cue[]>([]);
  /** 回顾问卷（SPEC-08 8.8 / A10）：ended 触发，per-video 一次；null = 不显示 */
  const [retroVideoId, setRetroVideoId] = useState<string | null>(null);
  /** 已跳过问卷的视频（会话内不再弹） */
  const retroSkippedRef = useRef<Set<string>>(new Set());
  /** 划词待解释术语（SubtitleTab → ChatTab 联动） */
  const [pendingTerm, setPendingTerm] = useState<{ term: string; consumed: () => void } | null>(null);
  /** 概念知识图（缓存/生成产物；null=未生成，组件会降级本地术语图） */
  const [conceptMap, setConceptMap] = useState<ConceptMapData | null>(null);
  const [conceptGenerating, setConceptGenerating] = useState(false);
  /** 概念图是否为降级产物（模型生成失败回退本地术语图时为 true） */
  const [conceptDegraded, setConceptDegraded] = useState(false);
  /** 概念图生成失败原因（降级横幅展示；成功或重新生成时清空） */
  const [conceptError, setConceptError] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  /** LLM 交互日志（验证期报告的子模块） */
  const [showLlmLog, setShowLlmLog] = useState(false);
  /** 当前视频的问答角色（每视频一次判定并缓存） */
  const [persona, setPersona] = useState<Persona | null>(null);
  /** 设置中的模型配置（modelReady 判断用；生成时 loadOutlineForVideo 会实时重读） */
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);

  /** chrome.runtime.sendMessage 的安全包装：上下文失效时静默返回 null */
  const sendRuntimeMessage = (message: unknown): Promise<unknown> => {
    try {
      return chrome.runtime.sendMessage(message);
    } catch {
      return Promise.resolve(null);
    }
  };

  /** 拉取设置中的模型配置（挂载时与设置页关闭后刷新 modelReady） */
  const refreshModelConfig = () => {
    sendRuntimeMessage({ type: MSG.GET_SETTINGS })
      .then((response: unknown) => {
        const stored = (response ?? {}) as { model?: ModelConfig };
        setModelConfig(stored.model ?? null);
      })
      .catch(() => {
        // background 未就绪时保持空配置（modelReady=false）
      });
  };

  useEffect(() => {
    currentVideoIdRef.value = video?.videoId ?? null;
    currentVideoMetaRef.value = video
      ? { title: video.title, durationMs: video.durationMs }
      : null;
    setSections([]);
    setPendingTerm(null);
    setConceptMap(null);
    setConceptError(null);
    // 换视频：先清空，再尝试读缓存字幕（此前看过该视频时 ChatTab 立即可吸附时间戳）
    setCues([]);
    const vid = video?.videoId;
    if (vid) {
      getSubtitle(db, vid)
        .then((rec) => setCues(rec?.cues ?? []))
        .catch(() => undefined);
    }
  }, [video?.videoId]);

  /** 问答角色：缓存命中直接用；未命中则按视频内容判定一次（失败降级默认角色） */
  useEffect(() => {
    const vid = video?.videoId;
    if (!vid || !modelConfig?.apiKey) return;
    let cancelled = false;
    (async () => {
      const cached = await getPersonaCached(vid, modelConfig).catch(() => null);
      if (cached) {
        if (!cancelled) setPersona(cached);
        return;
      }
      const fresh = await generatePersona({
        videoId: vid,
        title: video?.title ?? '',
        sections,
      }).catch(() => null);
      if (!cancelled && fresh) setPersona(fresh);
    })();
    return () => {
      cancelled = true;
    };
  }, [video?.videoId, video?.title, modelConfig?.apiKey]);

  /** 概念图缓存回填（模型就绪且 videoId 存在时） */
  useEffect(() => {
    const vid = video?.videoId;
    if (!vid || !modelConfig?.apiKey) return;
    let cancelled = false;
    getConceptMapCached(vid, modelConfig)
      .then((data) => {
        if (!cancelled) {
          setConceptMap(data);
          setConceptDegraded(false);
        }
      })
      .catch(() => {
        if (!cancelled) setConceptMap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [video?.videoId, modelConfig?.apiKey]);

  useEffect(() => {
    refreshModelConfig();
    // 三个 Tab 的下拉框切换预设会直接写 settings（含 API Key），此处跟随刷新
    // modelReady，避免"下拉切到没配 Key 的模型，界面仍显示可生成"
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const onSettingsChanged: (
      changes: Record<string, unknown>,
      area: string,
    ) => void = (changes, area) => {
      if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, 'settings')) {
        refreshModelConfig();
      }
    };
    chrome.storage.onChanged.addListener(onSettingsChanged);
    return () => chrome.storage.onChanged.removeListener(onSettingsChanged);
  }, []);

  useEffect(() => {
    // 打开侧边栏时拉取当前 tab 的视频信息
    try {
      void chrome.runtime
        .sendMessage({ type: MSG.CURRENT_VIDEO_GET })
        .then((response: unknown) => {
          setVideo((response as VideoInfoPayload | null | undefined) ?? null);
        })
        .catch(() => {
          // background 未就绪时静默，等 VIDEO_CHANGED 推送
        });
    } catch {
      // 扩展上下文异常时静默
    }

    const listener = (message: RuntimeMessage) => {
      if (message.type === MSG.VIDEO_CHANGED) {
        setVideo(message.payload);
        setPlayback(null);
      } else if (message.type === MSG.PLAYBACK_CHANGED) {
        setPlayback(message.payload);
        // 视频播完：弹一题回顾（每视频一次；未答且未跳过才弹）
        if (
          message.payload.ended === true &&
          message.payload.videoId === video?.videoId &&
          message.payload.videoId !== retroVideoId &&
          !retroSkippedRef.current.has(message.payload.videoId)
        ) {
          const vid = message.payload.videoId;
          getUsage(db, vid)
            .then((rec) => {
              if (!rec?.subjective) setRetroVideoId(vid);
            })
            .catch(() => undefined);
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  /** 字幕 Tab 点句跳播：panel -> background -> content */
  /** 抽帧诊断埋点：在生成/问答之后记录本次规划来源、帧数与自报覆盖率 */
  const trackVision = async () => {
    const diag = getLastFramePlan();
    if (!diag || diag.frames === 0) return;
    const vid = video?.videoId;
    if (!vid) return;
    try {
      const current = (await getUsage(db, vid)) ?? createEmptyUsage(vid, Date.now);
      await saveUsage(
        db,
        applyUsageEvent(
          current,
          { kind: 'vision', vision: { frames: diag.frames, byModel: diag.source === 'model', coverage: diag.coverage } },
          Date.now,
        ),
      );
    } catch {
      /* 埋点失败不影响使用 */
    }
  };

  /** 验证期埋点：记录一次使用事件（seek/字幕/大纲/概念图） */
  const trackUsage = async (kind: 'seek' | 'subtitle' | 'outline' | 'conceptMap' | 'save') => {
    const vid = video?.videoId;
    if (!vid) return;
    try {
      const current = (await getUsage(db, vid)) ?? createEmptyUsage(vid, Date.now);
      await saveUsage(db, applyUsageEvent(current, { kind }, Date.now));
    } catch {
      /* 埋点失败不影响使用 */
    }
  };

  const handleRequestSeek = (targetMs: number) => {
    if (!video) return;
    void trackUsage('seek');
    try {
      void chrome.runtime
        .sendMessage({ type: MSG.SEEK, payload: { videoId: video.videoId, targetMs } })
        .catch(() => {
          // content/background 未就绪时静默
        });
    } catch {
      // 扩展上下文异常时静默
    }
  };

  /** 提问自动暂停（ChatTab 调用）：panel -> background -> content */
  const handlePause = () => {
    if (!video) return;
    try {
      void chrome.runtime
        .sendMessage({ type: MSG.PAUSE, payload: { videoId: video.videoId } })
        .catch(() => {});
    } catch {
      /* 静默 */
    }
  };

  /** 一键全屏：当前视图在新标签页全窗口打开（Chrome 不允许扩展改侧栏宽度，此为替代） */
  const handleOpenFullscreen = () => {
    try {
      void chrome.tabs.create({ url: chrome.runtime.getURL(`panel.html?view=${effectiveTab}`) });
    } catch {
      /* 静默 */
    }
  };

  /**
   * 生成概念知识图；失败降级为本地术语关联图（零成本兜底）。
   * 失败一律留痕：原因进控制台（[vsc] 前缀）+ 降级横幅文案，
   * 否则界面只有一句"模型生成失败"，无从定位。
   */
  const handleGenerateConceptMap = async (secs: Section[], title: string) => {
    setConceptGenerating(true);
    setConceptDegraded(false);
    setConceptError(null);
    try {
      const data = await genConceptMap(video?.videoId ?? '', secs, title);
      setConceptMap(data);
      await trackUsage('conceptMap');
      await trackVision();
    } catch (err) {
      console.error('[vsc] concept map generate failed', err);
      setConceptMap(termIndexFallback(secs));
      setConceptDegraded(true);
      setConceptError(describeConceptMapFailure(err));
    } finally {
      setConceptGenerating(false);
    }
  };

  /** 关系边生成（流程图 Tab）：独立小请求，成功后更新 conceptMap 状态 */
  const handleGenerateFlows = async (): Promise<ConceptFlow[]> => {
    if (!video?.videoId) throw new Error('未检测到视频');
    const flows = await generateConceptFlows(video.videoId);
    setConceptMap((prev) => (prev ? { ...prev, flows } : prev));
    return flows;
  };

  /** 重判问答角色（用户点"重判角色"） */
  const handleRefreshPersona = async () => {
    if (!video || !modelConfig?.apiKey) return;
    const fresh = await generatePersona({
      videoId: video.videoId,
      title: video.title,
      sections,
    }).catch(() => null);
    if (fresh) setPersona(fresh);
  };

  /** 存入 Obsidian：视频笔记（大纲 Tab） */
  const handleSaveVideoNote = async (): Promise<string> => {
    if (!meta || !video || sections.length === 0) return '暂无可存的大纲';
    try {
      const { path, local } = await saveVideoNoteToObsidian({ videoId: video.videoId, meta, sections });
      void trackUsage('save');
      return local ? `未配置 Obsidian，已下载 .md：${path}` : `已存入 ${path}`;
    } catch (err) {
      return `存库失败：${err instanceof Error ? err.message : String(err)}`;
    }
  };

  /** 存入 Obsidian：术语卡（问答 Tab）；重复术语提示由 loader throw 带出 */
  const handleSaveNote = async (args: {
    kind: 'term' | 'segment';
    term?: string;
    payload: unknown;
  }): Promise<string> => {
    if (!meta || !video) return '未检测到视频';
    try {
      if (args.kind === 'term' && args.term) {
        const { path, local } = await saveTermCardToObsidian({
          term: args.term,
          payload: args.payload as never,
          meta,
          existingTerms: [],
        });
        void trackUsage('save');
        return local ? `未配置 Obsidian，已下载 .md：${path}` : `已存入 ${path}`;
      }
      const { path, local } = await saveVideoNoteToObsidian({
        videoId: video.videoId,
        meta,
        sections,
      });
      void trackUsage('save');
      return local ? `未配置 Obsidian，已下载 .md：${path}` : `已存入 ${path}`;
    } catch (err) {
      return err instanceof Error ? err.message : `存库失败：${String(err)}`;
    }
  };

  /** 回顾问卷作答（入库；SPEC-07 7.2 / A9） */
  const handleRetroAnswer = (choice: 'fewer' | 'same' | 'more') => {
    const vid = retroVideoId;
    if (!vid) return;
    setRetroVideoId(null);
    void (async () => {
      try {
        const current = (await getUsage(db, vid)) ?? createEmptyUsage(vid, Date.now);
        await saveUsage(db, applySubjective(current, choice, Date.now));
      } catch {
        /* 入库失败不影响使用 */
      }
    })();
  };

  const handleRetroSkip = () => {
    if (retroVideoId) retroSkippedRef.current.add(retroVideoId);
    setRetroVideoId(null);
  };

  /** 报告页手动补录问卷（写入当前视频） */
  const handleSubjectiveForReport = async (choice: 'fewer' | 'same' | 'more') => {
    const vid = video?.videoId;
    if (!vid) throw new Error('未检测到视频');
    const current = (await getUsage(db, vid)) ?? createEmptyUsage(vid, Date.now);
    await saveUsage(db, applySubjective(current, choice, Date.now));
  };

  /** 划词联动：字幕 Tab 选中术语 → 切问答 Tab 自动解释 */
  const handleExplainTerm = (term: string) => {
    setPendingTerm({ term, consumed: () => setPendingTerm(null) });
    setTab('chat');
  };

  // SPEC-08 8.2：url/cid 由 content 上报（VideoInfoPayload）；旧版本 payload 缺字段时兜底
  const meta: VideoMeta | null = video
    ? { ...video, url: video.url ?? '', cid: video.cid ?? 0 }
    : null;

  /** 字幕加载：经瀑布（缓存 → B 站一级通道；红线 8 保证不抛） */
  const handleLoadSubtitles = async (videoId: string): Promise<FetchResult> => {
    const result = meta
      ? await runWaterfall(videoId, meta)
      : { cues: [], status: 'no_subtitle' as const, error: '无视频元信息' };
    if (result.cues.length > 0) await trackUsage('subtitle');
    return result;
  };

  /** 手动粘贴解析：走瀑布手动直达通道并落缓存，成功后递增版本号触发重载 */
  const handleManualPaste = (text: string) => {
    if (!meta) return;
    void loadSubtitlesManual(meta.videoId, meta, text)
      .then(() => setPasteVersion((v) => v + 1))
      .catch(() => {
        /* 红线 8：瀑布不抛；此处兜底 */
      });
  };

  return (
    <div className="app">
      <header className="info-bar info-bar-rel">
        {video ? (
          <>
            <div className="info-title" title={video.title}>
              {video.title}
            </div>
            <div className="info-meta">
              <span className="info-video-id">{video.videoId}</span>
              <span>时长 {formatDuration(video.durationMs)}</span>
              {playback && (
                <span>
                  {formatDuration(playback.positionMs)} · {playback.playing ? '播放中' : '已暂停'}
                </span>
              )}
            </div>
          </>
        ) : (
          <div className="info-empty">未检测到 B 站视频</div>
        )}
        <button
          type="button"
          className="fullscreen-corner"
          title={standaloneView ? '关闭全屏标签页' : '全屏打开当前视图'}
          onClick={standaloneView ? () => window.close() : handleOpenFullscreen}
        >
          {standaloneView ? '退出全屏' : '⛶'}
        </button>
      </header>

      {retroVideoId && (
        <div className="retro-banner" role="dialog" aria-label="一题回顾">
          <span>这节课看完了：切出去搜索的次数比以往？</span>
          <button type="button" className="btn" onClick={() => handleRetroAnswer('fewer')}>
            明显少
          </button>
          <button type="button" className="btn" onClick={() => handleRetroAnswer('same')}>
            差不多
          </button>
          <button type="button" className="btn" onClick={() => handleRetroAnswer('more')}>
            更多
          </button>
          <button type="button" className="btn" onClick={handleRetroSkip}>
            跳过
          </button>
        </div>
      )}
      {showSettings ? (
        <>
          {showReport ? (
            <div className="report-wrap">
            <button type="button" className="btn" onClick={() => setShowReport(false)}>
              返回设置
            </button>
            <ValidationReportView
              onLoad={async () => ({
                usage: await listAllUsageFromDb(),
                qa: await listAllQaFromDb(),
                logs: await loadLlmLogs().catch(() => []),
              })}
              onSubjective={handleSubjectiveForReport}
            />
            </div>
          ) : showLlmLog ? (
            <div className="report-wrap">
              <button type="button" className="btn" onClick={() => setShowLlmLog(false)}>
                返回设置
              </button>
              <LlmLogView />
            </div>
          ) : (
            <SettingsPage
              onClose={() => {
                setShowSettings(false);
                // 保存后返回需刷新 modelReady
                refreshModelConfig();
              }}
              onOpenValidationReport={() => setShowReport(true)}
              onOpenLlmLog={() => setShowLlmLog(true)}
            />
          )}
        </>
      ) : (
        <>
{!standaloneView && (
            <nav className="tabs">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={tab === t.key ? 'tab active' : 'tab'}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
              <button
                type="button"
                className="tab settings-btn"
                onClick={() => setShowSettings(true)}
              >
                设置
              </button>
              <button
                type="button"
                className="tab settings-btn"
                title="使用帮助"
                onClick={() => setShowHelp(true)}
              >
                ？
              </button>
              <button
                type="button"
                className="tab settings-btn"
                title="重新加载本机数据（大纲/笔记/导图/问答全部从本地存储重读）"
                onClick={() => window.location.reload()}
              >
                ⟳
              </button>
            </nav>
          )}
          <main className="tab-body">
            {effectiveTab === 'subtitle' && (
              <SubtitleTab
                key={`${video?.videoId ?? 'none'}-${pasteVersion}`}
                videoId={video?.videoId ?? null}
                meta={meta}
                positionMs={playback?.positionMs ?? 0}
                onRequestSeek={handleRequestSeek}
                loadSubtitles={handleLoadSubtitles}
                onManualPaste={handleManualPaste}
                onExplainTerm={handleExplainTerm}
                onCues={setCues}
                punctuate={(vid) => punctuateSubtitles(vid)}
                restoreRaw={(vid) => restoreRawSubtitles(vid)}
              />
            )}
            {effectiveTab === 'outline' && (
              <OutlineTab
                videoId={video?.videoId ?? null}
                meta={meta}
                positionMs={playback?.positionMs ?? 0}
                onRequestSeek={handleRequestSeek}
                loadOutlineCached={loadOutlineCached}
                generateOutline={generateOutline}
                regenerateOne={regenerateOne}
                modelReady={!!modelConfig?.apiKey}
                onSaveVideoNote={handleSaveVideoNote}
                onSectionsChanged={(secs) => {
                  setSections(secs);
                  if (secs.length > 0) {
                    void trackUsage('outline');
                    void trackVision();
                  }
                }}
                onOpenSettings={() => setShowSettings(true)}
              />
            )}
            {effectiveTab === 'mindmap' && (
              <MindmapTab
                sections={sections}
                videoTitle={video?.title ?? ''}
                positionMs={playback?.positionMs ?? 0}
                onRequestSeek={handleRequestSeek}
                modelReady={!!modelConfig?.apiKey}
                onOpenSettings={() => setShowSettings(true)}
                generateConceptMap={handleGenerateConceptMap}
                generateFlows={handleGenerateFlows}
                conceptMap={conceptMap}
                degraded={conceptDegraded}
                degradedText={conceptError ?? undefined}
                generating={conceptGenerating}
                onGoOutline={() => setTab('outline')}
              />
            )}
            {effectiveTab === 'chat' && (
              <ChatTab
                videoId={video?.videoId ?? null}
                sections={sections}
                cues={cues}
                positionMs={playback?.positionMs ?? 0}
                onRequestSeek={handleRequestSeek}
                onPause={handlePause}
                modelReady={!!modelConfig?.apiKey}
                visionReady={!!modelConfig?.apiKey && modelConfig?.supportsVision === true}
                onOpenSettings={() => setShowSettings(true)}
                explain={explainFn}
                loadHistory={loadChatHistory}
                persona={persona}
                onRefreshPersona={handleRefreshPersona}
                onSaveNote={handleSaveNote}
                pendingTerm={pendingTerm ?? undefined}
              />
            )}
          </main>
        </>
      )}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}
