# 公共交互层去硬编码 · 架构设计文档

> 目标：消除 `src/preload/dom/chat-input.js`（1423 行）与 `src/preload/dom/js-detector.js`（196 行）中的平台特异性硬编码，将"找输入框/判断角色/检测附件卡片"等具体实现下放给 `src/providers/` 下的平台文件，为无限扩展新平台铺路。
> 范围：仅调研 + 设计，不改动代码。
> 生成时间：2026-09-23

---

## 一、现状调研：硬编码点清单（附行号）

### 1.1 chat-input.js 硬编码点

| # | 行号 | 硬编码内容 | 平台指向 | 严重度 |
|---|------|-----------|---------|--------|
| C1 | 76-92 | contenteditable 分段 Paste（每段 ≤6000 字符，"不会触发 ChatGPT 的附件行为"） | ChatGPT | 中 |
| C2 | 234 | 覆盖层排除：`#tokfree-overlay, #tokfree-window-manager, #tokfree-settings-drawer, [id^="tokfree-"]` | TokFree 自身（非平台） | 低 |
| C3 | 242 | `input.id === 'tokfree-user-input'` 二次防误发 | TokFree 自身 | 低 |
| C4 | 486 | `img.src.indexOf('blob:')===0` 图片预览计数 | 通用启发式 | 中 |
| C5 | 489-491 | 文件卡片选择器 `[class*="file"],[class*="attach"],[class*="upload"],[class*="chip"],[class*="thumb"],[data-testid*="file"]` | 通用启发式 | 中 |
| C6 | 495 | 文件名正则 `/\.(png\|jpg\|...\|json)/i` | 通用启发式 | 中 |
| C7 | 505 | 上传中指示器 `[class*="loading"],[class*="uploading"],[class*="progress"],[role="progressbar"],[class*="spinner"]` | 通用启发式 | 中 |
| C8 | 511 | 上传文案 `上传\|upload` | 通用启发式 | 低 |
| C9 | 957 | 历史消息选择器 `'.ds-message', '[data-message-author-role]', '[class*="message-row"]', '[class*="qwen-chat-message"]', '.answer', '[class*="question"]'` | **DeepSeek / ChatGPT / Claude / Qwen** 混合 | 高 |
| C10 | 964-965 | 删除控件 `button[aria-label*="删除"],[class*="delete"],[class*="remove"],[class*="close"]` | 通用启发式 | 中 |
| C11 | 966-967 | EXT_SIZE_RE `/^[A-Z0-9]{1,6}\s+\d+(\.\d+)?\s?(B\|KB\|MB\|GB\|TB)$/i`（DeepSeek 待发文件卡片"PDF 1.2MB"） | **DeepSeek 专属** | 高 |
| C12 | 968-969 | FILE_NAME_RE 扩展名白名单 | 通用启发式 | 中 |
| C13 | 1056 | 上传态文案 `/^(上传中\|解析中\|Uploading\|Parsing)\s*/i` | 通用启发式 | 低 |
| C14 | 1070-1072 | 附件 chips 兜底选择器（同 C5） | 通用启发式 | 中 |
| C15 | 1113-1123 | removePendingAttachment 注释：DeepSeek 文件卡片 `._25c7358`、图片卡片 `.d5fa3d1b`、删除控件 svg path `M10.6074 4.40278` | **DeepSeek 专属** | 高 |
| C16 | 1133 | FILE_NAME_RE 再次硬编码 | 通用启发式 | 中 |
| C17 | 1135 | `X_PATH_PREFIX = '4.40278'`（DeepSeek 删除图标 svg path 前缀） | **DeepSeek 专属** | 高 |
| C18 | 1137 | `/^图片(\s*×\s*\d+)?$/` 图片占位名 | DeepSeek 专属 | 中 |
| C19 | 1142 | HISTORY_SELS 再次硬编码（同 C9） | 混合 | 高 |
| C20 | 1163 | `CARD_SEL = '._25c7358,.d5fa3d1b'`（DeepSeek 卡片类名） | **DeepSeek 专属** | 高 |
| C21 | 1164-1177 | climbToCard 逻辑依赖 C20 | DeepSeek 专属 | 高 |
| C22 | 1227 | EXT_SIZE_RE 再次硬编码（同 C11） | DeepSeek 专属 | 高 |
| C23 | 1295-1350 | renameRemoteSession：`a[href*="/chat/s/"]`（DeepSeek 会话链接）、`.ds-dropdown-menu-option`、文案'重命名'、`input.ds-input__input[type="text"]` | **DeepSeek 专属** | 高 |
| C24 | 1356-1394 | readDeepThinkState / setDeepThink —— 已经是 provider 代理，**良好范例** | — | — |
| C25 | 692-716 | findInputArea 兜底：遍历 `textarea` + `div[contenteditable="true"], [role="textbox"]` | 通用启发式（已有 provider 优先） | 低 |
| C26 | 719-724 | isInTokFreeOverlay 覆盖层选择器（同 C2） | TokFree 自身 | 低 |
| C27 | 832-867 | triggerSend 已走 provider，良好范例 | — | — |

