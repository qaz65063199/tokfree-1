# Agent 自工程化（Self-Engineering）

> 让 AI Agent **自己写技能、自己修技能、自己迭代技能**——在「技能层」持续演化，而不触碰模型权重。
> 本文面向后续维护者与 AI：说明自工程化系统是什么、怎么运作、怎么用、怎么验证。

---

## 一、概述

### 1.1 什么是 Agent 自工程化

**自工程化**指 Agent 在完成真实任务的过程中，把「怎么做成一件事」沉淀为**可复用、可验证、可迭代**的方法资产，并在后续任务中自动调用、按效果优胜劣汰。

它有别于两类常见"自我改进"：

| 路线 | 改什么 | 本项目的取舍 |
| --- | --- | --- |
| **模型层演化**（微调 / RLHF） | 改模型权重 | ❌ 不做——成本高、不可控、无法在本地零 Token 环境落地 |
| **提示词层演化**（手改 prompt） | 人工改提示词 | ⚠️ 部分——但靠人肉维护，不规模化 |
| **技能层演化**（本项目） | 自动沉淀/验证/迭代**技能资产** | ✅ 采用——技能是外挂的 Markdown 方法论，可读写、可验证、可淘汰 |

**为什么是技能层**：TokFree 是**零 Token 成本**的桌面 Agent，没有 API 可微调；但技能库（`src/main/knowledge.js`）本身就是一套**可被 AI 读写的文件系统**。于是"改进"落到"写/改技能文件"上——这是可自动化的。

### 1.2 一句话闭环

> **执行任务 → 记录轨迹 → 复盘分析 → 生成/优化技能 → 沙盒验证 → 入库 → 下次优先调用 → 淘汰低效技能**

这条飞轮每转一圈，系统对"某类任务该怎么做"就更清楚一点。

---

## 二、三级演进路径

自工程化按"自动化程度"分三级。本项目**当前实现到 Level 3 的完整闭环**（可自动生成、验证、迭代、淘汰）。

### Level 1：可观测（Observability）

**目标**：能看见"任务是怎么做成的、哪一步慢/失败"。

- **执行轨迹**（`trace.js`）：每次工具调用记录工具名、参数、成功与否、错误、耗时、输出大小。
- **复盘引擎**（`retrospect.js`）：纯规则分析轨迹，产出失败模式、耗时热点、重复调用，并构造给 AI 的复盘 Prompt。
- **特征**：只**记录与呈现**，不改变任何行为。

### Level 2：可生成（Generation）

**目标**：能从复盘结论**自动生成**一份合格的技能，并**验证后入库**。

- **技能生成**（`skill-forge.js`）：把复盘发现转成标准技能草稿（name / description / content），经**结构校验 + 规则检查 + 模拟用例**验证，成功率 ≥ 80% 才允许入库。
- **特征**：能**写出**新技能，且拒绝污染技能库。

### Level 3：可演化（Evolution）

**目标**：技能库能**根据真实使用效果自我迭代、自我淘汰**。

- **技能迭代淘汰**（`skill-evolver.js`）：记录每次技能使用（成功/失败/耗时），分析出「待优化」与「淘汰候选」，低效技能自动归档（可恢复）。
- **特征**：技能库**优胜劣汰**，不无限膨胀。

### 本项目实现程度

| 级别 | 能力 | 实现 | 对应模块 |
| --- | --- | --- | --- |
| Level 1 | 轨迹记录 + 规则复盘 | ✅ 完整 | `trace.js`、`retrospect.js`、JsRunner 自动挂钩 |
| Level 2 | 技能生成 + 沙盒验证 + 入库 | ✅ 完整 | `skill-forge.js` + `knowledge.js` |
| Level 3 | 使用回写 + 优化建议 + 淘汰归档 | ✅ 完整 | `skill-evolver.js` |
| Level 3+ | 全自动无人值守优化（定时任务自动复盘→生成→淘汰） | ⚠️ 半自动 | 工具已就绪，需 AI/用户主动触发；无后台定时器 |

