# Changelog

## [0.9.0] - 2026-09-30

### Added
- **ZCode 风格 Agent 流程 · 进程胶囊（任务进度可视化）**：覆盖层右侧新增可折叠进程胶囊，展示任务步骤三态（✓ 完成 / → 进行中 / ○ 待办）与实时计时；拆分为「任务进度 N/M」（可点击展开）与「计时」两枚胶囊
- **任务流程规范（注入所有平台）**：统一「分析 → 调研 → 计划(todoWrite) → 执行 → 测试 → 更新记忆」流程，todoWrite 成为所有任务的强制起点
- **胶囊多数据源**：支持多 Agent 编排计划（team_plan_create）与单聊 todo 两种来源；AI 状态与计时覆盖任务全过程
- **Token 使用统计面板（ZCode 风格）**：KPI 卡片 + Token 活动热力图 + 每日趋势折线 + 窗口用量环形饼图（纯 CSS/SVG 实现）
- **反检测强化（借鉴 patchright / Camoufox）**：修复 CDP 泄漏（不 enable Runtime）+ 补充字体列表 / WebGPU / 时区偏移 + 指纹信号自洽自检
- **行为拟人化加强**：滚动惯性（缓动 + 过头回滚）+ 打字错字模型（邻键 / 整词重打 / 长停顿）+ 思考停顿 thinkPause / hoverDwell
- **崩溃捕获**：新增 render-process-gone / child-process-gone / unresponsive 捕获（附 profileId + crashReporter）
- **本地 OpenAI 兼容 API 增强**：窗口别名路由、任务绑定会话（mode=session）、沙箱 sleep

### Changed
- **进程胶囊**：从右栏内嵌改为「按钮 + 弹窗」；默认 tab 为累计；统计面板随 tab 联动
- **胶囊超时冻结**：任务超时后计时自动冻结；Worker 完成后 todo 自动收尾（防止无限计时）
- **非活动标签后台节流**：缓解多窗口场景下的内存崩溃
- **提示词**：主大脑也需写 todo；用户中途追加的待办即时追加进进度

### Fixed
- 修复多窗口下进程胶囊计时永不停止的问题（超时冻结 + Worker 完成自动收尾）

## [0.8.1] - 2026-09-28

### Fixed
- **agent-view 消息时间"假时间"修复**：只给实时到达的新消息打时间戳，历史消息 / 滚动 / 切回视图不再误打时间
- **ShardX 用点即自愈**：ShardX 工具调用前自动 ensureShardxReady（未装则装、未运行则启动，缓存 30s），修复"更新了但 ShardX 没启动"的问题

## [0.8.0] - 2026-09-28

### Added
- **ShardX 反检测浏览器集成**：AI 可直接调用 ShardX（引擎级反检测浏览器，patched Chromium）打开/读取被反爬拦截的外部网站；新增三工具 `open_shardx_browser` / `read_shardx_page` / `close_shardx_browser`；外部网站调研默认走 ShardX（webFetch 被风控挡回时的强伪装替代）
- **ShardX 无感就位**：随更新分发 ShardX 资产（`resources/shardx/`），首次启动自动静默安装 Launcher + 就位 MCP + 写入 mcp.json（不覆盖用户已有配置）；设置面板显示 ShardX 就位状态
- **任务绑定会话（mode=session）**：支持按会话绑定任务上下文
- **Token 用量统计 + 纯 CSS 柱状图**：覆盖层新增用量可视化
- **沙箱 sleep**：工具沙箱内支持 `sleep` 异步等待

### Fixed
- 修复自动上下文压缩（compaction）相关问题
- 修复 sendToChat 误报

## [0.7.0] - 2026-09-27

### Added
- **本地 OpenAI 兼容 API**：内置本地 HTTP 服务，暴露 `/v1/models` 与 `/v1/chat/completions`（OpenAI 兼容），支持设置开关、流式响应（SSE）、窗口别名路由，便于外部程序以标准 OpenAI SDK 调用本机 TokFree 窗口
- 新增本地 API 服务设置项与窗口别名配置入口

### Fixed
- 修复新建对话时误跳转到 DeepSeek 的问题

### Changed / Optimized
- **借鉴 Cuckoo 上游改进**：限流业务码 40029 识别、hook 性能优化、中断自动重试（decideRetry 纯函数）
- **子 Agent 派发优化**：token 用量上报链路 + continue 续对话派发模式，降低重复初始化开销