### 1.2 js-detector.js 硬编码点

| # | 行号 | 硬编码内容 | 平台指向 | 严重度 |
|---|------|-----------|---------|--------|
| J1 | 13 | `JS_TOOL_CALL_RE` 工具白名单（await read/write/... ） | TokFree 自身（保留） | 低 |
| J2 | 27 | `await mcpXxx(` 前缀识别 | TokFree 自身 | 低 |
| J3 | 115 | 装饰元素剔除选择器：`.md-code, .md-code-block-banner-wrap, .md-code-block-banner, button, [class*="toolbar"], [class*="copy"], [class*="download"], [class*="code-block-header"], [class*="lang"], [class*="header"]` | **DeepSeek（.md-code-*）+ 通用** | 高 |
| J4 | 128-135 | Monaco 编辑器结构：`.view-lines .view-line`（Qwen 海外版用 Monaco 渲染代码块） | **Qwen 海外版** | 高 |
| J5 | 137 | `.qwen-markdown-code-header, .margin-view-overlays, .margin` | **Qwen 专属** | 高 |
| J6 | 156-159 | 兜底选择器 `.md-code`（智谱用 div.md-code + highlight.js） | **智谱专属** | 中 |
| J7 | 167 | 语言标记 `'tokfree'` 判断 | TokFree 自身 | 低 |
| J8 | 171-172 | `'js' / 'javascript'` 语言判断 | 通用 | 低 |

### 1.3 依赖链分析

```
chat-input.js
  ├─ getProviderByUrl()  ← 已接入 provider 体系（findInput / triggerSend / findSendButton / getDeepThinkButton 等）
  ├─ findInputArea()     ← 已走 provider.findInput()，但兜底逻辑仍硬编码通用
  ├─ readPendingAttachments()  ← ⚠️ 完全未走 provider，硬编码 DeepSeek + 混合平台选择器
  ├─ removePendingAttachment() ← ⚠️ 完全未走 provider，硬编码 DeepSeek 卡片类名/svg path
  └─ renameRemoteSession()     ← ⚠️ 完全未走 provider，硬编码 DeepSeek DOM

js-detector.js
  ├─ getCodeBlockLanguage()  ← 已走 provider（detector.js line 19-25 代理）
  ├─ hasOnlyCodeContent()    ← ⚠️ 未走 provider，硬编码装饰元素选择器
  └─ extractCodeText()       ← ⚠️ 未走 provider，硬编码 Monaco/Qwen/智谱
```

**关键洞察**：`findInput / triggerSend / findSendButton / getDeepThinkButton / getCodeBlockLanguage` **已经走 provider 分派**，是本项目的良好范例；而**附件相关（读/删）+ 消息历史识别 + 代码块文本抽取 + 会话重命名**仍是硬编码重灾区。

---

## 二、Provider 适配器接口契约设计

### 2.1 设计原则

1. **能力可选（optional capability）**：每个方法都是可选实现，未实现则回退到通用逻辑（见第三节）。
2. **单一职责**：每个方法只回答一个具体问题（"这是用户的附件卡片吗？"），不掺杂流程控制。
3. **无状态**：方法应是纯查询/纯动作，不缓存跨调用状态（平台特有的边沿检测状态应由 provider 内部管理，如 qwen.js 的 `stopBtnVisible`）。
4. **覆盖层排除内聚到 BaseProvider**：所有 provider 都应排除 `#tokfree-*` 元素，这件事由基类/公共辅助统一处理，避免每个 provider 重复写。
5. **选择器与逻辑分离**：能用"声明式选择器 + 通用算法"覆盖的，就不要求 provider 写代码。

### 2.2 分层接口（三组）

