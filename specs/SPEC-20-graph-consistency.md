# SPEC-20 · wikilink 一致性与图谱结构链

- 状态：待验收（20.1-20.4 施工完成，自动门禁全绿；余 A8 [人工] 清空重建后抽查）
- 依赖：SPEC-19（溯源诚实性，已交付）
- 对应里程碑：MX（知识库可信度）
- 验收 tag：`spec-20-accepted`
- 起因：`vsc-knowledge/审计报告-第三轮-2026-10-22.md`——P1 wikilink 断链 + 公考两篇图谱分离

## 1. 用户约束

**只改蒸馏与入库逻辑**；旧知识库内容不复写不修改，由用户清空后重新生成。

## 2. 目标与范围

**做**（全部确定性实现，零新增模型调用）：

| # | 交付物 | 对应问题 | 文件 |
|---|--------|----------|------|
| 1 | **wikilink 目标 = 落盘文件名**：新增 `wikiLink(preferred)` 出口——target=`sanitizeFileName(preferred)`，display 保留原名；概念 wikilink 与 broader wikilink 全走此出口 | P1 断链（`[[h$*6 快捷键]]` vs 文件 `h$_6 快捷键.md`） | `capture.ts` |
| 2 | **父级 MOC**：复合领域（`公考_判断推理`）由 `parentDomain`（末段 `_` 前缀）派生父域；子域 MOC 顶部 `上域：[[MOC-父域]]`；写子域 MOC 时同步重建 `MOC-父域`，列出全部兄弟子域 MOC | 公考两篇图谱分离（异域无结构链） | `capture.ts` / `obsidianLoader.ts` |

**不做**（注明理由）：
- 同系列（同 bvid）笔记互链 / 系列 hub —— 本期不做。父级 MOC 已覆盖"同父域跨子域"的断链场景（公考 p22/p26）；同系列跨父域（如一课兼前端+公考）极少见，待真机出现再补。
- 跨域 broader / 虚根概念节点 —— 易造空洞虚根污染概念库（SPEC-19 N-2 复核已论证）。
- 旧库内容回溯修复 —— 用户自行清空重建。
- 标签图谱（`upsertDomainTag` 已注入 `公考` 父标签）—— 已存在，不动。

## 3. 执行方案

| # | 子任务 | 交付物 | 预估 |
|---|--------|--------|------|
| 20.1 | `wikiLink` 出口 + 概念链接/上位概念两处改用 | capture.ts + tests | 0.25d |
| 20.2 | `parentDomain` / `parentMocPath` / `buildParentMocMarkdown`；子域 MOC 加上域行 | capture.ts + tests | 0.25d |
| 20.3 | obsidianLoader：写子域 MOC 后同步重建父级 MOC | obsidianLoader.ts + tests | 0.25d |
| 20.4 | 门禁 G1/G2/G3 + 执行记录 | — | 0.1d |

每个子任务验收通过即 commit：`<type>(spec-20): <摘要>`。

## 4. 验收标准

- [ ] A1 [自动] `wikiLink('h$*6 快捷键')` → `[[h$_6 快捷键|h$*6 快捷键]]`；`wikiLink('加强论点')` → `[[加强论点]]`（无需别名）
- [ ] A2 [自动] `buildConceptLinksBlock` 产出的每条概念 wikilink，其目标与 `conceptNotePath` 落盘名一致（含非法字符名）
- [ ] A3 [自动] `buildConceptPageMarkdown` 的 `上位概念：` wikilink 目标 = 该 broader 概念的落盘名
- [ ] A4 [自动] `parentDomain`：`公考_判断推理`→`公考`、`公考_判断推理_图形`→`公考_判断推理`、`前端开发`→``
- [ ] A5 [自动] `buildMocMarkdown` 对复合领域产出 `上域：[[MOC-父域]]`；单段域无此行
- [ ] A6 [自动] `buildParentMocMarkdown` 列出全部同父域子域的 `[[MOC-子域]]`，无父域时调用方不写
- [ ] A7 [自动] G1 test + build 全绿；G3 redlines + prompts 通过；执行记录已追加
- [ ] A8 [人工] 清空重建后：概念 wikilink 在 Obsidian 中可点击跳转（含 `h$*6` 类特殊名）；公考两篇经 `MOC-公考` 在图谱中连通

## 5. 风险与回滚

- 风险：wikilink 带别名后 markdown 观感略长。应对：sanitize 后与原名一致时省略别名（`wikiLink` 内分支）。
- 风险：父级 MOC 覆盖式重建会丢手写内容。应对：与子域 MOC 同语义（生成文件，标注"由扩展生成"）；AGENTS.md 目录契约已约定 MOC 为生成物。
- 回滚：`git revert` 对应 commit。

## 6. 执行记录（append-only）

| 日期 | 执行者 | 变更摘要 | 自测结果 | commit |
|---|---|---|---|---|
| 2026-10-22 | 父 agent | 20.1 wikiLink 出口 + 概念链接/上位概念改用；20.2 parentDomain/mocFileName/buildParentMocMarkdown + 子域 MOC 上域行；20.3 obsidianLoader writeParentMocIfAny（存入/修复两路） | capture-wiki 新增 13 例全过 | （本条 commit） |
| 2026-10-22 | 父 agent | 20.4 门禁：vitest 74 文件 1273 例全绿（2 worker 45.7s）；build 4.7s；redlines/prompts 过。附带修复存量 flaky：frame-budget.test.ts 动态 import 冷加载撞 5s 单测超时（真机 6~48s），改静态 import 后该文件 13 例 0.54s | 门禁三件套全绿 | （同上） |
