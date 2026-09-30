/**
 * 引导者驱动器（Curator）—— 战略巡检秘书
 *
 * 定位（重要）：本模块不是 AI，不会"思考"。它只是"闹钟 + 秘书"：
 *   1. 判断"系统是否已空闲够久、该做一次战略巡检了"
 *   2. 去各处把项目现状采集回来（git / TODO / 教训 / 技能 / 历史目标）
 *   3. 拼成一段"战略巡检简报"
 *   4. 把简报注入指定窗口，由窗口里的 AI 真正思考并产出新目标
 *
 * 真正的"思考"发生在窗口 AI 的聊天里；本模块只负责喂料与触发。
 *
 * 配置持久化于 userData/curator-config.json（可在设置面板自定义）。
 */
const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../../core/agent-runtime/paths');
const { inject: injectMessage } = require('../../core/agent-runtime/inject');
const { execFile } = require('child_process');
// 自进化飞轮总开关（默认关；缺失时视为关闭）——本模块自身的 enabled 是其下层细分开关
let evolutionSwitch = null;
try { evolutionSwitch = require('./evolution-switch'); } catch (_) { evolutionSwitch = null; }

/** 总开关是否开启（关 → 不巡检） */
function isEvolutionEnabled() {
  try { return !!(evolutionSwitch && evolutionSwitch.isEnabled()); } catch (_) { return false; }
}
// 进化飞轮 SOP 技能名（由另一个模块定义；缺失时用字面量兜底）
let FLYWHEEL_SKILL_NAME = 'evolution-flywheel';
try {
  const fw = require('./flywheel-skill');
  if (fw && fw.FLYWHEEL_SKILL_NAME) FLYWHEEL_SKILL_NAME = fw.FLYWHEEL_SKILL_NAME;
} catch (_) {}
const NL = String.fromCharCode(10);

const DEFAULT_CONFIG = {
  enabled: false,          // 总开关（默认关，避免突然自触发）
  idleMinutes: 30,         // 系统空闲多久后触发巡检（分钟）
  minIntervalMinutes: 60,  // 两次巡检最小间隔（分钟）
  targetProfileId: '',     // 注入哪个窗口（空 = 主窗口）
  targetProfileIds: [],    // 多窗口巡检（可选；非空时优先于 targetProfileId，各自采集自身项目信号）
  maxProposals: 3,         // 建议 AI 产出几个候选目标
  briefPrompt: '',         // 附加到简报末尾的自定义指令
  collect: {
    git: true,
    todos: true,
    lessons: true,
    skills: true,
    goals: true,
  },
};

let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
let configFile = null;
let timer = null;
let idleSince = 0;      // 首次观察到"全空闲"的时刻（0 = 非空闲）
let lastReviewAt = 0;   // 上次巡检时刻

function getConfigFile() {
  if (!configFile) configFile = path.join(getBaseDir(), 'curator-config.json');
  return configFile;
}

function mergeConfig(base, patch) {
  const out = Object.assign({}, base, patch || {});
  out.collect = Object.assign({}, base.collect, (patch && patch.collect) || {});
  return out;
}

function loadConfig() {
  try {
    const f = getConfigFile();
    if (fs.existsSync(f)) {
      const saved = JSON.parse(fs.readFileSync(f, 'utf-8'));
      config = mergeConfig(DEFAULT_CONFIG, saved);
    }
  } catch (e) { console.error('[Curator] 读取配置失败:', e.message); }
}