新增三组接口，**按平台覆盖程度分级**：

#### 组 A：附件能力（AttachmentCapability）
```ts
interface AttachmentCapability {
  /** 扫描页面"待发送附件"（只读）。
   *  @returns Array<{name, kind: 'file'|'image', thumb?: string}>
   *  未实现 → 公共层用通用启发式（见 3.2）。 */
  readPendingAttachments?(): Array<PendingAttachment> | Promise<Array<PendingAttachment>>;

  /** 按名移除一个待发附件。
   *  @returns {success, error?}
   *  未实现 → 公共层返回 {success:false, error:'unsupported'}。 */
  removePendingAttachment?(name: string): Promise<RemoveResult>;

  /** 检测"是否有上传中"指示器。
   *  未实现 → 公共层用通用 loading/progress 选择器。 */
  hasUploadingIndicator?(): boolean;

  /** 生成"附件容器扫描范围"（可选优化）：给定输入框，返回应聚焦扫描的祖先容器。
   *  未实现 → 公共层向上爬 6 层找"像 rail"的容器。 */
  getAttachmentScope?(inputEl: Element): Element | null;
}
```

**为什么这样拆**：
- `readPendingAttachments` 是最难抽象的（DeepSeek 只显示"扩展名+体积"、Qwen/ChatGPT 可能用 `<img alt>`），声明式选择器无法覆盖所有形态，必须允许 provider 写 JS。
- 但**绝大多数平台**其实只需覆盖选择器 + 一个判断函数，因此提供**声明式降级**（见 2.4）。

#### 组 B：代码块能力（CodeBlockCapability）
```ts
interface CodeBlockCapability {
  /** 剔除代码块容器里的装饰元素（语言标签/复制按钮/toolbar）后，判断是否只剩代码。
   *  用于 hasOnlyCodeContent（"整条回复只有代码块"判定）。
   *  未实现 → 公共层用通用装饰选择器剔除。 */
  stripCodeBlockDecorations?(container: Element): Element;

  /** 从代码块元素（<pre> 或 div 容器）抽取纯代码文本。
   *  未实现 → 公共层按 code → Monaco .view-line → textContent 三级降级。 */
  extractCodeText?(blockEl: Element): string;

  /** 返回"代码块容器"的选择器列表（用于无 <pre> 的站点，如智谱 .md-code）。
   *  未实现 → 公共层用 ['pre', '.md-code']。 */
  codeBlockSelectors?: string[];
}
```

#### 组 C：会话/DOM 操作能力（SessionDomCapability）
```ts
interface SessionDomCapability {
  /** 重命名远程会话（目前仅 DeepSeek 实现）。
   *  未实现 → 公共层返回 unsupported。 */
  renameRemoteSession?(sessionId: string, newTitle: string): Promise<{success: boolean, error?: string}>;

  /** 返回"历史消息区域"的选择器（用于排除历史附件/历史消息）。
   *  未实现 → 公共层用一份精选的跨平台清单（保留 C9 现状）。 */
  historyMessageSelectors?: string[];

  /** 给定一个元素，判断它是否在 AI 历史消息区（而非输入区）。
   *  未实现 → 公共层用 historyMessageSelectors + closest 判断。 */
  isInHistoryMessage?(el: Element): boolean;
}
```

### 2.3 接口汇总（TypeScript 声明草案）

