# SPEC-19 · 溯源诚实性与入库校验强化

- 状态：进行中
- 依赖：SPEC-18（蒸馏质量门禁，已交付；本 spec 为其第二轮补强）
- 对应里程碑：MX（知识库可信度）
- 验收 tag：`spec-19-accepted`
- 起因：`vsc-knowledge/审计报告-第二轮-2026-10-22.md`（第三方审计 v2）+ `审计报告-第二轮-复核意见-2026-10-22.md`（实现方实证复核）

## 1. 用户约束

**只改蒸馏与入库逻辑**；旧知识库内容不复写不修改，由用户清空后重新生成。

## 2. 目标与范围

**做**（全部确定性实现 + prompt 约束，零新增模型调用）：

| # | 交付物 | 对应问题 | 文件 |
|---|--------|----------|------|
| 1 | **引文溯源诚实性**：`locateQuoteInRaw` 按 anchorSec 在 raw 定位并**截取原文**（引文=原文、锚点=命中行时间戳，根治批量赋锚）；未命中**强制降级 paraphrase**（去引号标转述） | N-1（P0） | `capture.ts` |
| 2 | 滑动窗近重复去重：±5s 内 textOverlap ≥ 0.6 合并（保留较长） | N-4（P1） | `merge.ts` |
| 3 | terms 过滤补中文实现细节词 + 快捷键形态；**正文「术语：」行也过滤** | terms 缺口（P1） | `capture.ts` |
| 4 | broader 入库校验：目标存在 + 非自身 + 无环，非法置空 | N-2（P1） | `capture.ts` / `obsidianLoader.ts` |
| 5 | `sanitizeFileName` 去尾随点号/空格/下划线 | N-6（P2） | `capture.ts` |
| 6 | prompt：broader 是上位母题非同级兄弟；章节标题主题须与条目一致 | N-5（P2） | `prompts/distill.md`、`prompts/knowledge-capture.md` |

**不做**（注明理由）：
- N-3 零引用概念页移出 MOC —— **不做**。移出会损失检索面；零引用是"宁缺毋滥"的可接受代价，补齐靠后续存入聚合。
- N-5 章节语义串味的机械校验 —— **不做**（需语义判断，只走 prompt 约束）。
- 旧库内容回溯修复 —— 用户自行清空重建。
- 卫生三件套（.gitignore/空文件/README）与 `sss` 残留 —— 用户自理。

## 3. 执行方案

| # | 子任务 | 交付物 | 预估 |
|---|--------|--------|------|
| 19.1 | locateQuoteInRaw + buildVerifiedReference 改造 | capture.ts + tests | 1d |
| 19.2 | 滑动窗去重 | merge.ts + tests | 0.25d |
| 19.3 | terms 覆盖 | capture.ts + tests | 0.25d |
| 19.4 | broader 校验 | capture.ts / obsidianLoader.ts + tests | 0.25d |
| 19.5 | 文件名尾随标点 | capture.ts + tests | 0.1d |
| 19.6 | prompt 两约束 | prompts/*.md | 0.1d |
| 19.7 | 门禁 G1/G2/G3 | — | 0.25d |

## 4. 验收标准

- [ ] A1 [自动] `locateQuoteInRaw`：在提示锚点附近定位原文行，返回的 text 必为 raw 逐字原文，startMs 为命中行时间戳
- [ ] A2 [自动] 标 `verbatim` 的引用：**渲染的引文在 raw 中逐字命中**（100%）；锚点 = 命中行时间戳（非模型批量赋锚）
- [ ] A3 [自动] 无法定位原文时 → 该引用**降级为 paraphrase**（不加引号、标"转述"），绝不保留假"原句"
- [ ] A4 [自动] 滑动窗去重：±5s 内 textOverlap ≥ 0.6 的条目合并为一条
- [ ] A5 [自动] terms：`记事本`/`输入法`/`Ctrl+S`/`E盘` 类词条不入索引；笔记正文「术语：」行同样过滤
- [ ] A6 [自动] broader：自指/悬空/成环的 broader 被置空，不再写入
- [ ] A7 [自动] 文件名无尾随点号/下划线
- [ ] A8 [自动] G1 build + test 全绿；G3 redlines + prompts 通过；执行记录已追加
- [ ] A9 [人工] 清空重建后抽查 10 条「原句」逐字回查 raw 全中；批量赋锚消失

## 5. 风险与回滚

- 风险：代码截原句后引文带 ASR 原貌（含"呢/呃"、误识），可读性下降。应对：这是"诚实优先"的取舍；转述形态已有，需要可读时模型可标 paraphrase。
- 风险：去重阈值 0.6 可能误合并不同内容。应对：仅在 ±5s 窗口内比对；保留较长条目；测试覆盖边界。
- 回滚：`git revert` 对应 commit。

## 6. 执行记录（append-only）

| 日期 | 执行者 | 变更摘要 | 自测结果 | commit |
|---|---|---|---|---|
| 2026-10-22 | 父 agent | 立项（依第二轮审计 + 实证复核） | — | — |
