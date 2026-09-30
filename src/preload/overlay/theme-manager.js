/**
 * TokFree — 主题管理器（自包含模块）
 *
 * 职责：
 *   - 维护可用主题清单（listThemes）
 *   - 读取当前主题（getTheme）
 *   - 切换主题：设置 <html data-brand> 并持久化到 localStorage（setTheme）
 *
 * 设计为自包含：在浏览器（preload）中依赖 document / localStorage；
 * 在无 DOM 环境（如 Node 单测）中安全降级，不抛错。
 */

'use strict';

// 可用主题清单（id 对应 themes.css 中的 [data-brand="id"]）
const THEMES = [
  { id: 'violet', name: '紫罗兰' },
  { id: 'ocean', name: '深海蓝' },
  { id: 'forest', name: '森绿' },
  { id: 'sunset', name: '暖橙' },
];

// 默认主题
const DEFAULT_THEME = 'violet';

// localStorage 持久化键名
const STORAGE_KEY = 'tokfree-brand-theme';

/**
 * 列出全部主题。
 * @returns {Array<{id: string, name: string}>} 主题数组（副本，避免外部篡改）
 */
function listThemes() {
  return THEMES.map((t) => ({ id: t.id, name: t.name }));
}

/**
 * 判断主题 id 是否合法。
 * @param {string} name 主题 id
 * @returns {boolean}
 */
function isValidTheme(name) {
  return THEMES.some((t) => t.id === name);
}

/**
 * 读取当前主题。
 * 优先取 localStorage 中已持久化的值，其次读 <html data-brand>，
 * 都无效时回退默认主题。
 * @returns {string} 当前主题 id
 */
function getTheme() {
  // 1. 优先从 localStorage 读取
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (isValidTheme(saved)) return saved;
    }
  } catch (e) {
    /* 忽略：localStorage 不可用 */
  }
  // 2. 其次读 document 上的属性
  try {
    if (typeof document !== 'undefined' && document && document.documentElement) {
      const attr = document.documentElement.getAttribute('data-brand');
      if (isValidTheme(attr)) return attr;
    }
  } catch (e) {
    /* 忽略：document 不可用 */
  }
  // 3. 回退默认主题
  return DEFAULT_THEME;
}

/**
 * 切换主题：设置 <html data-theme> 并持久化到 localStorage。
 * 传入无效主题时安全忽略（不改变现状、不抛错）。
 * @param {string} name 主题 id
 * @returns {boolean} 是否成功应用（无效主题返回 false）
 */
function setTheme(name) {
  // 无效主题：忽略，不崩溃
  if (!isValidTheme(name)) return false;

  // 设置 DOM 属性，触发 themes.css 的变量覆盖
  try {
    if (typeof document !== 'undefined' && document && document.documentElement) {
      document.documentElement.setAttribute('data-brand', name);
    }
  } catch (e) {
    /* 忽略：document 不可用 */
  }

  // 持久化，下次启动可恢复
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem(STORAGE_KEY, name);
    }
  } catch (e) {
    /* 忽略：localStorage 不可用 */
  }

  return true;
}

module.exports = {
  getTheme,
  setTheme,
  listThemes,
  // 额外导出，便于调用方/测试使用
  DEFAULT_THEME,
  STORAGE_KEY,
};
