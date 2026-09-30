/**
 * 应用级设置（全局，跨窗口统一）
 * 主题等 UI 偏好不应每个窗口独立——否则会出现"第一个窗口暗、新窗口亮"的不一致。
 * 存 userData/app-settings.json。
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

let cache = null;
let file = null;

function getFile() {
  if (!file) file = path.join(app.getPath('userData'), 'app-settings.json');
  return file;
}

function read() {
  if (cache) return cache;
  try {
    const f = getFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
      cache = obj && typeof obj === 'object' ? obj : {};
    } else {
      cache = {};
    }
  } catch (_) { cache = {}; }
  return cache;
}

function write(obj) {
  cache = obj || {};
  try {
    fs.writeFileSync(getFile(), JSON.stringify(cache, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.error('[Settings] 写入失败:', e.message);
    return false;
  }
}

/** 读主题（默认 light） */
function getTheme() {
  const s = read();
  return s.theme === 'dark' ? 'dark' : 'light';
}

/** 写主题 */
function setTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  const s = Object.assign({}, read(), { theme: t });
  write(s);
  return t;
}

/** 读回执发送延迟（全局，默认 4000-6000ms） */
function getSendDelay() {
  const DEF = { min: 4000, max: 6000 };
  const s = read();
  let min = Number(s.sendDelayMin);
  let max = Number(s.sendDelayMax);
  if (!isFinite(min) || min < 0) min = DEF.min;
  if (!isFinite(max) || max < min) max = DEF.max;
  if (max > 10000) max = 10000;
  if (max < min) max = min;
  return { min: min, max: max };
}

/** 写回执发送延迟（全局） */
function setSendDelay(min, max) {
  const DEF = { min: 4000, max: 6000 };
  let nMin = parseInt(min, 10);
  let nMax = parseInt(max, 10);
  if (!isFinite(nMin) || nMin < 0) nMin = DEF.min;
  if (!isFinite(nMax) || nMax < nMin) nMax = DEF.max;
  if (nMax > 10000) nMax = 10000;
  if (nMax < nMin) nMax = nMin;
  const s = Object.assign({}, read(), { sendDelayMin: nMin, sendDelayMax: nMax });
  write(s);
  return { min: nMin, max: nMax };
}

module.exports = { getTheme, setTheme, getSendDelay, setSendDelay, read, write };