function saveConfig() {
  try {
    fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (e) { console.error('[Curator] 写入配置失败:', e.message); return false; }
}

function updateConfig(patch) {
  config = mergeConfig(config, patch);
  saveConfig();
  return getConfig();
}

function getConfig() { return JSON.parse(JSON.stringify(config)); }

/**
 * 所有打开的窗口都空闲（不在等待回复、不在长任务）→ 系统空闲。
 *
 * 注意：这里**不再**把「有 running 目标」算作"不空闲"（那会导致死锁——见下方 tick 说明）。
 * running 目标改为在 runReviewForContext 里**按项目单独判断**：本项目有 running 目标
 * → 只跳过该项目窗口（self-loop 正在跑），不影响其他项目窗口的巡检。
 */
function isSystemIdle() {
  try {
    const windowState = require('../window');
    const watchdog = require('../watchdog');
    const ctxs = windowState.getAllContexts();
    for (const c of ctxs) {
      try {
        const st = watchdog.getStatus(c.profileId);
        const p = st && st.profile;
        if (p && (p.expectingReply || p.busy)) return false;
      } catch (_) {}
    }
    return true;
  } catch (_) { return false; }
}

/**
 * 指定项目是否有「运行中的目标」（带 projectDir 过滤）。
 * 用于解死锁：本项目 self-loop 正在跑 → curator 不打扰该窗口。
 * 异常时返回 false（保守放行，避免因依赖缺失而永久不巡检）。
 * @param {string} projectDir
 * @returns {boolean}
 */
function hasRunningGoalForProject(projectDir) {
  try {
    const selfLoop = require('./self-loop');
    if (!selfLoop || typeof selfLoop.listRunningGoals !== 'function') return false;
    const list = selfLoop.listRunningGoals(projectDir || undefined) || [];
    return list.length > 0;
  } catch (_) { return false; }
}

/**
 * 是否应触发一次巡检（纯函数，便于测试）
 * @param {object} s { idle:boolean, idleSince:number, lastReviewAt:number, now:number }
 * @param {object} cfg
 */
function shouldTrigger(s, cfg) {
  if (!cfg || !cfg.enabled) return false;
  if (!s || !s.idle) return false;
  const idleMs = (cfg.idleMinutes || 0) * 60000;
  if (!s.idleSince || (s.now - s.idleSince) < idleMs) return false;
  const gapMs = (cfg.minIntervalMinutes || 0) * 60000;
  if (s.lastReviewAt && (s.now - s.lastReviewAt) < gapMs) return false;
  return true;
}

/** 跑一条命令，返回 stdout 文本（失败返回空串，绝不抛） */
function runCmd(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { cwd: cwd, timeout: timeoutMs || 8000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
        function (err, stdout) { resolve(err ? '' : String(stdout || '').trim()); });
    } catch (_) { resolve(''); }
  });
}

/** 采集项目现状信号（每项独立容错，失败即空）
 * @param {string} projectDir 项目目录
 * @param {object} collect 采集项开关
 * @param {string} [profileId] 目标窗口 id（用于把 goals 限定为「该窗口的目标 + 无归属全局目标」，杜绝跨窗口污染）
 */
async function collectSignals(projectDir, collect, profileId) {
  const c = collect || {};
  const pid = profileId || '';
  const out = { projectDir: projectDir || '', profileId: pid, git: null, todos: [], lessons: [], skills: [], goals: [] };

  if (projectDir && c.git) {
    try {
      const branch = await runCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], projectDir);
      const status = await runCmd('git', ['status', '--short'], projectDir);
      const log = await runCmd('git', ['log', '--oneline', '-8'], projectDir);
      if (branch || status || log) out.git = { branch: branch, status: status, log: log };
    } catch (_) {}
  }

  if (projectDir && c.todos) {
    try {
      const rg = await runCmd('git', ['grep', '-n', '-I', '-E', 'TODO|FIXME|HACK', '--', '.'], projectDir, 10000);
      out.todos = rg ? rg.split(NL).slice(0, 15) : [];
    } catch (_) {}
  }

  // lessons：只喂「与该项目相关」的教训（项目专属全纳入 + 全局按关键词匹配 Top N），
  // 不再无差别注入全部教训，避免把无关项目的坑带进本项目的简报。
  if (c.lessons) {
    try {
      const lessons = require('../lessons');
      if (lessons && typeof lessons.matchLessons === 'function') {
        // 关键词：项目目录 basename（用于匹配全局教训的 tags）
        const keywords = [];
        try {
          const base = projectDir ? require('path').basename(projectDir) : '';
          if (base) keywords.push(base);
        } catch (_) {}
        const matched = lessons.matchLessons(projectDir || '', keywords, 5) || [];
        out.lessons = matched.slice(0, 8)
          .map(function (l) { return (l && (l.lesson || l.text)) || ''; })
          .filter(Boolean);
      } else if (lessons && typeof lessons.listLessons === 'function') {
        // 降级：旧接口（无 matchLessons 时）仍可工作，但只取少量
        const all = lessons.listLessons() || [];
        out.lessons = all.slice(0, 8).map(function (l) { return (l && (l.lesson || l.text)) || ''; }).filter(Boolean);
      }
    } catch (_) {}
  }

  // skills：技能库为「全局」资源，不按窗口/项目区分（skill-stats.json 无 projectDir/profileId 维度）。
  // 故这里保留全局视图，仅在简报文案中标注「全局技能库」，避免误导为项目专属。
  if (c.skills) {
    try {
      const evolver = require('./skill-evolver');
      const rep = evolver.analyze();
      const need = (rep && Array.isArray(rep.needOptimize)) ? rep.needOptimize : [];
      out.skills = need.slice(0, 8).map(function (x) {
        const it = x || {};
        return (it.name || '?') + '（成功率 ' + Math.round((it.rate || 0) * 100) + '%，用 ' + (it.uses || 0) + ' 次）';
      });
    } catch (_) {}
  }

  // goals：严格按【本项目 + 本窗口】过滤，绝不注入其他项目/窗口的目标。
  // 关键：必须同时传 projectDir（否则 listGoals 的项目过滤形同虚设，跨项目目标照旧出现）；
  // 并显式排除 legacy 老数据（无归属历史目标），避免污染简报。
  if (c.goals) {
    try {
      const selfLoop = require('./self-loop');
      const filter = {};
      if (pid) filter.profileId = pid;
      if (projectDir) filter.projectDir = projectDir;
      const all = (typeof selfLoop.listGoals === 'function')
        ? (selfLoop.listGoals(Object.keys(filter).length ? filter : undefined) || [])
        : [];
      out.goals = all.filter(function (g) { return g.status !== 'running' && g.legacy !== true; })
        .slice(0, 12)
        .map(function (g) { return g.title + ' [' + g.status + ']'; });
    } catch (_) {}
  }

  return out;
}

