# SPEC-18 · 蒸馏质量门禁与契约对齐

- 状态：待验收（18.1-18.7 施工完成，自动门禁全绿；余 A10 [人工] 真机核验）
- 依赖：SPEC-17（LLM wiki 层级结构，已实现；本 spec 为其质量补强）
- 对应里程碑：MX（知识库可信度）
- 验收 tag：`spec-18-accepted`
- 起因：`vsc-knowledge/审计报告-2026-10-22.md`（第三方审计）+ `审计报告-复核意见-2026-10-22.md`（实现方复核，含量化基线）

## 1. 目标与范围

**做**：只改**扩展侧入库/蒸馏逻辑**，使后续入库不再产生审计所列问题。全部为确定性实现 + prompt 约束，不引入新的模型调用。

| # | 交付物 | 文件路径（TECH-DESIGN §9） |
|---|--------|---------------------------|
| 1 | 章节要点确定性归一（排序/去重/越界回落） | `src/core/pipeline/capture.ts`、`src/core/pipeline/merge.ts` |
| 2 | 笔记可辨识与摘要锚点（违 B.1/B.9/C.6） | `src/core/pipeline/capture.ts` |
| 3 | 概念页引用：原句/转述分列 + 禁 `[00:00]` 占位 + 窗口软校验 | `src/core/pipeline/capture.ts`、`src/panel/obsidianLoader.ts` |
| 4 | AGENTS.md 契约对齐（目录/字段字典/tag/词汇/变更协议） | `src/core/pipeline/capture.ts` |
| 5 | terms 噪音过滤 + 文件名全角标点清洗 | `src/core/pipeline/capture.ts` |
| 6 | index entry schema 统一 + sourceType 补全 | `src/panel/obsidianLoader.ts`、`src/core/pipeline/capture.ts` |
| 7 | prompt 约束（别名/原句逐字/标题枚举一致） | `src/prompts/distill.md`、`src/prompts/knowledge-capture.md` |
| 8 | 单测覆盖上述全部 | `tests/unit/**` |

**不做**（并注明归属）：
- **不改动现有知识库内容**（用户自行清理）——本 spec 只保证**新写入**合规
- 核验晋升入口（user-note 晋升 UI）→ 后续 spec
- 并发写入锁、raw 写保护（companion 侧）→ 后续 spec
- 多库隔离/迁移工具 → EVOLUTION-ROADMAP
- 引文"逐字命中 raw"硬校验 → **明确否决**（raw 是 ASR 滚动碎片，逐字引用不可读；改用窗口软校验）
- 标题断言 ↔ 正文机械比对 → 否决（需语义），改 prompt 约束

## 2. 前置条件

- SPEC-17 已实现（capture/explain/obsidianLoader 链路在）
- 用户已确认：不修复现有库，只改管线

## 3. 执行方案

| # | 子任务 | 交付物 | 允许修改的路径 | 预估 |
|---|--------|--------|----------------|------|
| 18.1 | bullets 归一 | `normalizeBullets` 纯函数 + 接入 finalizeOutline | capture.ts / merge.ts / tests | 0.5d |
| 18.2 | 笔记合规 | callout + 章节摘要锚点 | capture.ts / tests | 0.25d |
| 18.3 | 引用溯源 | 原句/转述分列、禁 00:00、窗口软校验 | capture.ts / obsidianLoader.ts / tests | 1d |
| 18.4 | 契约对齐 | AGENTS_MD 重写 | capture.ts / tests | 0.25d |
| 18.5 | 噪音过滤 | terms 过滤 + 文件名清洗 | capture.ts / tests | 0.25d |
| 18.6 | index 统一 | 共享 entry 构造 + sourceType | capture.ts / obsidianLoader.ts / tests | 0.25d |
| 18.7 | prompt | 三个约束点 | prompts/*.md | 0.25d |
| 18.8 | 门禁 | G1/G2/G3 | — | 0.25d |

每个子任务验收通过即 commit：`fix(spec-18): <摘要>`。

## 4. 验收标准

每条标注 **[自动] / [半自动] / [人工]**。

- [ ] A1 [自动] `normalizeBullets`：乱序/重复/越界的 bullets 归一后有序、无重复、全部落在 [startMs, endMs] 内，越界者标 `approximate`
- [ ] A2 [自动] 视频笔记渲染含「AI 蒸馏 · 待核验」callout 且章节摘要句尾带 `[mm:ss]` 锚点
- [ ] A3 [自动] 概念引用：`sourceExcerpt` 为转述时不加引号、标 `语境转述`；`anchorSec` 为 0/非法时**不产出**该引用（无 `[00:00]` 占位）
- [ ] A4 [自动] 窗口软校验：引文与锚点 ±30s 原文 2-gram 覆盖率低于阈值 → 该引用被丢弃并计入日志（不阻断整体入库）
- [ ] A5 [自动] AGENTS_MD 快照：目录名为 `笔记/`、`概念/`（全局唯一）、`raw/`、`索引/`；含字段字典（含「N 分」口径）；含变更协议；不含未实现的 `术语/{领域}/` 与 `问答/` 承诺
- [ ] A6 [自动] terms 过滤：`npm install` / `main.js` / `counter` 类词条不入索引
- [ ] A7 [自动] `sanitizeFileName`：全角冒号等被替换；Windows 非法字符全清
- [ ] A8 [自动] video-note entry 含 `sourceType`；概念/笔记条目由同一构造函数产出
- [ ] A9 [自动] G1 `npm run build` + `npm test` 全绿；G3 `npm run check:redlines` 通过；执行记录已追加
- [ ] A10 [人工] 用户清理旧库后重新存入一集 → 对照清单核验新产物（锚点可点、引文可溯、无占位、契约可读）

## 5. 风险与回滚

- 风险：AGENTS.md 覆盖写 → 用户手写的内容会丢。应对：宪法明确 AGENTS.md 由扩展权威维护，本 spec 不改变该语义。
- 风险：引用过滤过严导致引用条目变少。应对：阈值可调（默认 0.35），宁缺毋滥；日志记录丢弃数。
- 回滚：`git revert` 对应 commit，或回到上一个验收 tag。

## 6. 执行记录（append-only）

| 日期 | 执行者 | 变更摘要 | 自测结果 | commit |
|---|---|---|---|---|
| 2026-10-22 | 父 agent | 立项（依审计+复核意见） | — | — |
| 2026-10-22 | 父 agent | 18.1-18.7 一次交付：normalizeBullets（排序/同刻 textOverlap 去重/越界回落）接入 finalizeOutline + buildVideoNoteMarkdown；笔记 AI 蒸馏 callout + 章节摘要锚点；概念引用 excerptKind（verbatim 加引号/paraphrase 标转述）+ buildVerifiedReference（禁 [00:00] 占位 + quoteWindowCoverage 窗口软校验阈值 0.35）；AGENTS_MD v2（目录对齐实际、字段字典含「N 分」口径、tag 双表示、source/sourceType 词汇、D 变更协议）；filterTerms 噪音过滤 + sanitizeFileName 全角标点；buildVideoNoteIndexEntry/buildConceptIndexEntry 共享构造（sourceType 显式）；distill.md 0.4.0（aliases 补全、excerptKind、锚点>0）；knowledge-capture.md 0.3.0（标题枚举一致、目录对齐） | tsc 干净；vitest 1245 例全绿（新增 28）；vite build 零错误；check:redlines + check:prompts 通过 | 待补 |