## [0.6.0] - 2026-09-25

### Added
- **Gemini Provider**：新增 Google Gemini 平台（DOM 模式）
- **全平台深度思考适配**：ChatGPT/Claude 补深度思考开关骨架（多策略容错）；Claude 新增 Effort 档位切换；智谱深度思考入口改用真机 class；千问新增生成图像模式切换
- **登录检测**：ChatGPT/Claude 新增登录页检测；智谱/千问补齐 isLoginPage / isMainInterface
- **子 Agent token 统计**：建立子 Agent token 用量上报链路；TStatus 增加 tokenCount/initialized/needsCompaction
- **continue 派发模式**：dispatch_task 支持 mode=continue 续对话派发（可复用已有 Worker 对话）
- **Hooks 事件系统**：引入 PreToolUse/PostToolUse 可插拔扩展点，payload 带 projectDir
- **Hooks 文档**：新增 hooks.md
- **目标可视化**：覆盖层新增自驱循环目标进度面板
- **平台对齐设计**：新增《平台功能对齐 DeepSeek 适配计划书》

### Fixed
- 修复限流业务码 40029 识别
- 修复千问 hook：thinking_summary finished 不再误判整体结束，仅正文阶段 finished 才结束
- 修复拦截模式 DOM 兜底被 hook 短片段调度抑制的问题
- 修复千问 DOM 兜底走结构化代码块提取 + 语言标签兼容 Monaco header
- 修复 isGenerating 语义分层多策略 + findSendButton 覆盖层排除
- 修复无 profile 的 traceKey 用 shell 取代笼统的 unknown

### Changed / Optimized
- **hook 性能优化**：借鉴上游 0.6.1 三项优化
- **中断自动重试**：retry-engine 抽出纯函数 decideRetry 并补单元测试
- **提示词分组**：按模式分组工具 JS 签名（单聊模式排除 team_*）
- **Agent Runtime 端口抽象**：baseDir 注入 + inject 端口解耦
- **团队提示词**：教授主大脑 continue-vs-fresh 派发模式

## [0.5.0] - 2026-09-22

### Added
- 新增内置平台**智谱清言**（chatglm.cn）网络拦截模式（拦截 assistant/stream SSE）
- 壳端输入区新增「深度思考」开关：与网页端同步，默认开启
- 新建窗口先选平台再登录（平台选择页）

### Fixed
- 修复删除窗口后界面卡死/卡顿：清理 profile 数据由同步 I/O 改为异步（fs.promises）
- 修复新建窗口被硬编码默认 deepseek、跳过平台选择页的问题

## [0.4.0] - 2026-09-22

### Added
- **会话栏「全量对话同步」**：新增 `src/preload/dom/session-catalog.js`，从 DeepSeek API 分页拉取全部对话；`list-sessions` 返回全量（含标题 + 项目标记）
- **重命名跨窗口同步**：会话重命名别名改为全局共享（`session-alias-global.json`），并广播 `session-renamed` 事件给所有窗口
- **Provider 模板增强**：模板扩展至 388 行 / 14 个接口；新增 DOM 探测脚本 `docs/provider-probe.js`

### Fixed
- **多图附件逐张显示**：`readPendingAttachments` 不再合并多张图片，逐张展示待发附件
- **引导者（Curator）修复**：`resolveTargetContexts` 改为遍历 `getAllContexts`（原 `getMainContext` 返回壳窗口，导致永不巡检）
- **标签页持久化修复**：`tabStatusMap` 声明时序错误（`var` 提升导致 `renderTabs` 抛异常、跳过 `persistTabs`），标签页数量异常（6→4）
- **看门狗 busy 残留修复**：清理长任务标记残留，避免误判停滞

### Changed / Optimized
- **AI 消息布局加固**：`.cv-ai` 增加 `flex-wrap`
- **消息时间长显**：时间戳常显
- **命令面板增强**：新增 6 个命令 + 「最近使用」
- **技能 description 补全**：统一补全技能描述
- **标签栏两行 + 按钮固定**：标签栏两行布局，操作按钮固定
- **发送延迟全局化**：默认延迟 4000–6000ms
- **窗口管理面板**：支持滚动

## [Pro 1.0.0] - 2026-09-17

