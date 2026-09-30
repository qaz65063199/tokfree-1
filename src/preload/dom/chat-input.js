/**
 * 聊天输入框交互：查找输入框、填入与发送消息、工具结果回传
 * 由原 preload.js 拆分而来，逻辑保持不变。
 */
const { ipcRenderer } = require('electron');
const state = require('./state');
const { BT } = require('./js-detector');
const { getProviderByUrl } = require('../../../src/providers');

/**
 * 防抖合并发送：多条消息在窗口期内合并为一条发出（不再逐条串行）。
 */
let mergeBuffer = '';        // 待合并内容
let mergeTimer = null;       // 防抖计时器
let mergeAfterSent = null;   // 最后一个 afterSent 回调
let mergeTag = null;         // 最后一条消息的 tag
let mergeFlushing = false;   // 是否正在 flush（防重入）
let mergeDeadline = 0;       // 最大等待兜底：首次入缓冲时的截止时间戳
const SEP = String.fromCharCode(10, 10) + '---' + String.fromCharCode(10, 10);
let unsentBuffer = '';  // 追踪「已填入输入框但未确认发出」的内容，防覆盖
let mergeResolvers = [];  // 本次合并发送的 Promise resolver 队列（多条入队者共享同一次发送结果）

/**
 * 是否仍有"待发送/正在发送"的回传。
 * 保留函数以兼容调用方（observer.js 的「卡住了？点我」）：
 * 返回 true 表示仍有缓冲中/正在发的回传，调用方据此跳过催促，避免催促语抢在回传前。
 * @returns {boolean}
 */
function flushPendingSend() {
  return mergeBuffer !== '' || mergeTimer !== null || mergeFlushing;
}

/**
 * 根据当前 URL 获取 provider
 */
function getCurrentProvider() {
  return getProviderByUrl(window.location.href);
}

/**
 * 生成随机等待时间（ms），范围由 state 配置（默认 2-4 秒）
 */
function randomDelay() {
  const min = typeof state.sendDelayMin === 'number' ? state.sendDelayMin : 4000;
  const max = typeof state.sendDelayMax === 'number' ? state.sendDelayMax : 6000;
  if (min >= max) return min;
  return Math.floor(Math.random() * (max - min)) + min;
}
/**
 * 将文本填入输入框（React 兼容：使用原生 value setter）
 * @param {Element} input - 输入框元素
 * @param {string} msg - 要填入的文本
 * @returns {boolean} 是否成功填入
 */
async function setInputContent(input, msg) {
  // ⚠️ 焦点保护：填内容需要 focus 网页输入框，但这会抢走用户正在"补充说明"框
  // 打字的光标。这里先快照用户当前焦点 + 光标位置，填完后立即恢复，
  // 把"打断"压缩到毫秒级，用户几乎无感。
  const snap = snapshotFocus(input);
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      input.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(
        input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      ).set;
      nativeSetter.call(input, msg);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      restoreFocus(snap);
      return true;
    }
    if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      input.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);

      // 分段 Paste：每段 ≤6000 字符，不会触发 ChatGPT 的附件行为，且每段都很快。
      // 实测 12000 字符只需约 350ms。
      const CHUNK_SIZE = 6000;
      for (let i = 0; i < msg.length; i += CHUNK_SIZE) {
        const chunk = msg.slice(i, i + CHUNK_SIZE);
        const dt = new DataTransfer();
        dt.setData('text/plain', chunk);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        });
        input.dispatchEvent(pasteEvent);
        if (i + CHUNK_SIZE < msg.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      restoreFocus(snap);
      return true;
    }
    restoreFocus(snap);
    return false;
  } catch (err) {
    console.error('[TokFree] 设置输入框内容失败:', err.message);
    restoreFocus(snap);
    return false;
  }
}

/**
 * 读取输入框当前内容（兼容 TEXTAREA/INPUT 读 .value，contenteditable 读 innerText/textContent）。
 * 用于发送前检查是否有未发出的残留内容，避免新消息覆盖旧消息。
 * @param {Element} input
 * @returns {string} 当前文本（读不到返回空串）
 */
function getInputContent(input) {
  try {
    if (!input) return '';
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
    if (input.isContentEditable || input.getAttribute('contenteditable') === 'true') {
      return input.innerText || input.textContent || '';
    }
    return input.innerText || input.textContent || input.value || '';
  } catch (_) { return ''; }
}

/**
 * 快照当前焦点元素 + 光标位置（供 setInputContent 后恢复，避免抢用户光标）。
 * @param {Element} excludeEl 即将被 focus 的元素（无需快照它）
 * @returns {{el:Element|null, start:number|null, end:number|null}|null}
 */
function snapshotFocus(excludeEl) {
  try {
    const el = document.activeElement;
    if (!el || el === document.body || el === excludeEl) return null;
    // 只关心"可输入的框"（用户正在打字的补充说明框等）
    const tag = el.tagName;
    const editable = tag === 'TEXTAREA' || tag === 'INPUT' || el.isContentEditable || el.getAttribute('role') === 'textbox';
    if (!editable) return null;
    let start = null, end = null;
    try {
      if (typeof el.selectionStart === 'number') { start = el.selectionStart; end = el.selectionEnd; }
    } catch (_) {}
    return { el: el, start: start, end: end };
  } catch (_) { return null; }
}

/** 恢复焦点 + 光标位置（仅当用户原本在可输入框、且元素仍在页面上） */
function restoreFocus(snap) {
  if (!snap || !snap.el) return;
  try {
    if (!snap.el.isConnected) return;
    // 仅当焦点确实被抢走时才恢复（避免无谓 focus）
    if (document.activeElement === snap.el) return;
    snap.el.focus();
    if (snap.start !== null && typeof snap.el.setSelectionRange === 'function') {
      snap.el.setSelectionRange(snap.start, snap.end);
    }
  } catch (_) {}
}

/**
 * 将消息加入防抖合并缓冲：窗口期内多条消息合并为一条发出。
 * 保留原函数签名与语义（调用方不变）：入队后立即返回 true。
 * @param {string} msg - 要发送的消息
 * @param {string} [tag] - 日志标记
 * @param {number} [fixedDelay] - 已忽略（统一遵循设置里的 randomDelay()）
 * @param {Function} [afterSent] - 发送后回调
 * @returns {Promise<boolean>} 是否已确认发出（多条合并时共享同一次发送结果）
 */
async function sendToChat(msg, tag, fixedDelay, afterSent) {
  if (!msg) return false;
  // 追加到合并缓冲（多条合成一条）
  mergeBuffer = mergeBuffer ? (mergeBuffer + SEP + msg) : msg;
  if (tag) mergeTag = tag;
  if (typeof afterSent === 'function') mergeAfterSent = afterSent;
  // 最大等待兜底：首次入缓冲时记录截止时间，防止消息不停到来导致永不发送
  // 与发送延迟设置联动：至少 8 秒，或延迟上限的 2 倍 + 2 秒（设高延迟时合并窗口更宽）
  if (!mergeDeadline) {
    const maxWait = Math.max(8000, (state.sendDelayMax || 6000) * 2 + 2000);
    mergeDeadline = Date.now() + maxWait;
  }
  // 重置防抖计时器（每来一条就重置，等"安静"后才发）
  if (mergeTimer) clearTimeout(mergeTimer);
  const delay = Math.min(randomDelay(), Math.max(0, mergeDeadline - Date.now()));
  mergeTimer = setTimeout(() => { flushMerge(); }, delay);
  // 返回 Promise：真正发送后由 flushMerge 用真实结果 resolve。
  // 只 resolve 不 reject，避免调用方未 catch 时产生 unhandled rejection。
  return new Promise((resolve) => { mergeResolvers.push(resolve); });
}

