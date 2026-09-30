/**
 * Worker 回报「DOM 兜底上报」。
 *
 * 背景（bug）：DeepSeek 等平台的 completion SSE 流有时挂起不结束
 * （reader.read() 一直 pending），主世界 hook 的 dispatch 永不触发 →
 * Worker 已生成 DONE 汇报，却既不上报主大脑、也不刷新心跳（状态卡"运行中"）。
 *
 * 对策：不依赖 hook dispatch。当按钮回到「发送」态（本轮生成结束）时，
 * 直接扫描 DOM 里最后一条 AI 消息；若含 Worker 回报暗号且本任务尚未上报过 DONE，
 * 就兜底上报。带去重，避免与 hook 正常路径重复上报。
 */
const state = require('./state');
const { getProviderByUrl } = require('../../providers');

const DONE_S = '>>>MASTER_DONE_START<<<';
const DONE_E = '>>>MASTER_DONE_END<<<';
const ASK_S = '>>>MASTER_ASK_START<<<';
const ASK_E = '>>>MASTER_ASK_END<<<';
const SYNC_S = '>>>MASTER_SYNC_START<<<';
const SYNC_E = '>>>MASTER_SYNC_END<<<';

/** 取当前平台最后一条 AI 消息的纯文本（不含覆盖层元素） */
function getLastAiText() {
  try {
    const provider = getProviderByUrl(window.location.href);
    if (!provider || typeof provider.getMessageCandidates !== 'function') return '';
    const cands = provider.getMessageCandidates();
    if (!cands || !cands.length) return '';
    const last = cands[cands.length - 1];
    let t = '';
    try { t = last.innerText || last.textContent || ''; } catch (_) {}
    return String(t || '').trim();
  } catch (_) { return ''; }
}

function detectReport(text) {
  const has = (s, e) => text.indexOf(s) !== -1 && text.indexOf(e) !== -1;
  const done = has(DONE_S, DONE_E);
  return { any: done || has(ASK_S, ASK_E) || has(SYNC_S, SYNC_E), done };
}

/**
 * DOM 兜底上报（幂等：同一任务 DONE 只上报一次）。
 * @param {string} reason 触发原因（日志用）
 * @returns {Promise<boolean>} 是否发起了上报
 */
async function tryReportWorkerFromDom(reason) {
  if (!state.currentWorkerTaskId) return false;
  const text = getLastAiText();
  if (!text) return false;
  const m = detectReport(text);
  if (!m.any) return false;
  // DONE 已上报过（hook 正常路径或本兜底）→ 跳过，避免重复
  if (m.done && state.workerDoneReported) return false;
  console.log('[TokFree][兜底] DOM 扫描到 Worker 回报(' + reason + ')，上报 taskId=' + state.currentWorkerTaskId);
  try {
    if (window.electronAPI && window.electronAPI.reportAiResponse) {
      await window.electronAPI.reportAiResponse(text, state.currentWorkerTaskId);
    }
  } catch (e) {
    console.error('[TokFree][兜底] Worker 回报失败: ' + (e && e.message));
    return false;
  }
  if (m.done) {
    state.workerDoneReported = true;
    state.currentWorkerTaskId = null;
  }
  return true;
}

module.exports = { tryReportWorkerFromDom };
