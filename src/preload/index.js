/**
 * TokFree preload 入口
 * 原 preload.js 的全部逻辑拆分为本目录下的模块，此处负责组装与初始化，
 * 初始化时序与原文件保持一致。
 */
console.log('[TokFree] Preload script 开始执行');

// 暴露 electronAPI 到渲染进程（contextBridge + window 兜底）
require('./api');

const { webFrame, ipcRenderer } = require('electron');
const state = require('./dom/state');
const ui = require('./overlay/ui');
const projectDir = require('./overlay/project-dir');
const bindEvents = require('./overlay/events');
const missionControl = require('./overlay/mission-control');
const commandPalette = require('./overlay/command-palette');
const observer = require('./dom/observer');
const chatInput = require('./dom/chat-input');
const { getProviderByUrl } = require('../providers');

// ========== 平台识别 ==========
// 在 init 之前先判断当前平台，决定走"网络拦截"还是"DOM 抓取"模式
const currentProvider = getProviderByUrl(window.location.href);
const useIntercept = !!(currentProvider && currentProvider.useIntercept);
console.log('[TokFree] 平台=' + (currentProvider ? currentProvider.id : 'unknown') +
  ', 模式=' + (useIntercept ? '网络拦截' : 'DOM 抓取'));

// ========== 主世界注入（拦截模式）==========
// 必须在页面脚本执行前把 hook 注入到主世界，才能覆盖到 window.fetch / XHR。
// preload 早于页面脚本执行，此处的 executeJavaScript 落在主世界。
if (useIntercept) {
  try {
    const hookByProvider = {
      deepseek: () => require('../interceptor/deepseek-hook').deepseekHookSource(),
      claude: () => require('../interceptor/claude-hook').claudeHookSource(),
      chatgpt: () => require('../interceptor/chatgpt-hook').chatgptHookSource(),
      qwen: () => require('../interceptor/qwen-hook').qwenHookSource(),
      zhipu: () => require('../interceptor/zhipu-hook').zhipuHookSource(),
    };
    const getSource = hookByProvider[currentProvider.id];
    if (getSource) {
      webFrame.executeJavaScript(getSource()).then(
        () => console.log('[TokFree] 主世界拦截器注入成功 (' + currentProvider.id + ')'),
        (err) => console.error('[TokFree] 主世界拦截器注入失败:', err && err.message)
      );
    } else {
      console.warn('[TokFree] 未找到 ' + currentProvider.id + ' 的拦截器实现');
    }
  } catch (err) {
    console.error('[TokFree] 加载拦截器失败:', err);
  }
}

// ========== 浏览器兼容 / 反自动化特征修复（常驻，所有窗口） ==========
// 修复 window.chrome 空对象、userAgentData.brands 缺 Google Chrome、plugins 为空等
// Electron 特征，避免 Google 登录/Cloudflare 判定"环境不安全"。
try {
  const compat = require('./browser-compat');
  webFrame.executeJavaScript(compat.buildBrowserCompatScript()).then(
    () => console.log('[TokFree] 浏览器兼容特征注入成功'),
    (err) => console.error('[TokFree] 浏览器兼容注入失败:', err && err.message)
  );
} catch (err) {
  console.error('[TokFree] 加载浏览器兼容模块失败:', err && err.message);
}

// ========== 指纹伪装注入 ==========
// 与 hook 注入同一时机（页面脚本执行前），在主世界覆盖指纹 API。
// 配置由主进程通过 additionalArguments 传入（base64）。
try {
  const fp = require('./fingerprint');
  const fpCfg = fp.readFingerprintConfig();
  if (fpCfg && fpCfg.enabled) {
    webFrame.executeJavaScript(fp.buildFingerprintScript(fpCfg)).then(
      () => console.log('[TokFree] 指纹伪装注入成功 (seed=' + (fpCfg.seed || '?') + ')'),
      (err) => console.error('[TokFree] 指纹伪装注入失败:', err && err.message)
    );
  }
} catch (err) {
  console.error('[TokFree] 加载指纹模块失败:', err && err.message);
}

