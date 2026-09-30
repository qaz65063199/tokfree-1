# API 型 Provider 设计（接入 chatgpt2api）

## 目标
让 tokfree 能接入任意 OpenAI 兼容后端（chatgpt2api 号池等），复用现有对话/生图/工具执行/多Agent能力，且**不影响现有 5 个平台**。

## 核心原理
webview 统一注入 preload，observer.js 依赖 provider 的 DOM 选择器解析回复并执行 tokfree 代码块。
→ 只要本地渲染一个"聊天 DOM"，下游全部自动复用。

## 集成点（全部 additive，用 mode 标志守卫）
1. provider 新增字段 `mode: 'api'`（现有 provider 无此字段 → 走原逻辑）
2. `shell.js` createTab：`mode==='api'` 时 src 用 provider.homeUrl（=本地页 file://）
3. `src/main/ipc.js` 新增 `api-provider-request`：主进程代理 HTTP（无 CORS，密钥不落库）
4. 本地聊天页 `src/ui/api-chat.html`：输入框 + 消息区，渲染成 provider 选择器可解析的 DOM

## 数据流
用户输入 → api-chat 页 → IPC(api-provider-request) → 主进程 fetch(chatgpt2api /v1/chat/completions)
→ 流式回传 → 页面渲染 assistant 消息到 DOM → 现有 observer 检测完成 → 执行 tokfree 代码块 / 回传

## 密钥与配置
baseUrl / authKey 存页面 localStorage（按 partition 隔离），不改主进程设置、不落库。

## 生图
统一走 /v1/images/generations；页面把返回图渲染为 markdown 图片消息，复用现有画廊/下载。

## 回退
删掉/停用 API provider 即恢复原状；现有 provider 代码路径完全未改。

## 验收
- 现有 5 平台对话、工具执行、看门狗行为不变（回归）
- 选中 API provider 后：文本对话流式、生图、tokfree 代码块执行均正常
