'use strict';
/**
 * Agent Runtime —— 窗口消息注入端口（inject port）
 *
 * 目的：把「向指定 profile 窗口注入消息」的调用收敛为注入的回调，
 * 让 src/main/team 下的模块不直接依赖 electron webContents。
 *
 * Electron 侧启动时调用 setInjector 注入实现（默认频道 master-inject-message）。
 * 未注入实现时（测试 / 未就绪）回退：若调用方传入了 ctx，则直接经 ctx 窗口发送。
 */
let injector = null;

/** 注入实现：fn(profileId, message) => any */
function setInjector(fn) {
  if (typeof fn === 'function') injector = fn;
}

/**
 * 向指定 profile 注入消息。
 * @param {string} profileId 目标窗口 profile
 * @param {string} message 消息正文
 * @param {object} [ctx] 可选：未注入实现时的回退上下文（含 win.webContents.send）
 */
function inject(profileId, message, ctx) {
  if (typeof injector === 'function') return injector(profileId, message);
  // 回退：直接经 ctx 窗口发送（频道/格式与 electron 侧一致）
  if (ctx && ctx.win && ctx.win.webContents && typeof ctx.win.webContents.send === 'function') {
    return ctx.win.webContents.send('master-inject-message', { message: message });
  }
  throw new Error('injector 未设置');
}

module.exports = { setInjector, inject };
