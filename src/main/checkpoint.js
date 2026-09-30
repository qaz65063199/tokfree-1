'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 文件检查点/回滚。
 *
 * 每次 edit/write/delete 前把文件旧内容快照存到磁盘，支持按时间回滚。
 * 存储：<baseDir>/checkpoints/，每个快照一个 JSON 文件。
 *
 * 设计要点：
 * - 快照按单调递增序号 + 时间戳命名，便于排序。
 * - 有数量与总大小上限，超出时删除最旧的快照，避免无限增长。
 * - 只保存文件内容，不保存元数据目录树；delete 的快照 deleted=true。
 */

const DEFAULT_MAX_SNAPSHOTS = 500;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024; // 50MB 总量上限

class CheckpointStore {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir 项目/用户数据根目录（快照存到其下 checkpoints/）
   * @param {number} [opts.maxSnapshots]
   * @param {number} [opts.maxBytes]
   */
  constructor(opts) {
    const options = opts || {};
    this.baseDir = options.baseDir || process.cwd();
    this.dir = path.join(this.baseDir, 'checkpoints');
    this.maxSnapshots = options.maxSnapshots || DEFAULT_MAX_SNAPSHOTS;
    this.maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
    this._seq = 0;
    this._ensureDir();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(this.dir)) {
        fs.mkdirSync(this.dir, { recursive: true });
      }
    } catch (e) {
      // 目录不可用时静默降级：后续 save 会返回 success:false
    }
  }

  _nextId() {
    this._seq += 1;
    const ts = Date.now();
    return String(ts).padStart(14, '0') + '-' + String(this._seq).padStart(6, '0');
  }

  /**
   * 保存一个快照。
   * @param {object} info
   * @param {string} info.filePath 被操作文件的绝对路径
   * @param {string|null} info.content 文件旧内容（删除时为 null）
   * @param {string} [info.operation] 'edit'|'write'|'delete'
   * @param {boolean} [info.deleted] 是否因删除而快照
   * @param {string} [info.note]
   * @returns {{success:boolean, id?:string, error?:string}}
   */
  save(info) {
    try {
      this._ensureDir();
      const id = this._nextId();
      const record = {
        id,
        filePath: info && info.filePath ? String(info.filePath) : '',
        content: info && info.content !== undefined ? info.content : null,
        operation: (info && info.operation) || 'edit',
        deleted: !!(info && info.deleted),
        note: (info && info.note) || '',
        createdAt: Date.now(),
        size: info && typeof info.content === 'string' ? Buffer.byteLength(info.content, 'utf8') : 0,
      };
      const file = path.join(this.dir, id + '.json');
      fs.writeFileSync(file, JSON.stringify(record), 'utf8');
      this._enforceLimits();
      return { success: true, id };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** 列出所有快照（按时间倒序，最新在前）。 */
  list() {
    try {
      if (!fs.existsSync(this.dir)) return [];
      const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
      const records = [];
      for (const f of files) {
        try {
          const raw = fs.readFileSync(path.join(this.dir, f), 'utf8');
          const rec = JSON.parse(raw);
          records.push(rec);
        } catch (e) {
          // 跳过损坏的快照
        }
      }
      records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return records;
    } catch (e) {
      return [];
    }
  }

  /** 读取某快照详情（含内容）。 */
  get(id) {
    try {
      const file = path.join(this.dir, id + '.json');
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      return null;
    }
  }

  /**
   * 回滚到某个快照：把快照内容写回 filePath。
   * @param {string} id 快照 id
   * @param {object} [opts]
   * @param {boolean} [opts.skipBackup=true] 回滚前是否把当前文件再存一份快照（默认存，便于反悔）
   * @returns {{success:boolean, filePath?:string, error?:string}}
   */
  restore(id, opts) {
    const options = opts || {};
    const rec = this.get(id);
    if (!rec) return { success: false, error: 'checkpoint not found: ' + id };
    const target = rec.filePath;
    if (!target) return { success: false, error: 'checkpoint has no filePath' };
    try {
      // 回滚前把当前内容再快照一次，允许"反悔"
      if (options.skipBackup !== false && fs.existsSync(target)) {
        try {
          const cur = fs.readFileSync(target, 'utf8');
          this.save({ filePath: target, content: cur, operation: 'restore-backup', note: 'restore-before-' + id });
        } catch (e) { /* ignore */ }
      }
      if (rec.deleted || rec.content === null) {
        // 快照是被删除前的（内容为 null）——无法恢复内容，只能提示
        return { success: false, error: 'checkpoint has no content (file was deleted or unreadable)' };
      }
      const dir = path.dirname(target);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, rec.content, 'utf8');
      return { success: true, filePath: target };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** 删除某快照。 */
  remove(id) {
    try {
      const file = path.join(this.dir, id + '.json');
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return { success: true };
    } catch (e) {
      return { success: false, error: e && e.message ? e.message : String(e) };
    }
  }

  /** 执行上限清理：数量超限或总大小超限时删最旧的。 */
  _enforceLimits() {
    try {
      const records = this.list(); // 已按时间倒序
      if (records.length <= this.maxSnapshots) {
        const total = records.reduce((s, r) => s + (r.size || 0), 0);
        if (total <= this.maxBytes) return;
      }
      // 保留最新的若干，删除其余
      const keep = [];
      let bytes = 0;
      for (const r of records) {
        const sz = r.size || 0;
        if (keep.length < this.maxSnapshots && bytes + sz <= this.maxBytes) {
          keep.push(r);
          bytes += sz;
        } else {
          // 超出限额，删除
          try {
            fs.unlinkSync(path.join(this.dir, r.id + '.json'));
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  }
}

// ---- 单例工厂 ----
// 供工具层（EditTool/WriteTool/FileDeleteTool）与 ipc.js 统一获取同一个 CheckpointStore 实例。
// baseDir 解析优先级：显式传入 > Electron userData > 进程 cwd（非 Electron 环境）。
let _defaultStore = null;

function _resolveBaseDir(explicit) {
  if (explicit) return explicit;
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      return electron.app.getPath('userData');
    }
  } catch (e) { /* 非 Electron 环境，回退 */ }
  return process.cwd();
}

/**
 * 获取（惰性创建）默认 CheckpointStore 单例。
 * @param {string} [baseDir] 可选，覆盖默认 baseDir；首次创建后再次传入不会重建。
 * @returns {CheckpointStore}
 */
function getCheckpointStore(baseDir) {
  if (!_defaultStore) {
    _defaultStore = new CheckpointStore({ baseDir: _resolveBaseDir(baseDir) });
  }
  return _defaultStore;
}

module.exports = { CheckpointStore, getCheckpointStore };
