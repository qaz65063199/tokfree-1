const { Tool, ToolResult } = require('./ToolRegistry');
const wm = require('./browser-window-manager');

// ========== 算法库 tools/humanize.js ==========
// 该文件由算法库 Worker 提供（导出 bezierPath / typingSchedule / scrollSchedule / clickDelay）。
// 延迟加载：若尚未就绪，使用内置兜底实现，保证工具层可独立加载、不阻塞其他功能。
let _hz = null;
function hz() {
  if (_hz) return _hz;
  try {
    const m = require('./humanize');
    if (m && typeof m.bezierPath === 'function' && typeof m.typingSchedule === 'function') {
      _hz = m;
      return _hz;
    }
  } catch (_) { /* 未就绪，走兜底 */ }
  _hz = FALLBACK;
  return _hz;
}

// 内置兜底：与 humanize.js 的接口保持一致（仅算法库未就绪时使用）
const FALLBACK = {
  bezierPath(p0, p1, opts) {
    opts = opts || {};
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy) || 1;
    const steps = opts.steps || Math.max(2, Math.round(dist / 8));
    const cOff = opts.controlOffset != null ? opts.controlOffset : 0.3;
    const overshoot = opts.overshoot != null ? opts.overshoot : 0.15;
    const jitter = opts.jitter != null ? opts.jitter : 1.5;
    const rnd = () => (Math.random() - 0.5);
    const c1 = { x: p0.x + dx * cOff + rnd() * dist * 0.3, y: p0.y + dy * cOff + rnd() * dist * 0.3 };
    const c2 = { x: p0.x + dx * (1 - cOff) + rnd() * dist * 0.3, y: p0.y + dy * (1 - cOff) + rnd() * dist * 0.3 };
    const end = { x: p1.x + dx * overshoot, y: p1.y + dy * overshoot };
    const cubic = (t, a, b, c, d) => {
      const mt = 1 - t;
      return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
    };
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      let x = cubic(t, p0.x, c1.x, c2.x, end.x);
      let y = cubic(t, p0.y, c1.y, c2.y, end.y);
      if (i !== 0 && i !== steps) { x += rnd() * jitter * 2; y += rnd() * jitter * 2; }
      pts.push({ x, y });
    }
    if (overshoot) pts.push({ x: p1.x + rnd() * jitter, y: p1.y + rnd() * jitter });
    return pts;
  },
  typingSchedule(text, opts) {
    opts = opts || {};
    const min = opts.minDelay != null ? opts.minDelay : 40;
    const max = opts.maxDelay != null ? opts.maxDelay : 220;
    const br = opts.backspaceRate != null ? opts.backspaceRate : 0;
    const out = [];
    for (const ch of String(text)) {
      if (br > 0 && /[a-zA-Z]/.test(ch) && Math.random() < br) {
        const wrong = String.fromCharCode(97 + Math.floor(Math.random() * 26));
        out.push({ char: wrong, delay: min + Math.random() * (max - min) });
        out.push({ char: '\b', delay: min + Math.random() * (max - min) });
      }
      out.push({ char: ch, delay: min + Math.random() * (max - min) });
    }
    return out;
  },
  scrollSchedule(deltaY, opts) {
    opts = opts || {};
    const steps = opts.steps || Math.max(2, Math.min(12, Math.round(Math.abs(deltaY) / 120) || 2));
    const minP = opts.minPause != null ? opts.minPause : 30;
    const maxP = opts.maxPause != null ? opts.maxPause : 120;
    const per = deltaY / steps;
    const out = [];
    for (let i = 0; i < steps; i++) {
      const jitter = (Math.random() - 0.5) * Math.abs(per) * 0.4;
      out.push({ deltaY: Math.round(per + jitter), pause: minP + Math.random() * (maxP - minP) });
    }
    return out;
  },
  clickDelay(opts) {
    opts = opts || {};
    const min = opts.minDelay != null ? opts.minDelay : 80;
    const max = opts.maxDelay != null ? opts.maxDelay : 300;
    return min + Math.random() * (max - min);
  },
};

// ========== 通用工具 ==========
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// 安全调用算法库的新增拟人函数（兜底实现可能没有，缺则返回 0 / null）
function thinkPauseMs(speed) {
  try {
    const fn = hz().thinkPause;
    if (typeof fn === 'function') return fn({}) * speed;
  } catch (_) {}
  return 0;
}
function hoverDwellOf(speed) {
  try {
    const fn = hz().hoverDwell;
    if (typeof fn === 'function') return fn({});
  } catch (_) {}
  return null;
}

function speedFactor(s) {
  if (s === 'fast') return 0.5;
  if (s === 'slow') return 1.8;
  return 1;
}