> **诚实说明**：任务描述提到的「auto-evolve / meta-evolve / meta-stats.json」在本仓库中**没有独立文件**。
> 它们对应的是 `skill-evolver.js` 的**分析（analyze）与淘汰（archivePass）**能力，由 `auto_skill_stats` / `auto_skill_archive_pass` 两个工具暴露。
> 「元统计」实际存储在 `skill-stats.json`（而非 meta-stats.json）。本文按真实代码撰写。

---

## 三、架构图：进化飞轮闭环

```
                        ┌──────────────────────────────────────────────┐
                        │              执行任务（AI 工作）               │
                        └───────────────────────┬──────────────────────┘
                                                │ 每步工具调用
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  trace.recordStep()  （JsRunner 自动挂钩）     │
                        │  userData/traces/<profileId>.json             │
                        └───────────────────────┬──────────────────────┘
                                                │ auto_trace_list / get
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  复盘引擎 retrospect.analyzeTrace()           │
                        │  失败模式 · 耗时热点 · 重复调用 · 优化建议      │
                        │  → buildRetrospectPrompt()（交给 AI 复盘）     │
                        └───────────────────────┬──────────────────────┘
                                                │ auto_retrospect
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  技能生成 skill-forge.buildSkillDraft()       │
                        │  → validateSkill() 沙盒验证（≥80% 才放行）      │
                        └───────────────────────┬──────────────────────┘
                                                │ auto_skill_forge(_commit)
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  知识库 knowledge.createSkill()               │
                        │  userData/knowledge/skills/<name>.md          │
                        └───────────────────────┬──────────────────────┘
                                                │ 项目 enable → 注入提示词
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  下次任务优先调用该技能（AI 按提示词行事）      │
                        └───────────────────────┬──────────────────────┘
                                                │ 使用中记录效果
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  skill-evolver.recordUsage()                  │
                        │  userData/knowledge/skill-stats.json          │
                        └───────────────────────┬──────────────────────┘
                                                │ auto_skill_stats
                                                ▼
                        ┌──────────────────────────────────────────────┐
                        │  分析 analyze() → 待优化 / 淘汰候选            │
                        │  archivePass() → 低效技能归档（可恢复）        │
                        └───────────────────────┬──────────────────────┘
                                                │
                                                └──────► 回到「执行任务」（用优化后的技能）
```

**飞轮的关键**：每个环节都有明确的**产物**与**消费者**——轨迹喂给复盘，复盘喂给生成，生成的技能被使用后喂给迭代，迭代结论又反过来影响下次执行。

---

## 四、模块说明

### 4.1 trace.js — 执行轨迹

**职责**：记录每次任务执行的完整轨迹（每一步工具调用的输入/输出/耗时/错误），是进化飞轮的**原料**。

**位置**：`src/main/team/trace.js`
**存储**：`userData/traces/<taskId>.json` + `index.json`

**核心接口**：

| 函数 | 说明 |
| --- | --- |
| `beginTrace(taskId, {profileId, goal})` | 开始记录一个任务轨迹（内存中） |
| `recordStep(taskId, {tool, args, success, error, durationMs, outputSize})` | 记录一步工具调用；未 begin 会自动补建 |
| `endTrace(taskId, {outcome, summary})` | 结束轨迹并落盘 + 更新索引 |
| `getTrace(taskId)` | 取轨迹（内存优先，否则读盘） |
| `listTraces(limit)` | 列出轨迹摘要（按开始时间倒序） |
| `clearAll()` | 清空所有轨迹（调试用） |
| `hasActive(taskId)` | 是否有活跃轨迹 |

**容量与淘汰**：`MAX_TRACES = 100`（超出按开始时间淘汰最旧）、`MAX_STEPS_PER_TRACE = 500`、`MAX_FIELD_LEN = 2000`（字段截断）。

**纯记录模块**：不改变任何工具行为，失败静默（绝不影响主流程）。