/**
 * 真正发送：把缓冲里合并的内容一次性填入并发出（含残留兜底、发送确认重试）。
 */
async function flushMerge() {
  if (mergeTimer) { clearTimeout(mergeTimer); mergeTimer = null; }
  if (mergeFlushing) return;   // 正在 flush，交给外层 finally 重新调度
  if (mergeBuffer === '') return;
  mergeFlushing = true;
  let sentOk = false;
  try {
    let content = mergeBuffer;
    mergeBuffer = '';
    mergeDeadline = 0;
    // 合并"上一轮未发出"的残留（unsentBuffer 兜底）
    if (unsentBuffer) content = unsentBuffer + SEP + content;
    unsentBuffer = '';
    const cb = mergeAfterSent; mergeAfterSent = null;
    const tag = mergeTag; mergeTag = null;
    sentOk = await doSendContent(content, tag, cb);
  } catch (e) {
    console.error('[TokFree] flushMerge 异常:', e && e.message);
  } finally {
    mergeFlushing = false;
    // 用真实发送结果 resolve 本次合并的所有等待者（多条入队者共享同一结果）
    const resolvers = mergeResolvers;
    mergeResolvers = [];
    for (const resolve of resolvers) {
      try { resolve(!!sentOk); } catch (_) {}
    }
    // flush 期间若又有新消息进来，继续调度
    if (mergeBuffer !== '' && mergeTimer === null) {
      const d = randomDelay();
      mergeTimer = setTimeout(() => { flushMerge(); }, d);
    }
  }
}

/**
 * 发送合并后的内容（"确认已发出" + 失败兜底）。
 * @param {string} content 已合并好的完整内容
 * @param {string} [tag] 日志标记
 * @param {Function} [afterSent] 发送后回调
 */
async function doSendContent(content, tag, afterSent) {
  const msg = content;

  const input = findInputArea();
  if (!input) {
    console.log('[TokFree] 找不到输入框，无法发送消息（记入 buffer 待补发）');
    unsentBuffer = msg;
    return false;
  }
  // ⚠️ 安全隔离：回执发送绝不能碰覆盖层的"补充说明"框。
  // 若 findInputArea 意外返回了覆盖层元素（新平台结构差异等），直接拒绝，
  // 避免把回执写进补充说明框、或把用户正在打的内容误发。
  try {
    if (input.closest && input.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]')) {
      console.error('[TokFree] findInputArea 返回了覆盖层元素，拒绝发送（防误发，记入 buffer 待补发）');
      unsentBuffer = msg;
      return false;
    }
  } catch (_) {}
  // ⚠️ 二次保险：绝不允许把回执写进补充说明框
  try {
    if (input.id === 'tokfree-user-input') {
      console.error('[TokFree] 拒绝向补充说明框写入回执（防误发用户输入，记入 buffer 待补发）');
      unsentBuffer = msg;
      return false;
    }
  } catch (_) {}

  // 合并已在 flushMerge 完成，这里直接填入（不再读残留追加）
  if (!(await setInputContent(input, msg))) {
    console.error('[TokFree] 填入输入框失败，记入 buffer 待补发');
    unsentBuffer = msg;
    return false;
  }
  // 防抖合并已在 sendToChat 按发送延迟设置等待过，此处填框后立即发送，不再额外等待
  // ⚠️ 隔离保护：记住覆盖层补充说明框的当前内容与焦点，发送后恢复
  let _ovInput = null, _ovValue = '', _ovFocused = false;
  try {
    _ovInput = document.getElementById('tokfree-user-input');
    if (_ovInput) {
      _ovValue = _ovInput.value;
      _ovFocused = document.activeElement === _ovInput;
    }
  } catch (_) {}
  const restoreOverlayInput = () => {
    try {
      if (_ovInput && _ovInput.value !== _ovValue) {
        _ovInput.value = _ovValue; // 回执流程若误改，恢复用户正在打的内容
      }
    } catch (_) {}
  };

  console.log('[TokFree] 立即触发发送');
  // 发送需要网页输入框聚焦；先快照用户焦点（补充说明框），发完立即恢复，
  // 避免"回执发送"把用户正在打字的光标抢走。
  const sendSnap = snapshotFocus(input);
  try { input.focus(); } catch (_) {}
  triggerSend(input);
  restoreFocus(sendSnap);
  restoreOverlayInput();
  console.log('[TokFree] 已触发发送, ' + (tag || '') + ', 长度=' + msg.length);

  // ★★★ 关键：等待「确认已发出」，未发出则重试 triggerSend（防止消息卡在输入框）
  let cleared = await waitForInputCleared(input, 3000);
  let sendRetries = 0;
  const MAX_SEND_RETRIES = 3;
  while (!cleared && sendRetries < MAX_SEND_RETRIES) {
    sendRetries++;
    console.warn('[TokFree] 输入框未清空，重试发送 (' + sendRetries + '/' + MAX_SEND_RETRIES + '), tag=' + (tag || ''));
    try { input.focus(); } catch (_) {}
    triggerSend(input);
    cleared = await waitForInputCleared(input, 3000);
    if (!cleared) {
      // 后台/被遮挡的 webview：合成事件无效，用主进程原生 Enter 兜底（会先聚焦再注入）
      await escalateNativeEnter();
      cleared = await waitForInputCleared(input, 3000);
    }
  }
  let sentOk = false;
  if (!cleared) {
    // 未确认发出：把完整内容记入 buffer，下一轮会合并进去（绝不覆盖）
    unsentBuffer = msg;
    console.error('[TokFree] 消息发送失败（重试' + MAX_SEND_RETRIES + '次仍卡在输入框），已记入 buffer 防覆盖: tag=' + (tag || '') + ', 长度=' + msg.length);
  } else {
    // 额外加固：cleared 通过但 getInputContent 仍能读到内容（说明这次实际没发出），也记入 buffer
    let residual = '';
    try { residual = getInputContent(input); } catch (_) { residual = ''; }
    if (residual) {
      unsentBuffer = msg;
      console.warn('[TokFree] 发送后复核仍有残留(长度=' + residual.length + ')，已记入 buffer 防覆盖: tag=' + (tag || ''));
    } else {
      // 确认发出：清空 buffer
      unsentBuffer = '';
      sentOk = true;
    }
  }

  // 是否为"中途回传"（工具结果 / JS 汇总 / 看门狗催促 / 截断续写），
  // 用于看门狗 reset 判定与会话计数排除
  const isFeedback = typeof tag === 'string' && (tag.indexOf('工具=') === 0 || tag === 'JS汇总' || tag === 'XML工具调用提示' || tag === '看门狗唤醒' || tag === '截断续写' || tag === '子任务回报' || tag === '编排推进');
  // 看门狗：发出请求 → 进入监护（等待 AI 回复）
  // reset=true（用户主动发送）重置确认计数；reset=false（中途回传）保留计数，避免自我重置死循环
  try {
    if (window.electronAPI && window.electronAPI.watchdogArm) {
      window.electronAPI.watchdogArm(!isFeedback).catch(() => {});
    }
  } catch (_) {}
  // 会话计数：真正的对话发送（排除工具结果 / JS 汇总回传，避免计数膨胀）
  if (!isFeedback) {
    // 用户主动发送新消息：重置截断续写窗口
    state.continueTimestamps = [];
    try {
      if (window.electronAPI && window.electronAPI.recordConversation) {
        window.electronAPI.recordConversation('sent').catch(() => {});
      }
    } catch (_) {}
  }
  if (typeof afterSent === 'function') afterSent();
  return sentOk;
}

