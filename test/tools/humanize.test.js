'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  bezierPath,
  typingSchedule,
  scrollSchedule,
  clickDelay,
  thinkPause,
  hoverDwell,
} = require('../../tools/humanize');

// 简单确定性随机源（LCG），用于可复现测试
function makeRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------- bezierPath ----------

test('bezierPath 返回点数合理', () => {
  const pts = bezierPath({ x: 0, y: 0 }, { x: 100, y: 0 }, { rng: makeRng() });
  assert.ok(Array.isArray(pts));
  assert.ok(pts.length > 2, '应有多于 2 个点');
  assert.ok(pts.length < 200, '点数不应爆炸');
});

test('bezierPath 首尾点接近 p0 / p1', () => {
  const p0 = { x: 10, y: 20 };
  const p1 = { x: 200, y: 130 };
  const pts = bezierPath(p0, p1, { rng: makeRng() });
  assert.deepStrictEqual(pts[0], { x: p0.x, y: p0.y });
  const last = pts[pts.length - 1];
  assert.ok(Math.abs(last.x - p1.x) < 1e-9);
  assert.ok(Math.abs(last.y - p1.y) < 1e-9);
});

test('bezierPath 过冲生效：轨迹中存在超过终点的点', () => {
  // 水平向右，终点 100，过冲应使某些点 x > 100
  const pts = bezierPath({ x: 0, y: 0 }, { x: 100, y: 0 }, {
    overshoot: 0.2,
    jitter: 0,
    steps: 20,
    rng: makeRng(),
  });
  const maxX = Math.max(...pts.map((p) => p.x));
  assert.ok(maxX > 100, `应有过冲点，最大 x=${maxX}`);
});

test('bezierPath overshoot=0 时无明显过冲', () => {
  const pts = bezierPath({ x: 0, y: 0 }, { x: 100, y: 0 }, {
    overshoot: 0,
    jitter: 0,
    steps: 20,
    rng: makeRng(),
  });
  const maxX = Math.max(...pts.map((p) => p.x));
  assert.ok(maxX <= 100 + 1e-6, `overshoot=0 时不应超过终点，maxX=${maxX}`);
});

test('bezierPath 默认 steps 随距离变化', () => {
  const near = bezierPath({ x: 0, y: 0 }, { x: 16, y: 0 }, { rng: makeRng() });
  const far = bezierPath({ x: 0, y: 0 }, { x: 1600, y: 0 }, { rng: makeRng() });
  assert.ok(far.length > near.length, '更远的距离应产生更多点');
});

// ---------- typingSchedule ----------

test('typingSchedule 长度至少为字符数', () => {
  const s = typingSchedule('hello', { backspaceRate: 0, rng: makeRng() });
  assert.strictEqual(s.length, 5);
  assert.strictEqual(s.map((e) => e.char).join(''), 'hello');
});

test('typingSchedule delay 落在范围内', () => {
  const s = typingSchedule('abcdefghij', {
    minDelay: 40,
    maxDelay: 220,
    backspaceRate: 0,
    rng: makeRng(),
  });
  for (const e of s) {
    assert.ok(e.delay >= 40 && e.delay <= 220, `delay 越界: ${e.delay}`);
  }
});

test('typingSchedule backspaceRate=1 时每字符都打错并退格', () => {
  const s = typingSchedule('abc', {
    backspaceRate: 1,
    minDelay: 10,
    maxDelay: 20,
    rng: makeRng(),
  });
  // 每个字符：wrong + backspace + correct = 3 步
  assert.strictEqual(s.length, 9);
  const backspaces = s.filter((e) => e.backspace);
  assert.strictEqual(backspaces.length, 3);
});

test('typingSchedule backspace 概率在多次采样中生效', () => {
  // 100 个字符，rate=0.3，应出现若干退格事件
  const text = 'a'.repeat(100);
  const s = typingSchedule(text, { backspaceRate: 0.3, rng: makeRng(999) });
  const backspaces = s.filter((e) => e.backspace).length;
  assert.ok(backspaces > 0, '应至少出现一次退格');
  assert.ok(backspaces < 100, '退格数应小于字符数');
  // 长度 = 字符数 + 2 * 退格数（每退格伴随一个错误字符）
  assert.strictEqual(s.length, 100 + 2 * backspaces);
});