```ts
// 附件
type PendingAttachment = { name: string; kind: 'file' | 'image'; thumb?: string };
type RemoveResult = { success: boolean; error?: string };

interface ProviderCapabilities {
  // ===== 已有（保留）=====
  findInput?(): Element | null;
  findSendButton?(): Element | null;
  triggerSend?(input: Element): boolean | Promise<boolean>;
  isElementVisible?(el: Element): boolean;
  isGenerating?(): boolean;
  isResponseComplete?(): boolean | Promise<boolean>;
  getMessageCandidates?(): Element[];
  getMessageMarkdown?(el: Element): Element | null;
  isUserMessage?(node: Element): boolean;
  getCodeBlockLanguage?(pre: Element): string;
  isLoginPage?(): boolean;
  isMainInterface?(): boolean;
  extractSessionId?(url: string): string | null;
  matchesUrl?(url: string): boolean;
  extractUserInfo?(): string | Promise<string>;
  getDeepThinkButton?(): Element | null;
  isDeepThinkOn?(): boolean;
  setDeepThink?(on: boolean): {ok:boolean, changed:boolean, available:boolean, error?:string};

  // ===== 新增：组 A 附件 =====
  readPendingAttachments?(): PendingAttachment[] | Promise<PendingAttachment[]>;
  removePendingAttachment?(name: string): Promise<RemoveResult>;
  hasUploadingIndicator?(): boolean;
  getAttachmentScope?(inputEl: Element): Element | null;
  // 声明式降级
  attachmentCardSelectors?: string[];   // "待发附件卡片容器"选择器
  attachmentNameSelectors?: string[];   // "文件名文本"选择器
  attachmentImageSelectors?: string[];  // "图片附件"选择器
  attachmentDeleteSelectors?: string[]; // "删除控件"选择器

  // ===== 新增：组 B 代码块 =====
  stripCodeBlockDecorations?(container: Element): Element;
  extractCodeText?(blockEl: Element): string;
  codeBlockSelectors?: string[];

  // ===== 新增：组 C 会话/DOM =====
  renameRemoteSession?(sessionId: string, newTitle: string): Promise<{success:boolean, error?:string}>;
  historyMessageSelectors?: string[];
  isInHistoryMessage?(el: Element): boolean;
}
```

### 2.4 声明式优先：能配置就不写代码

设计上**优先让 provider 只写选择器**，逻辑由公共层统一算法处理。例如：

```js
// deepseek.js 只需声明
module.exports = {
  id: 'deepseek',
  // ...
  attachmentCardSelectors: ['._25c7358', '.d5fa3d1b'],
  attachmentImageSelectors: ['img[src^="blob:"]', 'img[alt]'],
  attachmentNameSelectors: [], // DeepSeek 用"扩展名+体积"文本，走通用叶子文本识别
  attachmentDeleteSelectors: ['div[tabindex]'], // 配合通用 svg path 判断
  historyMessageSelectors: ['.ds-message'],
  codeBlockSelectors: ['pre', '.md-code'],
  stripCodeBlockDecorations(container) {
    // 可选：DeepSeek 特有装饰更精确剔除
    const clone = container.cloneNode(true);
    clone.querySelectorAll('.md-code-block-banner-wrap, .md-code-block-banner').forEach(el => el.remove());
    return clone;
  },
};
```

公共层 `readPendingAttachments()` 的分派逻辑：
```js
function readPendingAttachments() {
  const provider = getCurrentProvider();
  // 1) 优先用 provider 的完整实现
  if (provider && typeof provider.readPendingAttachments === 'function') {
    return provider.readPendingAttachments();
  }
  // 2) 其次用 provider 的声明式选择器 + 通用算法
  if (provider && (provider.attachmentCardSelectors || provider.attachmentImageSelectors)) {
    return genericScanAttachments(provider);
  }
  // 3) 最后用纯通用启发式（保留现状 C4-C14，但去掉 DeepSeek 专属部分）
  return genericScanAttachments(null);
}
```

---

## 三、向后兼容策略（未实现新接口时优雅降级）

### 3.1 四级降级链

对每个新接口，公共层按以下顺序尝试：

```
Level 1: provider.<方法>()        —— provider 完整实现
Level 2: provider.<选择器> + 通用算法  —— provider 只声明选择器
Level 3: 公共层通用启发式          —— 无 provider 信息时用一份精选的跨平台清单
Level 4: 返回"不可用"占位          —— {success:false} / [] / null（绝不抛错）
```

### 3.2 逐接口降级规则

| 接口 | Level 1（provider 实现）| Level 2（provider 选择器）| Level 3（通用启发式）| Level 4（占位）|
|------|------|------|------|------|
| `readPendingAttachments` | 调 provider | 用 `attachment*Selectors` + 通用扫描 | 保留现状 C4-C14（去掉 DeepSeek 专属部分） | `[]` |
| `removePendingAttachment` | 调 provider | 用选择器定位卡片 + 通用删除 | 现状逻辑（保留但去掉 `._25c7358` 等） | `{success:false, error:'unsupported'}` |
| `hasUploadingIndicator` | 调 provider | — | 现状 C7 通用选择器 | `false` |
| `getAttachmentScope` | 调 provider | — | 向上爬 6 层找"像 rail"容器 | `document` |
| `stripCodeBlockDecorations` | 调 provider | — | 现状 J3 通用装饰选择器（去掉 `.md-code-*`） | 原样返回 |
| `extractCodeText` | 调 provider | — | 现状 J4-J6 三级降级（code → Monaco → textContent） | `''` |
| `codeBlockSelectors` | — | 用 provider 选择器 | `['pre', '.md-code']` | `['pre']` |
| `renameRemoteSession` | 调 provider | — | `{success:false, error:'unsupported'}` | 同左 |
| `historyMessageSelectors` | — | 用 provider 选择器 | 保留现状 C9 精选清单 | `[]` |
| `isInHistoryMessage` | 调 provider | 用 `historyMessageSelectors` | 同左 | `false` |