function send(win, ev) {
  if (!win || win.isDestroyed()) throw new Error('窗口不存在或已关闭');
  win.webContents.sendInputEvent(ev);
}

// 记录每个窗口最后一次鼠标位置，作为贝塞尔起点
const lastPos = new Map();

function getWin(windowId) {
  if (!windowId) throw new Error('缺少 windowId');
  return wm.getWindow(windowId);
}

// 解析 target（CSS selector 或 {x,y}）为视口坐标
async function resolveTarget(win, target) {
  if (target && typeof target === 'object' && typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: Math.round(target.x), y: Math.round(target.y) };
  }
  if (typeof target === 'string' && target.trim()) {
    const sel = JSON.stringify(target);
    const code = '(function () {'
      + ' var el = document.querySelector(' + sel + ');'
      + ' if (!el) return null;'
      + ' try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (e) {}'
      + ' var r = el.getBoundingClientRect();'
      + ' return { x: r.left + r.width / 2, y: r.top + r.height / 2 };'
      + '})()';
    const r = await win.webContents.executeJavaScript(code, true);
    if (!r) return null;
    return { x: Math.round(r.x), y: Math.round(r.y) };
  }
  return null;
}

// 沿贝塞尔轨迹移动鼠标
async function moveTo(win, windowId, to, speed) {
  const from = lastPos.get(windowId) || { x: to.x - 120, y: to.y - 90 };
  const path = hz().bezierPath(from, to, {});
  for (const pt of path) {
    send(win, { type: 'mouseMove', x: Math.round(pt.x), y: Math.round(pt.y) });
    await sleep((10 + Math.random() * 10) * speed);
  }
  lastPos.set(windowId, { x: Math.round(to.x), y: Math.round(to.y) });
}

const HUMANIZE_PROMPT_SECTION = [
  '## 行为拟人化（真实输入事件）',
  '',
  '页面内 JS 模拟点击的 isTrusted=false，易被反检测识别。需真人级操作时用以下工具（走主进程真实输入管线）：',
  '- human_move(windowId, x, y, opts?) — 沿贝塞尔轨迹移动鼠标到 (x,y)',
  '- human_click(windowId, target, opts?) — target 为 CSS 选择器或 {x,y}；移动→停顿→按下→抬起',
  '- human_type(windowId, text, opts?) — 逐字符输入（可含 opts.selector 先聚焦）；支持拟人打字节奏',
  '- human_scroll(windowId, deltaY, opts?) — 分步拟人滚动（正数向下，负数向上）',
  '',
  '通用 opts：{ speed: "fast" | "normal" | "slow" }，影响所有延迟倍率。',
].join('\n');