/**
 * 立即发送单条消息（绕过防抖合并缓冲）。
 * 供本地 OpenAI 兼容 API 场景使用：收到 api-prompt 后必须尽快发出，
 * 不能等 8 秒"安静"。实现直接复用 doSendContent 的「填框 + 触发发送 + 确认清空」完整链路。
 * @param {string} msg 要发送的文本
 * @param {string} [tag] 日志标记
 * @returns {Promise<boolean>} 是否已确认发出
 */
async function sendImmediate(msg, tag) {
  const text = msg || '';
  if (!text) return false;
  try {
    await doSendContent(text, tag || 'API请求');
    return true;
  } catch (e) {
    console.error('[TokFree] sendImmediate 异常:', e && e.message);
    return false;
  }
}

/**
 * 轮询等待输入框内容被清空（= 站点已接收并发出该条消息）。
 * 每 100ms 检查一次，最多等 timeoutMs；超时返回 false（调用方继续，不卡死）。
 * @param {Element} input
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function waitForInputCleared(input, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  const readVal = () => {
    try {
      if (!input) return '';
      if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') return input.value || '';
      // contenteditable / role=textbox
      return (input.innerText || input.textContent || '').trim();
    } catch (_) { return ''; }
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    // 元素被替换（React 重渲染）也视为已发出
    if (!input.isConnected) return true;
    if (readVal() === '') return true;
  }
  console.warn('[TokFree] 等待输入框清空超时(' + (timeoutMs || 5000) + 'ms)，输入框仍非空，继续处理下一条');
  return false;
}

/**
 * 最强发送兜底：请求主进程聚焦目标 webContents 后注入真实级 Enter。
 * 后台标签 / 被 #chat-view 遮住的 webview：页面内合成事件（KeyboardEvent）无效，
 * 只有主进程 sendInputEvent 注入的原生 Enter 才能送达（主进程会先 focus 再注入）。
 * @returns {Promise<boolean>} 主进程是否成功注入
 */
async function escalateNativeEnter() {
  try {
    if (window.electronAPI && typeof window.electronAPI.sendEnterToChat === 'function') {
      const ok = await window.electronAPI.sendEnterToChat();
      console.log('[TokFree][send] 原生 Enter 兜底注入返回=' + ok);
      return !!ok;
    }
  } catch (e) {
    console.warn('[TokFree][send] 原生 Enter 兜底异常:', e && e.message);
  }
  return false;
}
/**
 * 将消息填入 DeepSeek 聊天输入框并触发发送（工具结果回传的公共实现）
 */
function sendMessageToChat(msg, tag) {
  return sendToChat(msg, tag);
}
/**
 * 把本地文件作为附件上传到当前网页版 AI 聊天。
 * 原理：读文件为 base64 → 构造 File → 塞进页面 <input type=file> 触发 change；
 * 若无 file input，则尝试向输入框派发 ClipboardEvent 粘贴。
 * @param {string} filePath 绝对路径
 * @returns {Promise<{success:boolean, error?:string, name?:string}>}
 */
async function attachFileToChat(filePath) {
  try {
    if (!window.electronAPI || !window.electronAPI.readFileBase64) {
      return { success: false, error: 'readFileBase64 API 不可用' };
    }
    const res = await window.electronAPI.readFileBase64(filePath);
    if (!res || !res.success) return { success: false, error: (res && res.error) || '读取文件失败' };

    const mimeMap = {
      // 图片
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
      tif: 'image/tiff', tiff: 'image/tiff',
      // 文档（AI 常能读的）
      pdf: 'application/pdf',
      txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
      json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values',
      xml: 'application/xml', yaml: 'application/x-yaml', yml: 'application/x-yaml',
      html: 'text/html', htm: 'text/html', log: 'text/plain',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      // 代码
      js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
      ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
      py: 'text/x-python', java: 'text/x-java-source', c: 'text/x-c', h: 'text/x-c',
      cpp: 'text/x-c++', hpp: 'text/x-c++', cs: 'text/plain', go: 'text/plain',
      rs: 'text/plain', rb: 'text/plain', php: 'text/plain', sh: 'text/x-sh',
      sql: 'text/plain', css: 'text/css', scss: 'text/plain', less: 'text/plain',
      // 压缩包
      zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
      '7z': 'application/x-7z-compressed',
    };
    const mime = mimeMap[res.ext] || 'application/octet-stream';
    // base64 → Uint8Array → File
    const bin = atob(res.base64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], res.name || 'file', { type: mime });

    // 记录上传前的附件数（用于检测上传完成）
    const beforeCount = countAttachments();

    // 1) 优先找页面 <input type=file>
    const inputs = Array.from(document.querySelectorAll('input[type=file]'));
    if (inputs.length > 0) {
      const input = inputs.find((el) => !el.disabled) || inputs[0];
      const dt = new DataTransfer();
      dt.items.add(file);
      try { input.files = dt.files; } catch (_) {}
      input.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[TokFree] 已触发 file input 上传附件: ' + res.name);
      return { success: true, name: res.name, via: 'input', beforeCount };
    }

    // 2) 兜底：向输入框派发 ClipboardEvent（粘贴文件）
    const input2 = findInputArea();
    if (input2) {
      // 焦点保护：上传附件需聚焦网页框，先快照用户焦点，粘完立即恢复
      const attachSnap = snapshotFocus(input2);
      input2.focus();
      const dt2 = new DataTransfer();
      dt2.items.add(file);
      const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt2 });
      input2.dispatchEvent(pasteEvent);
      restoreFocus(attachSnap);
      console.log('[TokFree] 已触发 paste 事件上传附件: ' + res.name);
      return { success: true, name: res.name, via: 'paste', beforeCount };
    }

    return { success: false, error: '未找到文件上传入口（无 file input 且无输入框）' };
  } catch (err) {
    console.error('[TokFree] 附件上传失败:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * 检测页面上已显示的附件数量（图片预览 / 文件卡片 / 文件名标签）
 * 用于判断上传是否完成。
 */
function countAttachments() {
  let count = 0;
  try {
    // ① blob: 图片预览（图片类附件）
    document.querySelectorAll('img').forEach((img) => {
      if (img.src && img.src.indexOf('blob:') === 0 && img.offsetWidth > 0 && img.offsetHeight > 0) count++;
    });
    // ② 文件卡片：含文件名（.png/.pdf 等）或删除按钮的容器
    const chips = document.querySelectorAll(
      '[class*="file"],[class*="attach"],[class*="upload"],[class*="chip"],[class*="thumb"],[data-testid*="file"]'
    );
    chips.forEach((el) => {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        const t = (el.innerText || '').trim();
        if (t && t.length < 200 && /\.(png|jpg|jpeg|gif|webp|bmp|pdf|txt|docx?|xlsx?|csv|json)/i.test(t)) count++;
      }
    });
  } catch (_) {}
  return count;
}

/** 页面是否仍有"上传中"指示器（spinner/progress） */
function hasUploadingIndicator() {
  try {
    const sel = '[class*="loading"],[class*="uploading"],[class*="progress"],[role="progressbar"],[class*="spinner"]';
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.offsetWidth > 0 && el.offsetHeight > 0) {
        const t = (el.innerText || '').toLowerCase();
        // 排除普通"加载中"文案里的非上传项（尽量保守：只要可见就算在传）
        if (t.indexOf('上传') !== -1 || t.indexOf('upload') !== -1 || !t) return true;
      }
    }
  } catch (_) {}
  return false;
}

/**
 * 等待附件上传完成
 * 判定：附件数量比上传前多 → 成功；超时则返回 false（但仍继续，避免卡死）
 * @param {number} beforeCount 上传前的附件数
 * @param {number} timeoutMs 最长等待（默认 12000ms）
 * @returns {Promise<boolean>} 是否检测到新附件
 */