/** 取某窗口执行模式（single/multi；失败默认 single） */
function resolveMode(profileId) {
  try {
    const m = require('./mode');
    if (m && typeof m.getMode === 'function') return m.getMode(profileId) || 'single';
  } catch (_) {}
  return 'single';
}

/**
 * 把采集到的信号拼成"战略巡检简报"（纯函数，便于测试）。
 *
 * 分步引导（关键设计）：简报不再一次性喂全部信号 + 全部要求，
 * 只给"第 1 步（网上调研）"所需的少量背景，并要求 AI 先读 SOP skill、按 SOP 往下走。
 * 信号只做精简呈现（git 分支/未提交数/TODO 条数），详细内容让 AI 自己用工具查。
 */
function buildBrief(sig, cfg) {
  const s = sig || {};
  const c = cfg || {};
  const mode = resolveMode(s.profileId);
  const dir = s.projectDir || '（未知）';
  const L = [];
  const SC = "skill_read('" + FLYWHEEL_SKILL_NAME + "')";

  L.push('【战略巡检 · 本项目】项目：' + dir);
  L.push('系统已空闲，且本项目当前【没有运行中的目标】。请做一次战略反思：本项目接下来该做什么？');
  L.push('');
  L.push('⚠️ 请先 ' + SC + ' 读取「进化飞轮 SOP」，然后**只执行第 1 步（网上调研）**。');
  L.push('完成第 1 步后，按 SOP 的指引继续下一步。**不要一次做多步。**');
  L.push('');
  L.push('## 本项目背景（少量，详细请自行用工具查）');
  if (s.profileId) L.push('- 目标窗口：' + s.profileId);
  L.push('- 执行模式：' + (mode === 'multi' ? '多 Agent（multi）' : '单 Agent（single）'));
  if (s.git) {
    const uncommitted = s.git.status ? s.git.status.split(NL).filter(Boolean).length : 0;
    L.push('- git 分支：' + (s.git.branch || '（未知）') + '；未提交改动：' + uncommitted + ' 项');
  }
  if (s.todos && s.todos.length) {
    L.push('- 已知 TODO/FIXME：约 ' + s.todos.length + ' 条（内容请自行 grep 查）');
  }
  L.push('');
  L.push('## 铁律');
  L.push('- **只针对本项目（' + dir + '）**，绝不涉及其他项目。');
  L.push('- 严格按 SOP 分步执行，一次只做一步，做完读 skill 看下一步。');
  L.push('');
  L.push('## 第 4 步分流规则（供你走到第 4 步时参考）');
  if (mode === 'multi') {
    L.push('- 你是【多 Agent 模式】：第 4 步请用 auto_goal_create 建目标（**务必带 projectDir=' + dir + '**），派发给子 Agent 执行。');
  } else {
    L.push('- 你是【单 Agent 模式】：第 4 步请自己挑一条最高优先级的待办执行。');
  }
  if (c.briefPrompt) { L.push(''); L.push('## 附加指令'); L.push(String(c.briefPrompt)); }

  return L.join(NL);
}

/**
 * 该窗口是否「适合被引导」（战略巡检只针对主 Agent / 普通单聊窗口）。
 * 排除：子 Agent（Worker）窗口——有进行中子任务、或被标记 role=worker。
 * @param {string} profileId
 * @returns {boolean}
 */