> **注意**：实际挂钩点是 `tools/JsRunner.js` 的 `hostBridge`，它用 `callerProfileId`（**窗口 profileId**，不是 taskId）作为 traceKey 调用 `recordStep`。
> 即：默认按**窗口**聚合轨迹，而非按任务。AI 复盘时用 `auto_trace_list` 看到的就是这些 key。

### 4.2 retrospect.js — 复盘引擎（Level 1 核心）

**职责**：消费轨迹，产出结构化复盘报告与给 AI 的复盘 Prompt。

**位置**：`src/main/team/retrospect.js`（纯 Node，仅依赖 trace.js）

**核心接口**：

| 函数 | 说明 |
| --- | --- |
| `analyzeTrace(input)` | 纯规则分析（输入 trace 对象或 taskId），返回 `{ok, summary, failureModes, hotspots, retries, findings}` |
| `buildRetrospectPrompt(input)` | 构造给「复盘 Agent」的完整 Prompt（含摘要、发现、步骤明细、输出结构要求） |
| `listOptimizableTraces(limit)` | 列出「值得复盘」的轨迹（失败/部分成功/长耗时/步骤多），按值得度降序 |
| `scoreTrace(summary)` | 给单条轨迹摘要打分（failed +50 / partial +30 / 每错误 +10 / 长耗时 +10 / 步骤多 +5） |

**分析维度**：

- **失败模式**（failureModes）：按 `tool + error` 归并，统计次数与步骤号。
- **耗时热点**（hotspots）：单步耗时 > `max(1000ms, 平均×2)` 视为热点；无热点则取最慢 3 步。
- **重复调用**（retries）：相同 `tool + args` 签名出现 ≥ 2 次。
- **可优化点**（findings）：把上述三类转成带 `severity`（high/medium/low）与 `suggestion` 的建议。

**常量**：`HOTSPOT_RATIO=2`、`HOTSPOT_MIN_MS=1000`、`RETRY_MIN=2`、`MAX_PROMPT_STEPS=60`。

### 4.3 skill-forge.js — 技能生成与验证（Level 2 核心）

**职责**：从复盘发现生成标准技能草稿，经沙盒验证后入库。

**位置**：`src/main/team/skill-forge.js`（纯 Node，惰性 require knowledge.js）

**核心接口**：

| 函数 | 说明 |
| --- | --- |
| `buildSkillDraft(analysis)` | 从容错字段（goal/steps/triggers/tools/validate/fallback…）生成 `{name, description, content}` |
| `validateSkill(draft, opts)` | 沙盒验证，返回 `{passed, score, checks, reason}` |
| `forgeSkill(draft, opts)` | 验证通过且 `score ≥ minScore`（默认 0.8）则调 `knowledge.createSkill` 入库 |
| `toKebabCase(text)` | 转 kebab-case 技能名 |
| `extractKeywords(text)` | 提取候选触发关键词（过滤停用词与 <3 字符词） |
| `NAME_RE` | 技能名正则：`^[a-z0-9]+(?:-[a-z0-9]+)*$` |

**验证的 6 项检查**（全部通过才 `passed`）：

1. `name` 合法（kebab-case，1-64 字符）
2. `description` 非空
3. `description` 长度合理（20-1024）
4. `description` 含 "Use when" 触发短语
5. `content` 非空
6. `content` 有步骤列表
7. `simulation.match`：description 关键词能匹配测试查询（匹配率 ≥ 80%）

**为什么"模拟用例"**：运行环境无法真调 AI 验证技能好不好，于是用「description 提取的关键词 vs 测试查询」的匹配率做**代理指标**——触发词覆盖得好，说明技能在未来任务中更可能被正确激活。

### 4.4 skill-evolver.js — 技能迭代与淘汰（Level 3 核心）

**职责**：记录技能使用效果，分析出待优化/淘汰候选，归档低效技能。