test('typingSchedule backspace 事件的 char 为空', () => {
  const s = typingSchedule('xxxx', { backspaceRate: 1, rng: makeRng() });
  for (const e of s) {
    if (e.backspace) assert.strictEqual(e.char, '');
    else assert.ok(typeof e.char === 'string' && e.char.length === 1);
  }
});

// ---------- scrollSchedule ----------

test('scrollSchedule 步数正确', () => {
  const s = scrollSchedule(600, { steps: 6, rng: makeRng() });
  assert.strictEqual(s.length, 6);
  for (const e of s) {
    assert.ok(typeof e.deltaY === 'number');
    assert.ok(e.pause >= 30 && e.pause <= 120, `pause 越界: ${e.pause}`);
  }
});

test('scrollSchedule deltaY 总和 ≈ 入参', () => {
  const total = 777;
  const s = scrollSchedule(total, { steps: 8, rng: makeRng() });
  const sum = s.reduce((a, e) => a + e.deltaY, 0);
  assert.ok(Math.abs(sum - total) < 1e-6, `总和 ${sum} 应≈ ${total}`);
});

test('scrollSchedule 支持负方向与自定义停顿范围', () => {
  const s = scrollSchedule(-300, { steps: 4, minPause: 10, maxPause: 50, rng: makeRng() });
  const sum = s.reduce((a, e) => a + e.deltaY, 0);
  assert.ok(Math.abs(sum - (-300)) < 1e-6);
  for (const e of s) {
    assert.ok(e.pause >= 10 && e.pause <= 50);
    assert.ok(e.deltaY <= 0, '负方向每步应 <= 0');
  }
});

// ---------- clickDelay ----------

test('clickDelay 返回范围 [80, 300]', () => {
  for (let i = 0; i < 200; i++) {
    const d = clickDelay();
    assert.ok(Number.isInteger(d), '应为整数毫秒');
    assert.ok(d >= 80 && d <= 300, `clickDelay 越界: ${d}`);
  }
});

test('clickDelay 支持自定义范围且落在范围内', () => {
  for (let i = 0; i < 100; i++) {
    const d = clickDelay({ min: 100, max: 120, rng: makeRng(i + 1) });
    assert.ok(d >= 100 && d <= 120, `自定义范围越界: ${d}`);
  }
});

// ---------- thinkPause ----------

test('thinkPause 落在 [300, 2500]（无长停顿）', () => {
  for (let i = 0; i < 200; i++) {
    const d = thinkPause({ longRate: 0, rng: makeRng(i + 1) });
    assert.ok(Number.isInteger(d), '应为整数毫秒');
    assert.ok(d >= 300 && d <= 2500, `thinkPause 越界: ${d}`);
  }
});

test('thinkPause 支持自定义范围', () => {
  for (let i = 0; i < 100; i++) {
    const d = thinkPause({ min: 100, max: 200, longRate: 0, rng: makeRng(i + 1) });
    assert.ok(d >= 100 && d <= 200, `自定义范围越界: ${d}`);
  }
});

test('thinkPause longRate=1 时落在 (max, longMax]', () => {
  for (let i = 0; i < 100; i++) {
    const d = thinkPause({ min: 300, max: 2500, longRate: 1, longMax: 6000, rng: makeRng(i + 1) });
    assert.ok(d >= 2500 && d <= 6000, `长停顿越界: ${d}`);
  }
});

// ---------- hoverDwell ----------

test('hoverDwell 返回时长在 [200, 800] 与微移动数组', () => {
  for (let i = 0; i < 100; i++) {
    const r = hoverDwell({ rng: makeRng(i + 1) });
    assert.ok(r.duration >= 200 && r.duration <= 800, `duration 越界: ${r.duration}`);
    assert.ok(Array.isArray(r.deltas));
    assert.ok(r.deltas.length >= 1);
    for (const d of r.deltas) {
      assert.ok(typeof d.dx === 'number' && typeof d.dy === 'number');
    }
  }
});

