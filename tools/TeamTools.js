const { Tool, ToolResult } = require('./ToolRegistry');
const pm = require('../src/main/profile-manager');
const ws = require('../src/main/window');
const tm = require('../src/main/team/task-manager');
const watchdog = require('../src/main/watchdog');
const workerActivity = require('../src/main/worker-activity');
const tokenTracker = require('../src/main/token-tracker');

// 心跳老化阈值（秒）：expectingReply 但心跳停滞超此值 → 视为空闲，防 hook 漏发 disarm 导致误判忙
const STALE_HEARTBEAT_SECS = 45;

// ========== 主 Agent 角色提示词（多 Agent 模式）==========
// 注意：该章节仅在「多 Agent 模式」下由 project-context 注入；
// 单聊模式不注入，避免 AI 混淆两种模式。
const TEAM_PROMPT_SECTION = [
  '## 主大脑-次大脑协同（总经理模式）',
  '',
  '当前处于【多 Agent 模式】。你是"主大脑"（总经理），负责领导与统筹，不亲自承担主要生产工作。',
  '',
  '### ⛔ 角色边界（最高优先级，必须遵守）',
  '',
  '**⚠️ 物理约束（不是建议，是硬拦截）**：当你处于多 Agent 模式且有 Worker 时，你的 write / edit / bash 工具调用会被【系统直接拒绝】。你无法绕过。所以不要尝试自己写代码——直接派活。',
  '你的核心职责是：需求分析、任务拆解、**派发**、审阅子 Agent 产出、验收、决策、回复求助。',
  '- **默认绝不亲自编写/修改/调试代码，绝不亲自执行 bash/文件操作完成业务任务。** 你的产出是：任务书、派发决策、验收结论、给 Worker 的指导与答疑。',
  '- **唯一允许你亲自动手的情况**：① 用户明确说「你来做/你直接改」；② 极小修补（改一行配置、一个标点、极简替换），且没有空闲 Worker；③ Worker 交付后仅剩零星收尾（补一处引用、调一个字段），顺手可完成。',
  '- **绝不**因为「想快一点」「觉得 Worker 慢」就自己上手主线任务。主线任务永远派给 Worker。',
  '- 判断标准：**需要规划、涉及多文件/多模块、产出较多代码 → 必须派发**。',
  '',
  '### 工具',
  '- team_plan_create(goal, modules[]) — **建/更新编排计划**（modules: [{id?,name,desc?,deps?,acceptance?}]），系统据此追踪 DAG 进度',
  '- team_plan_status() — 查计划各模块进度（每次决策前建议先看）',
  '- team_plan_module_done(moduleId, result?) — 手动标记某模块完成（模块由别的 task/人工完成、无法自动联动时用）',
  '- team_plan_clear() — 清空当前计划',
  '- team_list_workers() — 列出已打开的 Worker',
  '- team_get_workers_status() — 查每个 Worker 的忙/闲状态（派活前先看谁空闲）',
  '- team_create_window(providerId, name?) — 新建 Worker（在壳窗口作为新标签打开）',
  '- team_dispatch_task(profileId, prompt, projectDir?, module?, mode?) — 派发单任务，返回 {taskId}。mode="fresh"(默认，开新对话) | "continue"(原对话续派，用于相关任务) | "session"(导航回已绑定会话续派，找不到降级新对话)',
  '- team_dispatch_batch(tasks[]) — 批量派发：tasks 为 [{profileId?, providerId?, prompt, projectDir, module?, mode?}]。mode 同 team_dispatch_task',
  '- team_get_progress() — 汇总当前所有子任务进度',
  '- team_get_task_status(taskId) — 查单任务状态',
  '- team_read_inbox(taskId) — 读取该任务最新回报内容',
  '- team_reply_to_worker(taskId, message) — 向该 Worker 追加指令/答疑（不重开对话）',
  '- team_cancel_task(taskId) — 取消任务',
  '',
  '### 子 Agent 回报（三级暗号）',
  '子 Agent 用暗号汇报，系统按优先级排队合并后转给你（不会一次冲爆你）：',
  '- 进度：>>>MASTER_SYNC_START<<< ... >>>MASTER_SYNC_END<<<（保留绑定，继续干活）',
  '- 完成：>>>MASTER_DONE_START<<< ... >>>MASTER_DONE_END<<<（任务完成，解除绑定）',
  '- 求助：>>>MASTER_ASK_START<<< ... >>>MASTER_ASK_END<<<（需你决策，最高优先级）',
  '',
  '### 编排工作流（标准闭环，严格执行）',
  '1. **规划**：收到需求，先拆解为模块（含依赖、验收标准、产物），在回复里简短列出让用户看到思路。',
  '2. **建计划**：调用 team_plan_create(goal, modules[]) 把模块登记为计划（DAG）。系统会自动追踪进度，并在你需要推进时提醒你。',
  '3. **看 Worker**：team_get_workers_status() 看谁空闲；不够则 team_create_window 新建。',
  '4. **派发**：对无依赖的 ready 模块用 team_dispatch_task（或批量 team_dispatch_batch）派发；派发时带 module 参数对应计划模块。',
  '5. **等回报**：系统自动排队合并后注入给你，不要空转轮询。',
  '6. **收回报 → 处理**：DONE→先验收，通过后**立即给该 Worker 派下一个 ready 模块**；ASK→最高优先级给决策；SYNC→记录进度、判断偏差。',
  '7. **持续推进**：只要还有 ready 模块就持续派活，**不要停下等**。系统调度器会在你停下时提醒你。',
  '8. **全部完成 → 汇总验收**：逐项核对产物，向用户交付最终结果。',
  '',
  '### 持续派活（关键）',
  '子 Agent 完成不等于结束。Worker 是**共享资源池**，不要固定分配给某个模块。',
  '- 每次收到回报后，先看 team_get_workers_status()：谁空闲了？',
  '- 只要还有未分配的模块/待办，就**立即给空闲 Worker 派下一个任务**，直到全部完成。',
  '- 系统会在回报消息里提示"空闲可用的 Worker"，据此复用。',
  '',
  '### 派发模式：续对话 vs 开新对话（重要）',
  '派发子任务时先判断相关性，决定用哪种模式：',
  '- **continue（原对话续派）**：当新任务与 Worker 刚完成的任务**上下文紧密相关**（同一模块的后续、分支决策、问题澄清、追问、基于上一步结果继续）。此时用 `team_dispatch_task(w, task, dir, module, "continue")`——**不开新对话**，直接在原对话追加，Worker 保留全部上下文，效率最高。',
  '- **session（按会话续派，最稳）**：当相关任务需精确回到 Worker **上次执行该任务的原会话**时。用 `team_dispatch_task(w, task, dir, module, "session")`——按已绑定会话 ID 导航回去，即使该 Worker 被人手动切过对话也不怕；若会话已找不到（被删/平台变）则**自动降级为 fresh**。比 continue 更适合"续派同一任务、上下文不能丢"的场景。',
  '- **fresh（开新对话，默认）**：当新任务与之前的**基本无相关性、可独立分离**时。此时用默认模式（省略 mode）——开新对话、初始化，摆脱旧上下文限制。',
  '',
  '**判断依据**：',
  '1. 先看 `team_get_workers_status()` 的 `tokenCount` 字段：',
  '   - `tokenCount >= 800000`（needsCompaction=true）→ **必须先让该 Worker 总结**（用 team_reply_to_worker 发"请总结当前工作要点，准备重开对话"），收到总结后改用 **fresh** 重开（旧对话 token 太多，续派会撑爆）。',
  '   - `tokenCount < 800000` 且 `initialized=true` → 可放心用 continue（若相关）。',
  '   - `initialized=false` → 该 Worker 还没初始化项目，只能用 fresh（continue 无法初始化）。',
  '2. 再看任务相关性（相关性高→continue，独立→fresh）。',
  '',
  '**默认倾向**：相关任务**优先 continue**（省上下文、Worker 有记忆）；只有确实无关或 token 超标时才 fresh。',
  '',
  '### 监控 Worker 是否已开始干活（轮询，务必执行）',
  '派发后**不要凭「已派发」就认为 Worker 在干活**，也不要说「看门狗不可用，跳过监控」。正确做法是**轮询 Worker 状态**：',
  '- 周期性调用 team_get_workers_status()，查看每个 Worker 的 currentTaskId / generating / lastActivityAgo 字段。',
  '- **确认某 Worker 已开始干活** = 该 Worker 的 currentTaskId 已绑定（等于你派发的 taskId）**且** generating=true（或 lastActivityAgo 很小，如小于 60s）。',
  '- **确认某 Worker 卡住** = suspectedStuck=true（有任务 + 不在生成 + 超5分钟无活动），或 generating=false 且 lastActivityAgo 持续增大。',
  '- **轮询节奏**：单次间隔尽量长（大于等于5分钟），减少轮询次数，保持主线专注；不要空转轮询。',
  '- 若某环境下看门狗相关工具不可用，**降级方案就是轮询 team_get_workers_status()**——监控不因此缺失。',
  '',
  '### 处理卡住/失败的任务（重要，避免重复劳动）',
  '派发出去但长时间无回报的任务，**不要立即补做或重派**。按以下三步决策流程：',
  '',
  '**第一步：判断是否真卡住**（用 team_get_workers_status）',
  '- 看该 Worker 的 `generating`、`lastActivityAgo`、`suspectedStuck` 三个字段。',
  '- `generating=true` → 正在干活，继续等，**绝不补做**。',
  '- `generating=false` 且 `lastActivityAgo < 300s` → 可能思考/等待中，**再等**。',
  '- 仅当 `suspectedStuck=true`（有任务+不在生成+超5分钟无活动）→ 才进入下一步。',
  '',
  '**第二步：轻量唤醒（不重派、不补做）**',
  '- 用 team_reply_to_worker(taskId, "请继续…") 追加一句。',
  '- 唤醒后**至少再等 3-5 分钟**，很可能它只是慢或暂停。',
  '',
  '**第三步：确认无效才补做/重派**',
  '- 唤醒并等待后仍无产出，才考虑：① 换窗口重派；② 主大脑亲自补做。',
  '- **补做前先检查是否已有部分产物**（glob/read），避免与 Worker 正在写的文件冲突。',
  '',
  '**关键原则**：',
  '- 补做前必须确认 Worker 真死（suspectedStuck + 唤醒无效），否则极易重复劳动。',
  '- 若 Worker 最终交付了更完整版本（同名覆盖），**采用其版本**，不要坚持自己的。',
  '- 等待/轮询是操作层琐事：单次等待尽量长（≥5分钟），减少轮询次数，保持主线专注。',
  '',
  '### 派发前的规划与澄清（重要，先做这一步）',
  '收到用户需求后，**先规划 → 再判断是否需要澄清 → 最后才派发**。不要一上来就派。',
  '',
  '**第一步：规划**（在回复里简短列出，让用户看到你的思路）',
  '- 目标：最终要交付什么',
  '- 拆解：分几个模块/步骤',
  '- 依赖：先后顺序',
  '- 每个模块的验收标准',
  '- 风险/注意点（技术难点、易错处、边界）',
  '',
  '**第二步：判断需求清晰度**（决定是否澄清）',
  '- **清晰 → 跳过澄清，直接派发**：目标明确、范围清楚、验收标准可推断、实现路径无大分歧。',
  '- **模糊 → 先澄清再派发**：缺关键信息、有多种合理理解、方案选择会显著影响结果。',
  '- 原则：清晰就跳过，不要为问而问；真的模糊时，宁可先问清楚，也别让 Worker 返工。',
  '',
  '**第三步：澄清（仅当需求模糊）**',
  '- 一次只问 **1-3 个最关键**的问题（不要一次问一堆）。',
  '- 只问**会改变方案走向**的；其余用合理默认值并说明。',
  '- 给**选项**让用户选（降低回答成本），如「你想要 A 还是 B？」。',
  '- 用户回答后，补全规划再派发。',
  '',
  '**第四步：任务书（派发时用）**',
  '每个子任务的 prompt 应含四要素：**目标 / 验收标准 / 约束（技术、边界、不能改什么）/ 产物格式**。',
  '',
  '### 总经理标准工作流',
  '1. **先做规划与澄清**（见上一节）——明确模块划分、验收标准、依赖关系；需求清晰则跳过澄清',
  '2. team_get_workers_status() 看谁空闲；不够则 team_create_window 新建',
  '3. team_dispatch_batch(tasks) 并行派发无依赖模块',
  '4. 等待回报（系统自动排队投递）；有依赖的模块在上游 DONE 后再派',
  '5. 每次收到回报：DONE→验收归档 + 给该 Worker 派下一个；ASK→优先回复；SYNC→更新进度、判断偏差',
  '6. 全部完成 → 汇总验收',
  '',
  '### 收到 DONE 报告后的核验（重要）',
  'DONE 报告是 6 项结构化模板（任务目标/实际做法/产物路径/验证结果/遗留问题/自我评估）。**必须逐项核验**：',
  '- 产物路径是否真实存在（用 read/glob/grep 抽查，不要凭报告自述）；',
  '- 验证结果是否可信（命令与输出是否对得上，必要时自己重跑）；',
  '- 自我评估是否诚实（有无把未做说成已做、含糊带过遗留问题）。',
  '缺项或存疑，用 team_reply_to_worker 追问，**不要凭「已完成」三个字就通过**。',
  '',
  '### 派发提示词建议',
  '在派发的 prompt 中明确要求子 Agent：阶段完成/需决策时用对应暗号回传（如"完成时用 >>>MASTER_DONE_START<<< 与 >>>MASTER_DONE_END<<< 包裹结论"），日常代码块操作回合无需回传。',
  '',
  '### 自驱循环（无人干预持续进化，重要）',
  '当用户要求"持续做到达标/无人干预/自己去迭代"时，用自驱循环而非一次性完成：',
  '- auto_goal_create(title, successCriteria[]) 建目标（达标标准写清楚）；',
  '- 之后每轮 auto_goal_round(goalId, criteriaResults) 记录；系统驱动器会自动推进。',
  '- 循环会自动 执行→复盘→生成技能→再执行，直到达标/达上限/熔断。',
  '',
  '### 编排完成后自工程化（Level 3，重要）',
  '一个多 Agent 编排完成后，若发现"可复用的编排方法/模式"，主动沉淀为技能：',
  '- auto_trace_list() 看本次执行轨迹 → auto_retrospect(taskId) 复盘 → auto_skill_forge(analysis) 生成技能 → 验证通过 auto_skill_forge_commit 入库。',
  '- 用 auto_skill_stats() 看技能使用统计，auto_skill_archive_pass() 淘汰低效技能。',
  '- 元层：auto_meta_record 记录本次编排效果，auto_meta_analyze 分析"编排方法本身"是否有效。',
  '- 原则：只有**真正可复用**的编排模式才沉淀（同一类任务做过 2-3 次）。',
  '',
  '### 教训沉淀（自进化，重要）',
  '出现以下情况时，**主动调用 lesson_record 记录教训**，让系统越用越聪明：',
  '- 验收不通过（DONE 报告缺项/产物不存在/验证不可信）；',
  '- 用户明确纠正（说"不对/应该这样/下次别这样"）；',
  '- Worker 反复失败或报 ERROR。',
  '记录后简短告知用户：「任务 X 因 Y 失败，已记录教训：Z」。',
  '工具：lesson_record(lesson, context, tags, scope?) — lesson 为一句可复用的教训，context 为触发场景，tags 为关键词数组，scope 可为 "global" 或项目目录。',
  '',
  '### 注意',
  '- 子 Agent 是"叶子"，不应再 spawn 子 Agent。',
  '- 一个 Worker 同时只处理一个任务；多任务开多个 Worker。',
  '- 派发默认开新对话（fresh）；若任务与 Worker 已有上下文相关，可用 mode="continue" 在原对话续派（详见"派发模式"一节）。',
  '- team_reply_to_worker 用于对**同一任务**追加指令/答疑（不重开、不新建 task）。',
  '- **你是决策者，不是执行者。** 把执行留给 Worker，把思考、规划与验收留给自己。',
].join('\n');