### Changed (Pro 重包装)
- **品牌重命名为「TokFree」**：README.md / README.en.md 全面重写，突出 Pro 版定位与新增能力
- **package.json**：`name` 改为 `tokfree`，`description` 更新为 Pro 版定位，`keywords` 增加 `tokfree`
  - `repository` / `author` / `bugs` / `homepage` / `build.publish` 暂保留原作者仓库（独立仓库发布后替换，避免死链）
  - `build.appId` / `build.productName` / `SESSION_DIR` **保持不变**（改动会导致 userData 路径变化、现有本地数据"消失"）
- **README 徽章**：暂保留原作者仓库链接（加 TODO 注释，待独立发布后替换）

### Added (Pro 版新增能力汇总)
- **多 Agent 协同（总经理模式）**：主大脑/次大脑分工、三级暗号回报（SYNC/DONE/ASK）、收件队列、结构化 Worker 报告、跨窗口双向通讯、窗口状态总览
- **ShardX 反检测浏览器集成**：引擎级 patched Chromium，指纹伪装在 C++ 层
- **行为拟人化**：`human_move` / `human_click` / `human_type` / `human_scroll`，真实输入事件（`isTrusted=true`）
- **账号池 + 自动登录**：`safeStorage` 加密存储密码，登录失效自动重登，登录页代报
- **Plan / Act 双模式 + 操作确认回环**
- **教训记忆（Reflexion 式）**：失败/被纠正时主动沉淀并主动注入
- **事件日志与运行统计**
- **上下文压缩**（DeepSeek 专属）
- **跨项目知识库**：全局偏好 + 全局技能 + 项目知识三层
- **对话引导排队**（完成确认 / 限流保护 / 静默兜底）
- **截图与附件**：`screenshot` / `attachFile`
- **磁盘清理**

