/**
 * 账号池（本地加密存储）
 *
 * 集中管理各平台账号密码（本地加密），供窗口绑定与自动登录复用。
 * 安全要点：密码用 Electron safeStorage.encryptString() 加密后以 base64 存，
 * 绝不存明文；若系统加密不可用，降级为「不保存密码」，绝不静默存明文。
 *
 * 存储结构（userData/account-pool.json）：
 *   {
 *     "accounts": [
 *       { id, providerId, label, username, passwordEnc, group, status, lastUsed, note }
 *     ]
 *   }
 * 其中 passwordEnc 为 safeStorage 加密后的 base64；对外接口一律不返回密码。
 */
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// ========== 路径 ==========

function getStoreFile() {
  return path.join(app.getPath('userData'), 'account-pool.json');
}

// ========== 损坏容错 ==========

/** 把损坏文件改名备份，避免静默覆盖造成"数据丢失"错觉（参考 knowledge.js） */
function backupCorruptFile(file, reason) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(file, file + '.corrupt-' + stamp);
    console.error('[AccountPool] 文件损坏已备份(' + reason + '):', file);
  } catch (e) {
    console.error('[AccountPool] 备份损坏文件失败:', e.message);
  }
}

function readStore() {
  const f = getStoreFile();
  if (!fs.existsSync(f)) return { accounts: [] };
  try {
    const obj = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (obj && Array.isArray(obj.accounts)) return obj;
    backupCorruptFile(f, '结构非法');
  } catch (err) {
    console.error('[AccountPool] 读取账号池失败:', err.message);
    backupCorruptFile(f, 'JSON 解析失败');
  }
  return { accounts: [] };
}

function writeStore(obj) {
  try {
    fs.writeFileSync(getStoreFile(), JSON.stringify(obj, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[AccountPool] 写入账号池失败:', err.message);
    return false;
  }
}

// ========== 密码加密 ==========

function isEncryptionAvailable() {
  try {
    return !!(safeStorage
      && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable());
  } catch (_) {
    return false;
  }
}

/**
 * 加密密码。
 * @returns {{ enc: string, warning: string|null }}
 *   enc 为 base64 加密串（空串表示未保存）；warning 非空表示降级/失败提示。
 */
function encryptPassword(plain) {
  if (!plain) return { enc: '', warning: null };
  if (isEncryptionAvailable()) {
    try {
      const buf = safeStorage.encryptString(String(plain));
      return { enc: Buffer.from(buf).toString('base64'), warning: null };
    } catch (e) {
      console.error('[AccountPool] 加密密码失败:', e.message);
      return { enc: '', warning: '密码加密失败，出于安全未保存密码：' + e.message };
    }
  }
  // 系统加密不可用：降级为不保存密码（绝不静默存明文）
  return { enc: '', warning: '系统加密不可用，出于安全未保存密码（绝不存明文）' };
}

/** 解密密码；未保存返回 ''；解密失败/不可用返回 null */
function decryptPassword(enc) {
  if (!enc) return '';
  if (!isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch (e) {
    console.error('[AccountPool] 解密密码失败:', e.message);
    return null;
  }
}

// ========== 视图转换 ==========

/** 去掉密码字段，仅暴露 hasPassword 布尔 */
function toPublic(acc) {
  return {
    id: acc.id,
    providerId: acc.providerId,
    label: acc.label,
    username: acc.username,
    group: acc.group,
    status: acc.status,
    lastUsed: acc.lastUsed,
    note: acc.note,
    hasPassword: Boolean(acc.passwordEnc && acc.passwordEnc.length),
  };
}

function genId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return 'acc-' + Date.now() + '-' + rand;
}

// ========== 增删改查 ==========

/** 列出账号（可按 providerId 过滤），不含密码，含 hasPassword */
function listAccounts(providerId) {
  const all = readStore().accounts;
  const filtered = providerId ? all.filter(a => a.providerId === providerId) : all;
  return filtered.map(toPublic);
}

/** 获取单个账号（不含密码）；不存在返回 null */
function getAccount(id) {
  const acc = readStore().accounts.find(a => a.id === id);
  return acc ? toPublic(acc) : null;
}

/** 获取含明文密码的账号（仅主进程内部用，如自动登录）；不存在返回 null */
function getAccountWithPassword(id) {
  const acc = readStore().accounts.find(a => a.id === id);
  if (!acc) return null;
  const pub = toPublic(acc);
  pub.password = decryptPassword(acc.passwordEnc);
  return pub;
}

/**
 * 创建账号
 * @param {object} data { providerId, label, username, password, group, note }
 * @returns {{ success: boolean, id?: string, warning?: string|null, error?: string }}
 */
function createAccount(data) {
  const d = data || {};
  if (!d.providerId) return { success: false, error: '缺少 providerId' };
  if (!d.username) return { success: false, error: '缺少 username' };

  const { enc, warning } = encryptPassword(d.password);
  const store = readStore();
  const acc = {
    id: genId(),
    providerId: String(d.providerId),
    label: d.label || '',
    username: String(d.username),
    passwordEnc: enc,
    group: d.group || '',
    status: d.status || 'active',
    lastUsed: null,
    note: d.note || '',
  };
  store.accounts.push(acc);
  if (!writeStore(store)) return { success: false, error: '写入账号池失败' };
  const res = { success: true, id: acc.id };
  if (warning) res.warning = warning;
  return res;
}

/**
 * 更新账号（patch.password 若传则重新加密）
 * @returns {{ success: boolean, warning?: string|null, error?: string }}
 */
function updateAccount(id, patch) {
  const p = patch || {};
  const store = readStore();
  const acc = store.accounts.find(a => a.id === id);
  if (!acc) return { success: false, error: '账号不存在: ' + id };

  let warning = null;
  if (typeof p.label === 'string') acc.label = p.label;
  if (typeof p.username === 'string') acc.username = p.username;
  if (typeof p.group === 'string') acc.group = p.group;
  if (typeof p.note === 'string') acc.note = p.note;
  if (typeof p.status === 'string') acc.status = p.status;
  if (typeof p.providerId === 'string') acc.providerId = p.providerId;
  if (typeof p.password === 'string') {
    const r = encryptPassword(p.password);
    acc.passwordEnc = r.enc;
    warning = r.warning;
  }

  if (!writeStore(store)) return { success: false, error: '写入账号池失败' };
  const res = { success: true };
  if (warning) res.warning = warning;
  return res;
}

/** 删除账号 */
function deleteAccount(id) {
  const store = readStore();
  const idx = store.accounts.findIndex(a => a.id === id);
  if (idx === -1) return { success: false, error: '账号不存在: ' + id };
  store.accounts.splice(idx, 1);
  if (!writeStore(store)) return { success: false, error: '写入账号池失败' };
  return { success: true };
}

/** 更新 lastUsed 为当前时间 */
function markUsed(id) {
  const store = readStore();
  const acc = store.accounts.find(a => a.id === id);
  if (!acc) return { success: false, error: '账号不存在: ' + id };
  acc.lastUsed = new Date().toISOString();
  if (!writeStore(store)) return { success: false, error: '写入账号池失败' };
  return { success: true, lastUsed: acc.lastUsed };
}

module.exports = {
  listAccounts,
  getAccount,
  getAccountWithPassword,
  createAccount,
  updateAccount,
  deleteAccount,
  markUsed,
  // 供测试/诊断
  isEncryptionAvailable,
};
