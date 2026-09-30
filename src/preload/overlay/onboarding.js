/**
 * 新手引导（Onboarding）—— 三步上手：欢迎 → 选目录 → 就绪。
 *
 * 设计：自包含模块（自建 DOM + CSS），首次进入且未选目录时自动弹出。
 * 完成后写入 localStorage，不再打扰。
 */
const NL = String.fromCharCode(10);
const KEY = 'tokfree-onboarded';

// 品牌 TF 图标（44x44 圆角方块 + 紫罗兰渐变 + 白色 TF），内联 SVG
const TF_ICON_ONBOARD = '<svg viewBox="0 0 44 44" width="64" height="64" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tfGradOb" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c6cff"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs><rect width="44" height="44" rx="11" fill="url(#tfGradOb)"/><path d="M9 13.5 H22 V16.8 H17.3 V30.5 H14 V16.8 H9 Z" fill="#fff"/><path d="M25 13.5 H35 V16.8 H28.3 V20.8 H33.5 V24.1 H28.3 V30.5 H25 Z" fill="#fff"/></svg>';

let step = 0;

function done() {
  try { localStorage.setItem(KEY, '1'); } catch (_) {}
}

function isDone() {
  try { return localStorage.getItem(KEY) === '1'; } catch (_) { return false; }
}

function injectStyle() {
  if (document.getElementById('tokfree-ob-style')) return;
  const style = document.createElement('style');
  style.id = 'tokfree-ob-style';
  style.textContent = [
    '#tokfree-ob-mask { position: fixed; inset: 0; z-index: 2147483647; background: rgba(6,7,15,0.72); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }',
    '#tokfree-ob-mask.tokfree-hidden { display: none !important; }',
    '#tokfree-ob-box { width: 520px; max-width: 92vw; background: #161827; border: 1px solid rgba(124,108,255,0.28); border-radius: 22px; padding: 36px 34px 28px; box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,108,255,0.08); color: #e6e8f5; text-align: center; position: relative; }',
    '#tokfree-ob-icon { width: 64px; height: 64px; margin: 0 auto 20px; border-radius: 18px; background: linear-gradient(135deg, #7c6cff, #a78bfa); display: flex; align-items: center; justify-content: center; font-size: 30px; box-shadow: 0 12px 32px rgba(124,108,255,0.4); }',
    '#tokfree-ob-icon.tokfree-ob-icon-svg { background: none; font-size: 0; }',
    '#tokfree-ob-title { font-size: 22px; font-weight: 800; letter-spacing: -0.3px; margin-bottom: 10px; }',
    '#tokfree-ob-desc { font-size: 14px; color: #9298b8; line-height: 1.7; margin-bottom: 26px; }',
    '#tokfree-ob-dots { display: flex; gap: 8px; justify-content: center; margin-bottom: 26px; }',
    '.tokfree-ob-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.12); transition: all 0.3s; }',
    '.tokfree-ob-dot.active { background: #7c6cff; width: 22px; border-radius: 4px; }',
    '#tokfree-ob-actions { display: flex; gap: 10px; justify-content: center; }',
    '#tokfree-ob-actions button { padding: 11px 26px; border-radius: 11px; font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; transition: all 0.22s; }',
    '#tokfree-ob-primary { background: linear-gradient(135deg, #7c6cff, #6a58ff); color: #fff; box-shadow: 0 6px 18px rgba(124,108,255,0.3); }',
    '#tokfree-ob-primary:hover { transform: translateY(-1px); box-shadow: 0 10px 26px rgba(124,108,255,0.45); }',
    '#tokfree-ob-skip { background: transparent; color: #5d6280; border-color: rgba(255,255,255,0.1); }',
    '#tokfree-ob-skip:hover { color: #9298b8; }',
    '#tokfree-ob-skip-all { background: transparent; color: #5d6280; border-color: transparent; font-size: 13px; padding: 11px 14px; }',
    '#tokfree-ob-skip-all:hover { color: #9298b8; text-decoration: underline; }',
    '#tokfree-ob-steps-hint { position: absolute; top: 16px; right: 20px; font-size: 11px; color: #5d6280; }',
    // 浅色主题适配：显式二态，data-theme=light 走浅色
    'html[data-theme="light"] #tokfree-ob-box { background: #ffffff; border-color: rgba(124,108,255,0.3); color: #1a1c2e; box-shadow: 0 32px 80px rgba(20,20,50,0.22); }',
    'html[data-theme="light"] #tokfree-ob-desc { color: #5d6280; }',
    'html[data-theme="light"] .tokfree-ob-dot { background: rgba(0,0,0,0.12); }',
    'html[data-theme="light"] #tokfree-ob-skip { color: #9ca3af; border-color: rgba(0,0,0,0.12); }',
    'html[data-theme="light"] #tokfree-ob-skip:hover { color: #5d6280; }',
    'html[data-theme="light"] #tokfree-ob-skip-all { color: #9ca3af; }',
    'html[data-theme="light"] #tokfree-ob-skip-all:hover { color: #5d6280; }',
    'html[data-theme="light"] #tokfree-ob-steps-hint { color: #9ca3af; }',
  ].join(NL);
  document.head.appendChild(style);
}

