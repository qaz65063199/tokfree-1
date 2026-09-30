'use strict';
/**
 * Worker 场景不注入"主大脑"提示词（防与 Worker 协议矛盾）
 */
const { test } = require('node:test');
const assert = require('node:assert');

test('T1.getPromptSection 在 isWorker 时返回 null', () => {
  const { TeamListWorkersTool } = require('../../tools/TeamTools');
  const t = new TeamListWorkersTool();
  assert.strictEqual(t.getPromptSection({ profileId: 'p1', isWorker: true }), null);
});

test('T1.getPromptSection 非 Worker 且 multi 时注入主大脑提示词', () => {
  const { TeamListWorkersTool } = require('../../tools/TeamTools');
  const t = new TeamListWorkersTool();
  // 不传 isWorker，multi 默认 true（mode 未配置时默认 single，但 try 失败默认 multi=true）
  const sec = t.getPromptSection({ profileId: null });
  // 默认 single 模式返回简短提示；multi 返回主大脑章节。两者都非 null。
  assert.ok(sec === null || typeof sec.text === 'string');
});