test('hoverDwell 支持自定义范围与微移动次数', () => {
  const r = hoverDwell({ min: 100, max: 150, jitter: 5, moves: 3, rng: makeRng() });
  assert.ok(r.duration >= 100 && r.duration <= 150);
  assert.strictEqual(r.deltas.length, 3);
  for (const d of r.deltas) {
    assert.ok(Math.abs(d.dx) <= 5 && Math.abs(d.dy) <= 5, '微移动应在 jitter 范围内');
  }
});

// ---------- scrollSchedule 惯性 / 过头回滚 ----------

test('scrollSchedule 惯性：中段步长 > 首尾步长（钟形分布）', () => {
  const s = scrollSchedule(1000, { steps: 12, rng: makeRng(7) });
  const mid = Math.abs(s[Math.floor(12 / 2)].deltaY);
  const first = Math.abs(s[0].deltaY);
  const last = Math.abs(s[11].deltaY);
  assert.ok(mid > first, `中段 ${mid} 应大于首步 ${first}`);
  assert.ok(mid > last, `中段 ${mid} 应大于末步 ${last}`);
});

test('scrollSchedule 过头回滚后总和仍 ≈ 入参', () => {
  const s = scrollSchedule(800, { steps: 10, overshootRollback: true, rng: makeRng(3) });
  const sum = s.reduce((a, e) => a + e.deltaY, 0);
  assert.ok(Math.abs(sum - 800) < 1e-6, `总和 ${sum} 应≈ 800`);
  // 回滚生效：存在相邻两步方向相反
  let hasReversal = false;
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i].deltaY > 0 && s[i + 1].deltaY < 0) { hasReversal = true; break; }
    if (s[i].deltaY < 0 && s[i + 1].deltaY > 0) { hasReversal = true; break; }
  }
  assert.ok(hasReversal, '应存在过头回拉的方向反转');
});

test('scrollSchedule overshootRollback=false 时总和精确且无强制反转', () => {
  const s = scrollSchedule(600, { steps: 6, overshootRollback: false, rng: makeRng(5) });
  const sum = s.reduce((a, e) => a + e.deltaY, 0);
  assert.ok(Math.abs(sum - 600) < 1e-6);
});

// ---------- typingSchedule 错字模型 ----------

test('typingSchedule 相邻键错字：错误字符多来自 QWERTY 邻键', () => {
  const s = typingSchedule('qqqqqqqqqqqqqqqqqqqq', {
    backspaceRate: 1, minDelay: 1, maxDelay: 2, rng: makeRng(11),
  });
  const wrongs = s.filter((e) => !e.backspace && e.char !== 'q');
  assert.ok(wrongs.length > 0);
  for (const w of wrongs) {
    assert.ok('wa'.includes(w.char), `q 的错字应来自邻键 wa，实际 ${w.char}`);
  }
});

test('typingSchedule 整词打错重打：wordErrorRate=1 时单词被全退格', () => {
  const s = typingSchedule('hello', {
    backspaceRate: 0, wordErrorRate: 1, minDelay: 1, maxDelay: 2, rng: makeRng(9),
  });
  // 5 个错字 + 5 个退格 + 5 个正确 = 15 步
  assert.strictEqual(s.length, 15);
  assert.strictEqual(s.filter((e) => e.backspace).length, 5);
  // 末尾 5 步应是正确的 hello
  const tail = s.slice(10).map((e) => e.char).join('');
  assert.strictEqual(tail, 'hello');
});

test('typingSchedule 句末长停顿：delay 出现 > maxDelay 的值', () => {
  // 用句号触发长停顿（50% 概率），多跑几次确保命中
  let hit = false;
  for (let i = 0; i < 20 && !hit; i++) {
    const s = typingSchedule('hi.', {
      backspaceRate: 0, minDelay: 40, maxDelay: 220,
      longPauseMin: 500, longPauseMax: 1500, rng: makeRng(100 + i),
    });
    if (s.some((e) => e.delay > 220)) hit = true;
  }
  assert.ok(hit, '句末应偶发长停顿（delay 超过 maxDelay）');
});

