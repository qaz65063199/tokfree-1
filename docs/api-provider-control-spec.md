# control 模块规格：本地聊天页（api-chat.html / api-chat.js）

## 背景
tokfree 新增 API 型 provider（id: `api-openai`，mode: 'api'），其 homeUrl 指向本地页
`src/ui/api-chat.html`。该页在 webview 中被加载，preload 已自动注入（与其它平台一致）。

## 目标
实现一个自包含的聊天页，渲染出符合 provider 选择器的 DOM，从而让 tokfree 的
observer.js / 工具执行 / 看门狗 / 多 Agent 全部自动复用。

## 硬性约束（不要违背）
1. **不改任何现有文件**（除本模块要求的两个新文件）。避免影响现有平台。
2. 页面内**不要**直接用 fetch 调外部 API（会撞 CORS）；统一通过
   `window.electronAPI.apiProviderRequest(...)`（由 control 模块的 IPC 接线提供）。
3. DOM 结构必须包含：
   - 输入框 `#api-chat-input`（textarea）
   - 发送按钮 `#api-chat-send`（button）
   - 状态元素 `#api-chat-status`，生成中设 `data-generating="true"`，空闲设 "false"
   - 消息区：每条消息一个节点，用户消息 `data-role="user"`，
     AI 消息 `data-role="assistant"`，AI 消息正文内含 `.markdown` 容器
4. AI 回复的代码块用标准 `<pre><code class="language-xxx">` 结构，保证 tokfree 能识别 tokfree 代码块。
5. 提供配置区：baseUrl（默认 http://localhost:3000/v1）、authKey、模型名、生图开关。
   配置存 localStorage（按 partition 隔离）。

## 关键交互
- 发送：把用户输入渲染成 user 消息；调用 apiProviderRequest 请求
  `{baseUrl, path:'/chat/completions', authKey, stream:true, body:{model, messages, stream:true}}`；
  解析返回的 SSE 文本，增量渲染到 assistant 的 .markdown 容器；完成后设 data-generating="false"。
- 生图：走 `/images/generations`，把 b64/url 渲染成 `![img](...)` markdown。
- 错误：渲染为 assistant 消息（便于 tokfree 解析），同时状态置 false。

## 交付物
- `src/ui/api-chat.html`（含样式，可参考 src/ui/design-tokens.css 变量）
- `src/ui/api-chat.js`

## 验收
- 页面在无后端时给出可读错误，不白屏
- DOM 结构符合上面第 3 条（用 DevTools 能查到对应 id / data-role）
