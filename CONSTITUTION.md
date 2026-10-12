# 施工宪法 · video-study-copilot

> 本文件是项目施工的最高治理文档，所有参与本项目的 agent（父/子）与用户验收环节必须遵守。
> 与其他文档（含 TECH-DESIGN.md）冲突时，以本宪法为准。

- 版本：v1.2（2026-10-01，新增红线 11 可移植性；更新 spec 索引。v1.1：2026-09-30 依据 `reviews/AUDIT-2026-09-30.md` 修订）
- 代码仓库：`git@github.com:phpvincent/ai-video-driver.git`，主分支 `main`

## 0. 效力与变更

- 宪法由父 agent 维护；修改必须走 §8 变更流程并记入迭代日志。
- 子 agent 无权修改宪法、TECH-DESIGN.md、共享契约文件（§4）及其他 spec 的任何内容。

## 1. 角色与权责

| 角色 | 职责 | 禁止事项 |
|---|---|---|
| **父 agent（总控）** | 拆解与派发任务、执行 [自动]/[半自动] 验收、生成 [人工] 验收清单并判定门禁、维护治理文档与共享契约、提交与打 tag | 不直接编写大段业务代码（单点修复除外） |
| **子 agent（执行）** | 按派发包完成单个交付物：写代码、写测试、追加执行记录、按格式回报 | 修改派发包"允许修改清单"以外的文件；修改治理文档与共享契约 |
| **用户（最终验收人）** | 执行 [人工] 验收项并回报结果；拍板决策事件与 SPEC-07 验证结论 | — |

## 2. 工作流（spec 驱动，无 spec 不施工）

1. **无 spec 不开工**：任何代码变更必须归属某个 spec；不属于任何 spec 的需求，先由父 agent 立 spec。
2. **结构统一**：spec 必须按 `specs/_SPEC_TEMPLATE.md` 编写，同时具备执行方案、验收标准、执行记录三要素才可开工。
3. **执行记录 append-only**：只追加、不删改历史条目；每条含日期 / 执行者 / 变更摘要 / 自测结果 / 关联 commit。
4. **状态机**：`待开工 → 进行中 → 待验收 → 已验收`；打回回到 `进行中` 并记录原因。
5. **完成定义（DoD）**：代码 + 测试 + 执行记录 + 本地 commit 四者齐备，才可提交验收。

## 3. 验收把关

### 3.1 验收项分级

spec 的每条验收项必须标注执行方式：

| 标注 | 执行者 | 适用场景 |
|---|---|---|
| **[自动]** | 父 agent 直接运行 | 构建、单测、红线检查脚本、fixture 回放测试 |
| **[半自动]** | 父 agent 用浏览器自动化加载扩展执行 | 不依赖 B 站登录态的界面与交互 |
| **[人工]** | 用户按父 agent 生成的清单操作并回报 | 需要登录态、真实观感、性能手感、主观质量评分 |

### 3.2 铁律

1. **不信任汇报，只信任运行**：[自动]/[半自动] 项由父 agent 亲自执行；[人工] 项以用户回报为准。任何一项都不得以子 agent 自述代替。
2. **三道硬门禁，任一不过即打回**：
   - **G1 构建与测试**：`npm run build` 零错误，`npm test` 全绿；
   - **G2 验收标准**：spec 验收项逐条通过并逐条记录结果；
   - **G3 技术红线**：`npm run check:redlines` 通过，且父 agent 审查 `git diff <上一个验收 tag>..HEAD` 无红线违背。
3. **打回必须留痕**：在 spec 执行记录中写明失败门禁、原因、期望修复方向。
4. **验收通过后**：更新 spec 状态 → 打 tag `spec-XX-accepted` 并推送 → 追加迭代日志 → 必要时同步项目长期记忆。

## 4. 派发原则与共享契约

- **派发粒度**：一个 spec 内的一个可独立验证的交付物，不是整个 spec 打包。
- **派发包**：每次派发必须按 `specs/_DISPATCH_TEMPLATE.md` 生成，至少包含允许修改的文件清单、红线全文、相关设计原文摘录、DoD 与回报格式。子 agent 看不到主对话，派发包必须自足。
- **并行**：仅限无依赖的 spec（SPEC-04 ∥ SPEC-05）；并行的 spec 各自只拥有自己的目录。
- **共享契约**：`src/types.ts`（数据类型）、`src/messages.ts`（消息协议）、`src/config/`（常量与端点）由 SPEC-01 一次性定义，**只能由父 agent 修改**；子 agent 需要变更时在回报中提出需求。
- **路径约定**：产出必须落在 TECH-DESIGN.md §9 约定的路径，不得自造目录。

