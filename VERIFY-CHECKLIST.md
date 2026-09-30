# TokFree 重启后验证清单

> 本批改进多在 **主进程 / preload 层**，修改只在应用启动时加载一次，**必须重启应用（`npm start` 或重新打开 TokFree）后才生效**。
> 每项按「操作步骤 → 预期结果 → 涉及文件」列出。

---

## 1. Worker DONE 回报 + 窗口状态解除

**背景**：DeepSeek 等平台 SSE 流有时挂起不结束（`reader.read()` 一直 pending），主世界 hook 的 dispatch 永不触发，导致 Worker 已生成 DONE 汇报却不上报、状态卡「运行中」。

- **操作步骤**：多 Agent 模式下，给某个 Worker 派一个小任务（如「创建 hello.txt 并回报」），等它跑完。
- **预期结果**：
  1. Worker 完成后，主大脑**收到**该 DONE 回报（无需人工干预）；
  2. 该 Worker 窗口状态不再卡「运行中」，回到空闲。
- **涉及文件**：`src/preload/dom/worker-report-fallback.js`（DOM 兜底上报，幂等去重）、`src/preload/index.js`（在生成结束/按钮回到发送态时触发兜底）、`src/main/team/report-queue.js`、`src/main/team/task-manager.js`。

---

## 2. 回报解析：DONE content 是真报告（不含代码片段）

**背景**：Worker 常在真报告之后贴出含 `>>>MASTER_DONE_START<<<` / `>>>MASTER_DONE_END<<<` 字面量的修复代码，早期解析会误抓到代码片段。

- **操作步骤**：让一个 Worker 在 DONE 报告中附带一段含暗号字面量的 tokfree 代码块，观察主大脑收到的 content。
- **预期结果**：主大脑解析出的 content 是 **6 项结构化报告正文**，**不包含** Markdown 代码围栏（```...```）内的内容。
- **涉及文件**：`src/main/ipc.js` 的 `parseWorkerReport()`（解析前先用 `text.replace(/\`\`\`[\s\S]*?\`\`\`/g, '')` 剔除代码围栏，再取最后一对暗号）。

---

## 3. 编辑 diff：edit 返回含 unified diff

- **操作步骤**：让 AI 用 `edit` 工具修改任意一个文本文件的一行。
- **预期结果**：工具回执中除「已编辑/替换 N 处」外，**额外附一段 unified diff**（含 `---`/`+++` 头与 `-`/`+` 行），末尾可能带 `(checkpoint: <id>)` 提示。
- **涉及文件**：`tools/diff.js`（LCS 行级 diff，生成 unified diff）、`tools/EditTool.js`（`createUnifiedDiff` → `diffText` 拼进返回值）。

---

## 4. 检查点回滚：edit 后可见快照，可回滚

- **操作步骤**：
  1. 让 AI 用 `edit` 改一个文件（回执会带 checkpoint id）；
  2. 调用 `checkpoint_list()` 查看最近检查点；
  3. 用 `checkpoint_restore(id)` 回滚。
- **预期结果**：
  - `checkpoint_list` 列出刚改文件的快照（id / 文件路径 / 操作类型 edit / 时间 / 大小）；
  - `checkpoint_restore(id)` 把文件内容写回快照时的旧内容；回滚前会再存一份当前内容（可再反悔）。
  - 也可通过 IPC `checkpoint-list` / `checkpoint-restore` 查询。
- **涉及文件**：`src/main/checkpoint.js`（快照存储 `<baseDir>/checkpoints/`）、`tools/CheckpointTool.js`、`tools/EditTool.js` / `tools/WriteTool.js` / `tools/FileDeleteTool.js`（写前自动 `store.save`）、`src/main/ipc.js`（`checkpoint-list` / `checkpoint-restore`）、`src/preload/tool-names.js`。

---

## 5. 命令白名单：allow / confirm / deny 分级

**背景**：对标 Cline/Roo Code 的命令三级策略。判定顺序：**deny > allow > confirm > 内置黑名单兜底**。allow 命中但命令含 shell 链接/替换（`; | & \` $( `）时自动降级为 confirm，防 `npm test; rm -rf /` 绕过。

- **操作步骤**：
  1. 通过 IPC `command-policy-get` 查看当前配置（内置规则 + 用户规则）；
  2. `command-policy-add` 加一条 `{ action:'allow', type:'prefix', pattern:'npm test' }`；
  3. 让 AI 执行 `npm test`（应自动放行）；再执行 `npm test; echo hi`（因含 `;` 应降级为需确认）；
  4. 加一条 `{ action:'deny', pattern:'rm -rf' }`，让 AI 执行相关命令（应直接拒绝）。
- **预期结果**：allow 直接批准、含 shell 链接降级 confirm、deny 直接拒绝（信任模式也不能跳过 deny）。
- **涉及文件**：`src/main/command-policy.js`（`evaluateCommandPolicy`）、`src/main/tool-policy.js`（调用点，第 271 行附近）、`src/main/ipc.js`（`command-policy-get/add/remove/set`）、`src/main/dangerous-commands.js`。

---

## 6. 停止生成按钮

