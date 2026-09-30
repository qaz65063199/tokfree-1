/**
 * 命令面板（Command Palette）—— Ctrl+K 呼出，一个搜索框执行所有功能。
 *
 * 设计：自包含模块（自己创建 DOM + CSS），不依赖 template.js，
 * 避免大文件编辑风险。支持键盘导航（↑↓ 选择 / Enter 执行 / Esc 关闭）。
 */
const NL = String.fromCharCode(10);

let isOpen = false;
let filtered = [];
let activeIndex = 0;

/** 命令注册表：{ id, title, hint, keywords, run } */
function getCommands() {
  const cmds = [];
  function add(id, title, keywords, runFn, hint) {
    cmds.push({ id: id, title: title, keywords: (keywords || '').toLowerCase(), run: runFn, hint: hint || '' });
  }
  function clickBtn(btnId) {
    return function () {
      const el = document.getElementById(btnId);
      if (el) el.click();
    };
  }
  function toast(msg) {
    try { require('./ui').showToast(msg, 2000); } catch (_) {}
  }

  // 核心操作
  add('init', '初始化项目', 'init project 项目 目录', clickBtn('tokfree-btn-init'), '设置项目目录并注入提示词');
  add('compact', '压缩上下文', 'compact token 压缩 摘要', clickBtn('tokfree-btn-compact'), '生成摘要并开新会话续接');
  add('gen-doc', '生成项目说明', 'doc tokfree.md 文档 说明', clickBtn('tokfree-btn-gen-doc'), '让 AI 生成 TOKFREE.md');
  add('manual-parse', '卡住了？点我', 'stuck 催促 继续 卡住', clickBtn('tokfree-btn-manual-parse'), '发送“继续”指令催 AI');

  // 面板
  add('window-manager', '窗口管理', 'window 窗口 新建 切换', clickBtn('tokfree-btn-window-manager'), '新建/切换/配置窗口');
  add('mcp', 'MCP 工具', 'mcp 工具 server', clickBtn('tokfree-btn-mcp'), '管理 MCP server');
  add('knowledge', '知识库', 'knowledge skill 技能 偏好', clickBtn('tokfree-btn-knowledge'), '管理技能与全局偏好');
  add('account-pool', '账号池', 'account 账号 密码', clickBtn('tokfree-btn-account-pool'), '集中管理账号');
  add('settings', '设置', 'settings 设置 配置', clickBtn('tokfree-btn-settings'), '通知/重试/看门狗/引导者');

  // 模式与外观
  add('theme', '切换主题', 'theme 主题 亮 暗', clickBtn('tokfree-btn-theme'), '亮色/暗色');
  add('team-mode', '切换多 Agent 模式', 'team multi agent 多智能体 主大脑', clickBtn('tokfree-team-mode-toggle'), '本窗口作为主大脑');
  add('policy-mode', '切换 Plan / Act 模式', 'plan act policy 模式 只读', clickBtn('tokfree-policy-mode'), 'Plan 只读 / Act 执行');
  add('immersive', '沉浸式交流', 'immersive 沉浸 交流', clickBtn('tokfree-btn-immersive'), '切换沉浸式模式');

  // 快捷操作
  add('new-chat', '新对话', 'new chat 新对话 新建会话', clickBtn('cv-btn-new'), '开启新对话（当前标签）');
  add('attach', '上传附件', 'attach file 附件 上传 📎', clickBtn('cv-attach'), '上传附件到当前对话');
  add('check-update', '检查更新', 'update 更新 版本 升级', clickBtn('tokfree-btn-check-update'), '检查软件新版本');
  add('cleanup-cache', '清理缓存', 'cleanup cache 缓存 清理', clickBtn('tokfree-btn-cleanup-cache'), '删除浏览器缓存（保留登录态）');
  add('curator-now', '立即战略巡检', 'curator 巡检 战略 引导者', clickBtn('tokfree-btn-curator-now'), '立即发起一次战略巡检');
  add('about', '关于 TokFree', 'about 关于 版本 信息', clickBtn('tokfree-btn-about'), '查看版本与信息');

  // 补充说明
  add('focus-input', '聚焦补充说明框', 'input focus 补充 说明 输入', function () {
    const el = document.getElementById('tokfree-user-input');
    if (el) { el.focus(); }
  }, '光标跳到补充说明框');

  return cmds;
}

const RECENT_KEY = 'tokfree-cp-recent';
function getRecent() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}
function addRecent(id) {
  try {
    let arr = getRecent().filter(function (x) { return x !== id; });
    arr.unshift(id);
    if (arr.length > 5) arr = arr.slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(arr));
  } catch (_) {}
}

