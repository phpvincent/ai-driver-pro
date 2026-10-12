# SPEC-11 · 抽帧页聚类精修（本地稠密扫描 + dHash 页聚类 + 簇内清晰度选帧）

- 状态：**待验收**（2026-10-12 施工完成；[自动] A1~A6 全过，[人工] B1/B2 待冒烟）
- 依赖：SPEC-05 抽帧链路（结构候选 + LLM 挑选）
- 对应里程碑：v0.1.x
- 验收 tag：`spec-11-accepted`

## 1. 背景与问题

现有抽帧链路（SPEC-05）是"先规划后采集"：LLM 按字幕提示词挑选时刻，content 只在规划点采帧。两个盲区：

1. **翻页瞬间命中**：取帧点落在章节开头 +3s 或提示词字幕时刻，可能正好在 PPT 翻页动画中间（运动模糊帧）
2. **画面换了字幕没提**：代码演示/软件操作类视频，画面变化不伴随"看这里/如图"类口播 → 候选与规划都看不见

大厂方案（抖音/小红书的服务端流水线）用镜头边界检测 + 帧清晰度评分解决，但依赖 GPU 集群与专用 CV 模型。本 spec 在浏览器约束内做**等价收益的轻量翻译**：本地采集免费、token 才贵——把"选帧"工作从付费侧挪到免费侧。

## 2. 方案（第一期：目标点邻域精修）

### 2.1 流程（叠加在现有 planFrames 之后、requestFrames 之前）

```
现有：planFrames() → targetsMs ─────────────────→ requestFrames()（全尺寸采帧）
新增：             targetsMs → buildScanTargets() → SCAN_FRAMES（轻量扫描，只算 dHash+清晰度）
                              ↓（与 LLM 规划并行启动，隐藏延迟）
                   扫描样本 → clusterPages() → refineTargets() → 精修后的 targetsMs
```

### 2.2 三层实现

**① 纯函数层 `core/vision/pageCluster.ts`**（红线 1 友好，全部可单测）：

- `buildScanTargets(targetsMs, {windowMs, stepMs, maxSamples})`：每个目标 ±6s、步长 2s 的采样点（去重排序、总量封顶）
- `clusterPages(samples, maxDistance)`：顺序 dHash 聚类——相邻样本汉明距离 ≤5 归同一"页"，页边界 = 翻页点
- `sharpnessFromGray(gray, w, h)`：拉普拉斯算子方差（清晰度分，无模型）
- `refineTargets(samples, targetsMs, {windowMs})`：每个目标在 ±6s 内找最近样本所在页，**页内选清晰度最高的样本时刻**替换原目标；窗口内无样本 → 保持原值（优雅降级）

**② content 层 `frameCapture.ts` 扫描模式**（轻量，不发大图）：

- `scanFrames(video, pointsMs, {budgetMs})`：顺序 seek，每点只画两个小画布（9×8 灰度 → dHash；32×18 灰度 → 清晰度），**不导 JPEG**
- 时间预算（默认 25s）：超预算即返回已扫部分（graceful partial——不阻塞主流程）
- 复用现有 pause/restore 与 `captureInProgress` 守卫；新消息 `SCAN_FRAMES`（payload 传参，content 禁 import config，红线 10）

**③ panel 层 `framesClient.planFrames` 接线**：

- LLM 规划调用发起**之前**启动扫描 Promise（网络与 seek 并行，扫描延迟藏进 LLM 等待时间）
- LLM 返回后 await 扫描结果 → 精修 targets → 原有 guard/去重闸门不变
- 扫描失败/超时/无样本 → 原 targets 原样使用（行为等同现状）

### 2.3 不做的（第二期候选，登记回创意池）

- 全片稠密扫描（seek 成本不可控，30 分钟 = 900 次 seek）
- 页切换点新增帧（需与预算再平衡）
- 字幕停顿检测、VLM 显式 OCR 指令

## 3. 验收标准

**[自动]**（G1/G3 门禁）：

- [A1] `buildScanTargets`：窗口/步长/去重/封顶，纯函数 8 例
- [A2] `clusterPages`：连续同页聚类、翻页边界、距离阈值边界 6 例
- [A3] `sharpnessFromGray`：清晰图 > 模糊图、常量图 = 0、非法输入 0
- [A4] `refineTargets`：页内选最清晰、无样本保持原值、窗口边界 6 例
- [A5] `scanFrames`：假 video 驱动，预算截断、空输入、恢复播放状态
- [A6] 既有 1056+ 测试全绿（行为兼容：扫描路径全失败时 targets 不变）

**[人工]**（冒烟）：

- [B1] 导图生成：LLM 日志无新增失败；帧数不减少
- [B2] 代码演示类视频：抽查帧不再出现翻页模糊帧

## 4. 执行记录

| 日期 | 执行者 | 变更摘要 | 自测结果 | commit |
|---|---|---|---|---|
| 10-12 | 父 agent | 起草（依据抽帧链路精读 + 大厂方案对比 + 用户拍板） | — | 本提交 |
| 10-12 | 父 agent | 全量施工：① `core/vision/pageCluster.ts` 纯函数（buildScanTargets 均匀抽稀含首尾 / clusterPages 顺序聚类-隔页不合并 / sharpnessFromGray 拉普拉斯方差 / refineTargets 页内选最清晰并列取最早）② content `scanFrames` 轻量扫描（只算 9×8 dHash + 32×18 清晰度，不导 JPEG；时间预算 graceful partial；describeScan 注入供单测）+ `SCAN_FRAMES` 消息与 background 转发 ③ framesClient 接线：**扫描围绕结构候选**（调用前已知，LLM 按编号从候选挑——覆盖一切可能选择）与 LLM 规划**并行**，返回后 refineWithScan，guard/minGap 闸门在精修之后兜底 ④ VISION.refine 常量（window 6s/step 2s/budget 25s/max 200） | 1104 例全绿（+23：page-cluster 20 例 + scanFrames 4 例）；扫描全失败时 targets 恒等（行为兼容） | 本提交 |
| 10-12 | 父 agent | **冒烟修复**：用户实测 32 分钟视频扫描到 ~20min 停止——采样点升序执行 + 25s 预算耗尽 = 放弃整条时间轴后半段。修复 = interleaveScanOrder 两层交错序（先全部偶数下标=一遍覆盖全程，再奇数加密），预算只影响精修密度不影响覆盖范围；确定性保持 | 3 例新测试（前半执行覆盖首尾与四分位/全量=原集合/确定性）；1107 例全绿 | 本提交 |
