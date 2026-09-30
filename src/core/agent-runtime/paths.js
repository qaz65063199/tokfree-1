'use strict';
/**
 * Agent Runtime —— 基础目录（baseDir）注入
 *
 * 目的：让 src/main/team 下的模块不再直接 require('electron').app 取 userData 路径，
 * 改为通过本模块注入获取，便于在非 Electron 环境（测试/独立运行）复用。
 *
 * 行为不变：默认目录仍是 app.getPath('userData')；主进程启动时显式 setBaseDir 一次。
 */
let baseDir = null;

/** 主进程启动时调用：注入基础目录（app.getPath('userData')） */
function setBaseDir(dir) {
  if (typeof dir === 'string' && dir) baseDir = dir;
}

/** 取基础目录：优先注入值；否则回退 electron app.getPath('userData')；再否则 os.tmpdir() */
function getBaseDir() {
  if (baseDir) return baseDir;
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (_) {}
  try {
    return require('os').tmpdir();
  } catch (_) {
    return process.cwd();
  }
}

module.exports = { setBaseDir, getBaseDir };
