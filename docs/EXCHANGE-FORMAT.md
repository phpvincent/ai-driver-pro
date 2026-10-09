# vsc-outline 交换格式 v1.0

> **对外契约**（SPEC-09 §3.1）：v1 发布后字段只增不改；不兼容变更必须升主版本号。
> 本文与 `src/core/exchange/vscOutline.ts` 的校验器逐字段一致，单测锁定本文示例能通过校验（A7）。

## 1. 文件约定

- 文件名：`{标题}.{bvid}_p{page}.vsc-outline.json`（标题经文件系统安全化）
- 编码：UTF-8 JSON
- 校验顺序：JSON 合法 → `format` / `version` → `checksum` → 结构（未知字段忽略）→ 视频身份 → 时间戳覆盖率（<90% 仅警告）
- 主版本号高于本地支持 → 拒绝导入并提示升级插件

## 2. 示例

```json
{
  "format": "vsc-outline",
  "version": "1.0",
  "exportedAt": "2026-10-01T12:00:00.000Z",
  "exporter": { "app": "video-study-copilot", "appVersion": "0.1.0" },
  "video": {
    "platform": "bilibili",
    "bvid": "BV15yxMeKELY",
    "page": 1,
    "cid": 123456,
    "title": "图形推理速通",
    "durationMs": 2574000,
    "url": "https://www.bilibili.com/video/BV15yxMeKELY?p=1"
  },
  "outline": {
    "promptVersion": "0.2.1",
    "model": "qwen-vl-plus",
    "sections": [
      {
        "id": "sec_0001",
        "title": "图形推理的观察方法",
        "startMs": 0,
        "endMs": 312000,
        "summary": "先观察图形的整体特征再推理规律类型。",
        "bullets": [
          { "id": "sec_0001-b1", "text": "先观察再推理", "startMs": 45000 },
          { "id": "sec_0001-b2", "text": "找规律类型", "startMs": 100000 }
        ],
        "terms": ["观察法", "规律类型"],
        "importance": 4
      }
    ]
  },
  "notes": [
    {
      "id": "n_0001",
      "anchor": { "kind": "bullet", "sectionId": "sec_0001", "bulletId": "sec_0001-b1", "tMs": 45000 },
      "body": "先观察再推理，考场上容易跳过观察这步",
      "createdAt": "2026-10-01T12:00:00.000Z",
      "updatedAt": "2026-10-01T12:00:00.000Z",
      "replies": [
        {
          "id": "r_0001",
          "author": "assistant",
          "body": "观察的顺序建议：先看整体形状，再看元素数量与位置关系。",
          "createdAt": "2026-10-01T12:00:05.000Z"
        }
      ]
    }
  ],
  "checksum": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
}
```

> 示例中的 `checksum` 为占位值；实际文件由导出方按 §3 规则计算。

## 3. 字段规则

### 3.1 顶层

| 字段 | 类型 | 说明 |
|---|---|---|
| `format` | `"vsc-outline"` | 固定值，标识本格式 |
| `version` | `"主.次"` 字符串 | 本文件为 `"1.0"`；导入端只比较主版本 |
| `exportedAt` | ISO 8601 | 导出时间 |
| `exporter` | `{ app, appVersion }` | 导出方应用标识 |
| `video` | 对象 | 视频身份，见 §3.2 |
| `outline` | 对象 | 大纲内容，见 §3.3 |
| `notes` | 数组 | 笔记（可为空数组 = 只分享大纲），见 §3.4 |
| `checksum` | `"sha256:<64位小写十六进制>"` | 覆盖除自身外的全部内容 |

### 3.2 `video` —— 视频身份

- **同一视频的判定 = `platform` + `bvid` + `page` 三者都相等**；不一致时导入拒绝，提示两个视频的标题与分 P
- `cid`、`durationMs` 作辅助校验（当前仅展示，不参与判定）
- `platform` 当前固定 `"bilibili"`

### 3.3 `outline.sections[]`

- 章节字段：`id` / `title` / `startMs` / `endMs` / `summary` / `bullets` / `terms` / `importance`
- **派生字段不导出**：`score`、`density`、`cueRange`、要点上的 `approximate`——导入时由本地字幕重新计算，避免把对方的算法版本带进来
- 要点 `id` 为合成 id：`` `${section.id}-b${序号}` ``（序号从 1 开始）
- `importance`：1-5 整数

### 3.4 `notes[]`

- `anchor.kind` ∈ `section` | `bullet` | `time`
- **每个锚点都带 `tMs`**（毫秒）——这是重新归位和跨版本导入的**唯一可靠依据**，创建后永不改写；`sectionId` / `bulletId` 只是加速提示
- `replies[].author` ∈ `self` | `assistant`（助教回答）
- `importedFrom`（可选）：导入他人文件时由导入端标记来源，与自己的笔记区分显示
- 正文为 Markdown 纯文本（v1 不做富文本）

## 4. checksum 算法

```
sha256( stableStringify( 文件对象去掉 checksum 字段 ) )
```

`stableStringify`：递归稳定序列化——对象键按码元顺序排序、数组保持原序、原始值走 `JSON.stringify`。与文件内的键书写顺序无关，保证导出方与导入方对同一内容得到相同哈希。

## 5. 兼容性

- **未知字段必须忽略**（向前兼容）：校验器按此实现
- 主版本号高于本地支持 → 拒绝导入并提示升级
- 时间戳覆盖率低于 90%（落在本地字幕范围外）→ 警告"字幕版本可能不同"，不拒绝