### 3.3 兼容性保证

1. **API 零破坏**：现有 `module.exports` 导出的函数签名**全部不变**（`sendToChat` / `findInputArea` / `readPendingAttachments` 等），只是内部实现改为"先问 provider"。调用方（observer.js / intercept-observer.js 等）无需改动。
2. **内建 provider 逐个升级**：先迁 DeepSeek（硬编码最多），再迁 Qwen / 智谱 / ChatGPT / Claude。迁移期间旧平台走 Level 3 通用启发式，功能与现状**等价**（因为通用启发式就是从现状提炼的）。
3. **自定义 provider 不强制**：`provider.template.js` 里新增字段全部标 `?` 可选，老用户的自定义 provider 不加任何字段也能跑。
4. **异常隔离**：所有 provider 方法调用包在 `try/catch` 里，provider 抛错 → `console.warn` + 降级到下一级，绝不冒泡到主流程（参照现有 `getDeepThinkButton` / `triggerSend` 的容错风格）。

### 3.4 兜底辅助函数（公共层新增）

```js
// src/preload/dom/provider-bridge.js（新文件）
function callProvider(method, args, fallback) {
  try {
    const provider = getCurrentProvider();
    if (provider && typeof provider[method] === 'function') {
      return provider[method].apply(provider, args);
    }
  } catch (e) {
    console.warn('[TokFree] provider.' + method + ' 异常，降级:', e && e.message);
  }
  return typeof fallback === 'function' ? fallback() : fallback;
}
```

这样 chat-input.js 里原本硬编码的逻辑，可以一行改成：
```js
// 旧：var list = readPendingAttachments();  // 内部硬编码 DeepSeek
// 新：
var list = callProvider('readPendingAttachments', [], function() {
  return genericScanAttachments(getCurrentProvider());
});
```

---

## 四、迁移映射表（硬编码 → 目标位置）

| 硬编码点 | 行号 | 迁移目标 | 目标形态 |
|---------|------|---------|---------|
| C1（ChatGPT 分段 Paste） | 76-92 | `provider.contentEditablePasteChunkSize?` | 声明式字段（默认 6000） |
| C4-C8（附件计数/上传态） | 486-516 | `provider.readPendingAttachments?` + `hasUploadingIndicator?` | 接口 + 通用兜底 |
| C9（历史消息选择器） | 957, 1142 | `provider.historyMessageSelectors?` | 声明式数组 |
| C10-C14（删除/扩展名/上传态） | 964-1072 | `provider.attachment*Selectors?` | 声明式数组 |
| C11/C17/C20/C22（DeepSeek 卡片类名/svg path） | 966, 1135, 1163, 1227 | `deepseek.js` 的 `attachment*Selectors` + `removePendingAttachment?` | DeepSeek provider 实现 |
| C15-C21（removePendingAttachment 全套） | 1113-1275 | `provider.removePendingAttachment?` | 接口 |
| C23（renameRemoteSession DeepSeek） | 1295-1350 | `provider.renameRemoteSession?`（仅 deepseek.js 实现） | 接口 |
| J3（装饰元素剔除） | 115 | `provider.stripCodeBlockDecorations?` | 接口 |
| J4-J6（Monaco/Qwen/智谱代码抽取） | 128-159 | `provider.extractCodeText?` + `codeBlockSelectors?` | 接口 + 声明式 |
| C2/C3/C26（覆盖层排除） | 234, 242, 719 | 公共层 `isInTokFreeOverlay()`（保留，不下放） | 保留在公共层 |

### 迁移后文件职责

