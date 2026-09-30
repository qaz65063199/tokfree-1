const { Tool, ToolResult } = require('./ToolRegistry');
const wd = require('../src/main/watchdog');
const ws = require('../src/main/window');

/** 内部：获取当前"主窗口"profileId（单窗口场景的默认目标） */
function currentProfileId() {
  const ctx = ws.getMainContext ? ws.getMainContext() : null;
  return ctx ? ctx.profileId : null;
}

class WatchdogHeartbeatTool extends Tool {
  constructor() {
    super('watchdog_heartbeat', '刷新看门狗心跳（单聊模式下 AI 有活动时调用；多 Agent 模式请改用 team_get_workers_status 轮询 Worker）',
      { type: 'object', properties: {} }, 'watchdog_heartbeat()');
  }
  getPromptSection() {
    return {
      name: 'tool:watchdog',
      order: 114,
      text: [
        '看门狗（Watchdog）是 AI 的生命监护：长时间无心跳会判定 AI 停顿并自动唤醒。',
        '',
        '**适用范围**：仅在【单聊模式】下，AI 长时间执行任务（尤其多步长任务）时使用——',
        '定期调用 watchdog_heartbeat() 刷新心跳；预计长时间无输出时先 watchdog_busy(说明) 标记长任务，忙完再 watchdog_clear_busy()。',
        '',
        '**多 Agent 模式（总经理）/ 看门狗不可用时的降级方案（重要）**：',
        '- 在多 Agent 模式下，主大脑**不要依赖看门狗**判断 Worker 是否干活。',
        '- 改为**轮询** team_get_workers_status() 周期性查看各 Worker 状态，据此判断进度与是否卡住。',
        '- 若某环境下看门狗工具不可用，同样降级为轮询 team_get_workers_status()，**不要因此跳过监控**。',
      ].join('\n'),
    };
  }
  async execute() {
    try {
      const pid = currentProfileId();
      if (!pid) return ToolResult.error('未找到活动窗口');
      wd.arm(pid);
      return ToolResult.success({ profileId: pid });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

class WatchdogBusyTool extends Tool {
  constructor() {
    super('watchdog_busy', '标记长任务（期间看门狗不唤醒，并自动续心跳），避免长任务被误判为停顿',
      { type: 'object', properties: { note: { type: 'string', description: '任务说明（可选）' }, secs: { type: 'number', description: '有效期秒数（可选）' } } },
      'watchdog_busy(note, secs)');
  }
  async execute(p) {
    try {
      const pid = currentProfileId();
      if (!pid) return ToolResult.error('未找到活动窗口');
      wd.setBusy(pid, p && p.note, p && p.secs);
      return ToolResult.success({ profileId: pid, note: (p && p.note) || '' });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

class WatchdogClearBusyTool extends Tool {
  constructor() {
    super('watchdog_clear_busy', '清除长任务标记（任务完成后调用，恢复正常停顿检测）',
      { type: 'object', properties: {} }, 'watchdog_clear_busy()');
  }
  async execute() {
    try {
      const pid = currentProfileId();
      if (!pid) return ToolResult.error('未找到活动窗口');
      wd.clearBusy(pid);
      return ToolResult.success({ profileId: pid });
    } catch (e) { return ToolResult.error(e.message); }
  }
}

class WatchdogStatusTool extends Tool {
  constructor() {
    super('watchdog_status', '查看看门狗状态（心跳年龄、是否 busy、是否冷却、配置等）',
      { type: 'object', properties: {} }, 'watchdog_status()');
  }
  async execute() {
    try {
      const pid = currentProfileId();
      return ToolResult.success(wd.getStatus(pid));
    } catch (e) { return ToolResult.error(e.message); }
  }
}

module.exports = {
  WatchdogHeartbeatTool,
  WatchdogBusyTool,
  WatchdogClearBusyTool,
  WatchdogStatusTool,
};
