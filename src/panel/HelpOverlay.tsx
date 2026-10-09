/**
 * 面板内帮助浮层（SPEC-10 10.9）：三步上手 / 各 Tab 说明 / 数据与隐私 / FAQ。
 * 纯展示组件（renderToString 可测）；样式复用 notes.css 的弹窗遮罩体系。
 */
import './help.css';

export const HELP_STEPS: Array<{ title: string; body: string }> = [
  {
    title: '① 配置模型（只做一次）',
    body: '到 DeepSeek 或阿里云百炼注册并充值，创建一个 API Key，粘贴到本扩展「设置 → 模型配置」。详细步骤见 README 的「快速上手」。',
  },
  {
    title: '② 打开一个 B 站教学视频',
    body: '字幕会自动加载（UP 主字幕优先，无则用 AI 字幕；都没有可手动粘贴）。',
  },
  {
    title: '③ 生成大纲 → 导图 → 随时提问',
    body: '先「生成大纲」看清结构；导图把章节重组成知识流程；学习中卡住就在问答里直接问，答不上可以贴题目截图（需多模态模型）。',
  },
];

export const HELP_TABS: Array<{ name: string; body: string }> = [
  { name: '字幕', body: '三级采集瀑布：UP 主字幕 → 平台 AI 字幕 → 手动粘贴。AI 字幕可一键加标点顺句。' },
  { name: '大纲', body: '按字幕生成章节与要点，时间戳可点击跳播；可记笔记（整章/要点/时间点三种锚点）；支持导出分享、导入他人大纲。' },
  { name: '导图', body: '把大纲重组为「阶段 → 概念」知识流程图，播放跟随高亮；概念图/时间轴多种视图。' },
  { name: '问答', body: '划词解释、区间问答、自由提问；带 5 轮对话记忆；回答里的时间戳可跳播；支持题目截图。' },
  { name: '存入 Obsidian', body: '配置了 Obsidian 落进你的知识库；没配置也能一键下载 .md 到本地（自带来源与标签，放进任何笔记软件都能检索）。' },
];

export const HELP_FAQ: Array<{ q: string; a: string }> = [
  { q: '生成要多久、要花多少钱？', a: '大纲按视频长度分块生成，通常 20~90 秒；费用由你的模型按 token 计费，一集视频通常几分钱。验证期报告里有 token 与费用估算。' },
  { q: '我的数据存在哪里？', a: '全部在本机浏览器（IndexedDB），没有账号、没有服务器。清缓存前请到「设置 → 数据管理」导出备份。' },
  { q: '支持哪些视频？', a: 'B 站有字幕的教学视频效果最好（含 AI 字幕）；无字幕视频可手动粘贴文稿。手机端 B 站 App 不支持浏览器扩展。' },
  { q: '生成失败了怎么办？', a: '常见原因：模型输出格式不稳（换更稳定的模型）、Key 额度不足、网络代理拦截。「设置 → LLM 交互日志」里能看到每次请求的详情。' },
];

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="help-overlay" onClick={onClose}>
      <div className="help-modal" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="help-title">使用帮助</span>
          <button type="button" className="help-close" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <h4>三步上手</h4>
        <ol className="help-steps">
          {HELP_STEPS.map((s) => (
            <li key={s.title}>
              <b>{s.title}</b>
              <span>{s.body}</span>
            </li>
          ))}
        </ol>
        <h4>各 Tab 能做什么</h4>
        <ul className="help-tabs-list">
          {HELP_TABS.map((t) => (
            <li key={t.name}>
              <b>{t.name}</b>
              <span>{t.body}</span>
            </li>
          ))}
        </ul>
        <h4>数据与隐私</h4>
        <p className="help-privacy">
          本扩展不设账号、不上传你的数据：字幕/大纲/笔记/问答全部存在本机；模型请求用你自己的
          API Key 直连对应服务商；公开资料检索走 DuckDuckGo；Obsidian 同样是你本机的服务。
        </p>
        <h4>常见问题</h4>
        <ul className="help-faq">
          {HELP_FAQ.map((f) => (
            <li key={f.q}>
              <b>{f.q}</b>
              <span>{f.a}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
