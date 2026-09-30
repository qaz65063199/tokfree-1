/**
 * preload 全局共享状态
 */
module.exports = {
  initialPromptContent: '',
  pendingInitialPrompt: false,
  pendingToolCall: null,
  sendDelayMin: 4000,
  sendDelayMax: 6000,
  currentProjectDir: null,
  currentWorkerTaskId: null,
  // 本地 OpenAI 兼容 API：当前正在等待回复的 API 请求 id（收到普通回复后据此回传主进程）
  currentApiRequestId: null,
  // 服务端返回的权威 token 统计（{ accumulatedTokens, insertedAt, updatedAt, modelType }）
  serverTokenUsage: null,
  // 最近一次 AI 回复的消息 id（{ requestMessageId, responseMessageId }），供上下文压缩定位摘要用
  lastResponseMsgIds: null,
  // 截断续写：最近续写时间戳（1 分钟窗口限次）
  continueTimestamps: [],
  // 用户排队消息：AI 忙时暂存，随下一个代码块回执/工具结果一起发出
  pendingUserMessages: [],
  // 是否正在执行 JS 代码块（判断 AI 忙的一个信号）
  executingJsBlocks: false,
  // Worker 任务：本任务是否已上报过 DONE（hook 正常路径或 DOM 兜底，去重防重复上报）
  workerDoneReported: false,
};