function isGuidableWindow(profileId) {
  if (!profileId) return false;
  try {
    const tm = require('./task-manager');
    if (tm.isWorkerProfile && tm.isWorkerProfile(profileId)) return false;
  } catch (_) {}
  try {
    const pm = require('../profile-manager');
    const p = pm.getProfileById(profileId);
    if (p && p.role === 'worker') return false;
  } catch (_) {}
  return true;
}

/** 取某窗口当前项目目录（无则空串） */
function getWindowProjectDir(ctx) {
  try {
    return (ctx && ctx.sessionStore && ctx.sessionStore.state && ctx.sessionStore.state.selectedProjectDir) || '';
  } catch (_) { return ''; }
}

/**
 * 解析本次巡检要注入的目标窗口列表 —— 严格按归属，绝不做跨窗口 fallback：
 *   - 指定了 targetProfileId → 只用该窗口；不存在/不可引导 → 返回 []（跳过，不 fallback）。
 *   - 指定了 targetProfileIds（数组）→ 只用其中可用窗口。
 *   - 均未指定（系统级）→ 遍历所有窗口，返回「可引导且已绑定项目」的窗口（多标签架构下不能用 getMainContext，它返回壳窗口）。
 * @returns {Array<object>} 可引导的目标窗口 ctx 列表
 */
function resolveTargetContexts() {
  const windowState = require('../window');
  const out = [];
  const pick = function (profileId) {
    const c = windowState.getWindowByProfileId(profileId);
    if (!c) { console.log('[Curator] 目标窗口不存在，已跳过: ' + profileId); return; }
    if (!isGuidableWindow(c.profileId)) { console.log('[Curator] 目标窗口是子 Agent/Worker，已跳过: ' + profileId); return; }
    if (!getWindowProjectDir(c)) { console.log('[Curator] 窗口未绑定项目，已跳过: ' + profileId); return; }
    out.push(c);
  };

  const single = config.targetProfileId;
  const multi = Array.isArray(config.targetProfileIds) ? config.targetProfileIds.filter(Boolean) : [];

  if (single) {
    pick(single);
    return out;  // 指定了目标 → 绝不 fallback
  }
  if (multi.length > 0) {
    multi.forEach(pick);
    return out;  // 指定了目标集合 → 绝不 fallback
  }
  // 未指定（系统级）→ 遍历所有窗口，找「可引导且已绑定项目」的。
  // 多标签架构下 getMainContext() 返回【壳窗口】（registerShellWindow 设 lastActiveWindowId=shellWin.id），
  // 壳窗口不是 profile、windows 表里无 sessionStore，取不到 webview 的 selectedProjectDir，
  // 故不能用 getMainContext()，必须遍历 getAllContexts()。
  const all = windowState.getAllContexts();
  for (const c of all) {
    if (!c || !c.profileId) continue;            // 壳窗口 / 无 profile 的上下文跳过
    if (!isGuidableWindow(c.profileId)) continue; // 排除 Worker / 子 Agent 窗口
    if (!getWindowProjectDir(c)) continue;        // 未绑定项目跳过
    out.push(c);
  }
  if (out.length === 0) console.log('[Curator] 无可引导且绑定项目的窗口，已跳过战略巡检');
  return out;
}

/**
 * 对单个窗口做一次巡检：只采集「该窗口自身项目」的信号并注入该窗口。
 * 注入前校验 简报项目目录 == 目标窗口项目目录，不一致则跳过（杜绝跨项目误投）。
 */