**位置**：`src/main/team/skill-evolver.js`
**存储**：`userData/knowledge/skill-stats.json`
**归档**：`userData/knowledge/skills-archive/<name>.md` + `<name>.meta.json`

**核心接口**：

| 函数 | 说明 |
| --- | --- |
| `recordUsage(name, {success, durationMs})` | 记录一次技能使用（uses/success/fail/totalMs/lastUsedAt） |
| `getStat(name)` / `listStats()` | 取单个 / 全部技能统计 |
| `successRate(stat)` / `avgDuration(stat)` | 成功率（0-1）/ 平均耗时（ms），无使用返回 null |
| `analyze()` | 返回 `{needOptimize, archiveCandidates, healthy, summary}` |
| `listNeedingOptimize()` / `listArchiveCandidates()` | 快捷列表 |
| `archiveSkill(name, reason)` | 归档技能（正文移入 archive + 从注册表删除 + 标记统计） |
| `restoreSkill(name)` | 从归档恢复技能 |
| `runArchivePass()` | 批量执行淘汰归档（"供每日优化器调用"） |
| `clearStats()` | 清空统计（调试用） |

**配置阈值**（`CONFIG`）：

| 项 | 值 | 含义 |
| --- | --- | --- |
| `archiveAfterDaysUnused` | 30 | 超过 30 天未用且成功率低 → 归档 |
| `lowSuccessRate` | 0.5 | 成功率 < 50% 视为低效 |
| `minUsesForEval` | 3 | 至少用过 3 次才评估淘汰（避免误杀新技能） |
| `optimizeSuccessRate` | 0.7 | 成功率 < 70% → 建议优化 |
| `optimizeAvgMs` | 30000 | 平均耗时 > 30s → 建议优化 |

**归档 vs 删除**：归档是**可恢复**的——正文先复制到 `skills-archive/`，再从注册表删除；`restoreSkill` 可还原。

### 4.5 auto-evolve / meta-evolve（概念层）

> 这两个名字在**任务描述**中出现，但**代码中没有独立模块**。它们是 `skill-evolver.js` 能力的**概念代称**：

- **auto-evolve（自动演化）** = `recordUsage`（使用回写）+ `analyze`（分析）+ `runArchivePass`（淘汰）的组合，由 `auto_skill_stats` / `auto_skill_archive_pass` 工具暴露。
- **meta-evolve（元演化）** = 对"演化过程本身"的统计（技能成功率、淘汰数），即 `skill-stats.json` 里的**元数据**（非独立 meta-stats.json）。

**维护者注意**：若要新增真正的定时自动优化，应在 `src/main/team/` 下新建模块（如 `auto-evolve.js`）并挂到主进程定时器，而非假设它已存在。

### 4.6 knowledge.js — 技能库（存储底座）

**职责**：技能的 CRUD 与项目级启用状态，是 forge/evolver 的存储后端。

**位置**：`src/main/knowledge.js`
**关键接口**：`createSkill / readSkill / updateSkill / deleteSkill / listSkills / enableSkill / disableSkill / getEnabledSkills / buildKnowledgeSection`。

详见 `docs/KNOWLEDGE.md`。自工程化通过它落盘技能，通过 `buildKnowledgeSection` 把技能注入提示词。

---

## 五、工具清单（8 个 auto_* 工具）

全部定义在 `tools/AutoEngTools.js`，在 `tools/index.js` 注册。**这些工具不贡献独立提示词章节**（`getPromptSection()` 返回 `null`），说明由知识库章节统一注入。

