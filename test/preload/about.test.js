'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// ---------- 轻量 DOM stub ----------
function mkEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    style: {},
    onclick: null,
    _attrs: {},
    children: [],
    classList: {
      _s: {},
      add(c) { this._s[c] = true; },
      remove(c) { delete this._s[c]; },
      toggle(c) { if (this._s[c]) delete this._s[c]; else this._s[c] = true; },
      contains(c) { return !!this._s[c]; },
    },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k] || null; },
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return mkEl('button'); },
    querySelectorAll() { return [mkEl('button'), mkEl('button'), mkEl('button')]; },
  };
  return el;
}

// document 用内存映射保存 id -> element，支持幂等 getElementById
const _store = {};
global.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement(tag) { return mkEl(tag); },
  getElementById(id) { return _store[id] || null; },
};

global.requestAnimationFrame = (fn) => fn();
global.setTimeout = (fn) => 0;
global.clearTimeout = () => {};
global.console = console;

const about = require('../../src/preload/overlay/about');

// ---------- 测试 ----------

test('模块可 require 且导出函数存在', () => {
  assert.strictEqual(typeof about, 'object');
  assert.strictEqual(typeof about.openAbout, 'function');
  assert.strictEqual(typeof about.closeAbout, 'function');
});

test('导出兜底版本号常量', () => {
  assert.strictEqual(about.FALLBACK_VERSION, '0.3.8');
  assert.strictEqual(typeof about.readVersion, 'function');
});

test('openAbout 不抛错（mock document）', () => {
  assert.doesNotThrow(() => about.openAbout());
});

test('closeAbout 不抛错', () => {
  assert.doesNotThrow(() => about.closeAbout());
});

test('injectStyle 不抛错且幂等', () => {
  assert.doesNotThrow(() => about.injectStyle());
  assert.doesNotThrow(() => about.injectStyle());
});

test('readVersion 无 electronAPI 时返回兜底值', () => {
  const v = about.readVersion();
  assert.strictEqual(v, '0.3.8');
});
