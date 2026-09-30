/**
 * Token 用量追踪（Token Usage Tracker）
 *
 * 记录每个 profile（窗口/子 Agent）最近一次上报的服务端 token 累计用量，
 * 供主大脑（team 工具运行在主进程）感知子 Agent 的 token 消耗，
 * 为「按 token 判断是否续对话/重开」提供客观依据。
 *
 * 设计要点：
 * - 内存 Map：profileId -> { accumulatedTokens, updatedAt }
 * - 持久化：userData/token-usage.json（经 paths.getBaseDir() 定位）
 * - 纯记录模块，失败静默（绝不影响主流程）。
 * - 与 worker-activity.js 同风格：简洁、无副作用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { getBaseDir } = require('../core/agent-runtime/paths');

// profileId -> { accumulatedTokens, updatedAt }
const usage = new Map();

let loaded = false;

/** token-usage.json 路径 */
function getStorePath() {
  try {
    return path.join(getBaseDir(), 'token-usage.json');
  } catch (_) {
    return null;
  }
}

/** 从磁盘载入（仅一次，失败静默） */
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const p = getStorePath();
    if (!p) return;
    if (!fs.existsSync(p)) return;
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [pid, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && typeof v.accumulatedTokens === 'number') {
          usage.set(pid, {
            accumulatedTokens: v.accumulatedTokens,
            updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
          });
        }
      }
    }
  } catch (_) {
    /* 读取/解析失败静默忽略 */
  }
}

/** 落盘（失败静默） */
function persist() {
  try {
    const p = getStorePath();
    if (!p) return;
    const obj = {};
    for (const [pid, v] of usage.entries()) {
      obj[pid] = { accumulatedTokens: v.accumulatedTokens, updatedAt: v.updatedAt };
    }
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
  } catch (_) {
    /* 写入失败静默忽略 */
  }
}

/**
 * 把 token 增量上报到指标层（metrics-store）。全 try/catch，失败静默。
 * 用增量（本次累计 - 上次累计）避免重复累加；会话重置（累计变小）时按本次值计。
 * @param {string} profileId
 * @param {number} delta
 */
function recordMetricsDelta(profileId, delta) {
  if (!(typeof delta === 'number' && isFinite(delta) && delta > 0)) return;
  try {
    const metricsStore = require('./metrics-store');
    metricsStore.record(profileId, { tokensIn: delta });
  } catch (_) {
    /* 指标上报失败静默，绝不影响主流程 */
  }
}

/**
 * 记录某个 profile 的 token 累计用量。
 * @param {string} profileId
 * @param {number} count
 */
function setTokenCount(profileId, count) {
  if (!profileId || typeof profileId !== 'string') return;
  if (typeof count !== 'number' || !isFinite(count) || count < 0) return;
  ensureLoaded();
  const prev = getTokenCount(profileId);
  usage.set(profileId, { accumulatedTokens: count, updatedAt: Date.now() });
  persist();
  // 指标上报：用增量，避免重复累加（会话重置时 count < prev，按本次值计）
  recordMetricsDelta(profileId, count >= prev ? (count - prev) : count);
}

/**
 * 取某个 profile 的 token 累计用量。
 * @param {string} profileId
 * @returns {number} 未知返回 0
 */
function getTokenCount(profileId) {
  if (!profileId || typeof profileId !== 'string') return 0;
  ensureLoaded();
  const v = usage.get(profileId);
  return v && typeof v.accumulatedTokens === 'number' ? v.accumulatedTokens : 0;
}

/** 清除某个 profile 的记录（失败静默）。 */
function clearTokenCount(profileId) {
  if (!profileId || typeof profileId !== 'string') return;
  ensureLoaded();
  usage.delete(profileId);
  persist();
}

/** 清空所有记录（测试用）。 */
function _reset() {
  usage.clear();
  loaded = false;
}

module.exports = { setTokenCount, getTokenCount, clearTokenCount, _reset };