| # | 工具 | 用途 | 用法 |
| --- | --- | --- | --- |
| 1 | `auto_trace_list(limit?)` | 列出最近执行轨迹（执行历史） | `auto_trace_list(10)` |
| 2 | `auto_trace_get(taskId)` | 读取某条轨迹详情 | `auto_trace_get("abc123")` |
| 3 | `auto_retrospect(taskId)` | 复盘某轨迹，返回规则分析 + 复盘 Prompt | `auto_retrospect("abc123")` |
| 4 | `auto_skill_forge(analysis)` | 从复盘发现生成技能草稿并验证（**不入库**） | `auto_skill_forge({goal, steps, triggers})` |
| 5 | `auto_skill_forge_commit(draft)` | 验证通过则把草稿入库 | `auto_skill_forge_commit(draft)` |
| 6 | `auto_skill_stats()` | 技能使用统计 + 优化/淘汰建议 | `auto_skill_stats()` |
| 7 | `auto_skill_archive_pass()` | 执行淘汰归档（低效技能移入归档） | `auto_skill_archive_pass()` |
| 8 | `auto_skill_record_usage(name, success, durationMs?)` | 记录一次技能使用，驱动迭代淘汰 | `auto_skill_record_usage("code-review", true, 1200)` |

**典型两步式生成**：`auto_skill_forge`（预览草稿 + 验证结果）→ 人工/AI 确认 → `auto_skill_forge_commit`（真正入库）。
这样设计是为了**让 AI 先看验证结果再决定是否入库**，避免草率沉淀。

---

## 六、闭环飞轮：如何转起来

### 6.1 文字版

1. **执行**：AI 完成任务，JsRunner 自动把每一步工具调用写入轨迹。
2. **复盘**：任务结束后，AI 调 `auto_trace_list` 找到本次轨迹 → `auto_retrospect` 得到规则分析 + 复盘 Prompt。
3. **生成**：AI 按复盘 Prompt 反思，把可复用流程整理成 `analysis` → `auto_skill_forge` 生成草稿并验证。
4. **验证**：`validateSkill` 检查 name/description/content/触发词/模拟匹配；< 80% 直接拒绝。
5. **入库**：验证通过 → `auto_skill_forge_commit` → `knowledge.createSkill` 落盘。
6. **启用**：项目 `enableSkill` 后，下次初始化该技能被注入提示词。
7. **使用**：下次同类任务，AI 按技能行事；结束后 `auto_skill_record_usage` 回写效果。
8. **迭代**：`auto_skill_stats` 分析成功率/耗时 → 低效技能建议优化；`auto_skill_archive_pass` 归档长期低效技能。
9. **回到 1**：用优化后的技能执行下一个任务。

### 6.2 图

```
   ┌─────────┐   轨迹    ┌─────────┐  复盘  ┌─────────┐
   │  执行   │ ────────► │  记录   │ ─────► │  分析   │
   └─────────┘           └─────────┘        └────┬────┘
        ▲                                         │ 生成草稿
        │                                         ▼
        │                                    ┌─────────┐
        │            注入提示词               │  验证   │
        │         ┌─────────────┐            └────┬────┘
        │         ▼             │  ≥80% 放行       │
        │    ┌─────────┐   ┌────▼────┐             │
        └────│  调用   │◄──│  入库   │◄────────────┘
             └────┬────┘   └─────────┘
                  │ 使用效果
                  ▼
             ┌─────────┐  分析   ┌─────────┐
             │  统计   │ ──────► │ 优化/淘汰│ ──► 归档
             └─────────┘         └─────────┘
```

### 6.3 飞轮为什么能"越转越快"

- **正反馈**：好技能被用得越多 → 统计越准 → 越被保留；坏技能越用越暴露 → 被优化或淘汰。
- **低污染**：80% 验证门槛 + "同一件事做 2-3 次再沉淀"原则，防止一次性经验污染技能库。
- **可回收**：淘汰是归档不是删除，误杀可恢复。

---

## 七、使用指南：AI 何时该主动自工程化

知识库章节（`buildKnowledgeSection`）已明确列出三条触发时机，AI 应据此主动行动：

### 7.1 完成一个复杂任务后 ✅ 最常用

```
auto_trace_list()                 // 找到本次轨迹
auto_retrospect(taskId)           // 复盘：拿到分析 + 复盘 Prompt
// ... AI 按 Prompt 反思 ...
auto_skill_forge(analysis)        // 生成草稿 + 验证
auto_skill_forge_commit(draft)    // 验证通过则入库
```