async function waitForAttachmentReady(beforeCount, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 12000);
  let sawUploading = false;
  while (Date.now() < deadline) {
    const now = countAttachments();
    if (now > beforeCount) {
      // 已出现新附件；若还在"上传中"再等一会儿让它完成
      if (!hasUploadingIndicator()) {
        console.log('[TokFree] 附件上传完成（附件数 ' + beforeCount + ' → ' + now + '）');
        return true;
      }
      sawUploading = true;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('[TokFree] 附件上传等待超时（' + (timeoutMs || 12000) + 'ms），继续发送文本');
  return false;
}

/**
 * 从文本里提取附件路径。
 * ⚠️ 只认显式标记【附件：xxx】——不再自动上传"裸绝对路径"，
 * 避免 AI 输出/工具结果里提到的任意路径（含其他项目文件）被误上传。
 * AI 若确实要上传某文件，必须显式输出【附件：C:\xxx\y.png】。
 */
function extractAttachmentPaths(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  // 显式标记【附件：路径】
  const reMark = /【附件：([^】]+)】/g;
  let m;
  while ((m = reMark.exec(text)) !== null) { if (m[1]) out.push(m[1].trim()); }
  // 去重
  return Array.from(new Set(out));
}

/**
 * 判断 AI 当前是否"忙"（生成中 或 正在执行 JS 代码块）
 * 忙时不直接发用户消息，避免中断 AI / 与回执冲突。
 */
function isAiBusy() {
  if (state.executingJsBlocks) return true;
  try {
    const provider = getCurrentProvider();
    if (provider && typeof provider.isGenerating === 'function') {
      if (provider.isGenerating()) return true;
    }
  } catch (_) {}
  return false;
}

/**
 * 取出并清空排队的用户消息，返回可附加的文本片段（无则空串）
 */
function drainPendingUserMessages() {
  const q = state.pendingUserMessages;
  if (!Array.isArray(q) || q.length === 0) return '';
  const sep = String.fromCharCode(10);
  let out = sep + '---' + sep + '【用户补充（排队 ' + q.length + ' 条，请一并处理）】' + sep;
  out += q.join(sep + '---' + sep);
  state.pendingUserMessages = [];
  return out;
}

/**
 * 用户补充消息：AI 忙则排队（随下一个回执一起发），空闲则直接发。
 * @returns {{sent:boolean, queued:boolean, count?:number}}
 */
function sendUserMessage(msg) {
  const text = (msg || '').trim();
  if (!text) return { sent: false, queued: false };
  if (!isAiBusy()) {
    sendToChat(text, '用户补充');
    return { sent: true, queued: false };
  }
  state.pendingUserMessages.push(text);
  console.log('[TokFree] 用户补充已排队（共 ' + state.pendingUserMessages.length + ' 条），等下一个回执一起发');
  return { sent: false, queued: true, count: state.pendingUserMessages.length };
}

/**
 * 将 JSON 工具执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
function sendToolResultToChat(toolCall, result) {
  // 构造回传消息（明确的成功/失败信息，AI 可据此修正并继续）
  let msg;
  if (result.success) {
    const data = result.data || {};
    // 大内容截断保护（20KB），避免超长消息
    if (typeof data.content === 'string' && data.content.length > 20000) {
      data.content = data.content.substring(0, 20000) + String.fromCharCode(10) + '...[内容过长已截断]...';
    }
    msg = '【工具执行结果】' + toolCall.toolName + ' 执行成功 (callId: ' + (toolCall.callId || '') + ')' + String.fromCharCode(10) +
      JSON.stringify(data, null, 2);
  } else {
    msg = '【工具执行结果】' + toolCall.toolName + ' 执行失败 (callId: ' + (toolCall.callId || '') + ')' + String.fromCharCode(10) +
      '错误原因: ' + (result.error || '未知错误') + String.fromCharCode(10) +
      '请根据错误原因修正参数后重新调用工具。';
  }

  // 合并排队的用户补充（随本次回执一起发出）
  msg += drainPendingUserMessages();
  console.log('[TokFree] 回传工具结果, 消息长度=' + msg.length);
  sendMessageToChat(msg, '工具=' + toolCall.toolName);
}
/**
 * 将 JS 工具脚本执行结果发送回 DeepSeek 聊天，让 AI 看到结果并继续工作
 */
function sendCombinedJsResultsToChat(results) {
  if (!Array.isArray(results) || results.length === 0) return;

  const MAX_OUTPUT = 15000;
  const sep = String.fromCharCode(10);

  let msg = '【JS 执行结果汇总】(共 ' + results.length + ' 个脚本)' + sep + sep;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    msg += '—— 脚本 ' + (i + 1) + ' ——' + sep;
    if (item && item.result && item.result.success) {
      let out = (item.result.output || '').trim();
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + sep + '...[输出过长已截断]...';
      }
      msg += '✅ 成功' + sep + (out || '(脚本执行完成，无输出)');
    } else {
      msg += '❌ 失败' + sep + '错误原因: ' + ((item && item.result && item.result.error) || '未知错误') + sep;
      msg += '本次实际执行的代码(前300字符):' + sep + String((item && item.code) || '').slice(0, 300) + sep;
      msg += '请修正 JavaScript 代码后重新输出完整的 ' + BT + BT + BT + 'tokfree 代码块。';
    }
    msg += sep + sep;
  }

  // 合并排队的用户补充（随本次回执一起发出）
  msg += drainPendingUserMessages();
  console.log('[TokFree] 回传 JS 汇总执行结果, 消息长度=' + msg.length);

  // 识别结果里的图片/附件路径 → 先上传附件，等传完再发文本（让 AI 收到图 + 文字）
  try {
    const atts = extractAttachmentPaths(msg);
    if (atts.length > 0) {
      console.log('[TokFree] 检测到 ' + atts.length + ' 个附件，先上传再发文本');
      (async () => {
        for (const p of atts) {
          try {
            const r = await attachFileToChat(p);
            if (r && r.success) {
              console.log('[TokFree] 附件已触发上传:', r.name, '(' + r.via + ')');
              // 等待上传真正完成（检测附件预览出现 + 无上传中指示器），最多 12 秒
              await waitForAttachmentReady(r.beforeCount || 0, 12000);
            } else {
              console.error('[TokFree] 附件上传失败:', p, r && r.error);
            }
          } catch (e) { console.error('[TokFree] 附件上传异常:', p, e.message); }
        }
        // 附件都传完后，再发文本（确保 AI 同时收到图 + 文字）
        sendMessageToChat(msg, 'JS汇总');
      })();
      return;
    }
  } catch (_) {}

  sendMessageToChat(msg, 'JS汇总');
}
/**
 * 查找 DeepSeek 的输入框元素
 */
function findInputArea() {
  const provider = getCurrentProvider();
  if (provider && typeof provider.findInput === 'function') {
    const el = provider.findInput();
    // ⚠️ 必须排除覆盖层元素：provider 的兜底选择器 'textarea' 会命中
    // 覆盖层的"补充说明"框（#tokfree-user-input），导致回执填错框、发不出去
    if (el && !isInTokFreeOverlay(el)) return el;
  }

  // 通用兜底：找所有可见 textarea（⚠️ 必须排除 TokFree 覆盖层内的输入框，
  // 否则会把工具回执填进覆盖层的"补充说明"框，发不出去）
  const allTextareas = document.querySelectorAll('textarea');
  for (const ta of allTextareas) {
    if (isInTokFreeOverlay(ta)) continue;
    if (isInputVisible(ta)) return ta;
  }
  // 再找 contenteditable 或 textbox（同样排除覆盖层）
  const editables = document.querySelectorAll('div[contenteditable="true"], [role="textbox"]');
  for (const el of editables) {
    if (isInTokFreeOverlay(el)) continue;
    if (isInputVisible(el)) return el;
  }

  return null;
}

