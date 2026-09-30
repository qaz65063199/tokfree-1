# TokFree

<p align="center">
  <a href="https://github.com/qaz65063199/tokfree/releases/latest"><img src="https://img.shields.io/github/v/release/qaz65063199/tokfree?style=flat-square&color=8b93ff" alt="Latest Release"></a>
  <a href="https://github.com/qaz65063199/tokfree/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/qaz65063199/tokfree/build.yml?style=flat-square&label=Build" alt="Build Status"></a>
  <a href="https://github.com/qaz65063199/tokfree/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/qaz65063199/tokfree"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-8b93ff?style=flat-square" alt="Platform"></a>
  <a href="https://github.com/qaz65063199/tokfree"><img src="https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white" alt="Electron"></a>
</p>

[English](README.en.md) | 中文

> **TokFree** —— 在开源项目 [Cuckoo Code](https://github.com/wangyongpeng90/tokfree) 基础上深度扩展的专业版。保持"零 Token 成本"基因，加入多 Agent 协同、反检测浏览器集成、账号池自动登录、行为拟人化、Plan/Act 双模式、教训记忆、事件日志等一整套面向**长周期、多任务、高反检测要求**场景的专业能力。

**TokFree** 是一个**零 Token 成本**的 AI Agent 桌面端。

它通过 Electron 将 AI 网页版（DeepSeek、Claude、ChatGPT、Qwen、智谱清言等）嵌入本地窗口，并注入侧边覆盖层。AI 被系统提示词引导生成工具调用（JavaScript 代码块），在受限沙箱中执行，再把结果回传给 AI，形成「思考 → 行动 → 观察 → 再行动」的 Agent 循环。整个过程**不需要 API Key，不产生 API 调用费用**——你用的是网页版账号，而不是按 Token 计费的接口。

---

## Pro 版新增能力

Pro 版在原版基础上进行了系统性扩展，按能力域分为五大类：

### 一、多 Agent 协同（总经理模式）

- **主大脑 / 次大脑分工**：主大脑负责需求分析、任务拆解、派发、审阅、验收与决策；次大脑（Worker）独立执行子任务
- **三级暗号回报协议**：进度（SYNC）/ 完成（DONE）/ 求助（ASK），主大脑据此追踪任务状态
- **收件队列**：入队即返回 + taskId 去重 + 拖尾合并（debounce 2s / 硬上限 10s）+ 串行投递 + 优先级排序（ASK > DONE > SYNC）
- **结构化 Worker 报告**：Worker 完成时按 6 项模板回报（任务目标 / 实际做法 / 产物路径 / 验证结果 / 遗留问题 / 自我评估），主大脑逐项核验
- **跨窗口双向通讯**：派发确认（ack）+ 回报确认（失败重试，最多 2 次），只在关键节点单层确认，不做递归确认
- **窗口状态总览**：实时汇总各窗口 AI 状态（空闲 / 思考中 / 长任务 / 中断 / 限流冷却）

### 二、反检测与拟人化

- **ShardX 反检测浏览器集成**：接入引擎级反检测浏览器（patched Chromium，指纹伪装在 C++ 层），适用于注册账号、多账号操作、被风控拦截等高反检测场景
- **行为拟人化（真实输入事件）**：`human_move` / `human_click` / `human_type` / `human_scroll`，通过主进程 `sendInputEvent()` 发送 `isTrusted=true` 的真实输入事件，规避页面内 JS 模拟点击的检测
  - 贝塞尔鼠标轨迹（含过冲回拉 + 微抖）
  - 打字节奏（逐字符 + 随机间隔 + 偶发打错退格）
  - 渐进滚动、点击延迟 80-300ms
- **环境指纹自洽**：GPU / WebGL、`window.chrome`、`userAgentData.brands`、请求头对齐、确定性 Canvas/Audio 噪声，所有信号保持一致
- **每窗口独立代理**：`setProxy` / `testProxy`，配合指纹伪装实现环境隔离

### 三、账号与登录自动化

- **账号池**：集中管理各平台账号密码，密码使用 Electron `safeStorage.encryptString` 加密存储（系统加密不可用则降级为不存密码，**绝不存明文**）
- **窗口绑定账号**：`profile.account.accountId` 指向账号池账号
- **自动重登**：窗口加载后检测登录失效 → 自动「切密码登录 → 填账密 → 提交」→ 成功标记 / 失败弹窗选号
- **登录失效代报**：Worker 卡在登录页时由主进程侧代替它向主大脑发送求助回报

### 四、开发工作流增强

- **Plan / Act 双模式**：Plan 模式只读（写 / 执行工具被系统阻止），Act 模式正常执行但危险操作需确认（可配「信任模式」免确认）
- **操作确认回环**：危险操作弹窗确认，60s 超时视为拒绝
- **教训记忆（Reflexion 式）**：任务失败 / 被纠正时主动沉淀教训，下次同类任务初始化时**主动注入**提示词
- **跨项目知识库**：全局偏好 + 全局技能 + 项目知识三层结构，技能可跨项目启用
- **上下文压缩**（DeepSeek 专属）：token 达阈值时自动生成交接摘要 → 分享 → 新会话续接
- **事件日志与运行统计**：记录催促 / 拦截 / 派发 / 完成事件，窗口面板展示今日摘要与最近日志

### 五、平台能力扩展

- **截图与附件**：`screenshot` / `attachFile`，将界面截图或本地文件作为附件上传给多模态 AI
- **对话引导排队**：AI 完成确认、限流保护、静默兜底等机制保障长任务不中断
- **磁盘清理**：清理会话缓存与日志
- **看门狗（AI 生命监护）**：真中断 / 停下不干 / 纯静默分级催促，限流冷却保护，busy 长任务保护，电源保持
- **MCP 与长期记忆**：Claude Desktop 兼容配置，MemPalace 长期记忆按需检索

---

## 核心特性（原版基因）

### 零 Token 成本

不调用任何 AI 平台 API，不使用 API Token。直接复用网页版聊天能力，把网页版 AI 变成可执行本地操作的 Agent。

### 多平台 Provider 框架

- 内置 **DeepSeek**、**Claude**、**ChatGPT**、**Qwen**（chat.qwen.ai）和 **智谱清言**（chatglm.cn）五个平台
- 每个平台独立封装输入框定位、发送按钮检测、回复完成判断、消息解析等差异
- 新建窗口时可选择平台，也可**导入自定义 Provider**（提供类型声明和模板，降低扩展门槛）

### 真正的 AI Agent

不只是聊天。AI 可以读写文件、搜索代码、执行命令、查询数据库、调用 MCP 工具，并依据执行结果继续下一步，形成"思考 → 行动 → 观察 → 再行动"的 Agent 循环。

---

## 主要功能

- **多窗口管理**：每个窗口独立 Profile 上下文，互不干扰
- **项目初始化**：选择项目目录后，AI 获得目录树和系统提示词，操作基于真实项目上下文
- **工具调用系统**：AI 可调用读写文件、搜索代码、执行命令、查询数据库等工具
- **命令拦截**：自动检测 cmd / powershell / bash 代码块，确认后执行
- **MCP 支持**：采用 Claude Desktop 兼容格式配置，支持 stdio / http 类型 server
- **覆盖层面板**：显示命令预览、执行结果和历史记录，支持 Ctrl+Shift+C 或 Esc 切换
- **自动重试**：JS 代码执行失败且疑似代码不完整时，自动等待 1 秒重新获取并重试（最多 3 次），仍失败才回传 AI
- **会话持久化**：登录状态和设置保存到用户数据目录
- **安全机制**：30 秒命令超时、60 秒沙箱超时、1MB 输出缓冲区、危险命令确认
- **本地 OpenAI 兼容 API**：内置本地 HTTP 服务，暴露 `/v1/models` 与 `/v1/chat/completions`（OpenAI 兼容，支持 SSE 流式响应与窗口别名路由），外部程序可用标准 OpenAI SDK 调用本机 TokFree 窗口
- **ShardX 反检测浏览器集成**：AI 可直接调用引擎级反检测浏览器（patched Chromium）打开/读取被反爬拦截的网站；随更新分发资产，首次启动自动静默安装就位
- **进程胶囊（ZCode 风格）**：覆盖层以动态定位的步骤胶囊可视化当前任务的 `todoWrite` 进度，完成自动收起，防遮挡
- **任务流程规范**：通过系统提示词强制 AI 遵循「分析 → 调研 → 计划（todoWrite）→ 执行 → 测试 → 记忆」六步流程，进度实时可见
- **引导者（Curator）战略巡检**：系统空闲时自动采集项目现状（git/TODO/教训/技能/目标），拼成战略巡检简报注入窗口，驱动 AI 产出候选演进目标
- **自驱进化闭环**：执行轨迹 → 复盘 → 生成技能 → 沙盒验证 → 迭代淘汰，配合自驱循环（目标达标判定 + 五道防呆）实现无人干预持续进化

---

## 安装与运行

### 环境要求

- Node.js >= 16.0.0
- npm

### 步骤

```bash
# 克隆本仓库
git clone https://github.com/qaz65063199/tokfree.git
cd tokfree

# 安装依赖
npm install

# 如果 npm 提示 electron postinstall 脚本被阻止（allowScripts），先批准：
#   npm install-scripts ls
#   npm install-scripts approve electron
#   npm install
# 否则 electron 二进制不会下载，启动会报错

# 启动应用
npm start
```

### 可选：使用 ShardX 反检测浏览器

Pro 版的 ShardX 集成依赖 **ShardX Launcher** 在本地运行（提供本地 API）。若需高反检测场景，先启动 ShardX Launcher，再在应用内调用相关工具。

---

## 使用指南

1. 启动应用，选择平台（DeepSeek / Claude / ChatGPT / Qwen / 智谱清言 / 自定义 Provider）
2. 正常登录对应平台的网页版账号（或从账号池自动登录）
3. 点击「初始化项目」选择项目目录，AI 会获得目录树和系统提示词
4. 与 AI 对话，让它帮你修改文件、运行命令、查询代码等
5. AI 回复中的工具调用会被自动检测并执行
6. 执行结果自动回传 AI，AI 继续下一步，直到任务完成
7. 复杂任务可切换到**多 Agent 模式**，由主大脑拆解并派发给多个 Worker 并行执行

### 工具调用示例

AI 回复中包含以下格式的 `tokfree` 代码块时，系统会在沙箱中执行，并把结果回传给 AI：

````markdown
```tokfree
const content = await read("src/utils/helper.js");
await write("src/utils/helper.js", content.replace("formatDate", "formatTime"));
```
````

---

## 工具系统

支持的工具（通过 `tokfree` 代码块调用）：

| JS 函数 | 功能描述 |
|----------|----------|
| `read(path, options?)` | 读取文本文件（带行号窗口） |
| `readLines(path, options?)` | 读取文件为结构化行数组 |
| `write(path, content)` | 创建或覆盖文件 |
| `edit(path, old, new, replaceAll?, dryRun?)` | 精确替换文件内容 |
| `glob(pattern, searchPath?)` | 按 glob 模式查找文件 |
| `grep(pattern, options?)` | 正则搜索文件内容 |
| `bash(command, options?)` | 执行 shell 命令（cmd） |
| `pwsh(command, options?)` | 执行 PowerShell 命令 |
| `todoWrite(todos)` | 管理结构化任务列表 |
| `deleteFile(path)` | 删除文件（不可恢复） |
| `webFetch(url)` | 获取 HTTP(S) URL 内容（HTML 转 Markdown） |
| `mysql(options)` | 执行 MySQL SQL |
| `openBrowserWindow(url, options?)` | 打开 Electron 浏览器窗口 |
| `injectJS(windowId, code)` | 向指定窗口注入 JS |
| `screenshot(windowId?)` | 截图并保存为 PNG |
| `attachFile(path)` | 上传本地文件作为附件 |
| `mcpListServers()` | 列出已配置的 MCP server |
| `mcpGetTools(serverName)` | 查看 MCP server 工具列表 |
| `mcpCall(server, tool, args)` | 调用 MCP 工具 |
| `human_move / human_click / human_type / human_scroll` | 行为拟人化（真实输入事件） |
| `skill_* / preference_*` | 跨项目知识库 |
| `lesson_*` | 教训记忆 |
| `team_*` | 多 Agent 协同 |
| `watchdog_*` | 看门狗控制 |
| `log(...args)` | 输出中间结果到执行日志 |

所有文件操作均相对于当前绑定的项目目录，确保安全。

---

## MCP 配置

MCP 配置采用 **Claude Desktop 兼容格式**（可直接分享/导入）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/my-project"]
    }
  }
}
```

支持 stdio（command + args）和 http（url + headers）两种类型。启用/禁用状态单独存储，不污染主配置。通过覆盖层的「MCP」按钮打开管理面板。

---

## 自定义 Provider

想要接入新的 AI 平台？复制 `src/providers/custom/provider.template.js`，按模板填写：

- `id` / `name` / `homeUrl` 等基本信息
- 输入框、发送按钮的选择器
- `matchesUrl()`、`extractSessionId()` 等方法
- 自动解析相关方法（完成检测、消息定位等）

类型声明见 `src/providers/custom/provider.d.ts`。在应用内通过平台选择页导入 JS 文件即可使用。

---

## 技术细节

### 技术栈

- **框架**：Electron 33（Chromium 130）+ Node.js（>= 16）
- **前端**：原生 Web 技术（覆盖层 UI），无重型框架依赖
- **测试**：Node 内置 test runner（`npm test`，844 项全部通过）
- **打包**：electron-builder（Windows nsis + portable / macOS dmg + zip）
- **分发**：electron-updater + generic provider（增量更新 latest.yml + blockmap）

### 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    主进程 (src/main/)                     │
│  窗口管理 · IPC · Profile · 看门狗 · 事件日志 · 账号池      │
│  多 Agent 协同（派发/收件队列/调度器/任务状态）             │
│  自驱进化（轨迹/复盘/技能生成/自驱循环）· 引导者 · MCP 客户端 │
└───────────────┬─────────────────────────┬────────────────┘
                │ IPC                     │ IPC
┌───────────────▼──────────┐   ┌──────────▼──────────────────┐
│   渲染进程 preload        │   │   工具沙箱 (tools/JsRunner)   │
│  overlay UI · DOM 监测    │   │  执行 AI 生成的 tokfree 代码   │
│  hook 拦截 · 指纹伪装     │   │  暴露 read/write/bash/...    │
│  Provider（平台差异）     │   │  checkPolicy 拦截（Plan/Act） │
└──────────────────────────┘   └─────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────┐
│            AI 网页版（DeepSeek / Claude / ChatGPT /        │
│            Qwen / 智谱 / Gemini / 自定义 Provider）         │
└─────────────────────────────────────────────────────────┘
```