**判据**：任务复杂（多步/有失败/有弯路）、且流程**可能复用**。

### 7.2 某技能用得不顺时

```
auto_skill_stats()                // 看该技能成功率/耗时
// 若成功率低 → 用 skill_read 读正文 → skill_update 优化
```

### 7.3 定期维护（如项目里程碑）

```
auto_skill_stats()                // 总览：待优化 / 淘汰候选
auto_skill_archive_pass()         // 执行淘汰归档
```

### 7.4 原则（务必遵守）

- **只有真正可复用的方法论才沉淀为技能**——同一件事做过 **2-3 次**再沉淀。
- **生成前先验证**——永远走 `auto_skill_forge`（预览）→ `auto_skill_forge_commit`（入库）两步。
- **记录使用效果**——技能用完后 `auto_skill_record_usage`，否则迭代飞轮缺数据。
- **别把一次性经验当技能**——临时踩坑用 `lesson_record`（教训），可复用方法才用技能。

---

## 八、数据存储

所有自工程化数据都在 Electron 的 `userData` 目录下（`app.getPath('userData')`，Windows 通常为 `%APPDATA%\<appName>`；本项目经 `app.setPath` 指向会话目录，实际路径以启动日志 `[TokFree] Session 数据目录` 为准）。

```
<userData>/
├── traces/                          # 执行轨迹（trace.js）
│   ├── index.json                   # 索引：taskId → 摘要（含 stepCount/errorCount/durationMs/outcome）
│   └── <taskId>.json                # 单条轨迹全文（steps[] + outcome + summary）
│
└── knowledge/                       # 知识库（knowledge.js + skill-evolver.js）
    ├── preferences.md               # 全局偏好
    ├── skills.json                  # 技能注册表 [{name, description, tags, createdAt}]
    ├── skills/                      # 技能正文
    │   └── <name>.md
    ├── skill-stats.json             # 技能使用统计（skill-evolver.js）★元统计
    └── skills-archive/              # 淘汰归档（可恢复）
        ├── <name>.md
        └── <name>.meta.json         # 归档原因 + 时间
```

### 8.1 traces/index.json 结构

```json
{
  "traces": [
    {
      "taskId": "<profileId 或 taskId>",
      "profileId": "win-1",
      "goal": "任务目标",
      "outcome": "success | partial | failed | empty",
      "stepCount": 12,
      "errorCount": 2,
      "durationMs": 45000,
      "startedAt": "2025-01-01T00:00:00.000Z",
      "endedAt": "2025-01-01T00:00:45.000Z"
    }
  ]
}
```

### 8.2 traces/<taskId>.json 结构

```json
{
  "taskId": "win-1",
  "profileId": "win-1",
  "goal": "任务目标",
  "startedAt": "...",
  "endedAt": "...",
  "steps": [
    { "seq": 1, "ts": "...", "tool": "read", "args": "...", "success": true, "error": "", "durationMs": 120, "outputSize": 3400 }
  ],
  "outcome": "success",
  "summary": ""
}
```

### 8.3 skill-stats.json 结构

```json
{
  "stats": {
    "code-review": {
      "uses": 8,
      "success": 7,
      "fail": 1,
      "totalMs": 24000,
      "lastUsedAt": 1735689600000,
      "createdAt": 1735600000000,
      "archived": false
    }
  }
}
```

> **没有 meta-stats.json**。任务描述中的"元统计"即 `skill-stats.json`——它记录技能成功率/耗时，是 Level 3 迭代的决策依据。

---

## 九、验证方法：如何验证闭环成立

### 9.1 验证 Level 1（轨迹 + 复盘）