## 5. 版本控制

1. 每个子任务验收通过即 commit，提交信息格式：`<type>(spec-XX): <摘要>`，type ∈ feat / fix / test / docs / refactor / chore。
2. 每个 spec 验收通过打 tag `spec-XX-accepted`，G3 的 diff 审查以上一个 tag 为基线。
3. 禁止 force push `main`；禁止提交密钥、cookie、未清洗的接口录制（`tests/fixtures/raw/` 已排除）。
4. 回滚：未验收的子任务用 `git revert <commit>`；已验收的 spec 回滚到对应 tag 并记入迭代日志。

## 6. 技术红线（违背任一条，验收直接打回）

| # | 红线 | 检查方式 |
|---|---|---|
| 1 | 大纲生成必须是**确定性 pipeline**（分段 map-reduce），禁止改为 agentic loop；密度等派生指标由代码确定性计算 | pipeline 单测 + diff 审查 |
| 2 | 章节时间戳必须**吸附到真实 Cue 边界**，超阈值的幻觉时间戳丢弃或重试，禁止直接采信模型输出 | 吸附算法单测 |
| 3 | 提问上下文**禁止喂全量字幕**，只允许：全局章节列表 + 命中区间原文 + 上轮摘要 | 上下文编译器单测断言 |
| 4 | 所有模型输出必须过 **Zod Schema 校验**，失败自动重试一次 | pipeline 单测 |
| 5 | 字幕解析**禁止丢弃时间戳**，禁止合并为纯文本（与 ai-knowlage 的方向性差异，见 TECH-DESIGN §14.1） | 全部解析器单测断言输出含 startMs/endMs |
| 6 | **prompt 单一事实源**：运行时 prompt 正文只存在于 `src/prompts/*.md`，`.agents/skills/` 只能引用、禁止复制 | `npm run check:prompts` |
| 7 | 缓存分两层失效：字幕层按 `videoId + 字幕来源`，大纲层携带 `promptVersion + model`，升级后定向失效 | 缓存单测 |
| 8 | 采集瀑布每级必须返回 `(Cue[], status)`，**失败不抛异常**，降级到下一级 | 瀑布单测 + fixture 回放 |
| 9 | **禁止硬编码**：API key、模型标识、平台接口 URL/正则只允许出现在 `src/config/` | `check:redlines` grep 规则 |
| 10 | **API key 与模型调用禁入 content script**：`src/content/` 不得引用 modelConfig / apiKey / 模型客户端 | `check:redlines` grep 规则 |
| 11 | **可移植性**：任何功能都要考虑未来移植到其他浏览器（360 / QQ / Edge 等 Chromium 系，以及 Firefox）的场景。①**新增**的浏览器平台调用（`chrome.*` 中除 `runtime` 消息与 `storage` 以外的能力，如 `sidePanel` / `permissions` / `tabs` / `downloads` / `action`）只能写在 `src/platform/` 适配层，业务代码通过适配层调用；②适配层对"能力不存在"必须有降级路径，不得直接抛错白屏；③`core/` 保持零 `chrome.*` 依赖；④存量调用在触碰到对应文件时顺带迁移，不做一次性大搬迁 | `check:redlines` R11 规则（SPEC-08 落地）+ diff 审查 |

## 7. 文档同步义务

- 每次验收通过 → 当日追加 `ITERATION-LOG.md`。
- 技术决策变更（选型、数据结构、接口契约）→ 修改 TECH-DESIGN.md 对应章节 + 迭代日志记录理由。
- **决策扇出检查**：每条"决策"或"变更"类迭代日志必须附"受影响文档"清单，并逐个确认已修改后才可标记完成。
- 暂不实现的方向与 idea → `EVOLUTION-ROADMAP.md`。
- 长期有效的项目事实 → 同步项目长期记忆（MEMORY.md）。

## 8. 变更流程

- **宪法/红线修改**：父 agent 发起 → 迭代日志记录修改内容、理由、日期与受影响文档 → 方生效。
- **spec 范围变更**：在原 spec 追加"范围变更记录"条目，不删除原文。
- **紧急修复**（阻断性问题）：允许先修复后补记录，24 小时内补齐 spec 执行记录与验收。

