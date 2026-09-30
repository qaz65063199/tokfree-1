'use strict';

/**
 * 行为拟人化算法库（纯函数，无副作用，可 Node 单测）
 *
 * 提供鼠标轨迹、打字节奏、滚动节奏、点击延迟、思考/悬停停顿的拟人生成算法。
 * 全部函数不依赖 electron / 窗口 / DOM，仅做数学与随机数计算。
 * 随机源可通过 opts.rng 注入，便于测试确定性复现。
 */

/** 返回 [0,1) 随机数（默认 Math.random） */
function pickRng(opts) {
  if (opts && typeof opts.rng === 'function') return opts.rng;
  return Math.random;
}

/**
 * 三次贝塞尔鼠标轨迹（含过冲回拉 + 逐点微抖）。
 *
 * @param {{x:number,y:number}} p0 起点
 * @param {{x:number,y:number}} p1 终点
 * @param {object} [opts]
 * @param {number} [opts.steps] 主轨迹分段数，默认 ≈ 距离/8（至少 2）
 * @param {number} [opts.overshoot] 过冲比例（相对距离），默认 0.15
 * @param {number} [opts.jitter] 每点抖动幅度（px），默认 1.5
 * @param {number} [opts.controlOffset] 控制点偏移基准（px），默认 距离*0.25
 * @param {() => number} [opts.rng] 随机源，默认 Math.random
 * @returns {{x:number,y:number}[]} 轨迹点；首点 ≈ p0，末点 ≈ p1
 */
function bezierPath(p0, p1, opts = {}) {
  const rng = pickRng(opts);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);

  const steps = opts.steps != null ? opts.steps : Math.max(2, Math.round(dist / 8));
  const overshoot = opts.overshoot != null ? opts.overshoot : 0.15;
  const jitter = opts.jitter != null ? opts.jitter : 1.5;
  const controlOffset = opts.controlOffset != null ? opts.controlOffset : dist * 0.25;

  // 单位方向向量与法向量
  const ux = dist === 0 ? 0 : dx / dist;
  const uy = dist === 0 ? 0 : dy / dist;
  const nx = -uy;
  const ny = ux;

  // 过冲目标：沿方向超过 p1 一点
  const osTarget = {
    x: p1.x + ux * dist * overshoot,
    y: p1.y + uy * dist * overshoot,
  };

  // 控制点（带随机法向偏移）
  const c1 = {
    x: p0.x + ux * controlOffset + nx * (rng() - 0.5) * controlOffset,
    y: p0.y + uy * controlOffset + ny * (rng() - 0.5) * controlOffset,
  };
  const c2 = {
    x: osTarget.x - ux * controlOffset + nx * (rng() - 0.5) * controlOffset,
    y: osTarget.y - uy * controlOffset + ny * (rng() - 0.5) * controlOffset,
  };

  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    pts.push({
      x: a * p0.x + b * c1.x + c * c2.x + d * osTarget.x,
      y: a * p0.y + b * c1.y + c * c2.y + d * osTarget.y,
    });
  }

  // 过冲后回拉：从过冲点线性回到 p1
  const pullbackSteps = Math.max(1, Math.round(steps * 0.2));
  for (let i = 1; i <= pullbackSteps; i++) {
    const t = i / pullbackSteps;
    pts.push({
      x: osTarget.x + (p1.x - osTarget.x) * t,
      y: osTarget.y + (p1.y - osTarget.y) * t,
    });
  }

  // 逐点微抖
  for (const pt of pts) {
    pt.x += (rng() - 0.5) * 2 * jitter;
    pt.y += (rng() - 0.5) * 2 * jitter;
  }

  // 锚定首尾点
  pts[0] = { x: p0.x, y: p0.y };
  pts[pts.length - 1] = { x: p1.x, y: p1.y };
  return pts;
}

// ---------- 打字错字模型 ----------

// QWERTY 相邻键表（小写）：打错时优先命中相邻键，符合真实误触分布
const KEY_NEIGHBORS = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj',
  i: 'uojk', o: 'ipkl', p: 'ol',
  a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb',
  j: 'huikmn', k: 'jiolm', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
};

/**
 * 生成一个与目标字符不同的“错误字符”。
 * 字母优先取 QWERTY 相邻键（保持大小写）；数字取相邻数字；其余走字符池兜底。
 */
function randomWrongChar(target, rng) {
  const str = String(target == null ? '' : target);
  const lower = str.toLowerCase();
  const neighbors = KEY_NEIGHBORS[lower];
  if (neighbors) {
    const c = neighbors[Math.floor(rng() * neighbors.length)];
    return str === lower ? c : c.toUpperCase();
  }
  if (/^[0-9]$/.test(str)) {
    const cur = parseInt(str, 10);
    let d = Math.floor(rng() * 10);
    if (d === cur) d = (d + 1) % 10;
    return String(d);
  }
  const pool = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 8; attempt++) {
    const c = pool[Math.floor(rng() * pool.length)];
    if (c !== target) return c;
  }
  return target === 'x' ? 'y' : 'x';
}