// 注册主进程消息监听（与原 preload.js 顶层注册时机一致）
chatInput.registerIpcListeners();

// ========== 看门狗：收到主进程唤醒指令，向当前对话发送唤醒语 ==========
ipcRenderer.on('watchdog-wake', async (_event, { msg } = {}) => {
  try {
    console.log('[TokFree] 收到 watchdog-wake，发送唤醒语');
    if (!msg) return;
    // 唤醒语作为普通用户消息发送（不计入对话计数，由 chat-input 的 tag 区分）
    await chatInput.sendToChat(msg, '看门狗唤醒', 800);
  } catch (e) {
    console.error('[TokFree] watchdog-wake 处理异常:', e.message);
  }
});

// ========== AI 协作：主大脑收件注入 ==========
// 收件队列投递的批次回报，作为用户消息注入主大脑对话。
ipcRenderer.on('master-inject-message', async (_event, { message } = {}) => {
  try {
    if (!message) return;
    console.log('[TokFree] 收到 master-inject-message，长度=' + message.length);
    await chatInput.sendToChat(message, '子任务回报', 800);
  } catch (e) {
    console.error('[TokFree] master-inject-message 处理异常:', e.message);
  }
});

// ========== 本地 OpenAI 兼容 API：收到 API 请求，立即发送给网页 AI ==========
// 主进程 api-server 收到 HTTP 请求后发此事件；这里记录 requestId 并用 sendImmediate
// 立即发送（绕过 sendToChat 的 8 秒防抖合并），回复由 intercept-observer 回传。
ipcRenderer.on('api-prompt', async (_event, { requestId, message } = {}) => {
  try {
    if (!requestId || !message) return;
    console.log('[TokFree][API] 收到 api-prompt requestId=' + requestId + ', 长度=' + message.length);
    state.currentApiRequestId = requestId;
    await chatInput.sendImmediate(message, 'API请求');
  } catch (e) {
    console.error('[TokFree][API] api-prompt 处理异常:', e && e.message);
  }
});

// ========== AI 协作：绑定 Worker 任务 ==========
// 主进程派发任务时先绑定 taskId；随后的「系统提示词 + 任务」由 initial-prompt 发送。
// 绑定后，本窗口作为次大脑独立执行 tokfree 代码块；仅在回复含同步暗号时回传主大脑。
ipcRenderer.on('worker-bind-task', (_event, { taskId }) => {
  console.log('[TokFree] 绑定 Worker 任务, taskId=' + taskId);
  state.currentWorkerTaskId = taskId || null;
  state.workerDoneReported = false; // 新任务：复位 DONE 上报去重标记
  // 双向确认：回 ack 告知主进程本 Worker 已真实收到任务
  try {
    if (taskId && window.electronAPI && window.electronAPI.ackWorkerTask) {
      window.electronAPI.ackWorkerTask(taskId).catch((e) => {
        console.error('[TokFree] 回传 worker ack 失败:', e && e.message);
      });
    }
  } catch (e) {
    console.error('[TokFree] 回传 worker ack 异常:', e && e.message);
  }
});

// ========== 跨窗口同步：会话重命名 ==========
// 主进程广播「某会话被改名」；本窗口若展示该会话，同步网页端标题。
// renameRemoteSession 仅操作页面 DOM，不触发 rename-session IPC，无循环风险。
ipcRenderer.on('session-renamed', async (_event, payload = {}) => {
  try {
    const sid = payload && payload.sessionId;
    const alias = payload && payload.alias;
    if (!sid || !alias) return;
    await chatInput.renameRemoteSession(sid, alias);
  } catch (e) {
    console.error('[TokFree] session-renamed 处理异常:', e && e.message);
  }
});