// ========== human_move ==========
class HumanMoveTool extends Tool {
  constructor() {
    super(
      'human_move',
      '沿贝塞尔轨迹移动鼠标到指定坐标（发送真实 mouseMove 输入事件，isTrusted=true）',
      {
        type: 'object',
        properties: {
          windowId: { type: 'string', description: '目标窗口 ID' },
          x: { type: 'number', description: '目标 x（视口坐标）' },
          y: { type: 'number', description: '目标 y（视口坐标）' },
          opts: { type: 'object', description: '可选：{ speed: "fast"|"normal"|"slow" }' },
        },
        required: ['windowId', 'x', 'y'],
      },
      'human_move(windowId, x, y, opts?)'
    );
  }
  getPromptSection() {
    return { name: 'tool:humanize', order: 114, text: HUMANIZE_PROMPT_SECTION };
  }
  async execute(p) {
    try {
      const win = getWin(p.windowId);
      const speed = speedFactor(p.opts && p.opts.speed);
      const to = { x: Number(p.x), y: Number(p.y) };
      if (!isFinite(to.x) || !isFinite(to.y)) return ToolResult.error('无效的坐标');
      await moveTo(win, p.windowId, to, speed);
      return ToolResult.success({ moved: true, x: to.x, y: to.y });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== human_click ==========
class HumanClickTool extends Tool {
  constructor() {
    super(
      'human_click',
      '拟人点击：移动到目标（CSS 选择器或 {x,y}）→停顿→mouseDown→延迟→mouseUp（真实输入事件）',
      {
        type: 'object',
        properties: {
          windowId: { type: 'string', description: '目标窗口 ID' },
          target: { description: 'CSS 选择器字符串，或 { x, y } 坐标对象' },
          opts: { type: 'object', description: '可选：{ speed: "fast"|"normal"|"slow" }' },
        },
        required: ['windowId', 'target'],
      },
      'human_click(windowId, target, opts?)'
    );
  }
  async execute(p) {
    try {
      const win = getWin(p.windowId);
      const speed = speedFactor(p.opts && p.opts.speed);
      const pt = await resolveTarget(win, p.target);
      if (!pt) return ToolResult.error('未找到目标元素或坐标无效');
      await moveTo(win, p.windowId, pt, speed);
      // 到位后悬停微移动（模拟瞄准）+ 思考停顿
      const dwell = hoverDwellOf(speed);
      if (dwell && Array.isArray(dwell.deltas)) {
        for (const d of dwell.deltas) {
          send(win, { type: 'mouseMove', x: pt.x + d.dx, y: pt.y + d.dy });
          await sleep((40 + Math.random() * 60) * speed);
        }
        send(win, { type: 'mouseMove', x: pt.x, y: pt.y });
      }
      await sleep((50 + Math.random() * 100) * speed);
      const think = thinkPauseMs(speed);
      if (think > 0) await sleep(think);
      send(win, { type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await sleep(hz().clickDelay({}) * speed);
      send(win, { type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      return ToolResult.success({ clicked: true, x: pt.x, y: pt.y });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== human_type ==========
class HumanTypeTool extends Tool {
  constructor() {
    super(
      'human_type',
      '拟人输入文本：按打字节奏逐字符发送真实按键事件；opts.selector 可先聚焦元素',
      {
        type: 'object',
        properties: {
          windowId: { type: 'string', description: '目标窗口 ID' },
          text: { type: 'string', description: '要输入的文本' },
          opts: {
            type: 'object',
            description: '可选：{ selector?: string, speed?: "fast"|"normal"|"slow" }',
          },
        },
        required: ['windowId', 'text'],
      },
      'human_type(windowId, text, opts?)'
    );
  }
  async execute(p) {
    try {
      const win = getWin(p.windowId);
      const opts = p.opts || {};
      const speed = speedFactor(opts.speed);

      try { win.focus(); } catch (_) {}
      try { win.webContents.focus(); } catch (_) {}

      // 可选：先用拟人点击聚焦目标元素
      if (opts.selector) {
        const pt = await resolveTarget(win, opts.selector);
        if (!pt) return ToolResult.error('未找到聚焦元素: ' + opts.selector);
        await moveTo(win, p.windowId, pt, speed);
        send(win, { type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await sleep(hz().clickDelay({}) * speed);
        send(win, { type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        await sleep(30 * speed);
      }

      const text = String(p.text == null ? '' : p.text);
      const think = thinkPauseMs(speed);
      if (think > 0) await sleep(think);
      const schedule = hz().typingSchedule(text, {});
      for (const item of schedule) {
        await sleep((item.delay || 0) * speed);
        const ch = item.char;
        if (ch === '\b' || ch === 'Backspace' || ch === '{backspace}') {
          send(win, { type: 'keyDown', keyCode: 'Backspace' });
          send(win, { type: 'keyUp', keyCode: 'Backspace' });
        } else if (ch === '\n' || ch === 'Enter' || ch === '{enter}') {
          send(win, { type: 'keyDown', keyCode: 'Enter' });
          send(win, { type: 'char', keyCode: '\r' });
          send(win, { type: 'keyUp', keyCode: 'Enter' });
        } else {
          send(win, { type: 'keyDown', keyCode: ch });
          send(win, { type: 'char', keyCode: ch });
          send(win, { type: 'keyUp', keyCode: ch });
        }
      }
      return ToolResult.success({ typed: text.length });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

// ========== human_scroll ==========
class HumanScrollTool extends Tool {
  constructor() {
    super(
      'human_scroll',
      '拟人滚动：按渐进节奏分步发送真实 mouseWheel 事件（正数向下，负数向上）',
      {
        type: 'object',
        properties: {
          windowId: { type: 'string', description: '目标窗口 ID' },
          deltaY: { type: 'number', description: '总滚动量（像素）；正数向下，负数向上' },
          opts: { type: 'object', description: '可选：{ speed: "fast"|"normal"|"slow" }' },
        },
        required: ['windowId', 'deltaY'],
      },
      'human_scroll(windowId, deltaY, opts?)'
    );
  }
  async execute(p) {
    try {
      const win = getWin(p.windowId);
      const speed = speedFactor(p.opts && p.opts.speed);
      const deltaY = Number(p.deltaY);
      if (!isFinite(deltaY) || deltaY === 0) return ToolResult.error('无效的 deltaY');
      const center = await win.webContents.executeJavaScript(
        '({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) })',
        true
      );
      const x = (center && center.x) || 400;
      const y = (center && center.y) || 300;
      const schedule = hz().scrollSchedule(deltaY, {});
      for (const s of schedule) {
        send(win, { type: 'mouseWheel', deltaY: s.deltaY, x, y });
        await sleep((s.pause || 0) * speed);
      }
      return ToolResult.success({ scrolled: true, deltaY });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

module.exports = {
  HumanMoveTool,
  HumanClickTool,
  HumanTypeTool,
  HumanScrollTool,
};