function runReviewForContext(ctx) {
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) return Promise.resolve({ success: false, error: '窗口不可用' });
  const projectDir = getWindowProjectDir(ctx);

  // 解死锁：本项目有 running 目标 → self-loop 正在执行该项目的 goal，curator 不打扰（只跳过该窗口）
  if (hasRunningGoalForProject(projectDir)) {
    console.log('[Curator] 本项目有 running 目标，self-loop 执行中，跳过: ' + ctx.profileId + '（项目 ' + (projectDir || '未选择') + '）');
    return Promise.resolve({ success: false, skipped: true, profileId: ctx.profileId, projectDir: projectDir, reason: '本项目有 running 目标，self-loop 执行中' });
  }

  // 注入互斥：刚有人注入过（默认 15s 内）→ 跳过本次，避免与 self-loop / 收件队列挤在一起
  try {
    if (require('./master-activity').isRecentlyInjected(ctx.profileId, 15000)) {
      console.log('[Curator] 近期已注入（15s 内），互斥跳过: ' + ctx.profileId);
      return Promise.resolve({ success: false, skipped: true, profileId: ctx.profileId, projectDir: projectDir, reason: '近期已注入，互斥跳过' });
    }
  } catch (_) {}

  return collectSignals(projectDir, config.collect, ctx.profileId).then(function (signals) {
    // 关键校验：简报项目目录必须与目标窗口项目目录一致
    const sigDir = (signals && signals.projectDir) || '';
    if (sigDir !== projectDir) {
      console.log('[Curator] 简报项目目录与目标窗口不一致，已跳过: ' + ctx.profileId);
      return { success: false, skipped: true, profileId: ctx.profileId, error: '项目目录不一致' };
    }
    const brief = buildBrief(signals, config);
    try {
      injectMessage(ctx.profileId, brief, ctx);
      try { require('./master-activity').noteInject(ctx.profileId); } catch (_) {}
      console.log('[Curator] 已注入战略巡检简报 -> ' + ctx.profileId + '（项目 ' + (projectDir || '未选择') + '），长度=' + brief.length);
      return { success: true, profileId: ctx.profileId, projectDir: projectDir, length: brief.length };
    } catch (e) {
      console.error('[Curator] 注入失败:', e.message);
      return { success: false, profileId: ctx.profileId, error: e.message };
    }
  });
}

/**
 * 注入简报：按窗口/项目归属巡检，逐个窗口采集其自身项目信号并注入该窗口。
 * 指定目标窗口不可用时跳过（绝不 fallback 到无关窗口）。
 */
function runReview() {
  let targets = [];
  try { targets = resolveTargetContexts(); } catch (e) { console.error('[Curator] 解析目标窗口失败:', e.message); }
  if (!targets || targets.length === 0) {
    return Promise.resolve({ success: false, error: '无可用（可引导）窗口' });
  }
  return Promise.all(targets.map(function (ctx) {
    try { return runReviewForContext(ctx); } catch (e) { return Promise.resolve({ success: false, error: e.message }); }
  })).then(function (results) {
    const ok = results.filter(function (r) { return r && r.success; });
    return { success: ok.length > 0, injected: ok.length, results: results };
  });
}

async function tick() {
  // 总开关关 → 不巡检（叠加在细分开关 config.enabled 之上，运行时切换即时生效）
  if (!isEvolutionEnabled()) return;
  if (!config.enabled) return;
  const now = Date.now();
  const idle = isSystemIdle();
  if (!idle) { idleSince = 0; return; }
  if (!idleSince) idleSince = now;
  const s = { idle: idle, idleSince: idleSince, lastReviewAt: lastReviewAt, now: now };
  if (!shouldTrigger(s, config)) return;
  lastReviewAt = now;
  idleSince = now; // 重置，避免连续触发
  try { await runReview(); } catch (e) { console.error('[Curator] tick 处理异常:', e.message); }
}

function start(opts) {
  loadConfig();
  if (timer) return { started: false, reason: '已在运行' };
  const tickMs = (opts && typeof opts.tickMs === 'number' && opts.tickMs > 0) ? opts.tickMs : 5 * 60 * 1000;
  timer = setInterval(function () { tick().catch(function () {}); }, tickMs);
  if (timer.unref) timer.unref();
  console.log('[Curator] 引导者驱动器已启动，tick=' + (tickMs / 1000) + 's, enabled=' + config.enabled);
  return { started: true, tickMs: tickMs };
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function getStatus() {
  return {
    config: getConfig(),
    idleSince: idleSince,
    lastReviewAt: lastReviewAt,
    idle: isSystemIdle(),
    running: !!timer,
  };
}

/** 手动触发一次巡检（忽略空闲/间隔判断，但仍尊重 enabled） */
function triggerNow() {
  if (!isEvolutionEnabled()) return Promise.resolve({ success: false, error: '自进化飞轮总开关关闭' });
  if (!config.enabled) return Promise.resolve({ success: false, error: '引导者未启用' });
  lastReviewAt = Date.now();
  return runReview();
}

function _reset() { config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)); idleSince = 0; lastReviewAt = 0; }

module.exports = {
  DEFAULT_CONFIG,
  isEvolutionEnabled,
  loadConfig,
  getConfig,
  updateConfig,
  isSystemIdle,
  hasRunningGoalForProject,
  isGuidableWindow,
  shouldTrigger,
  collectSignals,
  buildBrief,
  getWindowProjectDir,
  resolveTargetContexts,
  runReviewForContext,
  runReview,
  tick,
  start,
  stop,
  getStatus,
  triggerNow,
  _reset,
};
