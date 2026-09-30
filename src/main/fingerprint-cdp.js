/**
 * CDP 指纹注入（方案 A）
 *
 * 用 webContents.debugger 的 Page.addScriptToEvaluateOnNewDocument，
 * 在每次新文档创建、任何页面脚本执行之前注入指纹伪装。
 * 比 preload 注入更早、更难被反检测系统通过"注入时机/安装来源"识别。
 *
 * preload 注入保留作为兜底（CDP attach 失败时仍能生效）；
 * 指纹函数内有幂等保护，双重注入不会重复应用。
 *
 * 注意：attach debugger 后，该窗口无法再打开 DevTools（Chromium 限制）。
 * 仅当用户为该窗口启用指纹时才 attach，属于可接受的取舍。
 */
const { buildFingerprintScript } = require('../preload/fingerprint');

const CDP_VERSION = '1.3';
const applied = new WeakSet();

/**
 * 对指定 webContents 应用 CDP 指纹注入
 * @param {Electron.WebContents} wc
 * @param {object} fpConfig profile.fingerprint
 * @returns {Promise<{success:boolean, alreadyApplied?:boolean, error?:string}>}
 */
async function applyFingerprintCdp(wc, fpConfig) {
  if (!wc || wc.isDestroyed()) return { success: false, error: 'webContents 不可用' };
  if (!fpConfig || !fpConfig.enabled) return { success: false, error: '指纹未启用' };
  if (applied.has(wc)) return { success: true, alreadyApplied: true };
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach(CDP_VERSION);
    }

    // ===== 借鉴 patchright：修复 CDP 自动化泄漏 =====
    // 站点探测 CDP 的经典手段：调用 Runtime.enable 后，V8 inspector 会改变
    // console 对象的实现（debug/inspect 挂上原生钩子），导致 console.debug 的
    // 行为/时序与未附加调试器时不同，可被 console 时序探测抓出。
    // patchright 的解法是"绝不主动调用 Runtime.enable"，只用
    // Page.addScriptToEvaluateOnNewDocument 做注入（该命令不依赖 Runtime）。
    //
    // 保险起见：这里显式调用一次 Runtime.disable，
    // 万一 Electron 内部/其它模块 attach 时打开了 Runtime，也把它关掉。
    try {
      await wc.debugger.sendCommand('Runtime.disable');
    } catch (_) {
      // Runtime domain 不可用时忽略（本身就没开启，正是我们要的状态）
    }

    // 仅用 Page domain 注入，不触碰 Runtime。
    // Page.addScriptToEvaluateOnNewDocument 在每次新文档创建、页面脚本执行前注入，
    // 且不产生 addBinding 那类可被检测的全局副作用。
    const source = buildFingerprintScript(fpConfig);
    await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source });

    // navigator.webdriver 兜底：即使指纹函数未启用，也保证 CDP 附加后 webdriver 读数不为 true。
    // （Electron 默认 navigator.webdriver=false；此注入是防御性双重保险。）
    try {
      await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
        source: 'try{Object.defineProperty(navigator,"webdriver",{get:function(){return false;},configurable:true});}catch(e){};',
      });
    } catch (_) {}

    applied.add(wc);
    console.log('[TokFree FP] CDP 注入成功 (seed=' + (fpConfig.seed || '?') + ', Runtime 已禁用防泄漏)');
    return { success: true };
  } catch (err) {
    console.error('[TokFree FP] CDP 注入失败，回退 preload 注入:', err && err.message);
    return { success: false, error: err && err.message };
  }
}

module.exports = { applyFingerprintCdp };
