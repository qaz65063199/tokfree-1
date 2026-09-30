/**
 * 窗口大小/位置记录（按 profileId 持久化到 userData/window-bounds.json）
 * 关闭窗口时记录 getBounds() + isMaximized()，下次打开时恢复。
 * 全 try/catch，任何异常都不影响窗口创建/关闭。
 */
'use strict';
const fs = require('fs');
const path = require('path');

let _file = null;
function getFile() {
  if (_file) return _file;
  try {
    const { app } = require('electron');
    _file = path.join(app.getPath('userData'), 'window-bounds.json');
  } catch (_) {
    _file = null;
  }
  return _file;
}

function loadAll() {
  try {
    const f = getFile();
    if (!f) return {};
    const raw = fs.readFileSync(f, 'utf-8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_) { return {}; }
}

/**
 * 读取指定 key 的窗口记录。
 * @returns {{x?:number,y?:number,width?:number,height?:number,maximized?:boolean}|null}
 */
function load(key) {
  try {
    if (!key) return null;
    const b = loadAll()[key];
    return (b && typeof b === 'object') ? b : null;
  } catch (_) { return null; }
}

/** 写入指定 key 的窗口记录。 */
function save(key, bounds) {
  try {
    if (!key || !bounds) return;
    const f = getFile();
    if (!f) return;
    const all = loadAll();
    all[key] = {
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      maximized: !!bounds.maximized,
    };
    fs.writeFileSync(f, JSON.stringify(all, null, 2), 'utf-8');
  } catch (_) {}
}

/** 从 BrowserWindow 抓取当前 bounds + maximized（供 close 时调用）。 */
function capture(win) {
  try {
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: !!win.isMaximized() };
  } catch (_) { return null; }
}

/**
 * 把记录应用到窗口（存在有效 width/height 时 setBounds）。
 * @returns {boolean|null} true=记录里是最大化，false=记录里非最大化，null=无有效记录
 */
function apply(win, key) {
  try {
    const b = load(key);
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number') return null;
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    return !!b.maximized;
  } catch (_) { return null; }
}

module.exports = { load, save, capture, apply };