/** 元素是否在 TokFree 覆盖层内（覆盖层自身的输入框不能被当作聊天输入框） */
function isInTokFreeOverlay(el) {
  try {
    if (!el || typeof el.closest !== 'function') return false;
    return !!el.closest('#tokfree-overlay, #tokfree-window-manager, #tokfree-account-pool, #tokfree-knowledge-panel, #tokfree-mcp-panel, [id^="tokfree-"]');
  } catch (_) { return false; }
}
/**
 * 检查元素是否可见
 */
function isInputVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}
/**
 * 发送初始提示（目录树+systemPrompt）到输入框
 */
async function sendInitialPromptToInput() {
  if (!state.initialPromptContent) {
    state.pendingInitialPrompt = false;
    return false;
  }

  const input = findInputArea();
  if (!input) {
    return false;
  }

  // 在初始化提示词末尾追加零宽标记（U+200B U+2063 U+200B），
  // 供显示层（hide-tool-turn）与提取层（conversation-extract）识别并隐藏该消息。
  // 零宽字符不破坏提示词语义，也不显示为可见字符；写入 localStorage 供跨模块读取。
  const INIT_MARKER = '\u200B\u2063\u200B';
  let markedContent = state.initialPromptContent;
  try { markedContent = state.initialPromptContent + INIT_MARKER; } catch (_) {}
  try { localStorage.setItem('tokfree-init-marker', INIT_MARKER); } catch (_) {}

  if (!(await setInputContent(input, markedContent))) {
    return false;
  }

  const sendDelay = randomDelay();
  console.log('[TokFree] 初始提示已填入，随机等待 ' + sendDelay + 'ms 后发送...');
  setTimeout(function() {
    console.log('[TokFree] 等待结束，开始发送初始提示');
    // 后台标签/被 Agent 视图盖住的 webview：输入框未聚焦时注入的 Enter 不会送达，
    // 发送前先聚焦输入框（与 sendToChat 一致），确保初始提示能真正发出。
    try { input.focus(); } catch (_) {}
    triggerSend(input);
    confirmInitialPromptSent(input);
  }, sendDelay);

  return true;
}

/**
 * 确认初始提示是否真正发出；未清空则重试 triggerSend，最后用主进程原生 Enter 兜底。
 * 与 doSendContent 的 waitForInputCleared 重试同款逻辑，但针对 initial-prompt 场景。
 * @param {Element} input 已填入初始提示的输入框
 */
async function confirmInitialPromptSent(input) {
  let cleared = await waitForInputCleared(input, 3000);
  let retries = 0;
  const MAX_RETRIES = 3;
  while (!cleared && retries < MAX_RETRIES) {
    retries++;
    console.warn('[TokFree] 初始提示输入框未清空，重试发送 (' + retries + '/' + MAX_RETRIES + ')');
    try { input.focus(); } catch (_) {}
    triggerSend(input);
    cleared = await waitForInputCleared(input, 3000);
    if (!cleared) {
      // 后台/被遮挡的 webview：合成事件无效，用主进程原生 Enter 兜底（会先聚焦再注入）
      await escalateNativeEnter();
      cleared = await waitForInputCleared(input, 3000);
    }
  }
  if (cleared) {
    console.log('[TokFree] 初始提示已确认发出');
  } else {
    console.error('[TokFree] 初始提示发送失败（重试' + MAX_RETRIES + '次仍卡在输入框），已放弃');
  }
  state.pendingInitialPrompt = false;
  return cleared;
}
/**
 * 等待输入框出现后再发送初始提示
 */
function waitForInitialPromptAndSend() {
  let attempts = 0;
  const maxAttempts = 30;
  console.log('[' + new Date().toISOString() + '] [TokFree] 开始等待输入框出现（最多 ' + maxAttempts + ' 次，每次 500ms）');

  const checkInterval = setInterval(() => {
    attempts++;
    if (attempts > maxAttempts) {
      clearInterval(checkInterval);
      state.pendingInitialPrompt = false;
      console.log('[' + new Date().toISOString() + '] [TokFree] 等待输入框超时，放弃发送初始提示');
      return;
    }

    const found = !!findInputArea();
    if (attempts === 1 || attempts % 5 === 0 || found) {
      console.log('[' + new Date().toISOString() + '] [TokFree] 等待输入框第 ' + attempts + ' 次检查, 输入框=' + (found ? '找到' : '未找到'));
    }
    if (found) {
      clearInterval(checkInterval);
      sendInitialPromptToInput();
    }
  }, 500);
}
/**
 * 触发发送消息
 */
function triggerSend(input) {
  const provider = getCurrentProvider();
  console.log('[TokFree][send] triggerSend 开始, provider=' + (provider && provider.id ? provider.id : '无') +
    ', 输入框=' + (input ? (input.tagName || 'unknown') : 'null') +
    ', 输入框可见=' + (input ? isInputVisible(input) : false) +
    ', 输入框offsetW/H=' + (input ? (input.offsetWidth + 'x' + input.offsetHeight) : 'n/a'));

  // 方法 0: 站点原生发送（智谱等免疫合成事件的平台，经主进程注入真实级输入）
  if (provider && typeof provider.triggerSend === 'function') {
    let result = null;
    try { result = provider.triggerSend(input); } catch (e) {
      console.warn('[TokFree][send] provider.triggerSend 抛异常，回退通用逻辑:', e && e.message);
    }
    if (result && typeof result.then === 'function') {
      result.then(function (ok) {
        if (ok) {
          console.log('[TokFree][send] 已通过站点原生发送触发');
        } else {
          console.log('[TokFree][send] 站点原生发送返回 false，回退通用逻辑');
          fallbackSend(provider, input);
        }
      }).catch(function (e) {
        console.warn('[TokFree][send] 站点原生发送 Promise 异常，回退通用逻辑:', e && e.message);
        fallbackSend(provider, input);
      });
      return;
    }
    if (result) {
      console.log('[TokFree][send] 已通过站点原生发送触发(同步)');
      return;
    }
    console.log('[TokFree][send] 站点原生发送返回假值，回退通用逻辑');
  }

  fallbackSend(provider, input);
}

/**
 * 通用发送兜底：查找发送按钮点击，或模拟 Enter 按键序列
 */
function fallbackSend(provider, input) {
  console.log('[TokFree][send] fallbackSend 开始, provider=' + (provider && provider.id ? provider.id : '无'));
  // 方法 1: 调用平台 Provider 查找发送按钮
  if (provider && typeof provider.findSendButton === 'function') {
    let btn = null;
    try { btn = provider.findSendButton(); } catch (e) {
      console.warn('[TokFree][send] findSendButton 异常:', e && e.message);
    }
    console.log('[TokFree][send] findSendButton 返回=' + (btn ? (btn.tagName || 'el') : 'null'));
    // ⚠️ 必须排除 TokFree 覆盖层按钮：部分 provider 的 findSendButton 选择器过于宽泛
    // （如 DeepSeek 的 'button[title*="发送"]'），会命中覆盖层里 title 含"发送"的
    // 「卡住了？点我」按钮（id=tokfree-btn-manual-parse），点击后触发"卡住催促"，
    // 导致工具回执被覆盖、发不出去（并形成反复催促的假死循环）。
    if (btn && !isInTokFreeOverlay(btn)) {
      try { btn.click(); } catch (e) { console.warn('[TokFree][send] btn.click 异常:', e && e.message); }
      console.log('[TokFree][send] 已点击发送按钮');
      return;
    }
    if (btn) {
      console.error('[TokFree][send] findSendButton 返回了覆盖层元素，拒绝点击（防误触「卡住了？点我」）');
    }
  }

  // 方法 2: 在输入框上模拟完整 Enter 按键序列（keydown + keypress + keyup）
  if (input) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, isComposing: false };
    input.dispatchEvent(new KeyboardEvent('keydown', opts));
    input.dispatchEvent(new KeyboardEvent('keypress', opts));
    input.dispatchEvent(new KeyboardEvent('keyup', opts));
    console.log('[TokFree][send] 已通过合成 Enter 键触发发送 (未找到发送按钮)');
  } else {
    console.warn('[TokFree][send] 无输入框，无法执行 Enter 兜底');
  }
}
/**
 * 注册主进程消息监听（initial-prompt）
 * 与原 preload.js 顶层注册时机一致：preload 入口加载时同步调用。
 */
