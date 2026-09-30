# 多 Agent 角色管理

> 本文档说明 TokFree 的「多 Agent 角色体系」：角色定义、开启方式、派发流程、物理约束、多组支持、UI 标识与角色修改。
> 相关源码：`src/main/team/role-manager.js`、`src/main/team/master-guard.js`、`src/main/team/mode.js`、`tools/JsRunner.js`。

## 1. 是什么

多 Agent 角色管理把窗口划分为两种角色，形成「总经理 → 员工」的协作结构：

- **主大脑（master）**：负责需求分析、任务拆解、派发、审阅、验收、决策；默认不亲自写/大改代码。
- **子 Agent（worker）**：接收主大脑派发的任务并独立执行，执行过程中通过三级暗号向主大脑回传进度与结果。

角色体系的目标是让一个窗口专注「规划与验收」，另一个（或多个）窗口专注「执行」，避免主大脑在复杂任务里既当裁判又当运动员。

角色与归属信息由 `src/main/team/role-manager.js` 统一管理（`role` + `belongTo`），模式开关由 `src/main/team/mode.js` 管理。

## 2. 角色定义

| 角色值 | 含义 | 行为 |
|--------|------|------|
| `master` | 主大脑 | 规划、派发、验收；受物理约束（见第 5 节），在有 Worker 时不能自己写文件/跑命令 |
| `worker` | 子 Agent | 执行主大脑派发的任务，按 Worker 协议用三级暗号回传 |
| `''`（空） | 单聊 | 默认模式，独立完成用户请求，不参与多 Agent 协作 |

### belongTo 归属

每个 worker 记录一个 `belongTo` 字段，指向它的主大脑（master）窗口标识。

- 有 `belongTo`：该 worker 属于某个特定的 master，回报只投递到自己的主大脑。
- 归属保证了「多主多从」时回报不会串台（见第 6 节）。

角色归属由 role-manager 持久化，窗口重启后仍可恢复。

## 3. 如何开启

1. 打开**设置面板**（覆盖层）。
2. 勾选 **多 Agent 模式**。
3. 当前窗口即变为 `master`（主大脑）。

模式按窗口独立存储（`mode.js`），默认是**单聊**；只有开启多 Agent 模式的窗口才会被注入总经理提示词并承担 master 职责。关闭该开关即回到单聊模式。

## 4. 如何派活

主大脑通过 team_* 工具派发任务：

- `team_dispatch_task(profileId, prompt, projectDir?, module?)` — 向指定 Worker 派发单个任务。
- `team_dispatch_batch(tasks[])` — 批量派发多个任务（无依赖模块可并行）。

派发流程：

1. 主大脑调用 `team_dispatch_task` / `team_dispatch_batch`。
2. 系统为目标窗口**自动开新对话 + 初始化项目上下文 + 绑定 taskId + 发送任务**。
3. **目标窗口随即变为 `worker`**，其 `belongTo` 指向发起派发的主大脑。
4. Worker 执行任务，通过 `>>>MASTER_SYNC_START<<<` / `>>>MASTER_DONE_START<<<` / `>>>MASTER_ASK_START<<<` 三级暗号回传。

> 提示：派发前先用 `team_get_workers_status()` 查看谁空闲（idle=true）。

## 5. 物理约束（重点）

主大脑**不能**在自己还有 Worker 时"既指挥又下场动手"。该约束在 `tools/JsRunner.js` 中**硬编码执行**（约 line 431-444）：

> **当窗口角色为 `master` 且名下存在 Worker 时：**
> - `write` / `edit` / `bash` 等**写/执行类工具被直接拒绝**（JsRunner 层硬拒绝，非提示词建议）。
> - **只读工具**（`read` / `readLines` / `glob` / `grep` 等）与 **`team_*` 协作工具放行**。

设计意图：

- 强制主大脑专注于**规划、派发、验收**，而不是抢 Worker 的活。
- 避免主大脑与 Worker **并行修改同一文件**导致冲突覆盖。

辅助机制：`src/main/team/master-guard.js` 负责**自干提醒**——当主大脑试图自己动手（或该由 Worker 完成时），给出提醒，引导主大脑回到"派发/验收"职责。

> 注意：约束只在「master + 名下有 Worker」时生效。若 master 名下暂无 Worker（例如准备亲自处理一个很小的收尾），约束不触发。

## 6. 多组支持

角色体系支持**多个主大脑各自带一组 Worker**并行工作，例如「2 个主 + 各自 2 个 Worker」。

- 每个 Worker 通过 `belongTo` 归属到**唯一**的主大脑。
- Worker 的回传只投递给 `belongTo` 指向的主大脑，**不会串到别的主大脑**。
- 因此多个 master 可以同时存在、各自管理自己的 Worker 组，互不干扰。

## 7. UI 标识

窗口列表中直观展示角色：

- 主大脑窗口显示：**`[主]`**
- 子 Agent 窗口显示：**`[次·主名]`**（"主名"为其归属主大脑的名称）

通过标签一眼区分「谁是主、谁是谁的次」。

## 8. 改角色

在**窗口列表**中通过「**角色**」按钮手动调整窗口角色，可选：

- **设为主**：把该窗口设为 `master`（主大脑）。
- **设为子**：把该窗口设为 `worker`（子 Agent）。
- **清除**：清空角色（回到 `''` 单聊模式）。

修改后会同步更新 role-manager 中的角色与归属信息，UI 标识随之刷新。

## 附：一句话总结

多 Agent 角色管理 = `master`（规划/派发/验收）+ `worker`（执行，`belongTo` 归属），
用 **JsRunner 物理约束** 保证主大脑在有 Worker 时只读+协作、不自己动手写代码，
支持多主多从分组、窗口列表可视标识、一键改角色。