- **操作步骤**：在壳层对话框让 AI 开始生成（长回复），观察输入栏。
- **预期结果**：AI 运行中，输入栏出现「■ 停止」按钮；点击后调用活动 webview 内网页端「停止」按钮，弹出「已停止生成」提示；AI 空闲时按钮隐藏。
- **涉及文件**：`src/ui/shell.html`（`#cv-stop`）、`src/ui/shell.js`（`syncStopBtn` / `stopActiveGeneration`，约 3016–3058 行）、各平台 provider 的 `isGenerating` 检测。

---

## 7. Todo 面板（覆盖层任务清单）

- **操作步骤**：让 AI 调用 `todoWrite([...])`，打开覆盖层面板查看「任务清单」区。
- **预期结果**：任务清单区显示 todo 项（进行中/已完成图标与样式区分），标题旁进度文本（如 `2/3`）随更新刷新。
- **涉及文件**：`src/main/todo-store.js`（按 profileId 存储）、`src/main/ipc.js`（`todo-list`）、`tools/TodoWriteTool.js`、`src/preload/overlay/template.js`（`tokfree-todo-list` / `tokfree-todo-progress`）、`src/preload/overlay/events.js`。

---

## 8. 会话搜索 / 导出

- **操作步骤**：
  1. 在左栏会话列表的搜索框输入关键词；
  2. 右键/菜单选择「导出 Markdown」。
- **预期结果**：
  - 搜索框过滤会话（优先走主进程 `session-search`，不可用则本地过滤兜底）；
  - 导出生成 Markdown 文件（写入下载目录），内容含会话标题、导出时间、消息数、逐条消息。
- **涉及文件**：`src/ui/shell.js`（`#lb-session-search-input` 与 `sessionSearch`）、`src/preload/shell-preload.js`（`sessionSearch` / `sessionExport`）、`src/main/ipc.js`（`session-search` / `session-export`）、`src/main/session-export.js`、`src/main/session-store.js`。

---

## 9. Git 集成

- **操作步骤**：对已选项目目录调用 IPC `git-status`（传 `projectDir`）；再对某文件调用 `git-diff`。
- **预期结果**：
  - `git-status` 返回 `{ success, isRepo, branch, files:[{path,status}], commits }`；非 git 仓库优雅返回 `isRepo:false`；
  - `git-diff` 返回该文件的 diff 文本。
- **涉及文件**：`src/main/git.js`（`getStatus` / `getLog` / `getDiff`，`execFile` 指定 cwd）、`src/main/ipc.js`（`git-status` / `git-diff`，约 1472/1496 行）、`src/preload/api.js`（`gitStatus` / `gitDiff`）。

---

## 10. @ 引用文件

- **操作步骤**：在壳层对话框输入框输入 `@`。
- **预期结果**：弹出项目文件补全菜单（`#cv-at-menu`），排除 `node_modules` / `.git` / `dist` 等目录；选中文件后消息中带上 `【引用：路径】` 标记；文件列表来自 IPC `list-project-files`。
- **涉及文件**：`src/ui/shell.html`（`#cv-input` placeholder + `#cv-at-menu`）、`src/ui/shell.js`（@ 触发与补全，约 1956 行）、`src/preload/shell-preload.js`（`listProjectFiles`）、`src/main/ipc.js`（`list-project-files`，约 1513 行）。

---

## 11. 用量统计面板

- **操作步骤**：打开窗口管理面板，查看「用量统计」区，点「刷新」。
- **预期结果**：显示今日 / 本周汇总与各窗口明细（收发计数等）；数据来自 `stats-summary`（按窗口/按天聚合）。
- **涉及文件**：`src/preload/overlay/template.js`（`tokfree-usage-section` / `tokfree-usage-summary` / `tokfree-usage-list`）、`src/preload/overlay/events.js`（渲染用量统计）、`src/main/ipc.js`（`stats-summary`，约 679 行）、`src/main/conversation-stats.js`、`src/main/event-log.js`。

---

## 12. 上下文压缩（DeepSeek 全自动 / 其他平台降级）

- **操作步骤**：
  1. 在 **DeepSeek** 窗口点「压缩」：走全自动流程（读 IndexedDB 全量消息 → 生成交接摘要 → 调 share API → 跳转新会话续接）；
  2. 在 **非 DeepSeek** 平台（Claude/ChatGPT/Qwen/智谱）点「压缩」：弹确认框，说明不支持全自动，改为「生成交接摘要 → 复制剪贴板 → 引导新建会话粘贴」。
- **预期结果**：
  - DeepSeek：自动生成摘要、打开新会话并初始化续接；
  - 其他平台：弹出通用压缩确认 → 生成摘要并复制到剪贴板 → 提示「新建会话粘贴继续」。
- **涉及文件**：`src/preload/dom/compaction.js`（`runCompaction` 按 `provider.supportsFullCompaction` 分派）、`src/providers/deepseek.js`（`supportsFullCompaction: true`）、`src/preload/overlay/template.js`（`#tokfree-btn-compact`）、`src/preload/overlay/events.js`、`src/main/project-context.js`（压缩后续接提示）。

---

## 附：快速自检命令（重启前）

```bash
npm test        # 全部单元测试（含 checkpoint / command-policy / diff / tool-policy 等）
```

重点确认与本批改动相关的测试通过：`test/main/checkpoint.test.js`、`test/main/command-policy.test.js`、`test/tools/diff.test.js`、`test/main/tool-policy.test.js`。
