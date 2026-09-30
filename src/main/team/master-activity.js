/**
 * 主大脑活动追踪（Master Activity）
 *
 * 记录"最近向主大脑注入了消息"的时刻，供收件队列与调度器**互斥**：
 *  - 队列注入一批回报后，短时间内不应再注入下一批；
 *  - 调度器注入"去派活"提示后，短时间内队列也不应插入。
 *
 * 根因：主大脑在「完成确认」模式下，isMasterIdle 判定为"空闲"（这是
 * 为了修复"只能调动一次"必须的），但这会让队列/调度器误以为可以立即再注入，
 * 导致同一时刻多条消息挤入，冲乱主大脑节奏。
 *
 * 纯内存 Map，进程重启清零。
 */
const lastInject = new Map(); // profileId -> 时间戳（ms）

/** 记录一次注入 */
function noteInject(profileId) {
  if (!profileId || typeof profileId !== 'string') return;
  lastInject.set(profileId, Date.now());
}

/** 距上次注入的毫秒数（从未注入返回 Infinity） */
function msSinceInject(profileId) {
  if (!profileId) return Infinity;
  const t = lastInject.get(profileId);
  return t ? (Date.now() - t) : Infinity;
}

/**
 * 是否"刚刚注入过"（默认 15 秒内）
 * 用于让队列与调度器互斥，给主大脑留出处理时间。
 */
function isRecentlyInjected(profileId, withinMs) {
  return msSinceInject(profileId) < (withinMs || 15000);
}

function _reset() { lastInject.clear(); }

module.exports = { noteInject, msSinceInject, isRecentlyInjected, _reset };