const STEPS = [
  { icon: TF_ICON_ONBOARD, title: '欢迎使用 TokFree', desc: '零 Token 成本的 AI Agent。<br>它能读写文件、执行命令、调用工具，像一个真正的助手帮你干活。<br><br>接下来 30 秒，带你完成设置。', primary: '开始', action: 'next' },
  { icon: '📁', title: '选择一个项目目录', desc: 'AI 将在你选定的目录里工作（读代码、改文件、跑命令）。<br><br>稍后点击覆盖层上的「初始化项目」按钮即可选择目录，我们会自动注入项目上下文。', primary: '下一步', action: 'next' },
  { icon: '✨', title: '一切就绪', desc: '目录已选好，AI 准备就绪。<br><br>在右下角悬浮球里随时查看状态；<br>按 <b>Ctrl+K</b> 呼出命令面板；<br>按 <b>Ctrl+Enter</b> 发送消息。', primary: '开始使用', action: 'finish' },
];

function render() {
  const box = document.getElementById('tokfree-ob-box');
  if (!box) return;
  const s = STEPS[step];
  box.innerHTML =
    '<div id="tokfree-ob-steps-hint">' + (step + 1) + ' / ' + STEPS.length + '</div>' +
    '<div id="tokfree-ob-icon"' + (s.icon.indexOf('<svg') === 0 ? ' class="tokfree-ob-icon-svg"' : '') + '>' + s.icon + '</div>' +
    '<div id="tokfree-ob-title">' + s.title + '</div>' +
    '<div id="tokfree-ob-desc">' + s.desc + '</div>' +
    '<div id="tokfree-ob-dots">' + STEPS.map(function (_, i) { return '<span class="tokfree-ob-dot' + (i === step ? ' active' : '') + '"></span>'; }).join('') + '</div>' +
    '<div id="tokfree-ob-actions">' +
      (step < STEPS.length - 1 ? '<button id="tokfree-ob-skip-all">跳过引导</button>' : '') +
      (step > 0 ? '<button id="tokfree-ob-skip">上一步</button>' : '') +
      '<button id="tokfree-ob-primary">' + s.primary + '</button>' +
    '</div>';

  document.getElementById('tokfree-ob-primary').onclick = handlePrimary;
  const skipAll = document.getElementById('tokfree-ob-skip-all');
  if (skipAll) skipAll.onclick = function () { close(); };
  const back = document.getElementById('tokfree-ob-skip');
  if (back) back.onclick = function () { step--; render(); };
}

function handlePrimary() {
  const s = STEPS[step];
  if (s.action === 'next') { step++; render(); return; }
  if (s.action === 'finish') { close(); }
}

function ensureDom() {
  if (document.getElementById('tokfree-ob-mask')) return;
  injectStyle();
  const mask = document.createElement('div');
  mask.id = 'tokfree-ob-mask';
  mask.className = 'tokfree-hidden';
  mask.innerHTML = '<div id="tokfree-ob-box"></div>';
  document.body.appendChild(mask);
}

function open() {
  ensureDom();
  step = 0;
  render();
  document.getElementById('tokfree-ob-mask').classList.remove('tokfree-hidden');
}

function close() {
  done();
  const mask = document.getElementById('tokfree-ob-mask');
  if (mask) mask.classList.add('tokfree-hidden');
}

/** 首次进入且未选目录时自动弹出 */
function maybeShowOnboarding(currentProjectDir) {
  if (isDone()) return;
  if (currentProjectDir) { done(); return; }
  open();
}

module.exports = { maybeShowOnboarding, open, close, isDone };
