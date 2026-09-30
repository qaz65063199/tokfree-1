'use strict';
/**
 * TokFree 统一日志抽象
 *
 * 目的：把分散的 console.* 收敛为统一的 logger，支持：
 *  - 级别过滤（环境变量 TOKFREE_LOG_LEVEL，默认 'info'）
 *  - 可选 taskId 关联（logger.with({ taskId })/logger.child({ taskId }) 返回带前缀子 logger）
 *  - 向后兼容：默认行为等价于 console（同级别同格式），无外部依赖
 *
 * 用法：
 *   const { logger } = require('../core/logger');
 *   logger.info('hello');
 *   const wlog = logger.with({ taskId: 'task-123' });
 *   wlog.warn('child'); // 输出前缀 [task:task-123]
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** 把级别名解析为数值；无法识别时回退 info */
function resolveLevel(name) {
  const key = String(name || 'info').toLowerCase();
  return LEVELS[key] != null ? LEVELS[key] : LEVELS.info;
}

/** 读取当前阈值（每次调用现读 env，便于运行期调整） */
function currentThreshold() {
  return resolveLevel(process.env.TOKFREE_LOG_LEVEL);
}

/**
 * 构造一个 logger（可带前缀）。
 * @param {string} prefix 形如 '[task:xxx]'，空串表示无前缀
 */
function makeLogger(prefix) {
  const log = {};

  function emit(level, method, args) {
    if (LEVELS[level] < currentThreshold()) return;
    if (prefix) {
      console[method](prefix, ...args);
    } else {
      console[method](...args);
    }
  }

  log.debug = function () { emit('debug', 'debug', arguments); };
  log.info = function () { emit('info', 'info', arguments); };
  log.warn = function () { emit('warn', 'warn', arguments); };
  log.error = function () { emit('error', 'error', arguments); };

  /** 派生带 taskId 前缀的子 logger */
  function derive(ctx) {
    let p = prefix;
    if (ctx && ctx.taskId != null && ctx.taskId !== '') {
      const tag = '[task:' + ctx.taskId + ']';
      p = p ? p + ' ' + tag : tag;
    }
    return makeLogger(p);
  }
  log.with = derive;
  log.child = derive;

  return log;
}

const logger = makeLogger('');

module.exports = { logger, LEVELS, resolveLevel };