1. 正常执行一个含多次工具调用的任务。
2. 调 `auto_trace_list()` → 应看到刚才的轨迹（key = 窗口 profileId）。
3. 调 `auto_trace_get(taskId)` → 应看到 `steps[]` 明细。
4. 调 `auto_retrospect(taskId)` → 应返回 `analysis`（含 failureModes/hotspots/retries/findings）与 `prompt`。
5. **反向验证**：故意让某工具失败（如读不存在的文件），复盘应把它归入 `failureModes`。

### 9.2 验证 Level 2（生成 + 验证）

1. 构造一个 `analysis`：`{goal: "生成周报", steps: ["收集数据", "写正文", "校对"], triggers: ["周报", "weekly report"]}`。
2. 调 `auto_skill_forge(analysis)` → 应返回 `draft`（name 为 kebab-case）+ `validation`（`passed: true`）。
3. 调 `auto_skill_forge_commit(draft)` → 应返回 `ok: true`。
4. 调 `skill_list()` → 应看到新技能。
5. **反向验证**：给一个 description 为空或 name 含大写的 draft 调 `auto_skill_forge_commit` → 应被拒绝（`ok: false` + reason）。

### 9.3 验证 Level 3（使用回写 + 迭代淘汰）

1. 调 `auto_skill_record_usage("code-review", true, 1200)` 多次，混入几次 `success: false`。
2. 调 `auto_skill_stats()` → `needOptimize` 应包含成功率低的技能。
3. 造一个「用过 ≥3 次 + 成功率 <50% + lastUsedAt 设为 30 天前」的技能，调 `auto_skill_stats()` → 应出现在 `archiveCandidates`。
4. 调 `auto_skill_archive_pass()` → 该技能被归档：`skill_list()` 看不到，`skills-archive/<name>.md` 存在。
5. 调 `restoreSkill`（经代码或后续工具）→ 技能恢复。

### 9.4 端到端闭环验证（推荐）

```
执行任务 → auto_trace_list → auto_retrospect → 得到 analysis
        → auto_skill_forge → auto_skill_forge_commit → skill_list（确认入库）
        → auto_skill_record_usage（多次，含失败）
        → auto_skill_stats（确认进入 needOptimize）
        → auto_skill_archive_pass（确认归档）→ skills-archive 存在
```

**通过标准**：每一步产物可被下一步消费，且反向用例（坏输入）被正确拒绝。

### 9.5 单元测试

本项目用 Node 内置 test runner（`npm test`）。自工程化相关测试覆盖 trace / retrospect / skill-forge / skill-evolver 的纯逻辑（这些模块设计为可注入依赖、惰性 require electron，便于测试）。

---

## 十、维护者备忘

- **改动位置**：新增自工程化能力应落在 `src/main/team/`（模块）+ `tools/AutoEngTools.js`（工具封装）+ `tools/index.js`（注册）三处。
- **不要顶层 require electron**：team 模块内部用 `app.getPath`，顶层 require 在测试环境会失败——用**惰性 require**（`loadXxx()` 模式）。
- **失败静默**：trace / retrospect 等模块任何异常都应静默降级，**绝不阻断主流程**。
- **工具命名一致**：JsRunner 桥接的全局函数名、prompt 章节、构造函数签名串必须完全一致。
- **归档优先于删除**：淘汰技能用归档（可恢复），避免误杀。
- **验证门槛**：技能入库前必须过 `validateSkill`，且 `score ≥ 0.8`。

---

## 十一、相关文档

| 文档 | 内容 |
| --- | --- |
| `docs/KNOWLEDGE.md` | 知识库（全局偏好 + 技能库 + 项目知识）三层体系 |
| `docs/SELF_ENGINEERING.md` | 本文——自工程化（技能层演化）闭环 |
| `src/main/team/trace.js` | 执行轨迹源码 |
| `src/main/team/retrospect.js` | 复盘引擎源码 |
| `src/main/team/skill-forge.js` | 技能生成与验证源码 |
| `src/main/team/skill-evolver.js` | 技能迭代与淘汰源码 |
| `tools/AutoEngTools.js` | 8 个 auto_* 工具封装 |