// ========== team_list_workers ==========
class T1 extends Tool {
  constructor() { super('team_list_workers', 'List OPEN workers', {type:'object',properties:{}}, 'team_list_workers()'); }
  getPromptSection(opts) {
    // Worker（被派发子任务）场景：不注入"主大脑"提示词，
    // 避免与 workerProtocol（"你是次大脑，执行任务"）矛盾导致 AI 不执行。
    if (opts && opts.isWorker) return null;
    let multi = true;
    try { multi = require('../src/main/team/mode').isMulti(opts && opts.profileId); } catch (_) {}
    if (multi) {
      return { name: 'tool:team', order: 115, text: TEAM_PROMPT_SECTION };
    }
    // 单聊模式：给一句简短提示，告知存在多 Agent 模式（用户可切换）
    return {
      name: 'tool:team',
      order: 115,
      text: [
        '## 工作模式',
        '',
        '当前为【单聊模式】：你直接独立完成任务，无需调度其他窗口。',
        '（如需多窗口并行分工，用户可在覆盖层开启「多 Agent 模式」，届时你将作为主大脑调度多个子 Agent。）',
      ].join('\n'),
    };
  }
  async execute(p) {
    try {
      const ctxs = ws.getAllContexts();
      const profiles = pm.readProfiles();
      const selfId = p && p.__callerProfileId;
      const workers = ctxs.map(c => {
        const pr = profiles.find(x => x.id === c.profileId);
        return {id:c.profileId, name:pr?pr.name:'', providerId:c.providerId, self: c.profileId === selfId};
      }).filter(x=>x.id);
      return ToolResult.success({workers, hint: 'self=true 的是你自己（主大脑窗口），不要向它派发任务'});
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_get_workers_status（新增：查忙闲）==========
class TStatus extends Tool {
  constructor() { super('team_get_workers_status', 'Show busy/idle status of all workers', {type:'object',properties:{}}, 'team_get_workers_status()'); }
  async execute(p) {
    try {
      const ctxs = ws.getAllContexts();
      const profiles = pm.readProfiles();
      const selfId = p && p.__callerProfileId;
      const active = ['PENDING', 'DISPATCHED', 'RUNNING', 'WAITING_MASTER'];
      const workers = ctxs.map(c => {
        const pr = profiles.find(x => x.id === c.profileId);
        // 该窗口是否有进行中的任务
        const myTasks = tm.listTasks({ masterProfileId: selfId || null }).filter(t => t.profileId === c.profileId && active.indexOf(t.status) !== -1);
        const cur = myTasks[0] || null;
        // 看门狗忙闲状态
        let busy = false;
        try { const st = watchdog.getStatus(c.profileId); const pf = st && st.profile; busy = !!(pf && ((pf.expectingReply && (pf.heartbeatAge || 0) < STALE_HEARTBEAT_SECS) || pf.busy)); } catch (_) {}
        const isSelf = c.profileId === selfId;
        // 最后活动时间（秒，null=从未活动）
        const lastActivityAgo = workerActivity.getAgoSeconds(c.profileId);
        // 疑似真卡住：有进行中任务 且 不在生成 且 (从未活动 或 超5分钟无活动)
        const suspectedStuck = !!cur && !busy && (lastActivityAgo === null || lastActivityAgo > 300);
        // token 用量：供主大脑判断是否该"续对话"还是"总结后重开"
        let tokenCount = 0;
        try { tokenCount = tokenTracker.getTokenCount(c.profileId); } catch (_) {}
        // 是否已初始化项目（决定能否直接续对话派发）
        const initialized = !!(c.sessionStore && c.sessionStore.state && c.sessionStore.state.selectedProjectDir);
        return {
          profileId: c.profileId,
          name: pr ? pr.name : '',
          providerId: c.providerId,
          self: isSelf,
          currentTaskId: cur ? cur.id : null,
          currentModule: cur ? cur.module : null,
          generating: busy,                       // 正在生成回复
          idle: !isSelf && !cur && !busy,         // 空闲可接新任务
          lastActivityAgo,                        // 距最后一次工具活动秒数（null=从未）
          suspectedStuck,                         // 疑似真卡住（有任务+不在生成+超5分钟无活动）
          tokenCount,                             // 该 Worker 累计 token 用量（未知 0）
          initialized,                            // 是否已初始化项目目录（可续对话）
          needsCompaction: tokenCount >= 800000,  // 超过 80 万，建议总结后重开
        };
      }).filter(x => x.profileId);
      const idleCount = workers.filter(w => w.idle).length;
      return ToolResult.success({ workers, idleCount, hint: 'idle=true 的 Worker 可立即派发新任务；self=true 是你自己；suspectedStuck=true 表示该 Worker 可能真卡住（有任务但5分钟无活动），可考虑唤醒；generating=true 时切勿补做' });
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_dispatch_task ==========
class T2 extends Tool {
  constructor() { super('team_dispatch_task', 'Dispatch task to a worker (fresh new chat by default; mode=continue to reuse current chat; mode=session to navigate back to a bound session)', {type:'object',properties:{profileId:{type:'string'},prompt:{type:'string'},projectDir:{type:'string'},module:{type:'string'},mode:{type:'string',description:'fresh=开新对话(默认)；continue=原对话续派(相关任务用)；session=导航回已绑定会话续派(找不到降级新对话)'},sessionId:{type:'string',description:'可选，session 模式下目标会话 ID；缺省时用该 Worker 最近任务记录的会话'}},required:['profileId','prompt']}, 'team_dispatch_task(profileId, prompt, projectDir?, module?, mode?, sessionId?)'); }
  async execute(p) {
    if(!p.profileId||!p.prompt) return ToolResult.error('missing args');
    try {
      if (p.__callerProfileId && tm.isWorkerProfile(p.__callerProfileId)) {
        return ToolResult.error('你是子 Agent（叶子节点），不能再派发任务给其他 Agent。请直接完成自己的任务。');
      }
      // 派发前双重拦截：① 调用者必须是 master；② 目标不能是 master
      const rm = require('../src/main/team/role-manager');
      if (p.__callerProfileId) {
        const callerRole = rm.getRole(p.__callerProfileId);
        if (callerRole.role !== 'master') {
          return ToolResult.error('只有主大脑（master）可以派发任务。你当前角色不是主大脑，请独立完成自己的任务。');
        }
      }
      const targetRole = rm.getRole(p.profileId);
      if (targetRole.role === 'master') {
        return ToolResult.error('不能向另一个主大脑（master）派发任务。master 应坚守岗位收取子 Agent 回报。请改派给 worker 窗口（team_get_workers_status 查看空闲 worker）。');
      }
      const { dispatchTask } = require('../src/main/team/dispatch');
      const res = await dispatchTask(p.profileId, p.prompt, p.projectDir, { module: p.module, masterProfileId: p.__callerProfileId || null, mode: p.mode, sessionId: p.sessionId });
      if (!res || !res.success) return ToolResult.error((res && res.error) || 'dispatch failed');
      return ToolResult.success({taskId:res.taskId, mode:res.mode || 'fresh'});
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_dispatch_batch ==========
class TBatch extends Tool {
  constructor() { super('team_dispatch_batch', 'Dispatch multiple tasks to workers in parallel', {type:'object',properties:{tasks:{type:'array',items:{type:'object',properties:{profileId:{type:'string'},providerId:{type:'string'},prompt:{type:'string'},projectDir:{type:'string'},module:{type:'string'},mode:{type:'string'},sessionId:{type:'string'}}}}},required:['tasks']}, 'team_dispatch_batch(tasks[])'); }
  async execute(p) {
    const tasks = Array.isArray(p.tasks) ? p.tasks : [];
    if (tasks.length === 0) return ToolResult.error('tasks 为空');
    if (p.__callerProfileId && tm.isWorkerProfile(p.__callerProfileId)) {
      return ToolResult.error('你是子 Agent（叶子节点），不能再派发任务。');
    }
    // 派发前拦截：调用者必须是 master（无 profile 上下文则放行，兼容单聊）
    const rm = require('../src/main/team/role-manager');
    if (p.__callerProfileId) {
      const callerRole = rm.getRole(p.__callerProfileId);
      if (callerRole.role !== 'master') {
        return ToolResult.error('只有主大脑（master）可以派发任务。你当前角色不是主大脑，请独立完成自己的任务。');
      }
    }
    const { dispatchTask } = require('../src/main/team/dispatch');
    const results = [];
    for (const t of tasks) {
      try {
        let profileId = t.profileId;
        if (!profileId && t.providerId) {
          const profile = pm.createProfile(t.module || ('Worker' + (pm.readProfiles().length + 1)), t.providerId);
          // 多标签架构：优先壳窗口开标签；壳不可用时回退旧窗口路径
          if (typeof ws.openProfileAsTab === 'function' && ws.openProfileAsTab(profile)) {
            profileId = profile.id;
          } else if (typeof ws.createWindow === 'function') {
            ws.createWindow(profile);
            profileId = profile.id;
          } else {
            results.push({ module: t.module || '', success: false, error: '无法创建 Worker（壳窗口/窗口均不可用）' });
            continue;
          }
        }
        if (!profileId) { results.push({ module: t.module || '', success: false, error: '缺少 profileId/providerId' }); continue; }
        // 目标为 master 时拒绝该项（不整体失败，继续处理其它目标）
        const targetRole = rm.getRole(profileId);
        if (targetRole.role === 'master') {
          results.push({ module: t.module || '', profileId, success: false, error: '不能向另一个主大脑（master）派发任务，请选择 worker 窗口。' });
          continue;
        }
        const res = await dispatchTask(profileId, t.prompt, t.projectDir, { module: t.module, masterProfileId: p.__callerProfileId || null, mode: t.mode, sessionId: t.sessionId });
        results.push({ module: t.module || '', profileId, success: !!(res && res.success), taskId: res && res.taskId, error: res && res.error });
      } catch (e) {
        results.push({ module: t.module || '', success: false, error: e.message });
      }
    }
    return ToolResult.success({ results });
  }
}

// ========== team_create_window ==========
class T4 extends Tool {
  constructor() { super('team_create_window', 'Create a new worker window (opens as a tab in the shell window)', {type:'object',properties:{providerId:{type:'string'},name:{type:'string'}},required:['providerId']}, 'team_create_window(providerId, name)'); }
  async execute(p) {
    if(!p.providerId) return ToolResult.error('missing providerId');
    try {
      const profiles = pm.readProfiles();
      const name = p.name || ('Worker' + (profiles.length + 1));
      const profile = pm.createProfile(name, p.providerId);
      // 多标签架构：优先在壳窗口内开新标签（统一工作台，不再弹新 BrowserWindow）；
      // 壳窗口不可用时回退旧的多窗口创建路径。
      if (typeof ws.openProfileAsTab === 'function' && ws.openProfileAsTab(profile)) {
        return ToolResult.success({profileId:profile.id, name:profile.name, providerId:p.providerId, openedAs:'tab'});
      }
      if(typeof ws.createWindow !== 'function') return ToolResult.error('createWindow not available');
      ws.createWindow(profile);
      return ToolResult.success({profileId:profile.id, name:profile.name, providerId:p.providerId, openedAs:'window'});
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_get_task_status ==========
class T3 extends Tool {
  constructor() { super('team_get_task_status', 'Get status', {type:'object',properties:{taskId:{type:'string'}},required:['taskId']}, 'team_get_task_status(taskId)'); }
  async execute(p) {
    if(!p.taskId) return ToolResult.error('missing taskId');
    try {
      const task = tm.getTask(p.taskId);
      if(!task) return ToolResult.error('not found');
      return ToolResult.success(task);
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_get_progress ==========
class TProg extends Tool {
  constructor() { super('team_get_progress', 'Summarize progress of all sub-tasks', {type:'object',properties:{}}, 'team_get_progress()'); }
  async execute(p) {
    try {
      let masterProfileId = (p && p.__callerProfileId) || null;
      if (!masterProfileId) { const mc = ws.getMainContext(); masterProfileId = mc ? mc.profileId : null; }
      const all = masterProfileId ? tm.listTasks({ masterProfileId }) : tm.listTasks();
      const summary = all.map(t => ({
        taskId: t.id,
        module: t.module,
        status: t.status,
        progress: t.progress,
        reports: t.reports.length,
      }));
      return ToolResult.success({ total: summary.length, tasks: summary });
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_plan_create（规划层：建立任务计划/DAG）==========
class TPlanCreate extends Tool {
  constructor() { super('team_plan_create', 'Create/overwrite the orchestration plan (modules + deps)', {type:'object',properties:{goal:{type:'string'},modules:{type:'array',items:{type:'object',properties:{id:{type:'string'},name:{type:'string'},desc:{type:'string'},deps:{type:'array',items:{type:'string'}},acceptance:{type:'string'}}}}},required:['goal','modules']}, 'team_plan_create(goal, modules[])'); }
  async execute(p) {
    try {
      if (!p.goal || !Array.isArray(p.modules) || p.modules.length === 0) {
        return ToolResult.error('需要 goal 和非空 modules 数组');
      }
      const caller = p && p.__callerProfileId;
      if (!caller) return ToolResult.error('无法确定调用者（主大脑）身份');
      const planManager = require('../src/main/team/plan');
      const plan = planManager.createPlan(caller, p.goal, p.modules);
      return ToolResult.success({
        created: true,
        moduleCount: plan.modules.length,
        summary: planManager.getSummary(plan),
        hint: '计划已建立。请立即用 team_get_workers_status 查看空闲 Worker，然后用 team_dispatch_task 逐个派发 ready 模块（可带 module 参数匹配模块名）。',
      });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== team_plan_status（查计划进度）==========
class TPlanStatus extends Tool {
  constructor() { super('team_plan_status', 'Show current orchestration plan status', {type:'object',properties:{}}, 'team_plan_status()'); }
  async execute(p) {
    try {
      const caller = p && p.__callerProfileId;
      if (!caller) return ToolResult.error('无法确定调用者身份');
      const planManager = require('../src/main/team/plan');
      const plan = planManager.getPlan(caller);
      if (!plan) return ToolResult.success({ hasPlan: false, hint: '当前没有计划。如需多 Agent 编排，请先 team_plan_create。' });
      planManager.refresh(plan);
      return ToolResult.success({
        hasPlan: true,
        goal: plan.goal,
        modules: plan.modules.map(function (m) {
          return { id: m.id, name: m.name, status: m.status, deps: m.deps, assignee: m.assignee, taskId: m.taskId, acceptance: m.acceptance };
        }),
        summary: planManager.getSummary(plan),
      });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== team_plan_module_done（手动标记模块完成）==========
class TPlanModuleDone extends Tool {
  constructor() { super('team_plan_module_done', 'Manually mark a plan module as done (when work was done outside its task)', {type:'object',properties:{moduleId:{type:'string'},result:{type:'string'}},required:['moduleId']}, 'team_plan_module_done(moduleId, result?)'); }
  async execute(p) {
    try {
      const caller = p && p.__callerProfileId;
      if (!caller) return ToolResult.error('无法确定调用者身份');
      if (!p.moduleId) return ToolResult.error('需要 moduleId');
      const planManager = require('../src/main/team/plan');
      const m = planManager.markModuleDone(caller, p.moduleId, p.result);
      if (!m) return ToolResult.error('未找到模块: ' + p.moduleId);
      const plan = planManager.getPlan(caller);
      return ToolResult.success({ moduleId: m.id, status: m.status, summary: planManager.getSummary(plan) });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== team_plan_clear（清空计划）==========
class TPlanClear extends Tool {
  constructor() { super('team_plan_clear', 'Clear the current orchestration plan', {type:'object',properties:{}}, 'team_plan_clear()'); }
  async execute(p) {
    try {
      const caller = p && p.__callerProfileId;
      const planManager = require('../src/main/team/plan');
      planManager.clearPlan(caller);
      return ToolResult.success({ cleared: true });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== team_show_dispatch_ui ==========
const ui = require('../src/main/team/ui');
class T5 extends Tool {
  constructor() { super('team_show_dispatch_ui', 'Open dispatch UI', {type:'object',properties:{}}, 'team_show_dispatch_ui()'); }
  async execute() {
    try {
      const res = await ui.showDispatchUI();
      return ToolResult.success(res);
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_read_inbox ==========
class T6 extends Tool {
  constructor() { super('team_read_inbox', 'Read latest report of a task', {type:'object',properties:{taskId:{type:'string'}},required:['taskId']}, 'team_read_inbox(taskId)'); }
  async execute(p) {
    try {
      const t = tm.getTask(p.taskId);
      if (!t) return ToolResult.error('task not found');
      try { require('../src/main/team/report-queue').consume(p.taskId); } catch (_) {}
      const latest = t.reports.length > 0 ? t.reports[t.reports.length - 1] : null;
      return ToolResult.success({ taskId: p.taskId, progress: t.progress, latest, reports: t.reports });
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_reply_to_worker ==========
class T7 extends Tool {
  constructor() { super('team_reply_to_worker', 'Reply to a worker (append instruction, no new chat)', {type:'object',properties:{taskId:{type:'string'},message:{type:'string'}},required:['taskId','message']}, 'team_reply_to_worker(taskId, message)'); }
  async execute(p) {
    try {
      const task = tm.getTask(p.taskId);
      if (!task) return ToolResult.error('task not found');
      const ctx = ws.getWindowByProfileId(task.profileId);
      if (!ctx || !ctx.win || ctx.win.isDestroyed()) return ToolResult.error('window not open');
      ctx.win.webContents.send('worker-bind-task', { taskId: task.id });
      ctx.win.webContents.send('master-inject-message', { message: p.message });
      tm.updateTaskStatus(task.id, 'DISPATCHED');
      return ToolResult.success({ sent: true });
    } catch(e) { return ToolResult.error(e.message); }
  }
}

// ========== team_cancel_task ==========
class TCancel extends Tool {
  constructor() { super('team_cancel_task', 'Cancel a sub-task', {type:'object',properties:{taskId:{type:'string'}},required:['taskId']}, 'team_cancel_task(taskId)'); }
  async execute(p) {
    try {
      const task = tm.getTask(p.taskId);
      if (!task) return ToolResult.error('task not found');
      tm.updateTaskStatus(task.id, 'CANCELLED', '由主大脑取消');
      try { require('../src/main/team/report-queue').consume(p.taskId); } catch (_) {}
      return ToolResult.success({ taskId: p.taskId, status: 'CANCELLED' });
    } catch(e) { return ToolResult.error(e.message); }
  }
}

module.exports = {
  TeamListWorkersTool: T1,
  TeamGetWorkersStatusTool: TStatus,
  TeamDispatchTaskTool: T2,
  TeamDispatchBatchTool: TBatch,
  TeamGetTaskStatusTool: T3,
  TeamGetProgressTool: TProg,
  TeamCreateWindowTool: T4,
  TeamShowDispatchUITool: T5,
  TeamReadInboxTool: T6,
  TeamReplyToWorkerTool: T7,
  TeamCancelTaskTool: TCancel,
  TeamPlanCreateTool: TPlanCreate,
  TeamPlanStatusTool: TPlanStatus,
  TeamPlanClearTool: TPlanClear,
  TeamPlanModuleDoneTool: TPlanModuleDone,
};