/**
 * 打字节奏（含按概率的“打错→退格”，整词偶发打错重打，句末/长词后偶发长停顿）。
 *
 * @param {string} text 待输入文本
 * @param {object} [opts]
 * @param {number} [opts.minDelay=40] 每字符最小延迟（ms）
 * @param {number} [opts.maxDelay=220] 每字符最大延迟（ms）
 * @param {number} [opts.backspaceRate=0.03] 单字符打错概率 [0,1]
 * @param {number} [opts.wordErrorRate] 整词打错概率，默认 backspaceRate*0.15（仅 4~12 长的词）
 * @param {number} [opts.longPauseMin=500] 长停顿下限（ms，模拟思考）
 * @param {number} [opts.longPauseMax=1500] 长停顿上限（ms）
 * @param {number} [opts.longWordLen=12] 触发长停顿的长词阈值
 * @param {() => number} [opts.rng] 随机源
 * @returns {{char:string, delay:number, backspace:boolean}[]}
 *   顺序事件；backspace:true 表示该步是退格（char 为空）。
 */
function typingSchedule(text, opts = {}) {
  const rng = pickRng(opts);
  const minDelay = opts.minDelay != null ? opts.minDelay : 40;
  const maxDelay = opts.maxDelay != null ? opts.maxDelay : 220;
  const backspaceRate = opts.backspaceRate != null ? opts.backspaceRate : 0.03;
  const wordErrorRate = opts.wordErrorRate != null ? opts.wordErrorRate : backspaceRate * 0.15;
  const longPauseMin = opts.longPauseMin != null ? opts.longPauseMin : 500;
  const longPauseMax = opts.longPauseMax != null ? opts.longPauseMax : 1500;
  const longWordLen = opts.longWordLen != null ? opts.longWordLen : 12;

  const randDelay = () => Math.round(minDelay + rng() * (maxDelay - minDelay));
  const schedule = [];
  const source = String(text == null ? '' : text);
  const pushChar = (ch) => schedule.push({ char: ch, delay: randDelay(), backspace: false });

  // 分词：字母数字为词，其余为分隔符（保留顺序）
  const tokens = source.match(/[A-Za-z0-9]+|[^A-Za-z0-9]+/g) || [];
  const SENT_END = /[.!?;:\n]/;

  for (const token of tokens) {
    const isWord = /^[A-Za-z0-9]+$/.test(token);

    if (isWord && wordErrorRate > 0 && token.length >= 4 && token.length <= 12 && rng() < wordErrorRate) {
      // 整词打错 → 全退格 → 重打
      for (const ch of token) pushChar(randomWrongChar(ch, rng));
      for (let i = 0; i < token.length; i++) {
        schedule.push({ char: '', delay: randDelay(), backspace: true });
      }
      for (const ch of token) pushChar(ch);
    } else {
      for (const ch of token) {
        if (backspaceRate > 0 && rng() < backspaceRate) {
          pushChar(randomWrongChar(ch, rng));
          schedule.push({ char: '', delay: randDelay(), backspace: true });
        }
        pushChar(ch);
      }
    }

    // 句末标点 或 超长词后，偶发一次长停顿（模拟思考），只叠加到当前步延迟、不新增步
    const lastCh = token[token.length - 1];
    const needLongPause = (isWord && token.length >= longWordLen) || (!isWord && SENT_END.test(lastCh));
    if (needLongPause && schedule.length && rng() < 0.5) {
      schedule[schedule.length - 1].delay += Math.round(longPauseMin + rng() * (longPauseMax - longPauseMin));
    }
  }
  return schedule;
}

/**
 * easeInOut 钟形权重（惯性用）：两端小、中间大。
 * 用 sin(π·t)^1.5 造出“起步慢→中段快→收尾慢”的平滑曲线，再加少量抖动。
 */
function easeInOutWeights(steps, rng) {
  const w = [];
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? 0.5 : i / (steps - 1);
    const bell = 0.15 + 0.85 * Math.pow(Math.sin(Math.PI * t), 1.5);
    w.push(bell * (0.85 + rng() * 0.3));
  }
  return w;
}

/**
 * 滚动节奏（缓动惯性多步 + 偶发过头回滚 + 随机停顿）。
 *
 * @param {number} deltaY 总滚动量（可正可负）
 * @param {object} [opts]
 * @param {number} [opts.steps=6] 分步数
 * @param {number} [opts.minPause=30] 每步最小停顿（ms）
 * @param {number} [opts.maxPause=120] 每步最大停顿（ms）
 * @param {boolean} [opts.overshootRollback] 是否启用过头回滚（默认：大步数且大滚动量时偶发）
 * @param {() => number} [opts.rng] 随机源
 * @returns {{deltaY:number, pause:number}[]} 各步滚动量与停顿；deltaY 之和 ≈ 入参
 */
