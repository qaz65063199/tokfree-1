# Hooks 事件系统

给 TokFree 的工具调用加**可插拔的扩展点**：你可以在工具执行前后插入自己的脚本，
做拦截、审计、追加提示、改写输入等——而无需修改 TokFree 本身。设计借鉴自 ZCode 的 Hook 协议。

## 1. Hooks 放哪

配置文件路径：`<userData>/hooks.json`
（`userData` 是应用的本地数据目录，可在应用内查看，Windows 通常在 `%APPDATA%\tokfree-session`。）

- **没有 hooks.json 时**：Hooks 系统零开销，工具行为完全不变。
- **解析失败 / 无匹配 hook**：一律放行（失败不影响正常使用）。

可参考示例文件 `.tokfreeCode/hooks.example.json`，复制为 `hooks.json` 后按需修改。

## 2. 事件

| 事件 | 触发时机 |
|------|---------|
| `PreToolUse` | 工具**执行前**。可放行 / 阻断 / 要求人工确认 / 改写输入。 |
| `PostToolUse` | 工具**执行后**。可追加上下文、记录日志（不能阻断已发生的操作）。 |

## 3. matcher 语法

`matcher` 是**工具名的正则**，用来决定哪些工具会触发该 hook：

- 不填 / 空串 `""` / `"*"` → 匹配**全部**工具
- `"write|edit"` → 匹配 write 或 edit
- `"bash"` → 只匹配 bash
- 非法正则会被跳过（该 hook 不生效，其余照常）

## 4. Hook 协议

TokFree 会把事件负载作为**一行 JSON** 写到 hook 子进程的 stdin，然后根据**退出码**和 **stdout** 判断结果：

**stdin 输入**（示例）：
```json
{"event":"PreToolUse","tool":"write","input":{"file_path":"a.txt","content":"..."}}
```

**退出码**：
| 退出码 | 含义 |
|-------|------|
| `0` | 放行（stdout 若为 JSON，可读取下方字段）|
| `2` | 阻断（reason 取自 stdout JSON 的 reason，或 stdout/stderr 原文）|
| 其他 | 视为失败 → 放行 |

**stdout JSON 字段**（仅在退出码 0 时解析）：
| 字段 | 类型 | 说明 |
|------|------|------|
| `decision` | `"allow" \| "deny" \| "ask"` | 允许 / 拒绝 / 请求人工确认 |
| `reason` | string | 拒绝或询问时展示给用户的原因 |
| `additionalContext` | string | 追加到工具结果中的上下文（多个 hook 会拼接）|
| `modifiedInput` | object | 改写工具输入（多个 hook 会合并）|

多个 hook 同时匹配时的聚合规则：任一 `deny` 立即拒绝；任一 `ask` 立即询问；否则 `additionalContext` 依次拼接、`modifiedInput` 依次合并。

## 5. 三个实用示例

### 示例① 禁止修改 .env
```json
{
  "PreToolUse": [
    { "matcher": "write|edit", "command": "node .tokfreeCode/hooks/example-pre-hook.js" }
  ]
}
```
脚本逻辑：write/edit 且 `input.file_path` 含 `.env` → `exit 2` 并输出 `{"reason":"禁止修改 .env 文件"}`，否则放行。
（完整脚本见 `.tokfreeCode/hooks/example-pre-hook.js`。）

### 示例② 每次 bash 后追加上下文
```json
{
  "PostToolUse": [
    { "matcher": "bash", "command": "node .tokfreeCode/hooks/example-post-hook.js" }
  ]
}
```
脚本在 stdout 输出 `{"decision":"allow","additionalContext":"..."}`，这段文字会附加到工具结果里，
相当于给 AI 一个额外的提醒（例如"记得检查退出码"）。

### 示例③ 对某类工具请求人工确认
```json
{
  "PreToolUse": [
    { "matcher": "bash", "command": "node .tokfreeCode/hooks/confirm-hook.js" }
  ]
}
```
脚本在检测到危险命令时输出 `{"decision":"ask","reason":"该命令疑似危险，请确认"}` 并 `exit 0`，
TokFree 会弹出确认回环，由用户决定是否继续。

## 6. 安全说明

- **无配置时零开销**：没有 hooks.json / 无匹配 hook 时，Hooks 系统直接短路，不影响任何工具调用。
- **超时 / 异常一律放行**：hook 执行超过默认 10 秒、spawn 失败、JSON 解析失败等，全部按"放行"处理，
  绝不会因 hook 故障而卡死或阻断正常操作。
- **不改动现有安全逻辑**：Hooks 是在 tool-policy / tool-confirm / dangerous-commands / command-policy
  之外的**额外**扩展点，不会绕过内置安全检查。