function registerIpcListeners() {
// 监听主进程发送的初始提示
ipcRenderer.on('initial-prompt', (_event, content) => {
  console.log('[' + new Date().toISOString() + '] [TokFree] 收到 initial-prompt 事件, content长度=' + (content || '').length);
  state.initialPromptContent = content || '';
  state.pendingInitialPrompt = true;
  // 如果当前已有新的空会话输入框，立即发送
  if (state.pendingInitialPrompt && state.initialPromptContent) {
    try {
      const input = findInputArea();
      console.log('[' + new Date().toISOString() + '] [TokFree] 首次查找输入框结果=' + (input ? '找到' : '未找到'));
      if (input) {
        sendInitialPromptToInput();
      } else {
        // 等待输入框出现
        waitForInitialPromptAndSend();
      }
    } catch (e) {
      console.error('[' + new Date().toISOString() + '] [TokFree] initial-prompt 处理异常:', e.message);
    }
  }
});
}


/**
 * 需求1b：读取网页输入区当前「已挂载的待发送附件」列表（只读，不改动页面）。
 * 优先把扫描范围收敛到「输入框附近的附件 rail 容器」，再在其中做精准匹配；
 * 找不到容器时降级为全页扫描（保留兜底能力）。
 * 排除历史消息(.ds-message)与 TokFree 覆盖层，只统计"待发送"的附件。
 * 返回 [{name, kind, thumb}]：kind: 'file' | 'image'；image 类附 thumb（blob URL）。
 * @returns {Array<{name:string, kind:string, thumb:string}>}
 */