// ========== 壳层全局设置：写入本 webview 的 localStorage ==========
// 壳层（唯一真源）保存设置后经主进程广播，让当前标签的 preload 模块（retry-engine /
// tool-loop-watchdog / observer 等）读到一致的值；新标签由壳层在 dom-ready 时注入。
ipcRenderer.on('settings-changed', (_event, payload) => {
  try {
    if (!payload || typeof payload !== 'object') return;
    const map = payload.local || {};
    for (const k of Object.keys(map)) {
      try { localStorage.setItem(k, String(map[k])); } catch (_) {}
    }
  } catch (e) {
    console.error('[TokFree] settings-changed 处理异常:', e && e.message);
  }
});

// ========== 初始化 ==========

/**
 * 初始化 TokFree 扩展
 * 注入样式、覆盖层 HTML，绑定事件，启动回复监听（拦截或 DOM 观察）
 */
// 看门狗：观察页面 DOM 活动（流式渲染/输入等），节流刷新心跳，
// 避免长回复生成期间无"完成事件"而被误判为停顿。
let _activityTimer = null;
let _lastActivityHb = 0;
function startActivityHeartbeat() {
  const bump = () => {
    const now = Date.now();
    if (now - _lastActivityHb < 2000) return; // 2 秒节流（配合 5s 催促，避免流式生成时误判停顿）
    _lastActivityHb = now;
    try {
      if (window.electronAPI && window.electronAPI.watchdogTouch) {
        window.electronAPI.watchdogTouch().catch(() => {});
      }
    } catch (_) {}
  };
  try {
    const mo = new MutationObserver(() => bump());
    const target = document.body || document.documentElement;
    if (target) mo.observe(target, { childList: true, subtree: true, characterData: true });
  } catch (_) {}
}

/**
 * 按钮状态心跳（辅助依据，独立于 DOM 活动观察）：
 * 输入框右下角是「停止」按钮 → AI 运行中 → 刷新心跳。
 * 这是原生信号，比 DOM 活动更可靠：即使页面完全静止（服务端思考、长命令执行），
 * 只要停止按钮还在，就刷新心跳，避免看门狗误判为停顿。
 * 停止按钮消失（变成发送按钮）→ 不再刷新 → 心跳自然老化 → 该催促时催促。
 * 所有模式（拦截/DOM）都启动。
 */
/**
 * 禁言/封禁检测（多语言）：当聊天输入框消失时，扫描页面文本找禁言提示。
 * 命中后上报主进程，窗口管理面板会显示红色「账号受限至 xxx」标签。
 * 支持中文（禁言/封禁）、英文（banned/suspended/muted）及其他常见表达。
 */