function scrollSchedule(deltaY, opts = {}) {
  const rng = pickRng(opts);
  const steps = opts.steps != null ? Math.max(1, Math.floor(opts.steps)) : 6;
  const minPause = opts.minPause != null ? opts.minPause : 30;
  const maxPause = opts.maxPause != null ? opts.maxPause : 120;

  // 惯性：用 easeInOut 钟形权重替代均匀随机
  const weights = easeInOutWeights(steps, rng);
  const total = weights.reduce((a, w) => a + w, 0) || 1;

  const out = [];
  let allocated = 0;
  for (let i = 0; i < steps; i++) {
    let d;
    if (i === steps - 1) {
      d = deltaY - allocated; // 末步补齐，保证总和精确
    } else {
      d = deltaY * (weights[i] / total);
      allocated += d;
    }
    out.push({
      deltaY: d,
      pause: Math.round(minPause + rng() * (maxPause - minPause)),
    });
  }

  // 偶发过头回滚：某步冲过头，紧随一步反向回拉（总和不变）
  const overshoot = opts.overshootRollback != null
    ? !!opts.overshootRollback
    : (steps >= 8 && Math.abs(deltaY) >= 400 && rng() < 0.35);
  if (overshoot && steps >= 4) {
    const peak = 1 + Math.floor(rng() * (steps - 3));
    const dir = Math.sign(deltaY) || 1;
    // 回拉量：确保 peak+1 反向（幅度为其原步长的 1.6 倍），叠加后必现方向反转
    const pull = dir * Math.abs(out[peak + 1].deltaY) * 1.6;
    out[peak].deltaY += pull;      // 冲过头（同向加大）
    out[peak + 1].deltaY -= pull;  // 回拉（反向，总和保持不变）
  }

  // 浮点纠正：把累计误差补到末步，保证总和精确等于入参
  const sum = out.reduce((a, e) => a + e.deltaY, 0);
  if (out.length) out[out.length - 1].deltaY += deltaY - sum;

  return out;
}

/**
 * 鼠标按下到抬起的延迟（ms）。
 *
 * @param {object} [opts]
 * @param {number} [opts.min=80] 最小延迟
 * @param {number} [opts.max=300] 最大延迟
 * @param {() => number} [opts.rng] 随机源
 * @returns {number} 毫秒数，默认范围 [80, 300]
 */
function clickDelay(opts = {}) {
  const rng = pickRng(opts);
  const min = opts.min != null ? opts.min : 80;
  const max = opts.max != null ? opts.max : 300;
  return Math.round(min + rng() * (max - min));
}

/**
 * 思考停顿（ms）：模拟操作前的犹豫/思考，默认 300~2500ms，偶发更长。
 *
 * @param {object} [opts]
 * @param {number} [opts.min=300] 最小思考时长
 * @param {number} [opts.max=2500] 最大思考时长
 * @param {number} [opts.longRate=0.1] 触发“更长停顿”的概率
 * @param {number} [opts.longMax=6000] 更长停顿上限
 * @param {() => number} [opts.rng] 随机源
 * @returns {number} 毫秒数
 */
function thinkPause(opts = {}) {
  const rng = pickRng(opts);
  const min = opts.min != null ? opts.min : 300;
  const max = opts.max != null ? opts.max : 2500;
  const longRate = opts.longRate != null ? opts.longRate : 0.1;
  const longMax = opts.longMax != null ? opts.longMax : 6000;
  let d = min + rng() * (max - min);
  if (rng() < longRate) d = max + rng() * (longMax - max);
  return Math.round(d);
}

/**
 * 悬停停留：返回悬停总时长与若干“微移动”增量（模拟手部抖动）。
 *
 * @param {object} [opts]
 * @param {number} [opts.min=200] 最小悬停时长
 * @param {number} [opts.max=800] 最大悬停时长
 * @param {number} [opts.jitter=3] 微移动幅度（px）
 * @param {number} [opts.moves] 微移动次数，默认按时长推算
 * @param {() => number} [opts.rng] 随机源
 * @returns {{duration:number, deltas:{dx:number,dy:number}[]}}
 */
function hoverDwell(opts = {}) {
  const rng = pickRng(opts);
  const min = opts.min != null ? opts.min : 200;
  const max = opts.max != null ? opts.max : 800;
  const jitter = opts.jitter != null ? opts.jitter : 3;
  const duration = Math.round(min + rng() * (max - min));
  const moves = opts.moves != null ? Math.max(1, Math.floor(opts.moves))
    : Math.max(1, Math.round(duration / 250));
  const deltas = [];
  for (let i = 0; i < moves; i++) {
    deltas.push({
      dx: Math.round((rng() - 0.5) * 2 * jitter),
      dy: Math.round((rng() - 0.5) * 2 * jitter),
    });
  }
  return { duration, deltas };
}

module.exports = {
  bezierPath,
  typingSchedule,
  scrollSchedule,
  clickDelay,
  thinkPause,
  hoverDwell,
};