function readPendingAttachments() {
  var out = [];
  var seen = {};
  function push(name, kind, thumb) {
    name = String(name == null ? '' : name).trim();
    if (!name) return;
    var key = kind + '|' + name;
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ name: name, kind: kind, thumb: thumb || '' });
  }
  function skip(el) {
    try {
      if (!el || !el.closest) return false;
      var HISTORY_SELS = ['.ds-message', '[data-message-author-role]', '[class*="message-row"]', '[class*="qwen-chat-message"]', '.answer', '[class*="question"]'];
      for (var _hi = 0; _hi < HISTORY_SELS.length; _hi++) { if (el.closest(HISTORY_SELS[_hi])) return true; } // 历史消息里的图/文件不算（多平台）
      if (el.closest('#tokfree-overlay,#tokfree-root,[id^="tokfree-"]')) return true; // 覆盖层
    } catch (_) {}
    return false;
  }
  // 删除/移除控件（老版 DeepSeek / 其它平台可能有 aria-label 或语义 class；新版无，仅作兜底）
  var DEL_SEL = 'button[aria-label*="删除"],button[aria-label*="移除"],button[aria-label*="Remove"],' +
                'button[title*="删除"],button[title*="移除"],[class*="delete"],[class*="remove"],[class*="close"]';
  // 文件卡片「扩展名 + 体积」特征：DeepSeek 待发文件卡片只显示形如 "PDF 1.2MB" / "DOCX 34KB"
  var EXT_SIZE_RE = /^[A-Z0-9]{1,6}\s+\d+(?:\.\d+)?\s?(?:B|KB|MB|GB|TB)$/i;
  // 文件名（带点 + 扩展名）特征：其它平台/场景的兜底
  var FILE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|svg|pdf|txt|md|docx?|xlsx?|pptx?|csv|json|zip|gz|tar|7z|py|js|ts|go|java|c|cpp|html|css|xml|yaml|yml)\b/i;

  // 判断一个元素是否"像附件 rail 容器"：含 blob 图 / 含 alt 像文件名的图 / 含 ext+size 文本
  function looksLikeRail(el) {
    try {
      if (!el || !el.querySelector) return false;
      if (el.querySelector('img[src^="blob:"]')) return true;
      var imgs = el.querySelectorAll('img[alt]');
      for (var i = 0; i < imgs.length; i++) {
        var a = (imgs[i].getAttribute('alt') || '').trim();
        if (a && FILE_NAME_RE.test(a)) return true;
      }
      var txt = (el.innerText || '').trim();
      if (txt && txt.length < 2000) {
        var lines = txt.split(/\r?\n/);
        for (var j = 0; j < lines.length; j++) {
          if (EXT_SIZE_RE.test(lines[j].trim())) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  try {
    // ① 收敛扫描范围：从输入框向上找最近的、含附件特征的容器
    var railScope = null;
    try {
      var inputArea = findInputArea();
      if (inputArea) {
        var cur = inputArea.parentElement;
        for (var d = 0; d < 6 && cur && !railScope; d++) {
          if (looksLikeRail(cur)) railScope = cur;
          cur = cur.parentElement;
        }
      }
    } catch (_) {}
    var scope = railScope || document;

    // ② 图片附件：逐张收集（每张一个附件项，带各自缩略图）
    var imgCount = 0;            // 供下方兜底逻辑判断"是否已识别到图片"
    var imgSeen = {};            // 去重（同 src 只算一张）
    var imgIdx = 0;
    var imgs = scope.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (!img.offsetWidth || !img.offsetHeight) continue;
      if (img.offsetWidth < 32 || img.offsetHeight < 32) continue; // 过滤装饰性小图
      if (skip(img)) continue;
      var src = img.src || '';
      var isBlob = src.indexOf('blob:') === 0;
      var isData = src.indexOf('data:') === 0;
      var altTxt = (img.getAttribute('alt') || '').trim();
      var altLikeName = altTxt && altTxt.length <= 120 && FILE_NAME_RE.test(altTxt);
      if (!isBlob && !isData && !altLikeName) continue;
      // 若在收敛 rail 内，放宽 alt 类判定；否则要求文件名特征（防整页装饰图）
      if (!isBlob && !isData && !railScope && !altLikeName) continue;
      // 去重：同 src（blob/data，非空）只算一次
      var dkey = (isBlob || isData) ? ('src:' + src) : ('alt:' + altTxt + ':' + imgIdx);
      if ((isBlob || isData) && imgSeen[dkey]) continue;
      imgSeen[dkey] = 1;
      imgIdx++;
      var oneName = altLikeName ? altTxt : ('图片' + (imgIdx > 1 ? imgIdx : ''));
      push(oneName, 'image', (isBlob || isData) ? src : '');
    }
    imgCount = imgIdx;

    // ③ 文件附件：DeepSeek 待发文件卡片只显示「扩展名 + 体积」（如 "PDF 1.2MB"）。
    // 找到承载该文本的"最内层"元素作为文件名；再退回「含扩展名点号的文件名」判定。
    var foundCards = 0;
    var all = scope.querySelectorAll('*');
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      if (!el.offsetWidth || !el.offsetHeight) continue;
      if (skip(el)) continue;
      // 只取"叶子文本"：其直接文本能匹配特征（避免把整块容器当成卡片）
      var own = '';
      try {
        var kids = el.childNodes;
        for (var c = 0; c < kids.length; c++) {
          if (kids[c].nodeType === 3) own += kids[c].nodeValue;
        }
      } catch (_) {}
      own = own.trim();
      var isExtSize = EXT_SIZE_RE.test(own);
      var isFname = FILE_NAME_RE.test(own) && own.length <= 120;
      if (!isExtSize && !isFname) continue;
      var line = own.split(/\r?\n/)[0].trim();
      line = line.replace(/^(上传中|解析中|Uploading|Parsing)\s*/i, '').slice(0, 120);
      if (!line) continue;
      // 图片扩展名的 ext+size 通常由图片卡片承载，避免与图片附件重复
      if (isExtSize && /^(png|jpe?g|gif|webp|bmp|svg)\s/i.test(line)) {
        var hasImg = false;
        for (var x = 0; x < out.length; x++) { if (out[x].kind === 'image') { hasImg = true; break; } }
        if (hasImg) continue;
      }
      push(line, 'file', '');
      foundCards++;
    }

    // ④ 兜底：老选择器（保留，兼容其它平台 / 未来改版）
    if (foundCards === 0 && imgCount === 0) {
      var chips = scope.querySelectorAll(
        '[class*="file"],[class*="attach"],[class*="upload"],[class*="chip"],[class*="thumb"],[data-testid*="file"]'
      );
      for (var k = 0; k < chips.length; k++) {
        var cel = chips[k];
        if (!cel.offsetWidth || !cel.offsetHeight) continue;
        if (skip(cel)) continue;
        var ct = (cel.innerText || cel.textContent || '').trim();
        if (!ct || ct.length > 200) continue;
        if (!FILE_NAME_RE.test(ct)) continue;
        var cl = ct.split(/\r?\n/)[0].trim().slice(0, 120);
        push(cl, 'file', '');
      }
    }
  } catch (_) {}
  return out;
}

/**
 * 需求1b（异步版）：在 webview 内把图片附件的 blob 缩略图转成 dataURL 后再返回。
 * 背景：壳层（shell.html）与 webview 是不同上下文，blob URL 绑定创建它的 document，
 * 跨上下文访问被拒绝 → 壳层 <img src="blob:..."> 会破图。dataURL 是内联字符串，可跨上下文。
 * 转换失败时该图 thumb 置空，由壳层优雅降级为「🖼 图标 + 文件名」。
 * @returns {Promise<Array<{name:string, kind:string, thumb:string}>>}
 */
async function readPendingAttachmentsAsync() {
  var list = readPendingAttachments();
  for (var i = 0; i < list.length; i++) {
    var a = list[i];
    if (a && a.kind === 'image' && a.thumb && a.thumb.indexOf('blob:') === 0) {
      try {
        a.thumb = await blobUrlToDataURL(a.thumb);
      } catch (_) {
        a.thumb = '';
      }
    }
  }
  return list;
}

/**
 * 需求1c：按文件名移除网页输入区的一个「待发送附件」（供壳层 chip 的「×」调用）。
 *
 * 调研结论（DeepSeek 网页版，2026-09）：
 * - 文件卡片容器：._25c7358；图片卡片容器：.d5fa3d1b。
 * - 删除控件：卡片内唯一含「×」图标（svg path d 前缀 "M10.6074 4.40278"）的 div[tabindex]；
 *   文件卡片上为 ._8402d8c，图片卡片上为 .c8b3f8a6。
 * - 该控件默认 opacity:0，仅在卡片 :hover 时可见；但「直接 el.click()」即可删除，
 *   无需模拟 hover（程序化派发 mouseover/mouseenter 无法触发 CSS :hover，实测无效）。
 * - 因此本函数：按名定位卡片 → 在卡片内找到「×」按钮 → 原生 click()。
 *
 * 定位复用了 readPendingAttachments 的匹配规则：
 * - 文件卡片：文件名文本（tokfree-test.txt）或「扩展名+体积」叶子文本（TXT 18B）。
 * - 图片卡片：<img alt="文件名">。
 *
 * @param {string} name 附件名（与 readPendingAttachments 返回的 name 一致）
 * @returns {Promise<{success:boolean, error?:string}>}
 */
async function removePendingAttachment(name) {
  try {
    name = String(name == null ? '' : name).trim();
    if (!name) return { success: false, error: '附件名为空' };

    var FILE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|svg|pdf|txt|md|docx?|xlsx?|pptx?|csv|json|zip|gz|tar|7z|py|js|ts|go|java|c|cpp|html|css|xml|yaml|yml)\b/i;
    // 删除按钮里的「×」图标特征路径前缀（DeepSeek 全站一致）
    var X_PATH_PREFIX = '4.40278';
    // 图片附件可能被 readPendingAttachments 命名为「图片」/「图片 ×N」
    var isImagePlaceholder = /^图片(\s*×\s*\d+)?$/.test(name);

    function skip(el) {
      try {
        if (!el || !el.closest) return false;
        var HISTORY_SELS = ['.ds-message', '[data-message-author-role]', '[class*="message-row"]', '[class*="qwen-chat-message"]', '.answer', '[class*="question"]'];
        for (var _hi = 0; _hi < HISTORY_SELS.length; _hi++) { if (el.closest(HISTORY_SELS[_hi])) return true; } // 历史消息（多平台）
        if (el.closest('#tokfree-overlay,#tokfree-root,[id^="tokfree-"]')) return true;
      } catch (_) {}
      return false;
    }

    // 在给定卡片容器内找「×」删除按钮
    function findDeleteBtn(card) {
      if (!card) return null;
      var cands = card.querySelectorAll('div[tabindex], button, [role="button"]');
      for (var i = 0; i < cands.length; i++) {
        var b = cands[i];
        if (b === card) continue;
        var p = b.querySelector && b.querySelector('svg path[d*="' + X_PATH_PREFIX + '"]');
        if (p) return b;
      }
      return null;
    }

    // 向上收敛到卡片容器（DeepSeek 的两种卡片类名；找不到就退回最近的 tabindex 祖先）
    var CARD_SEL = '._25c7358,.d5fa3d1b';
    function climbToCard(el) {
      var cur = el;
      for (var d = 0; d < 10 && cur; d++) {
        if (cur.matches && cur.matches(CARD_SEL)) return cur;
        cur = cur.parentElement;
      }
      // 兜底：从起点向上，找第一个含「×」按钮的容器（限制层数防误伤整页）
      cur = el;
      for (var e = 0; e < 6 && cur; e++) {
        if (findDeleteBtn(cur)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    var inputArea = null;
    try { inputArea = findInputArea(); } catch (_) {}
    var scope = document;
    // 收敛扫描范围：输入框向上找含附件特征的容器（与 readPendingAttachments 一致）
    try {
      if (inputArea) {
        var cur = inputArea.parentElement;
        for (var d = 0; d < 8 && cur; d++) {
          var t = (cur.innerText || '');
          if (cur.querySelector('img[src^="blob:"]') || /\d+(?:\.\d+)?\s?(?:B|KB|MB|GB|TB)/i.test(t)) { scope = cur; break; }
          cur = cur.parentElement;
        }
      }
    } catch (_) {}

    // ① 图片附件：优先按 <img alt="文件名"> 定位
    var hitCard = null;
    try {
      var imgs = scope.querySelectorAll('img');
      for (var ii = 0; ii < imgs.length; ii++) {
        var img = imgs[ii];
        if (!img.offsetWidth || !img.offsetHeight) continue;
        if (skip(img)) continue;
        var alt = (img.getAttribute('alt') || '').trim();
        if (!alt) continue;
        if (isImagePlaceholder || alt === name || (FILE_NAME_RE.test(name) && alt === name)) { hitCard = climbToCard(img); if (hitCard) break; }
      }
    } catch (_) {}

    // ② 文件附件：按「文件名叶子文本」或「扩展名+体积叶子文本」定位
    if (!hitCard) {
      try {
        var all = scope.querySelectorAll('*');
        for (var j = 0; j < all.length; j++) {
          var el = all[j];
          if (!el.offsetWidth || !el.offsetHeight) continue;
          if (skip(el)) continue;
          var own = '';
          try {
            var kids = el.childNodes;
            for (var c = 0; c < kids.length; c++) { if (kids[c].nodeType === 3) own += kids[c].nodeValue; }
          } catch (_) {}
          own = own.trim();
          if (!own || own.length > 120) continue;
          // 命中：文本等于目标名，或目标名是「扩展名+体积」形态时匹配（readPendingAttachments 可能返回后者）
          var hit = (own === name) || (FILE_NAME_RE.test(own) && own === name);
          if (!hit) {
            // 兼容：readPendingAttachments 对无 alt 的文件卡片返回「扩展名 体积」文本
            var EXT_SIZE_RE = /^[A-Z0-9]{1,6}\s+\d+(?:\.\d+)?\s?(?:B|KB|MB|GB|TB)$/i;
            if (EXT_SIZE_RE.test(name) && own.toUpperCase() === name.toUpperCase()) hit = true;
          }
          if (!hit) continue;
          hitCard = climbToCard(el);
          if (hitCard) break;
        }
      } catch (_) {}
    }

    if (!hitCard) return { success: false, error: '未找到匹配的待发附件：' + name };

    var delBtn = findDeleteBtn(hitCard);
    if (!delBtn) return { success: false, error: '附件卡片上未找到删除控件：' + name };

    // 删除前后各数一次：确认真的删掉了
    function countByName() {
      var n = 0;
      try {
        var im = scope.querySelectorAll('img[alt]');
        for (var a = 0; a < im.length; a++) {
          if (im[a].offsetWidth > 0 && (im[a].getAttribute('alt') || '').trim() === name) n++;
        }
        var els = scope.querySelectorAll('*');
        for (var b = 0; b < els.length; b++) {
          var e2 = els[b];
          if (!e2.offsetWidth || !e2.offsetHeight) continue;
          var ow = '';
          try { var kk = e2.childNodes; for (var q = 0; q < kk.length; q++) { if (kk[q].nodeType === 3) ow += kk[q].nodeValue; } } catch (_) {}
          if (ow.trim() === name) n++;
        }
      } catch (_) {}
      return n;
    }
    var before = countByName();

    delBtn.click();
    await new Promise(function (res) { setTimeout(res, 600); });

    var after = countByName();
    if (after < before) return { success: true };
    // 名称可能命中的是图片占位名（如"图片"），click 后无法用同名计数确认——放宽为「卡片已消失」
    var stillGone = !document.body.contains(hitCard);
    if (stillGone) return { success: true };
    return { success: false, error: '删除控件已点击，但附件仍在：' + name };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
}

/**
 * 把 blob URL 转成 dataURL（在拥有该 blob 的文档内执行，才能读取）。
 * @param {string} url blob URL
 * @returns {Promise<string>} dataURL
 */
function blobUrlToDataURL(url) {
  return fetch(url)
    .then(function (r) { return r.blob(); })
    .then(function (b) {
      return new Promise(function (resolve, reject) {
        var fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result || '')); };
        fr.onerror = function () { reject(fr.error || new Error('FileReader failed')); };
        fr.readAsDataURL(b);
      });
    });
}

async function renameRemoteSession(sessionId, newTitle) {
  try {
    if (!sessionId) return { success: false, error: '缺少 sessionId' };
    const title = (newTitle == null ? '' : String(newTitle)).trim();
    if (!title) return { success: false, error: '新标题为空' };

    const esc = (window.CSS && CSS.escape) ? CSS.escape(sessionId) : String(sessionId).replace(/"/g, '\\"');
    const item = document.querySelector('a[href*="/chat/s/' + esc + '"]') ||
                 document.querySelector('a[href*="/chat/s/' + sessionId + '"]');
    if (!item) return { success: false, error: '未找到会话项' };

    const menuBtn = item.querySelector('[role="button"]');
    if (!menuBtn) return { success: false, error: '未找到菜单按钮' };
    menuBtn.click();

    const waitFor = function (fn, timeoutMs) {
      return new Promise(function (resolve) {
        const start = Date.now();
        (function tick() {
          let v = null;
          try { v = fn(); } catch (e) { v = null; }
          if (v) return resolve(v);
          if (Date.now() - start >= timeoutMs) return resolve(null);
          setTimeout(tick, 100);
        })();
      });
    };

    const renameOpt = await waitFor(function () {
      const opts = document.querySelectorAll('.ds-dropdown-menu-option');
      for (const o of opts) {
        if (((o.innerText || '').trim()) === '重命名') return o;
      }
      return null;
    }, 2000);
    if (!renameOpt) return { success: false, error: '未找到「重命名」菜单项' };
    renameOpt.click();

    const input = await waitFor(function () {
      return document.querySelector('input.ds-input__input[type="text"]') ||
             document.querySelector('input.ds-input__input');
    }, 2500);
    if (!input) return { success: false, error: '未找到重命名输入框' };

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, title);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));

    return { success: true };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
}

