/**
 * 工具确认回环（Plan/Act + 危险操作确认）
 *
 * 当策略判定为 confirm 时，主进程通过本模块向对应窗口的 renderer 发送
 * 'tool-confirm-request'，等待 renderer 回 'tool-confirm-response'。
 * 超时（60s）视为拒绝。
 */
const windowState = require('./window');

// 确认超时：60 秒，超时视为拒绝
const CONFIRM_TIMEOUT = 60 * 1000;

// requestId -> { resolve, timer }
const pendingMap = new Map();
let seq = 0;

/**
 * 向指定窗口请求用户确认
 * @param {string} profileId 目标窗口 profile
 * @param {string} toolName 工具名
 * @param {object} params 工具参数
 * @param {string} reason 需要确认的原因
 * @returns {Promise<boolean>} 用户是否同意
 */
function confirmViaRenderer(profileId, toolName, params, reason) {
  return new Promise((resolve) => {
    const ctx = windowState.getWindowByProfileId(profileId);
    if (!ctx || !ctx.win || ctx.win.isDestroyed()) {
      // 找不到窗口：保守拒绝
      resolve(false);
      return;
    }

    const requestId = 'confirm-' + (++seq) + '-' + Date.now();
    const timer = setTimeout(() => {
      pendingMap.delete(requestId);
      resolve(false);
    }, CONFIRM_TIMEOUT);

    pendingMap.set(requestId, { resolve, timer });

    try {
      ctx.win.webContents.send('tool-confirm-request', {
        requestId,
        tool: toolName,
        params: params || {},
        reason: reason || '',
      });
    } catch (err) {
      clearTimeout(timer);
      pendingMap.delete(requestId);
      resolve(false);
    }
  });
}

/**
 * renderer 回传用户选择（供 ipc 调用）
 * @param {string} requestId
 * @param {boolean} ok 是否同意
 * @returns {boolean} 是否命中待处理请求
 */
function respondConfirm(requestId, ok) {
  const entry = pendingMap.get(requestId);
  if (!entry) return false;
  pendingMap.delete(requestId);
  clearTimeout(entry.timer);
  entry.resolve(!!ok);
  return true;
}

module.exports = { confirmViaRenderer, respondConfirm, CONFIRM_TIMEOUT };