function detectBannedNotice() {
  try {
    // 扫描页面文本找禁言/封禁提示。
    // ⚠️ 不再要求"输入框消失"——DeepSeek 等平台被禁言时输入框可能仍在，
    // 只是发消息被拦 / 页面顶部有提示横幅。
    const body = document.body;
    if (!body) return null;
    // 1) 主判据：扫描"提示类"元素（横幅/弹窗/提示条）——禁言提示一定在这类容器里
    let hintText = '';
    try {
      const cands = document.querySelectorAll(
        '[class*="banner"], [class*="notice"], [class*="toast"], [class*="dialog"], ' +
        '[class*="modal"], [class*="alert"], [class*="tip"], [class*="warning"], ' +
        '[role="alert"], [role="dialog"], [role="status"]'
      );
      for (const el of cands) {
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
          hintText += ' ' + (el.innerText || el.textContent || '');
        }
      }
    } catch (_) {}

    // 2) 输入框状态：判断聊天是否"无法输入"（禁言的直接证据）
    let inputBroken = false;
    try {
      const inputs = document.querySelectorAll('textarea, div[contenteditable="true"], [role="textbox"]');
      let hasVisible = false, allDisabled = true;
      for (const el of inputs) {
        if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
          hasVisible = true;
          const dis = el.disabled || el.getAttribute('contenteditable') === 'false' || el.getAttribute('aria-disabled') === 'true';
          if (!dis) allDisabled = false;
        }
      }
      // 输入框不存在，或全部禁用 → 输入被阻断
      if (!hasVisible || (hasVisible && allDisabled)) inputBroken = true;
    } catch (_) {}

    // 组装待检测文本：
    // - 提示区有内容 → 以提示区为准（最可靠）
    // - 提示区为空但输入被阻断 → 才用全文兜底（避免聊天内容里提到"禁言"误报）
    let text = hintText.trim();
    if (!text) {
      if (!inputBroken) return null;   // 提示区空 + 输入正常 → 不检测（防误报）
      text = (body.innerText || body.textContent || '');
    }
    text = text.slice(0, 30000);
    if (!text.trim()) return null;
    const lower = text.toLowerCase();
    // 强关键词（完整短语，正常聊天极少出现）
    const KWS = [
      // 中文
      '已被禁言', '禁言至', '已被封禁', '封禁至', '账号已被限制', '账号已被暂停',
      '账号已被封禁', '账号存在异常', '账号存在违规', '违反用户使用规范', '违反社区规范',
      '违反平台规范', '暂时无法使用', '无法使用该账号', '账号已被限制使用',
      // 英文
      'has been banned', 'has been suspended', 'has been muted',
      'banned until', 'suspended until', 'muted until',
      'account suspended', 'account banned', 'account is suspended',
      'your account has been', 'has been restricted', 'restricted until',
    ];
    let hit = null;
    for (const kw of KWS) {
      if (lower.indexOf(kw.toLowerCase()) !== -1) { hit = kw; break; }
    }
    if (!hit) return null;
    const until = extractUntilTs(text);
    console.log('[TokFree] 禁言检测命中: "' + hit + '" until=' + (until ? new Date(until).toLocaleString() : '未知') + ' (提示区=' + hintText.length + '字)');
    return { keyword: hit, until: until || 0 };
  } catch (e) {
    console.error('[TokFree] 禁言检测异常:', e && e.message);
    return null;
  }
}