> 备注：Pro 1.0.0 为在原作者 [Cuckoo Code](https://github.com/wangyongpeng90/tokfree)（GPL-3.0）基础上的重包装版本，保留了原版全部核心能力（零 Token 成本、多平台 Provider、Agent 循环、工具系统、MCP 等）。向原作者致敬。

## [Unreleased]

### Added
- 同步上游 0.3.9：面板新增「对话 Token」显示（DeepSeek 服务端 `accumulated_token_usage`，过万简写为 x.xx万）
  - `deepseek-hook` 捕获 token 字段并通过事件 detail 透传（保留本地 `interrupted` 字段）
  - `intercept-observer` 保存到 `state.serverTokenUsage`
  - 覆盖层模板与事件新增 token 显示区，每秒刷新
- **看门狗（Watchdog）—— AI 生命监护**：AI 发出请求后长时间无回复时自动唤醒，让任务接着跑
  - 监护模型（arm/disarm）：仅在"发出请求、等待 AI 回复"期间计时；收到回复即退出监护，空闲时不打扰
  - 停顿检测：等待期间心跳超时（默认 4 分钟）判定停顿 → 自动发送唤醒语
  - 流活动心跳：等待期间页面有渲染活动则刷新心跳，避免长回复被误判
  - 限流保护：识别回复中的限流文案（"请求过于频繁"等）→ 进入冷却（默认 15 分钟）不再打扰
  - 长任务保护：AI 可标记 busy，期间自动续心跳、不唤醒；busy 超时自动失效
  - 新增工具：`watchdog_heartbeat` / `watchdog_busy` / `watchdog_clear_busy` / `watchdog_status`
  - 窗口管理面板内置看门狗状态与控制（暂停/恢复/立即唤醒）
- **截断即时续写**（与看门狗互补，恢复并改进）：拦截模式下检测到回复被截断时立即续写
  - 检测信号：流中断（interrupted，未收到正常结束事件）或末尾未闭合的 ``` 代码块
  - 续写提示词："继续，直接输出剩余内容。不要重复已经输出过的内容，不要重新开始，从中断处接着写。"
  - 限流：1 分钟滑动窗口内最多续写 3 次，超限停止；用户手动发消息时重置窗口
  - 续写消息不计入对话计数
  - 核心实现 `src/main/watchdog.js`（配置持久化 `watchdog-config.json`）
- 窗口管理新增「今日 发X 收Y」对话计数
- 新增内置平台 **智谱清言**（chatglm.cn）：`src/providers/zhipu.js`，采用 DOM 抓取模式（`useIntercept: false`）
  - 输入框 `textarea.scroll-display-none`、发送按钮 `div.enter`、AI 消息裸 `.answer`、正文链 `.answer-content` / `.markdown-body`
  - 回复完成检测基于"停止对话"按钮消失 + 末条正文非空
  - 发送经 `provider.triggerSend` 由主进程 `webContents.sendInputEvent` 注入原生 Enter（站点免疫合成事件）
  - 无单独提示词模板，回退 `default.md`

### Fixed
- 看门狗「完成确认」模式（方案 B）：
  - AI 完成**纯文本回复**（无工具调用、无 JS 代码块、无任何代码围栏）后，进入确认模式，5 秒（`confirmDelay`）后发送完成确认催促
  - 催促语引导 AI：未完成则继续推进；已全部完成则附上暗号
  - AI 回复出现暗号（`doneKeyword`，默认 `紫电青霜-7391`）→ 立即停止催促
  - 连续催促上限 `maxNags`（默认 5 次），达上限自动停止
  - **前提 1**：仅在"不运行 JS、且无任何代码块"时触发（含工具/代码块视为进展，不催促）
  - **前提 2**：检测到停止后附加延迟器（confirmDelay，默认 5 秒）再发送，避免打断主流程
  - 暗号说明自动追加到系统提示词（project-context.js），AI 完成时主动附暗号
  - 中断/静默监护（10s 中断催 / 4min 静默催）逻辑保持不变
  - 新增单元测试 `test/main/watchdog.test.js`（14 个用例：暗号检测、scheduleConfirm、连续催促上限、arm reset 语义、中断标记、电源保持等）
- 锁屏/后台持续运行保障：
  - 看门狗新增电源保持：有活跃监护任务时开启 `powerSaveBlocker('prevent-app-suspension')` 阻止系统休眠，空闲自动释放（不常驻耗电）
  - 看门狗注册 `powerMonitor` 事件（suspend/resume/lock-screen/unlock-screen）记录日志，便于排查
  - 调度台窗口（ipc.js / team/ui.js）与 openBrowserWindow 工具窗口补 `backgroundThrottling: false`
- 看门狗分级催促：区分"检测到中断/截断"与"纯静默无信号"两种停顿
  - 已检测到中断/截断（hook 的 `interrupted=true`）→ 10 秒后即催促（`interruptInterval`）
  - 纯静默无任何信号 → 维持 4 分钟再催促（`interval`）
  - 修复"正常完成仍被误催"与"思考中断却不催"两个极端
- 同步上游 0.3.10：修复切换平台时闪退（`window-all-closed` 延迟确认，避免销毁旧窗口与重建新窗口间隙误退出）
- 同步上游 0.3.10：修复 userData 目录不存在时启动崩溃（`app.setPath('userData')` 前兜底创建目录）
- **MCP 客户端连接自愈**（`src/main/mcp-client.js`）：修复底层 stdio 进程/传输已死但连接条目仍标记 `connected: true`，导致列表显示"已连接"而调用抛 `Not connected` 的问题
  - `connectServer` 改用 SDK 的 `client._transport` 作为存活判据，陈旧连接先关闭再重连
  - `listConfiguredServers` 同样以 `_transport` 报告连接状态
  - `callMcpTool` 捕获 `Not connected` 后自动重连并重试一次
- 修复 `test/preload/js-detector.test.js` 中 4 个用例因 mock 缺少 `cloneNode` / `querySelectorAll` 而失败的问题

## [0.3.8] - 2026-09-11

### Changed
- **DeepSeek / Claude / ChatGPT 三个平台的 AI 回复获取，从 DOM 抓取改为网络请求拦截**
  - 在页面主世界（main world）注入拦截器，被动观察平台自身的 completion SSE 流，
    直接解析回复文本，不再依赖 MutationObserver + DOM 稳定性轮询
  - 仅旁路读取（response.clone / responseText 快照），不修改请求与响应
  - 正文提取区分并排除 THINK / reasoning 片段
  - DeepSeek：解析 response/fragments 的 THINK / RESPONSE 分片
  - Claude：解析 content_block_delta 的 text_delta（忽略 thinking_delta）
  - ChatGPT：解析 /backend-api/f/conversation 的裸 v 追加、patch 批量操作、
    message 快照（仅采纳 assistant）与 message/status 结束信号
  - 工具执行结果回传仍沿用原有模拟输入框发送方式

## [0.3.6] - 2026-09-08

### Fixed
- 添加标准编辑菜单，修复 macOS 无法在 DeepSeek 输入框复制/粘贴的问题

## [0.3.5] - 2026-09-08

### Fixed
- glob/grep 工具打包后 ripgrep ENOENT，通过 asarUnpack 解包二进制并修正运行路径
- 恢复 README 中 Codecov 覆盖率徽章

## [0.3.4] - 2026-09-07

### Fixed
- pwsh 工具改用 execFile，避免管道符被 cmd 预解析导致命令残缺
- 主窗口 UA 改为 Chrome 130 普通标识，避免 DeepSeek 提示隐私风险
- openBrowserWindow 工具窗口同步设置 Chrome 130 UA，不再暴露 Electron 标识
- XML invoke 检测不再要求必须位于文本开头，并避免提示语自触发循环
- 渲染进程可通过 --tokfree-user-data 参数加载自定义 Provider

### Added
- Provider 发送扩展接口（provider.triggerSend），支持站点原生发送
- 流式稳定性双通道校验（mutation 快照 + interval 兜底）
- 完成检测兜底轮询（每 2s 主动复查），覆盖后台/最小化漏触发场景
- MCP 工具调用识别（await mcpXxx / log(await xxx））
- 无 pre 的 .md-code 代码容器兜底

### Changed
- 会话 ID 提取与跳转 URL 改为 Provider 方法，不再硬编码 DeepSeek 格式

## [0.3.0] - 2026-09-07

### Added
- 多平台 Provider 框架：支持 DeepSeek 与 Claude，按平台区分输入框/发送按钮/用户信息/消息解析
- 平台选择页：新窗口未指定平台时展示卡片式选择页（含官方品牌 logo）
- 提示词模板化：每平台独立模板，支持 `{{PLATFORM_INFO}}` `{{TOOL_API_TYPES}}` `{{TOOLS_LIST}}` `{{TOOL_SECTIONS}}` `{{PROJECT_DIR}}` `{{PROJECT_INTRO_SECTION}}` `{{MCP_SECTION}}` 占位符
- 自定义 Provider 功能：用户可通过平台选择页导入 JS 文件，支持复制到 userData、重名替换、删除前窗口占用检查
- 自定义 Provider 类型声明与模板：`src/providers/custom/provider.d.ts` + `provider.template.js`
- Provider 方法化：平台差异全部下沉到 Provider 方法（findInput/findSendButton/isResponseComplete/getMessageCandidates 等）
- Claude 自动解析：基于停止按钮边沿触发完成检测，跳过空消息，避免重复触发
- 按平台分文件记录渲染日志到 `wyp/log/{providerId}.log`
- 新增 Provider 单元测试

### Changed
- 系统提示词由单文件改为多平台模板，运行时按 providerId 选择并替换占位符
- 工具 API 类型定义从 `tools/tokfree-tools.d.ts` 动态读取，避免多处维护
- 平台 logo 从首字母占位改为官方 SVG

### Fixed
- Claude 自动解析重复触发/漏触发问题
- 多个 `{{PROJECT_DIR}}` 占位符只替换第一个的问题
- 导入自定义 Provider 后源文件被删导致失效的问题

---

## [0.2.5-beta.1] - 2026-09-02

### Added
- 新增 MCP（Model Context Protocol）按需查询能力
  - mcpListServers() 查看已配置的 MCP server（名称/类型/状态/工具数/工具名）
  - mcpGetTools(serverName) 查看指定 server 的工具详情（描述+参数）
  - mcpCall(server, tool, args) 调用 MCP 工具
- MCP 启动时自动连接已启用的 server，初始化项目时等待连接（8 秒超时）
- MCP 配置保存前完整 JSON 结构校验（错误时明确提示且不覆盖输入）
- MCP 配置保存后弹确认框，由用户决定是否通知 AI（避免打断 AI 操作）
- showConfirmDialog 扩展支持确认/取消双按钮 + Promise 返回（向后兼容）
- 新增 McpCallTool、McpQueryTools 单元测试

### Changed
- MCP 提示词改为按需查看模式，不再全量注入工具列表（节省 token）
- MCP 保存后的自动通知改为简短格式，引导 AI 按需查询
- 移除 .tokfreeCode/TOKFREE.md 作为全局项目介绍（避免干扰其他项目场景）

### Fixed
- 修复 connectEnabledServers 从未被调用导致 MCP 启动后未连接的问题
- 修复 initProject 同步逻辑中 MCP 连接时序竞态（改为 async + 等待）

---

## [0.2.0] - 2026-08-27

### Breaking Changes
- 主进程重构：main.js 拆分为 src/main/ 模块（应用生命周期、IPC、项目上下文、会话存储分离）
- preload 重构：preload.js 拆分为 src/preload/ 模块（DOM 监测、overlay UI、工具解析分离）
- 移除 MySQLTool.js（已无维护，提示词中不再暴露）
- 移除旧版工具桥接实现（ToolBridge.js、UnifiedToolManager.js、WebContentCapturer.js）
- bash/pwsh 不再强制要求 description 参数（改为可选）

### Added
- 新增 5 个对标 dsh 的工具实现：
  - read（offset/limit 分段读取，替代 readFile）
  - write（全量覆盖，替代 writeFile）
  - edit（精确替换，替代 editFile）
  - glob（ripgrep 引擎，替代旧 GlobTool）
  - grep（ripgrep JSON 输出，替代旧 GrepTool）
- 新增 todoWrite 工具（全量任务列表，对标 dsh todo_write）
- 新增 pwsh 工具（PowerShell 执行，对标 dsh tool-pwsh）
- 新增 webFetch 工具（HTML 转 Markdown，对标 dsh web_fetch）
- 新增 openBrowserWindow / injectJS 工具（打开调试窗口并注入 JS）
- 工具系统支持 section 机制（对标 dsh systemPrompt.section），每个工具有独立的 prompt section
- 系统提示词全面改版：中文 dsh 风格 + 动态平台检测（Windows/macOS/Linux）
- 发送延迟可配置（UI 设置 + localStorage 持久化）
- UI 全面改版：悬浮球模式（48px 右下角 FAB + 小面板），不再占用全高侧边栏
- 跨平台启动脚本 start.js（Windows/macOS/Linux 通用）
- 完整单元测试覆盖（tools / main / preload）

### Changed
- package.json start 脚本改为 node start.js（修复 macOS chcp: command not found）
- start.js 自动根据平台选择 UTF-8 编码设置
- 工具返回格式统一为 dsh 风格（纯文本 envelope / marker）
- 错误提示统一为英文 dsh 风格
- package.json 增加 allowScripts 配置（npm 新版本 electron postinstall 被阻止问题）

### Fixed
- edit 工具 CRLF 适配（LF 的 old_string 能匹配 CRLF 文件）
- bash/pwsh 非零退出不再报错，改用 [exit code: N] 标记
- glob 路径去掉 ./ 前缀
- Windows 平台信息动态生成（不再硬编码）
- Electron postinstall 被 npm allowScripts 阻止导致二进制缺失的问题
- JS 脚本无输出时提示使用 log()

### Security
- bash/pwsh 危险命令黑名单保留（Windows + PowerShell 特有命令）
- 命令执行超时限制保持 30 秒
- 输出缓冲 1MB 限制保持

### Dependencies
- 新增 @vscode/ripgrep（glob/grep 底层引擎）
- 新增 turndown + @joplin/turndown-plugin-gfm（webFetch HTML 转 Markdown）

---

## [1.0.0] - 2026-08-11

### Added
- 初始版本发布
- Electron 桌面应用，嵌入 DeepSeek 网页版
- 自动检测 AI 回复中的 cmd/powershell 代码块，弹窗确认后执行
- 工具调用系统：支持 file_write、file_read、file_edit、file_glob、file_grep、bash、file_delete 等工具
- 会话级项目目录绑定，工具操作以项目目录为基础
- 侧边覆盖层面板，显示命令预览、执行结果和历史记录
- Ctrl+Shift+C 快捷键切换覆盖层
- 项目初始化功能，自动生成目录树并注入系统提示词
- 支持危险命令检测与额外警告
- 会话持久化（cookies/localStorage 保存到 %APPDATA%/tokfree-session）

### Security
- 命令执行前必须用户确认
- 危险命令（rm -rf /、format、shutdown 等）触发额外警告
- 30 秒命令执行超时限制
- 1MB 命令输出缓冲区限制
