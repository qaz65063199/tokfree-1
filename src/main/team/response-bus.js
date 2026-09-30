/**
 * AI Worker 回复事件总线
 * 仅负责把指定窗口的 AI 完成回复转发给主进程协作系统。
 * 当前阶段只建立基础通道，不改变现有业务逻辑。
 */
const EventEmitter = require('events');

const bus = new EventEmitter();

// 防止异常监听器拖垮主流程
bus.setMaxListeners(100);

function emitWorkerResponse(payload) {
  if (!payload || typeof payload !== 'object') return false;

  const data = {
    profileId: payload.profileId || '',
    providerId: payload.providerId || '',
    taskId: payload.taskId || '',
    text: typeof payload.text === 'string' ? payload.text : '',
    finished: payload.finished !== false,
    timestamp: payload.timestamp || new Date().toISOString(),
  };

  bus.emit('worker-response', data);
  return true;
}

function onWorkerResponse(listener) {
  if (typeof listener !== 'function') return () => {};
  bus.on('worker-response', listener);
  return () => bus.off('worker-response', listener);
}

module.exports = {
  emitWorkerResponse,
  onWorkerResponse,
  bus,
};
