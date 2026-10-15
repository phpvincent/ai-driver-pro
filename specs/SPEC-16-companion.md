# SPEC-16 · 本地知识库 companion 程序（剥离 Obsidian 运行时依赖）

- 状态：**施工中**（2026-10-15 立项；用户三项决策已确认）
- 依赖：SPEC-06（Obsidian 沉淀）、SPEC-15（知识库检索）
- 验收 tag：`spec-16-accepted`

## 1. 用户决策（2026-10-15）

- 痛点：新用户要装 Obsidian + Local REST API 插件 + 开 HTTP 模式，门槛太高（同事实测踩坑：新版插件默认只开 HTTPS）
- 方案：提供**本地 companion 程序**——用户运行后扩展即可保存/检索个人知识库；文件仍是 md，装了 Obsidian 的用户可直接打开该目录为 vault
- 决策 ①：**单二进制**（bun compile，Windows/macOS，零依赖双击即用）
- 决策 ②：**并存**——companion 为默认引导，Obsidian 直连保留为高级选项（同一套协议），未配置时下载 .md 兜底不变
- 决策 ③：端口 **28123**（避开 Local REST API 的 27123/27124），数据目录 **~/vsc-knowledge**

## 2. 架构

```
扩展（几乎零改动）              companion（新增）                    本地目录
PUT /vault/{path}        →     零依赖 HTTP 服务            →      ~/vsc-knowledge/
GET /vault/{path}        →     127.0.0.1:28123                    ├─ 视频笔记/*.md
GET /vault/（列目录）     →     Bearer <key>                       ├─ 术语/*.md
GET /vault/index.json    →     md 落盘（自动建父目录）             └─ index.json / index.md
（检索在扩展内跑，逻辑不动）
```

- **协议 = Local REST API 子集**：companion 实现 `PUT/GET /vault/{path}` + `GET /vault/`；
  扩展现有 obsidian sink（src/sinks/obsidian.ts）原样工作——companion 与 Obsidian 直连共用一套代码
- **检索不动**：知识库检索 = 扩展拉取 index.json 后本地 searchIndex，companion 只需能读任意 vault 文件
- **md 格式不变**：与现有 buildVideoNoteMarkdown 完全一致，Obsidian 用户 Open folder as vault 即接管

## 3. companion 设计

- TypeScript 单文件（companion/src/companion.ts），**零运行时依赖**（node:http + node:fs），
  bun compile 打成单二进制（companion-win64.exe / companion-macos）
- 监听 `127.0.0.1:28123`（仅回环，不出本机）
- 鉴权：首次启动生成随机 API Key → 存 `~/vsc-knowledge/.vsc-key` + 控制台打印（用户粘贴到扩展设置）
- 数据目录：默认 `~/vsc-knowledge`；环境变量 `VSC_KNOWLEDGE_DIR` 可覆盖
- 接口：
  - `GET /vault/` → 根目录 JSON 列表（测试连接显示条目数用）
  - `GET /vault/{path}` → 读文件（404 带清晰 message）
  - `PUT /vault/{path}` → 写文件，自动建父目录
  - 其余 → 404；鉴权失败 → 401
- 路径安全：vaultPath 解码后禁止 `..` 逃逸（防目录穿越）

## 4. 扩展侧改动

- config：`COMPANION = { baseUrl: 'http://127.0.0.1:28123', downloadUrl: <GitHub Releases> }`（红线 9）
- manifest：host_permissions 加 `http://127.0.0.1:28123/*`（固定授权，免用户手动）
- 设置页「Obsidian 配置」→「知识库同步」：默认指引 = companion（下载运行 → 复制控制台 Key → 粘贴）；
  Obsidian 5 步指引保留为折叠高级选项；接口地址 placeholder 改 companion 默认
- 存入/检索逻辑零改动（同协议）

## 5. 验收

- [A] 自动：companion HTTP 行为单测（写/读/列目录/鉴权/穿越防护/自动建父目录）
- [B1] 运行 companion → 扩展测试连接成功（显示 vsc-knowledge 条目数）
- [B2] 存入视频笔记/术语卡 → ~/vsc-knowledge/ 出现 md；Obsidian 打开该目录可浏览全部内容
- [B3] 问答触发知识库检索命中 companion 保存的笔记
- [B4] 旧 Obsidian 直连用户不受影响（填 27123 地址照常工作）