/**
 * 读取「深度思考」开关状态（供壳端同步显示）。
 * @returns {{available:boolean, on:boolean}} available=网页端是否存在该开关
 */
function readDeepThinkState() {
  try {
    const provider = getCurrentProvider();
    if (!provider || typeof provider.getDeepThinkButton !== 'function' || typeof provider.isDeepThinkOn !== 'function') {
      return { available: false, on: false };
    }
    const btn = provider.getDeepThinkButton();
    if (!btn) return { available: false, on: false };
    return { available: true, on: !!provider.isDeepThinkOn() };
  } catch (_) {
    return { available: false, on: false };
  }
}

/**
 * 切换「深度思考」开关。
 * @param {boolean} on 目标状态
 * @returns {{ok:boolean, changed:boolean, available:boolean, error?:string}}
 */
function setDeepThink(on) {
  try {
    const provider = getCurrentProvider();
    if (!provider || typeof provider.setDeepThink !== 'function') {
      return { ok: false, changed: false, available: false };
    }
    const r = provider.setDeepThink(on);
    if (r && typeof r === 'object') {
      return {
        ok: !!r.ok,
        changed: !!r.changed,
        available: r.available !== false,
        error: r.error,
      };
    }
    return { ok: false, changed: false, available: false };
  } catch (err) {
    return { ok: false, changed: false, available: false, error: (err && err.message) || String(err) };
  }
}

module.exports = {
  randomDelay,
  setInputContent,
  sendImmediate,
  sendToChat,
  sendMessageToChat,
  flushPendingSend,
  fallbackSend,
  isInTokFreeOverlay,
  sendToolResultToChat,
  sendCombinedJsResultsToChat,
  sendUserMessage,
  attachFileToChat,
  extractAttachmentPaths,
  isAiBusy,
  findInputArea,
  isInputVisible,
  sendInitialPromptToInput,
  waitForInitialPromptAndSend,
  triggerSend,
  readPendingAttachments,
  readPendingAttachmentsAsync,
  removePendingAttachment,
  registerIpcListeners,
  renameRemoteSession,
  readDeepThinkState,
  setDeepThink,
};