### 核心机制

- **TokFree 代码块（工具调用）**：AI 回复中的 ```tokfree 代码块被提取 → 在受限沙箱（`tools/JsRunner.js`）中异步执行 → 结果回传 AI，形成「思考 → 行动 → 观察 → 再行动」循环。沙箱注入 `__callerProfileId` / `projectDir`，相对路径按项目根解析。
- **hook 拦截模式**：主世界注入网络拦截器（`src/interceptor/`），直接拦截平台 SSE 流式响应，边收边解析，比 DOM 抓取更快更稳；DOM 抓取作为兜底。
- **多 Agent 暗号协议**：主大脑派发任务时注入 Worker 协议，Worker 用三级暗号回报——进度 `>>>MASTER_SYNC_START<<<`、完成 `>>>MASTER_DONE_START<<<`、求助 `>>>MASTER_ASK_START<<<`；收件队列按 taskId 去重 + 拖尾合并 + 优先级（ASK > DONE > SYNC）串行投递。
- **看门狗（AI 生命监护）**：监测「距最后一次活动的时长」——真中断（5s）/ 停下不干（5s）/ 纯静默兜底（240s）分级催促，限流冷却 90s、busy 长任务保护、绝对超时兜底（1200s）、电源保持。
- **动态提示词组装**：项目初始化时（`src/main/project-context.js`）读平台模板，替换 `{{TOOL_API_TYPES}}` / `{{TOOLS_LIST}}` / `{{TOOL_SECTIONS}}` / `{{PROJECT_DIR}}` 等占位符，并叠加知识库章节、完成暗号章节、（派发时）Worker 协议。
- **Plan / Act 双模式**：`tool-policy.js` 在工具执行前插 `checkPolicy`——Plan 模式只读（写/执行被 block），Act 模式危险操作经 `tool-confirm.js` 弹窗确认（60s 超时视为拒绝）。
- **用户数据隔离**：用户数据在 `%APPDATA%/tokfree-session/`（`app.setPath` 设置），与安装目录完全分离，覆盖安装不丢数据。

### 目录结构速览

```
main.js                      主进程入口（薄壳，转发 src/main/）
src/main/                    主进程逻辑（窗口/IPC/看门狗/账号池/team/自驱进化）
src/preload/                 渲染进程（overlay UI/DOM 监测/指纹伪装/压缩）
src/providers/               平台 Provider（deepseek/claude/chatgpt/qwen/zhipu...）
src/prompt/                  各平台系统提示词模板
src/interceptor/             各平台网络拦截器（主世界注入）
tools/                       工具实现（38 个文件，单一注册入口 tools/index.js）
test/                        单元测试（81 个 .test.js，844 项）
```

---

## 项目结构

```
tokfree/
├── main.js                 # Electron 主进程入口（薄壳，转发到 src/main/）
├── start.js                # 跨平台启动脚本（日志写入 wyp/log/）
├── src/
│   ├── main/               # 主进程逻辑（多窗口、IPC、看门狗、事件日志、账号池、多 Agent 协同）
│   ├── preload/            # 渲染进程逻辑（overlay UI、DOM 监测、指纹伪装、反自动化特征修复）
│   ├── providers/          # 平台 Provider
│   └── prompt/             # 各平台系统提示词模板
├── tools/                  # 工具实现（文件/命令/搜索/MCP/拟人化/多 Agent/知识库/教训/看门狗）
├── test/                   # 单元测试
└── dist/                   # 构建产物
```

---

## 构建与发布

- 本仓库已配置 GitHub Actions，推送 `v*` 标签会自动构建 Windows 和 macOS 安装包并发布到 Releases
- 本地手动构建：`npm run build:win:local` 或 `npm run build:mac:local`
- 构建产物输出到 `dist/` 目录

---

## Roadmap

下一阶段计划见 [Roadmap.md](Roadmap.md)。

---

## 贡献

欢迎提交 Issue 和 Pull Request。

- 报告 Bug 或建议新功能：Issues
- 提交代码：Pull Requests

---

## 更新日志

> 完整版本历史见 [CHANGELOG.md](CHANGELOG.md)。以下为近期主要版本亮点。

### [0.8.1] - 2026-09-28
- **消息时间"假时间"修复**：只给实时到达的新消息打时间戳，历史消息/滚动/切回视图不再误打时间
- **ShardX 用点即自愈**：调用前自动 ensureShardxReady（未装则装、未运行则启动，缓存 30s）

### [0.8.0] - 2026-09-28
- **ShardX 反检测浏览器集成**：新增 `open_shardx_browser` / `read_shardx_page` / `close_shardx_browser` 三工具；外部网站调研默认走 ShardX
- **ShardX 无感就位**：随更新分发资产，首次启动自动静默安装 Launcher + 就位 MCP + 写 mcp.json
- **任务绑定会话（mode=session）**、**Token 用量统计 + 纯 CSS 柱状图**、**沙箱 sleep**

### [0.7.0] - 2026-09-27
- **本地 OpenAI 兼容 API**：内置本地 HTTP 服务，暴露 `/v1/models` 与 `/v1/chat/completions`（SSE 流式 + 窗口别名路由），外部程序可用标准 OpenAI SDK 调用
- **借鉴 Cuckoo 上游改进**：限流业务码 40029 识别、hook 性能优化、中断自动重试
- **子 Agent 派发优化**：token 用量上报链路 + continue 续对话派发

### [0.6.0] - 2026-09-25
- **Gemini Provider**（DOM 模式）
- **全平台深度思考适配**：ChatGPT/Claude 补深度思考开关骨架；Claude Effort 档位；千问图像模式
- **continue 派发模式**、**Hooks 事件系统**（PreToolUse/PostToolUse）、**目标可视化**面板

### [0.5.0] - 2026-09-22
- 新增内置平台**智谱清言**（网络拦截模式）
- 壳端「深度思考」开关、新建窗口先选平台再登录

### [0.4.0] - 2026-09-22
- **会话栏「全量对话同步」**、**重命名跨窗口同步**、Provider 模板增强（388 行 / 14 接口）
- 修复多图附件逐张显示、引导者巡检、标签页持久化（`var` 提升时序）、看门狗 busy 残留

### [Pro 1.0.0] - 2026-09-17
- **品牌重命名为「TokFree」**，全面重写中英文 README，突出 Pro 版定位
- 汇总 Pro 版新增能力：多 Agent 协同、ShardX 集成、行为拟人化、账号池+自动登录、Plan/Act 双模式、教训记忆、事件日志、上下文压缩、跨项目知识库等

---

## 致敬原作者

**TokFree 并非从零开始，它站在巨人的肩膀上。**

本项目的全部基础架构——Electron 桌面端框架、多窗口隔离、覆盖层 UI、Provider 框架、工具系统、系统提示词工程、MCP 集成、会话持久化等核心设计——均来自开源项目 **[Cuckoo Code](https://github.com/wangyongpeng90/tokfree)**。原作者以一己之力构建了一套完整、优雅、真正可用的「零 Token 成本 AI Agent 桌面端」方案，其架构之清晰、扩展点之合理，是本项目能够在其上持续演进的根基。

Pro 版在原作基础上新增了多 Agent 协同、ShardX 反检测浏览器集成、账号池与自动登录、行为拟人化、Plan/Act 双模式、教训记忆、事件日志、上下文压缩、跨项目知识库等能力，但**没有改变原作的核心哲学**——零 Token 成本、网页版即 Agent、一切操作在本地可控沙箱中完成。

谨向原作者 **wangyongpeng90** 及所有 [Cuckoo Code 贡献者](https://github.com/wangyongpeng90/tokfree/graphs/contributors) 致以最诚挚的感谢。也感谢 [@27584](https://github.com/27584) 在 Provider 发送扩展接口、流式稳定性、自定义 Provider 加载、MCP 工具识别等方面的框架级贡献。

原项目同样采用 **GNU General Public License v3.0** 许可，TokFree 严格遵循同一许可，所有衍生工作同样开源。如果你喜欢这个项目，请务必也给[原项目](https://github.com/wangyongpeng90/tokfree)点一个 Star —— 那才是一切的起点。

---

## 许可证

本项目使用 GNU General Public License v3.0 许可证。详见 LICENSE 文件。

---

## 致谢

- **wangyongpeng90** 及 Cuckoo Code 贡献者：提供了整个项目的基础架构与开源许可
- [@27584](https://github.com/27584)：Provider 发送扩展接口、流式稳定性双通道、自定义 Provider 渲染进程加载、MCP 工具识别等框架级改进（PR #9）
- DeepSeek、Claude、ChatGPT、Qwen、智谱清言提供强大的 AI 能力
- Electron 提供跨平台桌面框架
- 所有贡献者和用户
