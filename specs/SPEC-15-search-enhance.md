# SPEC-15 · 公开资料检索增强（路由 + Tavily + Wikipedia 三级瀑布）

- 状态：**待验收**（2026-10-13 施工完成；[自动] 过，[人工] B1~B3 待冒烟）
- 依赖：SPEC-05（问答公开资料注入）
- 验收 tag：`spec-15-accepted`

## 1. 用户决策（2026-10-13）

- 问答前先判断"这题需要外部资料吗"（路由）再检索
- 检索源 = 博查 Bocha API（用户 Key，微信注册免费领 1000 次，国内直连）+ Wikipedia 中文 API（免 Key）
- 设置页 Key 配置处加博查开放平台链接与获取指引
- 2026-10-13 变更：Tavily 需国际信用卡，面向国内用户不可行 → 全量替换为博查

## 2. 设计

- **路由 shouldSearchWeb（纯函数）**：术语解释必检；含时新/外部词（最新/版本/发布/官网/新闻/价格…）必检；其余仅当知识库与字幕都无命中才检（课内无依据）。省请求、防噪音、护隐私
- **并行检索（2026-10-13 六轮，用户决策）**：博查 + Wikipedia + DDG 三路**同时**发（原为瀑布：上层空手才轮到 DDG），组装按优先级排序 博查→Wikipedia→DDG（trimSnippets 按预算从头装，DDG 只补余量；冷门词前两级空手时 DDG 已在途不用再等一轮）。全程静默降级。
- **博查**：POST /v1/web-search（Bearer Key，summary=true，max 5 条）；失败/无 Key 静默跳过。响应形状为 `{code, msg, data:{webPages:{value[]}}}`（2026-10-13 实测修正：初版误读根级 webPages 导致"测试连接"误报失败与检索静默空结果；同时校验 body.code ≠ 200 按失败处理）
- **Wikipedia 中文**：MediaWiki action=query&list=search（免 Key，srlimit=2，剥 HTML 标签）
- **设置页**：搜索增强（可选）独立区段：密码输入 + 独立「保存」与「测试连接」按钮（2026-10-13 三轮：从 Obsidian 区段拆出防误点；测试连接用当前表单 Key 发一次真实检索，消耗 1 次额度）+ 博查开放平台链接（open.bochaai.com/api-keys，API Key 管理）+ 免费额度领取链接（open.bochaai.com/package/purchase，微信扫码注册免费领 1000 次试用包，无需信用卡）+ 获取步骤提示
- 端点全部来自 config 常量（红线 9）；检索内容仍受 webContextMaxChars 预算（红线 3）
- 可观测性（2026-10-13 五轮）：检索请求（博查/Wikipedia/DDG）写入 LLM 交互日志（label `web-search`，不设 inputTokens 故不进费用汇总）；explain 两次 Schema 校验失败经 onValidationError 回调补一条 ok=false 的 qa 日志（请求本身 HTTP 成功，chatCompletion 只记 ok=true，不补则日志"看不到失败原因"）；referencedTimestamps 上限 6→12（检索增强后素材更密，紧上限导致整次回答失败，segment-qa.md 0.3.1）

## 3. 验收

- [A] 1150 例全绿（+7：路由三态/Tavily 解析/Wikipedia 解析/URL 构造）
- [B1] 未配 Key：概念型问题（如"类比推理是什么"）回答带 Wikipedia 来源
- [B2] 配置博查 Key 后：时效性问题（如"xx 最新版本"）回答质量明显提升，来源区显示网页结果
- [B3] 课内有依据的问题（问章节内容）不再发起外部请求（Network 面板无 wikipedia/tavily）
- [B4] 设置 → 搜索增强：「购买资源包」链接可点开（open.bochaai.com/package/purchase）；粘贴 Key 后点「测试连接」显示连接成功（消耗 1 次额度）；空 Key 点测试有提示
- [B5] 问答触发检索时 LLM 日志出现 label 为 `web-search` 的条目（bocha/wikipedia，含检索词与结果标题）；Schema 校验两次失败时日志出现 ok=false 的 qa 条目（错误详情可见）；referencedTimestamps 上限放宽后不再因「Too big: <=6 items」整次失败