```
src/preload/dom/chat-input.js（瘦身后）
  ├─ 流程控制：防抖合并、发送确认、重试、焦点保护  ← 保留
  ├─ provider 分派：callProvider(...)              ← 新增桥接
  └─ 通用兜底：genericScanAttachments 等            ← 从现状提炼

src/preload/dom/js-detector.js（瘦身后）
  ├─ 代码块提取流程（围栏解析、工具识别）           ← 保留
  └─ provider 分派：extractCodeText / strip...     ← 新增桥接

src/providers/deepseek.js（加厚）
  ├─ 现有：findInput / triggerSend / getDeepThinkButton...
  └─ 新增：attachment*Selectors / removePendingAttachment
           / renameRemoteSession / historyMessageSelectors
           / extractCodeText / stripCodeBlockDecorations

src/providers/qwen.js（加厚）
  └─ 新增：extractCodeText（Monaco .view-line）/ codeBlockSelectors

src/providers/zhipu.js（加厚）
  └─ 新增：codeBlockSelectors（.md-code）/ extractCodeText

src/providers/chatgpt.js / claude.js
  └─ 新增：historyMessageSelectors（[data-message-author-role] / [class*="message-row"]）
```

---

## 五、实施路线（分阶段，风险可控）

### 阶段 1：基础设施（不改行为）
- 新建 `src/preload/dom/provider-bridge.js`，提供 `callProvider(method, args, fallback)`。
- 扩展 `provider.d.ts` 与 `provider.template.js`，加入新接口（全部 optional）。
- **不触碰** chat-input.js / js-detector.js 逻辑。

### 阶段 2：代码块能力迁移（低风险，独立）
- 在 `js-detector.js` 的 `hasOnlyCodeContent / extractCodeText` 加 provider 分派。
- 迁移 DeepSeek / Qwen / 智谱的代码块逻辑到各自 provider。
- 保留通用兜底为 Level 3。

### 阶段 3：附件能力迁移（中风险，DeepSeek 先行）
- 提取现状逻辑为 `genericScanAttachments(provider)`（Level 3 通用函数）。
- `deepseek.js` 实现 `readPendingAttachments / removePendingAttachment / attachment*Selectors`。
- chat-input.js 改为 `callProvider(...)`。
- 回归测试：DeepSeek 窗口读附件 chip、点 × 删除。

### 阶段 4：会话/DOM 能力迁移（中风险）
- `renameRemoteSession` 迁到 `deepseek.js`。
- `historyMessageSelectors` 迁到各 provider。

### 阶段 5：清理
- 删除 chat-input.js / js-detector.js 里已迁移的硬编码（保留通用兜底）。
- 更新 `provider.template.js` 文档与注释。

---

## 六、风险与注意事项

1. **【主进程/preload 改动需重启生效】**：chat-input.js / js-detector.js 是 preload 脚本，只在应用启动时加载一次。迁移后必须重启应用验收。
2. **【provider 方法序列化问题】**：`login-manager` 会把部分方法序列化后在页面上下文执行（见 deepseek.js 第 452-453 行注释）。新增的附件/代码块方法若被序列化，**不能依赖闭包变量**，需用 `this` 调同对象方法。建议：附件/代码块方法目前**不需要被序列化**（只在 preload 世界内调用），但要写清注释避免后人误用。
3. **【DeepSeek 卡片类名会变】**：`._25c7358` / `.d5fa3d1b` 是 hash class，DeepSeek 改版即失效。迁移后应**同时保留**"通用叶子文本识别"作为 Level 2 兜底（现状 C11 EXT_SIZE_RE 就是干这个的），不依赖 hash class 为主路径。
4. **【provider 返回 Promise vs 同步】**：`readPendingAttachmentsAsync` 目前是 async（要转 blob → dataURL）。接口设计允许 `readPendingAttachments` 返回 `Promise`，公共层需统一 `await`。
5. **【测试覆盖】**：迁移需同步补充 `test/preload/` 下针对 provider 分派/降级的单测（现状无此类测试）。

---

## 七、验收标准

- [ ] 每个硬编码点（C1-C27, J1-J8）都有明确的迁移目标或"保留"理由。
- [ ] 新接口全部 optional，老自定义 provider 不加字段仍能跑。
- [ ] 四级降级链对每个新接口都有明确规则（见 3.2 表）。
- [ ] DeepSeek / Qwen / 智谱 / ChatGPT / Claude 的迁移归属清晰。
- [ ] 迁移后 `chat-input.js` 行数显著下降，平台细节下沉到 providers。

---

*本文档仅做调研与设计，未修改任何代码。*