## 9. spec 索引与依赖图

```
SPEC-01 骨架 ─► SPEC-02 字幕瀑布 ─► SPEC-03 大纲 ─┬─► SPEC-04 导图 ─┐
                                                 └─► SPEC-05 问答 ─┴─► SPEC-06 知识沉淀 ─► SPEC-08 MVP 收口 ─┬─► SPEC-07 MVP 验证期（真实使用）
                                                                                               └─► SPEC-09 大纲笔记与交换格式
```

| Spec | 标题 | 依赖 | 状态 |
|---|---|---|---|
| SPEC-01 | 工程骨架、共享契约与质量工具链 | — | 已验收（spec-01-accepted） |
| SPEC-02 | 字幕采集瀑布与字幕 Tab | SPEC-01 | 已验收（spec-02-accepted） |
| SPEC-03 | 预读大纲 pipeline | SPEC-02 | 已验收（spec-03-accepted，2026-10-09 用户冒烟通过） |
| SPEC-04 | 思维导图与播放跟随 | SPEC-03 | 已验收（spec-04-accepted，2026-10-09；含三级匹配高亮修复） |
| SPEC-05 | 划词解释与区间问答 | SPEC-03 | 已验收（spec-05-accepted，2026-10-09 用户冒烟通过） |
| SPEC-06 | Obsidian 知识沉淀 | SPEC-04, SPEC-05 | 已验收（spec-06-accepted，2026-10-09；含 .md 降级与内容标签） |
| SPEC-07 | MVP 验证期 | SPEC-08 | 已验收（spec-07-accepted，2026-10-09 **真实使用 10/10 通过**，MVP 价值假设成立 → 继续，v0.2 按 EVOLUTION-ROADMAP 梯队推进） |
| SPEC-08 | MVP 收口与真机验证 | SPEC-06 | 已验收（spec-08-accepted，2026-10-09 冒烟 A~F 六组全过） |
| SPEC-09 | 大纲笔记与大纲交换格式 | SPEC-08 | 已验收（spec-09-accepted，2026-10-09 冒烟通过，含笔记弹窗/全局 ⏱ 等二轮反馈修复） |
| SPEC-10 | 公网发布产品化（P0/P1 批次） | SPEC-09 | 已验收（spec-10-accepted，2026-10-09 F 组冒烟通过）；剩余发布动作 = CWS 提交 + 仓库 public（见 EVOLUTION-ROADMAP §0） |
| SPEC-11 | 抽帧页聚类精修（本地扫描+dHash 页聚类+清晰度选帧） | SPEC-05 | **待验收**：纯函数层/content 轻量扫描/panel 并行接线全部完成（1104 例 +23）；[人工] B1/B2 待冒烟 |
| SPEC-12 | 生成进度反馈与扫描预算设置 | SPEC-11 | **待验收**：progressBus/扫描进度链路/分块与阶段进度/预算设置项/进度条 UI 全部完成（1115 例 +8）；[人工] B1~B3 待冒烟 |
| SPEC-13 | AI 自由画布（思维导图 + 流程图） | SPEC-04 | **待验收**：freeCanvas 纯函数 + 双 prompt + markmap/mermaid 渲染 + 纠错重试（1130 例全绿，CSP 零 eval）；[人工] B1~B3 待冒烟 |
| SPEC-14 | 引用问答+上下文增强+记忆升级 | SPEC-12 | **待验收**：persona 简述/记忆 store+滚动压缩/引用链路/胶囊 UI 完成（1143 例 +7）；[人工] B1~B4 待冒烟 |
| SPEC-15 | 公开资料检索增强（路由+Tavily+Wikipedia） | SPEC-05 | **待验收**：shouldSearchWeb 路由/三级瀑布/设置页 Key+指引完成（1150 例 +7）；[人工] B1~B3 待冒烟 |
| SPEC-14 | 引用问答+上下文增强+记忆升级 | SPEC-12 | **待验收**：persona 简述/记忆 store+滚动压缩/引用链路/胶囊 UI 完成（1143 例 +7）；[人工] B1~B4 待冒烟 |
| SPEC-15 | 公开资料检索增强（路由+Tavily+Wikipedia） | SPEC-05 | **待验收**：shouldSearchWeb 路由/三级瀑布/设置页 Key+指引完成（1150 例 +7）；[人工] B1~B3 待冒烟 |
