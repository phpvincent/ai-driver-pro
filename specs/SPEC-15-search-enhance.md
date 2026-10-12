# SPEC-15 · 公开资料检索增强（路由 + Tavily + Wikipedia 三级瀑布）

- 状态：**待验收**（2026-10-13 施工完成；[自动] 过，[人工] B1~B3 待冒烟）
- 依赖：SPEC-05（问答公开资料注入）
- 验收 tag：`spec-15-accepted`

## 1. 用户决策（2026-10-13）

- 问答前先判断"这题需要外部资料吗"（路由）再检索
- 检索源 = Tavily API（用户 Key）+ Wikipedia 中文 API（免 Key）
- 设置页 Key 配置处加 Tavily 官网链接与获取指引

## 2. 设计

- **路由 shouldSearchWeb（纯函数）**：术语解释必检；含时新/外部词（最新/版本/发布/官网/新闻/价格…）必检；其余仅当知识库与字幕都无命中才检（课内无依据）。省请求、防噪音、护隐私
- **三级瀑布**：有 Tavily Key → Tavily + Wikipedia 并行合并；无 Key → Wikipedia；两者皆空 → DDG Instant Answer 兜底（现状）。全程静默降级不 throw
- **Tavily**：POST /search（Bearer Key，basic depth，max 5 条，已提取正文）；失败/无 Key 静默跳过
- **Wikipedia 中文**：MediaWiki action=query&list=search（免 Key，srlimit=2，剥 HTML 标签）
- **设置页**：搜索增强（可选）密码输入 + 官网链接（app.tavily.com，免费 1000 次/月，无需信用卡）+ 获取步骤提示；随知识库开关一并保存
- 端点全部来自 config 常量（红线 9）；检索内容仍受 webContextMaxChars 预算（红线 3）

## 3. 验收

- [A] 1150 例全绿（+7：路由三态/Tavily 解析/Wikipedia 解析/URL 构造）
- [B1] 未配 Key：概念型问题（如"类比推理是什么"）回答带 Wikipedia 来源
- [B2] 配置 Tavily Key 后：时效性问题（如"xx 最新版本"）回答质量明显提升，来源区显示网页结果
- [B3] 课内有依据的问题（问章节内容）不再发起外部请求（Network 面板无 wikipedia/tavily）
