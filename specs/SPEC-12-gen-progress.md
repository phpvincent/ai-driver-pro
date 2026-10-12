# SPEC-12 · 生成进度反馈与扫描预算设置

- 状态：**待验收**（2026-10-12 施工完成；[自动] A1/A2/A4 过，A3 并入设置页夹取逻辑（5~120），[人工] B1~B3 待冒烟）
- 依赖：SPEC-11（扫描预算的存在）、SPEC-03/04（大纲/导图生成链路）
- 对应里程碑：v0.1.x
- 验收 tag：`spec-12-accepted`

## 1. 背景与用户决策

- SPEC-11 冒烟发现扫描预算在长视频时间轴 60% 处耗尽（已修交错序）。用户问询后拍板：
  1. **预算做成设置项**而非时长自适应——"我们不知道视频的具体信息密度"，把判断权交给用户
  2. **大纲/导图生成给进度条**——扫描点数已知，进度可精确计算
  3. **报错中止要告知用户 + 可重试**
- 现状盘点（可复用资产）：`buildOutline` 已有 `onProgress` 分块钩子（未接 UI）；OutlineTab degraded 态已有重试按钮；MindmapTab 已有降级横幅 + 重试。**真正缺口 = 进度可见性 + 预算设置。**

## 2. 方案

### 2.1 进度总线 `panel/progressBus.ts`

轻量 pub/sub（panel 内，无跨模块依赖）：

```ts
interface GenProgress { videoId: string; stage: 'scan' | 'outline' | 'mindmap'; done: number; total: number; label?: string }
subscribe / publish / subscribeForVideo(videoId, cb)
```

三个发布源：

| 源 | 阶段 | 进度语义 |
|---|---|---|
| content `scanFrames` | scan | scanned/total（交错序下已扫点也均匀覆盖全程，进度即真实推进度） |
| outlineLoader（分块循环） | outline | doneChunks/totalChunks，label「第 x/N 块」 |
| mindmapLoader（生成主链） | mindmap | 阶段序（字幕→抽帧规划→帧采集→模型生成），label 驱动 |

### 2.2 扫描进度链路

- content `scanFrames` 新增 `onProgress` 注入（每 5 点节流），handler 接 `chrome.runtime.sendMessage`
- 新消息 `SCAN_PROGRESS`（videoId + scanned/total）；background `forwardToPanel` 广播（与 VIDEO_CHANGED 同通道）
- panel 消息入口转发进总线

### 2.3 设置项

- `Settings.frameScan?: { budgetSec?: number }`（默认 25，UI 限 5~120）
- 设置页「抽帧」区加数字输入（秒），提示文案说明权衡（更满的精修 vs 更长的等待）
- `framesClient.scanAroundCandidates` 经 GET_SETTINGS 读取，传入 SCAN_FRAMES payload

### 2.4 UI

- 共享进度条组件 `GenerationProgress`：读总线按 videoId 过滤，细进度条 + label（无进度数据退化为现有文案，兼容）
- OutlineTab loading 态、MindmapTab generating 态接入

### 2.5 错误与重试（验收确认既有覆盖）

- OutlineTab degraded：错误文案 + 重试按钮（已有，SPEC-03）✓
- MindmapTab degraded：降级横幅 + 重试（已有，SPEC-04）✓
- 本 spec 补：扫描失败不产生用户可见错误（它本来就是可选增强，静默降级是设计行为）

## 3. 验收标准

**[自动]**：

- [A1] progressBus：订阅/发布/按 videoId 过滤/退订，8 例
- [A2] scanFrames onProgress：节流（每 5 点）、注入驱动，2 例
- [A3] 设置读写：budgetSec 缺省回落 25、非法值夹取 5~120，3 例
- [A4] 既有 1107+ 测试全绿

**[人工]**（冒烟）：

- [B1] 大纲生成：进度条显示「第 x/N 块」推进；失败时错误文案 + 重试可用
- [B2] 导图生成：进度条阶段推进（含扫描百分比）；关闭抽帧时不出现扫描阶段
- [B3] 设置页改预算为 60 秒 → 重启生成，扫描明显变满（LLM 日志耗时印证）

## 4. 执行记录

| 日期 | 执行者 | 变更摘要 | 自测结果 | commit |
|---|---|---|---|---|
| 10-12 | 父 agent | 起草（用户三项决策） | — | 本提交 |
| 10-12 | 父 agent | 全量施工：① `panel/progressBus.ts` 轻量 pub/sub（扇出快照迭代、订阅者异常隔离、按 videoId 过滤）② 扫描进度链路：content scanFrames onProgress（每 5 点节流+末点必报）→ SCAN_PROGRESS 消息 → background forwardToPanel → App 转发进总线 ③ 大纲分块进度：outlineLoader 在 onProgress 钩子发布「字幕分块 x/N」（复用既有 pipeline 钩子，core 层零改动）④ 导图阶段进度：mindmapLoader 四阶段（读取→抽帧规划→已选 N 帧→模型生成），扫描期间细粒度百分比由 scan 事件叠加 ⑤ 预算设置：Settings.frameScan.budgetSec（UI 限 5~120 默认 25，随抽帧开关一并保存；framesClient 读取传 SCAN_FRAMES，非法回落 VISION.refine.budgetMs）⑥ UI：GenerationProgress 组件（无事件时 null 兼容旧文案），OutlineTab loading 态 + MindmapTab generating 态接入；MindmapTab 补 videoId prop（App 传入）。错误重试确认为既有覆盖（OutlineTab degraded 重试 / MindmapTab 降级横幅重试），未重复建设 | 1115 例全绿（+8：progressBus 6 + onProgress 2）；tsc/build/红线过 | 本提交 |
