/**
 * 会话-目录映射持久化存储 + URL 会话检测（每 profile 独立实例）
 * 由原 session-store.js 改造：从单例改为工厂函数，每个 profile 拥有独立存储文件和状态。
 */
const fs = require('fs');
const path = require('path');
const { getProviderByUrl } = require('../providers');

/**
 * 创建 profile 专属的 session store 实例
 * @param {string} profileId profile id
 * @param {string} storeDir 存储目录（通常是 userData）
 * @param {object} windowState window 管理模块引用
 */
function createSessionStore(profileId, storeDir, windowState) {
  const STORE_FILE = path.join(storeDir, 'session-dir-map-' + profileId + '.json');
  // 会话别名（重命名）独立存放，不侵入「会话→目录」映射文件的既有格式。
  // 全局共享（不含 profileId）：重命名需跨所有窗口同步，别名必须是一份全局数据。
  const ALIAS_FILE = path.join(storeDir, 'session-alias-global.json');
  // 旧版「每 profile 独立别名文件」，仅用于一次性迁移（迁移后不再写入）
  const LEGACY_ALIAS_FILE = path.join(storeDir, 'session-alias-' + profileId + '.json');
  // 会话最近活跃时间独立存放（用于会话列表按时间倒序），不侵入既有映射格式
  const ACTIVITY_FILE = path.join(storeDir, 'session-activity-' + profileId + '.json');
  // 全量会话目录（从网页端抓取），存 { id, title, updatedAt, pinned }
  const CATALOG_FILE = path.join(storeDir, 'session-catalog-' + profileId + '.json');

  function readSessionStore() {
    try {
      if (fs.existsSync(STORE_FILE)) {
        return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('[TokFree] 读取会话存储失败:', err.message);
    }
    return {};
  }

  function writeSessionStore(store) {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
      console.log('[TokFree] 会话存储已保存:', STORE_FILE);
    } catch (err) {
      console.error('[TokFree] 写入会话存储失败:', err.message);
    }
  }

  function getProjectDirBySessionId(sessionId) {
    if (!sessionId) return null;
    const store = readSessionStore();
    return store[sessionId] || null;
  }

  function saveSessionDirMapping(sessionId, projectDir) {
    if (!sessionId) return;
    const store = readSessionStore();
    store[sessionId] = projectDir;
    writeSessionStore(store);
  }

  // ========== 会话别名（重命名） ==========

  function readAliases() {
    try {
      if (fs.existsSync(ALIAS_FILE)) {
        const data = JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf-8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
      }
      // 向后兼容：全局别名文件不存在时，尝试从旧版「每 profile 别名文件」迁移一次
      if (fs.existsSync(LEGACY_ALIAS_FILE)) {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_ALIAS_FILE, 'utf-8'));
        if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
          writeAliases(legacy);
          return legacy;
        }
      }
    } catch (err) {
      console.error('[TokFree] 读取会话别名失败:', err.message);
    }
    return {};
  }

  function writeAliases(map) {
    try {
      fs.writeFileSync(ALIAS_FILE, JSON.stringify(map, null, 2), 'utf-8');
    } catch (err) {
      console.error('[TokFree] 写入会话别名失败:', err.message);
    }
  }

  /** 保存/清除会话别名（空别名 = 清除，恢复显示会话 ID） */
  function saveAlias(sessionId, alias) {
    if (!sessionId) return;
    const map = readAliases();
    const a = String(alias || '').trim();
    if (a) map[sessionId] = a.slice(0, 60);
    else delete map[sessionId];
    writeAliases(map);
  }

  function getAliases() {
    return readAliases();
  }

  // ========== 会话最近活跃时间（用于列表按时间倒序） ==========

  function readActivity() {
    try {
      if (fs.existsSync(ACTIVITY_FILE)) {
        const data = JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf-8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
      }
    } catch (err) {
      console.error('[TokFree] 读取会话活跃时间失败:', err.message);
    }
    return {};
  }

  function writeActivity(map) {
    try {
      fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(map, null, 2), 'utf-8');
    } catch (err) {
      console.error('[TokFree] 写入会话活跃时间失败:', err.message);
    }
  }

  // 同一会话 60s 内不重复写盘，避免频繁切换会话时写爆磁盘
  let lastTouchSid = null;
  let lastTouchTs = 0;

  /** 记录某会话的最近活跃时间（容错；同一 sid 60s 内节流） */
  function touchSession(sessionId) {
    if (!sessionId) return;
    const now = Date.now();
    if (sessionId === lastTouchSid && (now - lastTouchTs) < 60000) return;
    try {
      const map = readActivity();
      map[sessionId] = now;
      writeActivity(map);
      lastTouchSid = sessionId;
      lastTouchTs = now;
    } catch (err) {
      console.error('[TokFree] 记录会话活跃时间失败:', err.message);
    }
  }

  /** 返回会话活跃时间副本 */
  function getActivity() {
    return readActivity();
  }

  /**
   * 搜索会话：按会话 ID / 别名 / 项目目录模糊匹配（不区分大小写）。
   * 注意：会话「消息内容」不在 session-store 中（由 webview/preload 侧采集），
   * 因此本方法只覆盖 ID / 别名 / 目录三类元数据。
   * @param {string} query 关键词（空则返回全部）
   * @returns {Array<{sessionId:string, alias:string, projectDir:string}>}
   */
  function searchSessions(query) {
    const q = String(query || '').trim().toLowerCase();
    const store = readSessionStore();
    const aliases = readAliases();
    const out = [];
    for (const sid of Object.keys(store)) {
      const alias = aliases[sid] || '';
      const dir = store[sid] || '';
      if (!q ||
          sid.toLowerCase().indexOf(q) !== -1 ||
          alias.toLowerCase().indexOf(q) !== -1 ||
          String(dir).toLowerCase().indexOf(q) !== -1) {
        out.push({ sessionId: sid, alias, projectDir: dir });
      }
    }
    return out;
  }

  function extractSessionIdFromUrl(url) {
    if (!url) return null;
    // 平台 provider 优先（智谱 cid=、Claude /chat/ 等）
    try {
      const provider = getProviderByUrl(url);
      if (provider && typeof provider.extractSessionId === 'function') {
        const sid = provider.extractSessionId(url);
        if (sid) return sid;
      }
    } catch (_) { /* provider 异常时回退旧逻辑 */ }
    // Claude: https://claude.ai/chat/xxx
    if (url.includes('claude.ai')) {
      const m = url.match(/\/chat\/([a-zA-Z0-9_-]+)/i);
      return m ? m[1] : null;
    }
    // ChatGPT: https://chatgpt.com/c/{uuid}
    // 注意：创建会话过程中 URL 会有中间态 /c/WEB:xxx，不能把 WEB 当会话 ID
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      const uuidMatch = url.match(/\/c\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (uuidMatch) return uuidMatch[1];
      const genericMatch = url.match(/\/c\/([a-zA-Z0-9_-]+)/i);
      if (genericMatch && genericMatch[1] !== 'WEB') return genericMatch[1];
      return null;
    }
    // DeepSeek: https://chat.deepseek.com/a/chat/s/xxx
    const match = url.match(/\/chat\/s\/([a-f0-9-]+)/i);
    if (match) return match[1];
    const altMatch = url.match(/\/s\/([a-f0-9-]+)/i);
    return altMatch ? altMatch[1] : null;
  }

  // ========== 全量会话目录（网页端抓取） ==========

  /** 保存全量会话目录（全量覆盖，容错） */
  function saveCatalog(list) {
    try {
      const arr = Array.isArray(list) ? list : [];
      fs.writeFileSync(CATALOG_FILE, JSON.stringify(arr, null, 2), 'utf-8');
      console.log('[TokFree] 会话目录已保存:', CATALOG_FILE, '(' + arr.length + ' 条)');
    } catch (err) {
      console.error('[TokFree] 写入会话目录失败:', err.message);
    }
  }

  /** 读取全量会话目录（容错返回 []） */
  function getCatalog() {
    try {
      if (fs.existsSync(CATALOG_FILE)) {
        const data = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf-8'));
        if (Array.isArray(data)) return data;
      }
    } catch (err) {
      console.error('[TokFree] 读取会话目录失败:', err.message);
    }
    return [];
  }

  const state = {
    currentSessionId: null,
    selectedProjectDir: null,
    pendingProjectDir: null,
  };

  function handleUrlChange(url, targetWindow) {
    const sessionId = extractSessionIdFromUrl(url);
    const win = targetWindow || (windowState && windowState.getMainWindow());

    if (sessionId) {
      state.currentSessionId = sessionId;
      console.log('[TokFree][' + profileId + '] 当前会话ID: ' + sessionId);

      if (state.pendingProjectDir) {
        saveSessionDirMapping(sessionId, state.pendingProjectDir);
        state.selectedProjectDir = state.pendingProjectDir;
        state.pendingProjectDir = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-dir-updated', state.selectedProjectDir);
          win.webContents.send('session-restored', { sessionId, projectDir: state.selectedProjectDir });
        }
        console.log('[TokFree][' + profileId + '] 暂存目录已绑定');
        return;
      }

      const restoredDir = getProjectDirBySessionId(sessionId);
      if (restoredDir) {
        state.selectedProjectDir = restoredDir;
        if (win && !win.isDestroyed()) {
          win.webContents.send('session-restored', { sessionId, projectDir: restoredDir });
          win.webContents.send('project-dir-updated', restoredDir);
        }
      } else {
        state.selectedProjectDir = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-dir-updated', null);
        }
      }
    } else {
      // 提取不到会话 ID（如 ChatGPT 首页 https://chatgpt.com/）：
      // 若有暂存目录（刚初始化但还没绑定会话），保留目录；否则清空（恢复原行为）。
      state.currentSessionId = null;
      if (!state.pendingProjectDir) {
        state.selectedProjectDir = null;
        if (win && !win.isDestroyed()) {
          win.webContents.send('project-dir-updated', null);
        }
      }
    }
  }

  function tryRestoreSessionFromUrl(targetWindow) {
    const win = targetWindow || (windowState && windowState.getMainWindow());
    if (!win || win.isDestroyed()) return;
    const url = win.webContents.getURL();
    handleUrlChange(url, win);
  }

  return {
    readSessionStore,
    writeSessionStore,
    getProjectDirBySessionId,
    saveSessionDirMapping,
    readAliases,
    saveAlias,
    getAliases,
    readActivity,
    touchSession,
    getActivity,
    searchSessions,
    saveCatalog,
    getCatalog,
    extractSessionIdFromUrl,
    handleUrlChange,
    tryRestoreSessionFromUrl,
    state,
  };
}

module.exports = { createSessionStore };