function injectStyle() {
  if (document.getElementById('tokfree-cp-style')) return;
  const style = document.createElement('style');
  style.id = 'tokfree-cp-style';
  style.textContent = [
    '#tokfree-cp-mask { position: fixed; inset: 0; z-index: 2147483647; background: rgba(6,7,15,0.55); backdrop-filter: blur(4px); display: flex; align-items: flex-start; justify-content: center; padding-top: 14vh; }',
    '#tokfree-cp-mask.tokfree-hidden { display: none !important; }',
    '#tokfree-cp-box { width: 560px; max-width: 92vw; background: #161827; border: 1px solid rgba(255,255,255,0.10); border-radius: 16px; box-shadow: 0 24px 64px rgba(0,0,0,0.5); overflow: hidden; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #e6e8f5; }',
    '#tokfree-cp-input { width: 100%; box-sizing: border-box; border: none; outline: none; background: transparent; padding: 16px 18px; font-size: 15px; color: #e6e8f5; border-bottom: 1px solid rgba(255,255,255,0.08); }',
    '#tokfree-cp-input::placeholder { color: #5d6280; }',
    '#tokfree-cp-list { max-height: 46vh; overflow-y: auto; padding: 6px; }',
    '.tokfree-cp-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 10px; cursor: pointer; }',
    '.tokfree-cp-item.active { background: rgba(124,108,255,0.18); }',
    '.tokfree-cp-item .tokfree-cp-title { font-size: 13.5px; font-weight: 600; color: #e6e8f5; flex-shrink: 0; }',
    '.tokfree-cp-item .tokfree-cp-hint { font-size: 11px; color: #8a90b8; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.tokfree-cp-empty { padding: 24px; text-align: center; color: #5d6280; font-size: 13px; }',
    '.tokfree-cp-foot { padding: 8px 14px; border-top: 1px solid rgba(255,255,255,0.08); font-size: 11px; color: #5d6280; display: flex; gap: 14px; }',
    '.tokfree-cp-foot kbd { padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,0.06); font-family: Consolas, monospace; }',
  ].join(NL);
  document.head.appendChild(style);
}

function ensureDom() {
  if (document.getElementById('tokfree-cp-mask')) return;
  injectStyle();
  const mask = document.createElement('div');
  mask.id = 'tokfree-cp-mask';
  mask.className = 'tokfree-hidden';
  mask.innerHTML =
    '<div id="tokfree-cp-box">' +
      '<input id="tokfree-cp-input" type="text" placeholder="输入命令…（如：窗口、压缩、任务中心）" autocomplete="off" />' +
      '<div id="tokfree-cp-list"></div>' +
      '<div class="tokfree-cp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> 选择</span><span><kbd>Enter</kbd> 执行</span><span><kbd>Esc</kbd> 关闭</span></div>' +
    '</div>';
  document.body.appendChild(mask);
  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  const input = document.getElementById('tokfree-cp-input');
  input.addEventListener('input', function () { filter(input.value); });
  input.addEventListener('keydown', onKeydown);
}

function filter(q) {
  const all = getCommands();
  const kw = (q || '').trim().toLowerCase();
  if (kw) {
    filtered = all.filter(function (c) {
      return c.title.toLowerCase().indexOf(kw) !== -1 || c.keywords.indexOf(kw) !== -1;
    });
  } else {
    const recent = getRecent();
    if (recent.length) {
      const rank = {};
      recent.forEach(function (id, i) { rank[id] = i; });
      all.forEach(function (c) { if (rank[c.id] !== undefined) c._recent = true; });
      all.sort(function (a, b) {
        const ra = rank[a.id], rb = rank[b.id];
        if (ra === undefined && rb === undefined) return 0;
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      });
    }
    filtered = all;
  }
  activeIndex = 0;
  renderList();
}

function renderList() {
  const list = document.getElementById('tokfree-cp-list');
  if (!list) return;
  if (!filtered.length) {
    list.innerHTML = '<div class="tokfree-cp-empty">没有匹配的命令</div>';
    return;
  }
  list.innerHTML = filtered.map(function (c, i) {
    return '<div class="tokfree-cp-item' + (i === activeIndex ? ' active' : '') + '" data-idx="' + i + '">' +
      '<span class="tokfree-cp-title">' + (c._recent ? '★ ' : '') + c.title + '</span>' +
      (c.hint ? '<span class="tokfree-cp-hint">' + c.hint + '</span>' : '') +
    '</div>';
  }).join('');
  list.querySelectorAll('.tokfree-cp-item').forEach(function (el) {
    el.addEventListener('click', function () { runAt(parseInt(el.dataset.idx, 10)); });
    el.addEventListener('mouseenter', function () {
      activeIndex = parseInt(el.dataset.idx, 10);
      list.querySelectorAll('.tokfree-cp-item').forEach(function (x, i) {
        x.classList.toggle('active', i === activeIndex);
      });
    });
  });
}

function runAt(i) {
  const c = filtered[i];
  if (!c) return;
  addRecent(c.id);
  close();
  setTimeout(function () { try { c.run(); } catch (_) {} }, 60);
}

function onKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); close(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, filtered.length - 1); renderList(); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); renderList(); return; }
  if (e.key === 'Enter') { e.preventDefault(); runAt(activeIndex); return; }
}

function open() {
  ensureDom();
  const mask = document.getElementById('tokfree-cp-mask');
  const input = document.getElementById('tokfree-cp-input');
  if (!mask || !input) return;
  isOpen = true;
  mask.classList.remove('tokfree-hidden');
  input.value = '';
  filter('');
  setTimeout(function () { input.focus(); }, 30);
}

function close() {
  const mask = document.getElementById('tokfree-cp-mask');
  if (mask) mask.classList.add('tokfree-hidden');
  isOpen = false;
}

function toggle() { if (isOpen) close(); else open(); }

function bindCommandPalette() {
  window.addEventListener('keydown', function (e) {
    // Ctrl+K 或 Cmd+K
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
    }
  }, true);
}

module.exports = { bindCommandPalette, open, close, toggle };
