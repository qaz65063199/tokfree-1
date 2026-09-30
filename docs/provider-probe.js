/**
 * ============================================================================
 * TokFree 新平台接入辅助工具 —— DOM 探测脚本
 * ============================================================================
 *
 * 用途：快速探测某个 AI 平台的聊天页关键 DOM 选择器，帮助接入新 Provider。
 *
 * 使用方法：
 *   1. 在 TokFree（或任意浏览器）中打开目标 AI 平台的聊天页面；
 *   2. 打开开发者工具（F12）→ Console 控制台；
 *   3. 把本文件全部内容复制粘贴进 Console，回车运行；
 *   4. 阅读控制台输出的结构化报告，把「推荐选择器」片段复制进
 *      src/providers/<平台>.js 的 findInput / findSendButton 等位置。
 *
 * 输出内容：
 *   - 候选输入框 / 发送按钮 / 停止按钮 / 消息容器
 *   - 一段可直接填入 Provider 模板的选择器片段
 *
 * 说明：本脚本纯浏览器 JS，无任何依赖，不会修改页面，只做只读探测。
 * ============================================================================
 */
(function () {
  'use strict';

  // ---------- 通用工具 ----------
  function visible(el) {
    try {
      if (!el) return false;
      if (el.offsetWidth > 0 && el.offsetHeight > 0) return true;
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (_) { return false; }
  }

  function inOverlay(el) {
    try {
      if (!el || typeof el.closest !== 'function') return false;
      return !!el.closest('[id^="tokfree-"], #tokfree-overlay, #tokfree-root');
    } catch (_) { return false; }
  }

  function cls(el) {
    try {
      if (!el) return '';
      const c = el.className;
      if (typeof c === 'string') return c.trim();
      if (c && c.baseVal) return c.baseVal.trim();
      return '';
    } catch (_) { return ''; }
  }

  function desc(el) {
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : '?',
      id: el.id || '',
      className: cls(el).slice(0, 120),
      placeholder: el.getAttribute ? (el.getAttribute('placeholder') || '') : '',
      ariaLabel: el.getAttribute ? (el.getAttribute('aria-label') || '') : '',
      title: el.getAttribute ? (el.getAttribute('title') || '') : '',
      text: (el.textContent || '').trim().slice(0, 40),
    };
  }

  // 生成一个尽量稳定的推荐选择器（优先 id / aria-label / data-testid，其次 class）
  function suggestSelector(el) {
    try {
      if (el.id) return '#' + el.id;
      const dt = el.getAttribute && el.getAttribute('data-testid');
      if (dt) return '[data-testid="' + dt + '"]';
      const al = el.getAttribute && el.getAttribute('aria-label');
      if (al) return el.tagName.toLowerCase() + '[aria-label="' + al + '"]';
      const ph = el.getAttribute && el.getAttribute('placeholder');
      if (ph) return el.tagName.toLowerCase() + '[placeholder*="' + ph.slice(0, 12) + '"]';
      const c = cls(el);
      if (c) {
        const first = c.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        if (first) return el.tagName.toLowerCase() + '.' + first;
      }
      return el.tagName.toLowerCase();
    } catch (_) { return ''; }
  }

  const report = { input: [], send: [], stop: [], message: [], recommended: {} };

  // ---------- 1. 候选输入框 ----------
  try {
    const sel = 'textarea, [contenteditable="true"], [role="textbox"]';
    const found = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (inOverlay(el)) return;
      if (!visible(el)) return;
      found.push(el);
    });
    // 推荐：优先 textarea / contenteditable，且 placeholder 含聊天关键词
    const score = (el) => {
      let s = 0;
      const ph = (el.getAttribute('placeholder') || '').toLowerCase();
      if (/message|输入|提问|ask|发送|send|deepseek|chat/.test(ph)) s += 10;
      if (el.tagName === 'TEXTAREA') s += 3;
      if (el.getAttribute('contenteditable') === 'true') s += 3;
      const area = el.offsetWidth * el.offsetHeight;
      if (area > 5000) s += 2;
      return s;
    };
    found.sort((a, b) => score(b) - score(a));
    report.input = found.map(desc);
    if (found[0]) report.recommended.input = suggestSelector(found[0]);
    console.group('%c[探测] 候选输入框', 'color:#2b8a3e;font-weight:bold');
    if (report.input.length) console.table(report.input);
    else console.warn('未找到可见的输入框（页面是否已加载完成？）');
    console.groupEnd();
  } catch (e) { console.warn('[探测] 输入框探测异常：', e); }

  // ---------- 2. 候选发送按钮 ----------
  try {
    const all = [];
    document.querySelectorAll('button, [role="button"], [class*="send"], [class*="submit"]').forEach((el) => {
      if (inOverlay(el)) return;
      if (!visible(el)) return;
      all.push(el);
    });
    const key = (el) => {
      const t = (el.textContent || '').toLowerCase();
      const al = (el.getAttribute('aria-label') || '').toLowerCase();
      const ti = (el.getAttribute('title') || '').toLowerCase();
      const s = (t + ' ' + al + ' ' + ti);
      return { s, match: /send|发送|提交|submit/.test(s) };
    };
    const matched = [];
    all.forEach((el) => {
      if (key(el).match) matched.push(el);
    });
    // 若没有明确文案，则回退：输入框附近的最后一个可点击按钮（右下角常见位置）
    report.send = matched.map(desc);
    if (matched[0]) report.recommended.send = suggestSelector(matched[0]);
    console.group('%c[探测] 候选发送按钮', 'color:#1971c2;font-weight:bold');
    if (report.send.length) console.table(report.send);
    else {
      console.warn('未找到带 send/发送/提交 文案的按钮。以下为页面上全部可见按钮，可人工辨识：');
      console.table(all.map(desc));
    }
    console.groupEnd();
  } catch (e) { console.warn('[探测] 发送按钮探测异常：', e); }

  // ---------- 3. 候选停止按钮 ----------
  try {
    const matched = [];
    document.querySelectorAll('button, [role="button"], [aria-label], [title]').forEach((el) => {
      if (inOverlay(el)) return;
      if (!visible(el)) return;
      const s = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
      if (/stop|停止|中断|cancel|取消/.test(s)) matched.push(el);
    });
    report.stop = matched.map(desc);
    if (matched[0]) report.recommended.stop = suggestSelector(matched[0]);
    console.group('%c[探测] 候选停止按钮', 'color:#e8590c;font-weight:bold');
    if (report.stop.length) console.table(report.stop);
    else console.info('当前未发现停止按钮（可能 AI 未在生成中，或该平台无独立停止键）。');
    console.groupEnd();
  } catch (e) { console.warn('[探测] 停止按钮探测异常：', e); }

  // ---------- 4. 消息容器候选 ----------
  try {
    // 启发式：同一 class 组合出现 >=3 次，且各自 innerText 长度 > 10
    const map = new Map();
    document.querySelectorAll('div, article, section, li').forEach((el) => {
      try {
        if (inOverlay(el)) return;
        if (!visible(el)) return;
        const c = cls(el);
        if (!c) return;
        const t = (el.innerText || '').trim();
        if (t.length <= 10) return;
        // 只统计"最内层"——若子元素已计入同一 class，跳过父容器粗块（用文本长度上限抑制）
        if (t.length > 8000) return;
        if (!map.has(c)) map.set(c, []);
        map.get(c).push({ el, len: t.length });
      } catch (_) {}
    });
    const candidates = [];
    map.forEach((arr, c) => {
      if (arr.length >= 3) {
        // 取该 class 下文本长度的中位数作为代表
        const lens = arr.map((x) => x.len).sort((a, b) => a - b);
        candidates.push({
          className: c.slice(0, 120),
          count: arr.length,
          medianTextLen: lens[Math.floor(lens.length / 2)],
          sample: (arr[0].el.innerText || '').trim().slice(0, 60).replace(/\s+/g, ' '),
        });
      }
    });
    candidates.sort((a, b) => b.count - a.count);
    report.message = candidates.slice(0, 15);
    if (candidates[0]) report.recommended.message = '.' + candidates[0].className.split(/\s+/)[0];
    console.group('%c[探测] 消息容器候选（同 class 重复出现）', 'color:#7048e8;font-weight:bold');
    if (report.message.length) console.table(report.message);
    else console.warn('未找到明显的重复消息容器（页面可能没有历史消息）。');
    console.groupEnd();
  } catch (e) { console.warn('[探测] 消息容器探测异常：', e); }

  // ---------- 5. 推荐选择器片段 ----------
  try {
    const r = report.recommended;
    const fmt = (v) => (v ? "'" + v + "'" : "'' /* 待补充 */");
    const snippet = [
      '// ==== TokFree Provider 选择器片段（探测自动生成）====',
      'inputSelectors: [' + fmt(r.input) + '],',
      'sendButtonSelectors: [' + fmt(r.send) + '],',
      'stopButtonSelectors: [' + fmt(r.stop) + '],',
      'messageSelectors: [' + fmt(r.message) + '],',
    ].join('\n');
    console.group('%c[探测] 推荐选择器片段（可直接填入 Provider 模板）', 'color:#c92a2a;font-weight:bold');
    console.log('%c' + snippet, 'color:#c92a2a');
    console.groupEnd();
    // 也提供一份对象，便于右键复制
    window.__tokfreeProbeReport = { report, snippet };
    console.log('[探测] 完整结果已挂到 window.__tokfreeProbeReport，方便复制。');
  } catch (e) { console.warn('[探测] 生成推荐片段异常：', e); }

  console.log('%c[TokFree] DOM 探测完成 ✅', 'color:#2b8a3e;font-weight:bold;font-size:14px');
})();