/** 从文本提取"解禁时间"时间戳（多格式：中文年月日 / ISO / 英文月日年）；无则 0 */
function extractUntilTs(text) {
  const mk = (y, mo, d, h, mi) => {
    try { return new Date(y, mo - 1, d, h || 0, mi || 0).getTime(); } catch (_) { return 0; }
  };
  // 中文：2026 年 9 月 19 日 16:46
  let m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日(?:\s*(\d{1,2})[:：](\d{2}))?/);
  if (m) return mk(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  // ISO：2026-09-19 16:46
  m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return mk(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  // 英文：September 19, 2026
  const MON = { january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12,jan:1,feb:2,mar:3,apr:4,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12 };
  m = text.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) {
    const mo = MON[m[1].toLowerCase()];
    if (mo) return mk(+m[3], mo, +m[2], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  }
  return 0;
}

/** 启动禁言检测轮询（每 3 秒一次，命中上报主进程） */
function startBannedWatcher() {
  const POLL_MS = 3000;
  let lastSig = null;

  setInterval(() => {
    try {
      const info = detectBannedNotice();
      const sig = info ? (info.keyword + '|' + info.until) : '';
      if (sig === lastSig) return;
      lastSig = sig;
      if (info) {
        if (window.electronAPI && window.electronAPI.watchdogNoteBanned) {
          window.electronAPI.watchdogNoteBanned(info).catch(() => {});
        }
        console.log('[TokFree] 检测到账号受限：' + info.keyword + (info.until ? ' 至 ' + new Date(info.until).toLocaleString() : ''));
      } else {
        if (window.electronAPI && window.electronAPI.watchdogClearBanned) {
          window.electronAPI.watchdogClearBanned().catch(() => {});
        }
      }
    } catch (_) {}
  }, POLL_MS);
}

/**
 * 页面状态上报（供窗口管理面板显示真实状态）
 * - 'login'：在登录页
 * - 'home'：在平台首页（未进入对话）
 * - 'ready'：已进入对话（正常）
 */
function startPageStateReporter() {
  let last = null;
  const report = async () => {
    try {
      const p = currentProvider;
      if (!p) return; // 未选平台：主进程按 providerId 为空判断
      let state = 'ready';
      try {
        if (typeof p.isLoginPage === 'function' && p.isLoginPage()) state = 'login';
        else if (p.homeUrlPattern && p.homeUrlPattern.test(window.location.href)) state = 'home';
      } catch (_) {}
      if (state === last) return;
      last = state;
      if (window.electronAPI && window.electronAPI.reportPageState) {
        window.electronAPI.reportPageState(state).catch(() => {});
      }
    } catch (_) {}
  };
  report();
  setInterval(report, 4000);
}

function startButtonHeartbeat() {
  const POLL_MS = 2000;
  const STALL_MS = 120000;   // 生成态但内容 120s 无增长 → 判定卡住，交看门狗
  let prevGenerating = false;
  let prevDiagGen = null;
  let lastContentLen = -1;
  let lastProgressAt = Date.now();
  let stallReported = false;
  let generatingStartAt = 0;   // 本轮生成开始时刻（拦截模式 DOM 兜底判断 hook 是否派发用）

  // 取"进展信号"：最后一条 AI 消息的文本长度（跨平台尽量通用）
  // 覆盖层内的元素（token 计数/动画/时间会持续变化，绝不能被算作"AI 进展"）
  function inOverlay(el) {
    try { return !!(el && el.closest && el.closest('#tokfree-root, #tokfree-overlay, #tokfree-mission-control, [id^="tokfree-"]')); } catch (_) { return false; }
  }

  function readProgressLen() {
    try {
      // 只在 AI 消息区测量（排除覆盖层）：取最后一条 AI 消息的文本长度。
      // ⚠️ 教训：曾用 document.body 兜底，但覆盖层的 token 计数/动画文字一直在变，
      // 导致长度永远"有变化"→ 永不判定卡住 → 心跳一直刷 → 看门狗永不老化、永不催。
      const sels = ['.ds-message', '[class*="message"]', '[class*="markdown"]', '[class*="think"]'];
      let maxLen = -1;
      for (let si = 0; si < sels.length; si++) {
        const els = document.querySelectorAll(sels[si]);
        for (let j = els.length - 1; j >= 0; j--) {
          const el = els[j];
          if (inOverlay(el)) continue;
          const len = (el.textContent || '').length;
          if (len > maxLen) maxLen = len;
          break; // 每个选择器只看最后一条非覆盖层元素
        }
      }
      return maxLen;
    } catch (_) { return -1; }
  }

  setInterval(() => {
    try {
      const p = currentProvider;
      if (!p || typeof p.isGenerating !== 'function') return;
      const gen = p.isGenerating();

      // 进展信号：内容长度变化 → 刷新"最近进展"时刻
      const len = readProgressLen();
      if (len >= 0 && len !== lastContentLen) {
        lastContentLen = len;
        lastProgressAt = Date.now();
        stallReported = false;
      }

      // 诊断：状态变化时输出真实按钮结构
      if (prevDiagGen === null || gen !== prevDiagGen) {
        try {
          const all = document.querySelectorAll('button, [role="button"], .ds-button');
          const info = [];
          all.forEach((b, i) => {
            if (i > 25 || info.length >= 12) return;
            const cls = typeof b.className === 'string' ? b.className : '';
            const aria = b.getAttribute('aria-label') || '';
            const title = b.getAttribute('title') || '';
            const txt = (b.textContent || '').trim().slice(0, 16);
            if (cls.indexOf('circle') !== -1 || cls.indexOf('send') !== -1 || cls.indexOf('stop') !== -1 || aria || title) {
              info.push({ c: cls.slice(0, 70), a: aria, t: title, x: txt, d: !!b.disabled });
            }
          });
          console.log('[TokFree BtnDiag] gen=' + gen + ' (prev=' + prevDiagGen + ') btns=' + JSON.stringify(info));
        } catch (_) {}
        prevDiagGen = gen;
      }

      if (gen) {
        // false→true 边沿：记录本轮生成开始时刻（拦截模式 DOM 兜底据此判断 hook 是否派发）
        if (!prevGenerating) generatingStartAt = Date.now();
        // ⚠️ 卡住检测：按钮显示"生成中"，但内容长期不增长 → 视为卡住。
        // 关键：此时【停止刷心跳】，否则心跳一直刷新，看门狗永不老化、永不催促。
        if (lastContentLen >= 0 && (Date.now() - lastProgressAt) > STALL_MS) {
          if (!stallReported) {
            stallReported = true;
            console.log('[TokFree STALL] 生成态但 ' + Math.round((Date.now() - lastProgressAt) / 1000) + 's 无进展' +
              ' (lastLen=' + lastContentLen + ', 当前len=' + readProgressLen() + ', gen=' + gen + ')，交看门狗接管');
            if (window.electronAPI && window.electronAPI.watchdogButtonIdle) {
              window.electronAPI.watchdogButtonIdle().catch(() => {});
            }
          }
          // 不再 touch，让看门狗心跳老化、到期催促
        } else {
          // 正常运行中：刷新心跳，防止页面静止被误判停顿
          if (window.electronAPI && window.electronAPI.watchdogTouch) {
            window.electronAPI.watchdogTouch().catch(() => {});
          }
        }
      } else if (prevGenerating) {
        // 停止→发送 边沿：本轮结束/中断。通知看门狗，若它仍在监护中且没收到完成事件，会加速催促。
        if (window.electronAPI && window.electronAPI.watchdogButtonIdle) {
          window.electronAPI.watchdogButtonIdle().catch(() => {});
        }
        // 拦截模式 DOM 兜底：hook 漏抓（SSE 格式/端点变化）时事件不派发、代码块永不执行。
        // 本轮生成结束且 hook 未派发过 → 从 DOM 提取最后一条 AI 回复走同一处理流程。
        // 安全性：fallbackProcessFromDom 内部判断 lastDispatchAt，正常派发时不触发；
        // processInterceptedResponse 内部用 lastProcessedText 去重，杜绝重复执行代码块。
        if (useIntercept) {
          try {
            require('./dom/intercept-observer').fallbackProcessFromDom(generatingStartAt).catch(() => {});
          } catch (_) {}
        }
      }
      // Worker 兜底上报：若本窗口是 Worker 且尚未上报 DONE，扫描最后一条 AI 消息；
      // hook 因 SSE 挂起未 dispatch（按钮态可能恒为生成中）时，靠这里兜底上报，
      // 避免"DONE 收不到 + 状态卡运行中"。安全性：要求 DONE_START/END 成对出现
      //（不完整回复不误报）+ workerDoneReported 幂等（DONE 只上报一次）。
      try { require('./dom/worker-report-fallback').tryReportWorkerFromDom('poll').catch(() => {}); } catch (_) {}
      prevGenerating = gen;
    } catch (_) {}
  }, POLL_MS);
}

/**
 * 需求2：轻量 DOM 变化通知器。
 * 监听页面（排除 TokFree 覆盖层）的消息/输入区变化，去抖 250ms 后
 * 用 ipcRenderer.sendToHost 通知壳层「内容已变」，让壳端即时同步（替代纯轮询）。
 * 纯通知、无副作用；任何异常都不影响主流程。
 */
function startDomChangeNotifier() {
  if (window.__tokfreeDomNotifier) return;
  window.__tokfreeDomNotifier = true;
  var timer = null;
  var pendingKinds = {};
  function flush() {
    timer = null;
    var kinds = Object.keys(pendingKinds);
    pendingKinds = {};
    if (!kinds.length) return;
    try {
      ipcRenderer.sendToHost('tokfree-dom-changed', { kind: kinds.join(','), at: Date.now() });
    } catch (_) {}
  }
  function inOverlay(node) {
    try {
      var el = node && (node.nodeType === 1 ? node : node.parentElement);
      return !!(el && el.closest && el.closest('#tokfree-root,#tokfree-overlay,#tokfree-status-badge,[id^="tokfree-"]'));
    } catch (_) { return false; }
  }
  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (!m) continue;
        if (inOverlay(m.target)) continue;
        if (m.type === 'characterData' || m.type === 'childList') pendingKinds[m.type] = 1;
      }
      if (!Object.keys(pendingKinds).length) return;
      if (timer) return; // 已在防抖窗口内
      timer = setTimeout(flush, 250);
    });
    var target = document.body || document.documentElement;
    if (target) mo.observe(target, { childList: true, subtree: true, characterData: true });
  } catch (e) {
    console.error('[TokFree] DOM 变化通知器启动失败:', e && e.message);
  }
}

