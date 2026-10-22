# SPEC-21 · 并发与内存边界加固

- 状态：待验收（21.1-21.5 施工完成，自动门禁全绿）
- 依赖：SPEC-20（wikilink/图谱结构链，已交付）
- 对应里程碑：MX（稳定性）
- 验收 tag：`spec-21-accepted`
- 起因：`vsc-knowledge/全量代码审查-2026-10-22.md` 设计风险 R1–R3

## 1. 用户约束

只修并发与内存边界三处设计风险；不改蒸馏语义、不改产物格式。

## 2. 目标与范围

**做**（全部确定性实现，零新增模型调用）：

| # | 交付物 | 对应风险 | 文件 |
|---|--------|----------|------|
| 1 | **genMutex 真互斥**：`withGenMutex` 忙时**排队等待**而非放行（保持 isGenBusy 语义）；canvas 路径经同一入口，大纲/画布跨任务不再并发抢 seek | R1（中） | `genMutex.ts` / `canvasLoader.ts` |
| 2 | **索引写串行化**：`saveVideoNoteToObsidian`/`saveTermCardToObsidian` 的 readIndex→writeIndex 走同一 promise 队列，并发触发不丢条目 | R2（中低） | `obsidianLoader.ts` |
| 3 | **dialogueMemory LRU 上限**：store 按 videoId 容量上限 20，超限挤出最久未访问 | R3（低） | `dialogueMemory.ts` |

**不做**：
- 蒸馏语义 / 产物格式变更 —— 归 SPEC-18/19 语义域，本 spec 不碰。
- 旧库内容迁移 —— 用户清空重建。
- 全局状态外置到 storage —— 会话内内存态已够用（切 Tab 不卸载 panel 容器的场景由模块级 state 覆盖）。

## 3. 执行方案

| # | 子任务 | 交付物 | 预估 |
|---|--------|--------|------|
| 21.1 | withGenMutex 排队互斥 + 排队上限防御 | genMutex.ts + tests | 0.25d |
| 21.2 | canvasLoader 收敛到 withGenMutex（已有），补前置 isGenBusy 语义；验证 outline 路径不受影响 | canvasLoader.ts + tests | 0.1d |
| 21.3 | obsidianLoader 索引写 promise 队列（withIndexLock） | obsidianLoader.ts + tests | 0.25d |
| 21.4 | dialogueMemory LRU（容量 20，Map 保序 → 访问时 re-insert） | dialogueMemory.ts + tests | 0.1d |
| 21.5 | 门禁 G1/G2/G3 + 执行记录 | — | 0.1d |

每个子任务验收通过即 commit：`<type>(spec-21): <摘要>`。

## 4. 验收标准

- [ ] A1 [自动] `withGenMutex`：并发 2 个任务**串行执行**（前一个完成后才开始第二个），期间 `isGenBusy()` 恒为 true
- [ ] A2 [自动] `withGenMutex`：任务抛错后锁释放，后续任务可继续（不卡死）
- [ ] A3 [自动] 大纲 + 画布并发触发：不同时执行（同一时刻最多一个在飞）
- [ ] A4 [自动] `saveVideoNote` + `saveTermCard` 并发：索引最终含两者条目（不丢）
- [ ] A5 [自动] dialogueMemory：写入 25 个 videoId 后 store 容量 ≤ 20，最旧的被挤出，新的保留
- [ ] A6 [自动] G1 test + build 全绿；G3 redlines + prompts 通过；执行记录已追加

## 5. 风险与回滚

- 风险：排队互斥改变原有"立即执行"语义，若有代码依赖 fire-and-forget 会变慢。应对：所有调用方本来就是 await 生成任务，串行只是等待而非丢弃。
- 风险：LRU 挤出后换视频回来丢上下文摘要。应对：容量 20 覆盖一个会话常见视频数；且 `setDialogue`/`clearDialogue` 是显式管理入口。
- 回滚：`git revert` 对应 commit。

## 6. 执行记录（append-only）

| 日期 | 执行者 | 变更摘要 | 自测结果 | commit |
|---|---|---|---|---|
| 2026-10-22 | 父 agent | 21.1 withGenMutex 改 promise 链排队真互斥（忙时排队非放行）；21.2 canvas 已在同一锁内，跨任务互斥由 21.1 覆盖；21.3 withIndexLock 串行化 saveVideoNote/saveTermCard/repairKnowledgeHealth 的索引读改写；21.4 dialogueMemory LRU（上限 20，mem() 统一入口，setDialogue 不再绕过） | 新增 concurrency-hardening 6 例全过 | （本条 commit） |
| 2026-10-22 | 父 agent | 21.5 门禁：vitest 76 文件 1293 例全绿；tsc --noEmit 全绿；build 4.7s；redlines/prompts 过 | 门禁三件套全绿 | （同上） |
