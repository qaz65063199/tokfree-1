/**
 * Worker 活动追踪（Worker Activity Tracker）
 *
 * 记录每个 profile（窗口/Worker）最后一次工具活动的时间戳，供主大脑判断
 * Worker 是否真卡住提供客观依据（配合 team_get_workers_status 的
 * lastActivityAgo / suspectedStuck 字段）。
 *
 * 设计要点：
 * - 纯内存 Map，不落盘；进程重启即清零。
 * - 不改变任何现有工具行为，仅在工具执行成功后记录时间。
 * - key 为 profileId；无 profileId（如单聊未绑定）时不记录。
 */

// profileId -> 最后活动时间戳（ms）
const lastActivity = new Map();

/**
 * 记录一次活动（工具成功执行后调用）。
 * @param {string|null|undefined} profileId
 */
function touch(profileId) {
  if (!profileId || typeof profileId !== 'string') return;
  lastActivity.set(profileId, Date.now());
}

/**
 * 获取最后活动时间戳。
 * @param {string} profileId
 * @returns {number|null} 时间戳（ms），从未活动返回 null
 */
function getLastActivity(profileId) {
  if (!profileId || typeof profileId !== 'string') return null;
  return lastActivity.has(profileId) ? lastActivity.get(profileId) : null;
}

/**
 * 获取距最后一次活动的秒数。
 * @param {string} profileId
 * @returns {number|null} 秒数（取整），从未活动返回 null
 */
function getAgoSeconds(profileId) {
  const ts = getLastActivity(profileId);
  if (ts === null) return null;
  return Math.floor((Date.now() - ts) / 1000);
}

/** 清空所有记录（测试用）。 */
function _reset() {
  lastActivity.clear();
}

module.exports = { touch, getLastActivity, getAgoSeconds, _reset };
