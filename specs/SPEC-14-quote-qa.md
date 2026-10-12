# SPEC-14 · 大纲要点引用问答 + 问答上下文增强 + 记忆升级

- 状态：**待验收**（2026-10-13 施工完成；[自动] 过，[人工] B1~B4 待冒烟）
- 依赖：SPEC-09（笔记 UI 挂点）、SPEC-12（composer/progressBus）
- 验收 tag：`spec-14-accepted`

## 1. 用户确认的方案

1. **「记 / 问」整合按钮**：要点行单按钮 → 迷你菜单（记一条笔记 / 带上下文提问）
2. **引用问答**：携带要点原文 + 章节（标题/摘要/时间/术语）+ 视频标题 + **视频简述（persona 判定顺产，方案 B）**跳转问答 Tab；引用条可移除；区间自动设为章节范围
3. **问答 UI 瘦身**：时间窗口收进胶囊按钮（平时只显示当前窗口，点击弹浮层重选：±30s/整章/自定义/引用章节）；角色条收为胶囊
4. **每次问答上下文增强**：视频简述 + 全部章节目录（标题+摘要，标注聚焦章节）
5. **记忆升级（并入本次）**：切 Tab 失忆修复（记忆外置模块级 + 从 qaHistory 重建）+ 滑窗升级滚动摘要（超出 5 轮的旧轮合并进会话摘要，小调用，失败降级为文本拼接）

## 2. 关键设计

- 视频简述：persona.md 0.2.0→0.3.0，JSON 输出加 `summary`（≤100 字全片简述）——与角色判定同一次调用，零额外请求；Persona 类型加 summary；升版自动失效旧缓存
- 引用/目录素材：explainLoader 组装为 `=== 课程背景 ===` / `=== 引用要点 ===` 分区（与文本附件同口径：不是指令）
- 记忆：`panel/dialogueMemory.ts` 模块级 store（videoId → {turns, summary}）；溢出触发 flash 小调用压缩，失败降级把旧轮 digest 追加进 summary（不丢信息）；ChatTab 挂载从 store 或 qaHistory 重建
- 范围联动：引用到达时 rangeMode 切 custom 并填章节时间（复用既有自定义机制）；用户仍可手动改

## 3. 验收

- [A] 自动：素材分区构造 / 记忆 store（压缩-降级-重建）/ pill 渲染断言
- [B1] 大纲要点 → 问 → 跳转问答 + 引用条 + 窗口锁定章节区间
- [B2] 引用后提问，回答明显基于该要点上下文
- [B3] 切 Tab 再回，追问仍记得先前对话（失忆修复）
- [B4] 超过 5 轮后旧轮进会话摘要（LLM 日志可见压缩调用）

## 4. 执行记录

| 日期 | 执行者 | 变更摘要 | 自测结果 | commit |
|---|---|---|---|---|
| 10-13 | 父 agent | 全量施工：① persona 0.3.0 输出加 summary（视频简述，与角色判定同调用零额外成本；Persona 类型/Schema/loader 透传）② dialogueMemory 模块级 store（窗口 5 轮 + 滚动摘要；溢出 flash 小调用压缩，失败降级文本追加；compactDialogue 在 loader 层）③ ChatTab 记忆 store 化 + 挂载从 store/qaHistory 重建（切 Tab 失忆修复）；会话摘要走 compiler prevSummary 通道 ④ explainLoader：courseBackgroundNote（标题/简述/目录/▶聚焦章）+ quoteNote（章节/时间/摘要/术语/要点）注入每次问答 ⑤ OutlineTab 要点「记」→⋯菜单（记笔记/带上下文提问）；App qaQuote 状态 + 切 chat Tab + 换视频清除 ⑥ ChatTab 引用条 chip + 引用到达自动切自定义区间填章节时间（可手改）+ 浮层含「引用章节区间」选项 ⑦ UI 瘦身：时间窗口与角色各收进胶囊按钮（浮层重选/重判），互斥展开 | 1143 例全绿（+7 qa-context：store 挤出/降级压缩/背景与引用素材）；persona 版本锁 0.3.0 | 本提交 |
| 10-13 | 父 agent | 修复：compactDialogue 压缩调用对思考模型不友好——maxTokens 300 被 reasoning 全部吃光（实测日志：finish_reason=length、reasoning_tokens=300、content 空→降级文本拼接）。改为 maxTokens 800 + thinking 强制 disabled（内部维护性调用不烧思考预算；端点不识别该字段时靠 token 余量兜底）。信息本就不丢（catch 降级），此修复恢复压缩质量 | 1153 例全绿 | 本提交 |