function init() {
  try {
    ui.injectCSS();
    ui.injectOverlay();
    projectDir.initProjectDirSection();
    bindEvents();
    missionControl.bindMissionControl();
    commandPalette.bindCommandPalette();
    ui.updateHomeMode();

    // 隐藏工具回合：不显示 tokfree 代码块消息与工具回执（只留普通文字/结果）
    try { require('./dom/hide-tool-turn').start(); } catch (e) { console.error('[TokFree] 启动工具回合隐藏失败:', e && e.message); }

    // 监听 URL 变化（SPA 路由）
    window.addEventListener('popstate', ui.updateHomeMode);
    window.addEventListener('hashchange', ui.updateHomeMode);
    setInterval(ui.updateHomeMode, 1500);
    // 首次延迟执行，确保 overlay 已注入
    setTimeout(ui.updateHomeMode, 500);

    // 默认显示覆盖层 - 兜底强制显示
    ui.forceShowOverlay();

    // 按钮状态心跳：所有模式都启动（辅助看门狗判断 AI 是否运行中）
    startButtonHeartbeat();
    // 需求2：DOM 变化通知器（事件驱动同步，替代纯轮询）
    startDomChangeNotifier();
    // 禁言/封禁检测（输入框消失 + 页面提示 → 上报主进程，窗口面板红标）
    startBannedWatcher();
    // 页面状态上报（未登录/平台首页 → 窗口面板显示真实状态）
    startPageStateReporter();

    if (useIntercept) {
      // 拦截模式：监听主世界注入器派发的 'tokfree-ai-response' 事件
      const interceptObserver = require('./dom/intercept-observer');
      interceptObserver.startInterceptObserver();
      // 失败自动重试引擎 + 工具循环看门狗（仅拦截模式）
      try { require('./dom/retry-engine').startRetryEngine(); } catch (e) { console.error('[TokFree] 启动重试引擎失败:', e.message); }
      try { require('./dom/tool-loop-watchdog').startSessionWatcher(); } catch (e) { console.error('[TokFree] 启动看门狗会话监视失败:', e.message); }
      // 看门狗：拦截模式下页面仍在流式渲染，用轻量观察器感知活动、刷新心跳
      startActivityHeartbeat();
    } else {
      // DOM 抓取模式（延迟启动观察器，等待页面框架渲染）
      setTimeout(observer.startObserver, 2000);
    }
  } catch (err) {
    console.error('[TokFree] init() 出错:', err);
    // 兜底：即使出错也强制显示面板
    ui.forceShowOverlay();
  }

  // 定期巡检：防止面板被意外隐藏
  ui.startOverlayWatcher();

  // 定期提取当前平台用户信息并更新窗口名
  // extractUserInfo 允许返回 string 或 Promise<string>（接口类实现需异步）
  let lastSentUserName = '';
  let userNameFetching = false;
  setInterval(async () => {
    if (userNameFetching) return;
    userNameFetching = true;
    try {
      const provider = getProviderByUrl(window.location.href);
      if (!provider || typeof provider.extractUserInfo !== 'function') return;
      let text = provider.extractUserInfo();
      if (text && typeof text.then === 'function') text = await text;
      if (text && text !== lastSentUserName) {
        lastSentUserName = text;
        window.electronAPI.updateWindowName(text).catch(() => {});
      }
    } catch (e) {
      console.error('[TokFree] 轮询用户名异常:', e.message);
    } finally {
      userNameFetching = false;
    }
  }, 3000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

