const { Tool, ToolResult } = require('./ToolRegistry');
const { getCheckpointStore } = require('../src/main/checkpoint');

/**
 * 文件检查点 / 回滚工具。
 *
 * 每次 edit/write/delete 前，对应工具会把文件旧内容快照到磁盘
 * （见 tools/EditTool.js 等对 getCheckpointStore().save 的调用）。
 * 本工具提供两个能力：
 *   - checkpoint_list()      列出最近检查点（id/文件/时间/操作类型）
 *   - checkpoint_restore(id) 回滚到指定检查点，把快照内容写回原文件
 *
 * 与 ipc.js 的 checkpoint-list / checkpoint-restore 共用同一个
 * getCheckpointStore() 单例，保证 AI 与 UI 看到的是同一份快照。
 */

/** 格式化时间戳为可读字符串（本地时区）。 */
function formatTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch (e) {
    return String(ts);
  }
}

class CheckpointListTool extends Tool {
  constructor() {
    super(
      'checkpoint_list',
      '列出最近的文件检查点（edit/write/delete 前自动保存的旧内容快照），可用于查看可回滚点。',
      {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '返回条数上限，默认 20',
          },
        },
        additionalProperties: false,
      },
      'checkpoint_list(limit?)'
    );
  }

  getPromptSection() {
    return {
      name: 'tool:checkpoint',
      order: 112,
      text: [
        '文件检查点 / 回滚：每次 edit/write/delete 前，系统会自动把文件旧内容存为检查点，支持回滚。',
        '',
        '- checkpoint_list(limit?) — 列出最近检查点（id/文件/时间/操作类型）。',
        '- checkpoint_restore(id) — 回滚到该检查点：把快照内容写回原文件。回滚前会再存一份当前内容，可再反悔。',
        '',
        '典型用法：改错了想撤销 → checkpoint_list 找到那次修改前的检查点 → checkpoint_restore(id)。',
        '注意：delete 操作产生的检查点没有内容（deleted=true），无法用 restore 恢复文件内容。',
      ].join('\n'),
    };
  }

  async execute(params) {
    try {
      const store = getCheckpointStore();
      const n = Number.isInteger(params && params.limit) ? params.limit : 20;
      const records = store.list().slice(0, n);
      const checkpoints = records.map((r) => ({
        id: r.id,
        filePath: r.filePath,
        operation: r.operation,
        deleted: !!r.deleted,
        size: r.size || 0,
        createdAt: formatTime(r.createdAt),
      }));
      if (checkpoints.length === 0) {
        return ToolResult.success('当前没有检查点（尚未发生可回滚的文件修改）。');
      }
      const lines = checkpoints.map(
        (c, i) =>
          (i + 1) + '. ' + c.id +
          ' | ' + c.operation + (c.deleted ? '(删除)' : '') +
          ' | ' + c.filePath +
          ' | ' + c.createdAt
      );
      return ToolResult.success(
        '最近 ' + checkpoints.length + ' 个检查点：\n' + lines.join('\n') +
        '\n\n用 checkpoint_restore(id) 回滚到某个检查点。'
      );
    } catch (e) {
      return ToolResult.error('列出检查点失败: ' + (e && e.message ? e.message : String(e)));
    }
  }
}

class CheckpointRestoreTool extends Tool {
  constructor() {
    super(
      'checkpoint_restore',
      '回滚到指定文件检查点：把快照内容写回原文件。回滚前会自动把当前内容再存一份，可再次反悔。',
      {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '要回滚到的检查点 id（来自 checkpoint_list）',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      'checkpoint_restore(id)'
    );
  }

  async execute(params) {
    try {
      const id = params && params.id;
      if (typeof id !== 'string' || id.trim().length === 0) {
        return ToolResult.error('缺少检查点 id');
      }
      const store = getCheckpointStore();
      const res = store.restore(id.trim());
      if (!res || !res.success) {
        return ToolResult.error('回滚失败: ' + ((res && res.error) || '未知错误'));
      }
      return ToolResult.success('已回滚到检查点 ' + id + '，文件: ' + res.filePath);
    } catch (e) {
      return ToolResult.error('回滚失败: ' + (e && e.message ? e.message : String(e)));
    }
  }
}

module.exports = { CheckpointListTool, CheckpointRestoreTool };
