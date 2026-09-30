# TokFree

<p align="center">
  <!-- ⚠️ Before pushing to your own repo, replace every YOUR_GITHUB_USERNAME below with your GitHub username (5 badges + 1 clone URL). -->
  <a href="https://github.com/YOUR_GITHUB_USERNAME/tokfree/releases/latest"><img src="https://img.shields.io/github/v/release/YOUR_GITHUB_USERNAME/tokfree?style=flat-square&color=8b93ff" alt="Latest Release"></a>
  <a href="https://github.com/YOUR_GITHUB_USERNAME/tokfree/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/YOUR_GITHUB_USERNAME/tokfree/build.yml?style=flat-square&label=Build" alt="Build Status"></a>
  <a href="https://github.com/YOUR_GITHUB_USERNAME/tokfree/blob/master/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square" alt="License"></a>
  <a href="https://github.com/YOUR_GITHUB_USERNAME/tokfree"><img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-8b93ff?style=flat-square" alt="Platform"></a>
  <a href="https://github.com/YOUR_GITHUB_USERNAME/tokfree"><img src="https://img.shields.io/badge/Electron-33-47848f?style=flat-square&logo=electron&logoColor=white" alt="Electron"></a>
</p>

English | [中文](README.md)

> **TokFree** — a professional edition deeply extended from the open-source project [Cuckoo Code](https://github.com/wangyongpeng90/tokfree). It keeps the "zero-token-cost" DNA and adds multi-agent collaboration, anti-detection browser integration, account pool with auto-login, behavioral humanization, Plan/Act dual mode, lessons memory, event logging, and more — a full toolkit for **long-running, multi-task, anti-detection-critical** scenarios.

**TokFree** is a **zero-token-cost** AI Agent desktop application.

It uses Electron to embed the web versions of AI assistants (DeepSeek, Claude, ChatGPT, Qwen, Zhipu Qingyan, etc.) into a local window and injects a sidebar overlay. The AI is guided by the system prompt to generate tool calls (JavaScript code blocks), which are executed in a restricted sandbox, and the results are sent back to the AI — forming a "think → act → observe → act again" agent loop. The whole flow requires **no API key and incurs no API usage fees** — you use your web account instead of a pay-per-token API.

---

## What's New in Pro

Pro systematically extends the original project across five capability domains:

### 1. Multi-Agent Collaboration (Manager Mode)

- **Master / Worker division of labor**: the master brain handles requirement analysis, task decomposition, dispatch, review, acceptance and decisions; workers (sub-brains) execute subtasks independently
- **Three-level signal protocol**: progress (SYNC) / done (DONE) / ask (ASK), used by the master to track task state
- **Report queue**: return-on-enqueue + taskId dedup + tail-merge (debounce 2s / hard cap 10s) + serial delivery + priority ordering (ASK > DONE > SYNC)
- **Structured worker reports**: workers report against a 6-item template (goal / approach / artifacts / verification / open issues / self-assessment); the master verifies item by item
- **Bidirectional cross-window messaging**: dispatch ack + report confirmation (retry up to 2 times), single-layer confirmation at key nodes only, no recursive confirmation
- **Window status overview**: real-time summary of each window's AI state (idle / thinking / long task / interrupted / rate-limited)

### 2. Anti-Detection & Humanization

- **ShardX anti-detection browser integration**: engine-level patched Chromium with C++-layer fingerprint spoofing, ideal for account registration, multi-account operation, and bypassing risk control
- **Behavioral humanization (real input events)**: `human_move` / `human_click` / `human_type` / `human_scroll` send real input events (`isTrusted=true`) via the main process `sendInputEvent()`, avoiding detection of in-page JS click simulation
  - Bezier mouse trajectories (with overshoot pull-back + micro-jitter)
  - Typing rhythm (per-character + random intervals + occasional typo + backspace)
  - Progressive scrolling, click delay 80-300ms
- **Consistent environment fingerprints**: GPU / WebGL, `window.chrome`, `userAgentData.brands`, request-header alignment, deterministic Canvas/Audio noise — all signals kept consistent
- **Per-window proxy**: `setProxy` / `testProxy` for environment isolation together with fingerprint spoofing

### 3. Account & Login Automation

- **Account pool**: centrally manages platform credentials; passwords are stored encrypted via Electron `safeStorage.encryptString` (degrades to not storing the password if system encryption is unavailable — **never plaintext**)
- **Window-bound accounts**: `profile.account.accountId` points to an account in the pool
- **Auto re-login**: detects login expiry after page load → switches to password login → fills credentials → submits → marks success / shows account picker on failure
- **Login-failure proxy reporting**: when a worker is stuck on the login page, the main process reports on its behalf to the master

### 4. Development Workflow Enhancements

- **Plan / Act dual mode**: Plan mode is read-only (write/execute tools are blocked by the system); Act mode executes normally but dangerous operations require confirmation (a "trust mode" can skip it)
- **Operation confirmation loop**: dangerous operations prompt for confirmation, with a 60s timeout treated as rejection
- **Lessons memory (Reflexion-style)**: lessons are proactively recorded on failure/correction and **actively injected** into the prompt at the start of similar tasks
- **Cross-project knowledge base**: three layers — global preferences + global skills + project knowledge; skills can be enabled across projects
- **Context compaction** (DeepSeek only): on token threshold, auto-generates a handoff summary → share → new session continuation
- **Event log & runtime stats**: records nag / intercept / dispatch / done events; the window panel shows today's summary and recent logs

### 5. Platform Capability Extensions

- **Screenshot & attachments**: `screenshot` / `attachFile` uploads UI screenshots or local files as attachments to multimodal AI
- **Conversation guidance queueing**: completion confirmation, rate-limit protection and silent fallback keep long tasks from stalling
- **Disk cleanup**: cleans session caches and logs
- **Watchdog (AI life guardian)**: graded nagging for true interruption / stalled-no-action / pure silence; rate-limit cooldown; busy long-task protection; power-save blocker
- **MCP & long-term memory**: Claude Desktop compatible config; MemPalace long-term memory with on-demand retrieval

---

## Core Features (Original DNA)

### Zero Token Cost

No AI platform API is called, and no API token is used. It directly reuses the chat capabilities of the web versions, turning a web-based AI into an agent that can perform local operations.

### Multi-Platform Provider Framework

- Built-in **DeepSeek**, **Claude**, **ChatGPT**, **Qwen**, and **Zhipu Qingyan** (chatglm.cn) platforms
- Each platform independently encapsulates differences such as input box location, send button detection, reply completion detection, and message parsing
- You can choose a platform when creating a new window, or **import a custom Provider** (type declarations and templates are provided to lower the barrier to extension)

### A True AI Agent

Not just chat. The AI can read/write files, search code, execute commands, query databases, call MCP tools, and continue based on the execution results, forming a "think → act → observe → act again" agent loop.

---

## Main Features

- **Multi-window management**: each window has an independent profile context without interference
- **Project initialization**: after selecting a project directory, the AI gets the directory tree and system prompt, so operations are based on real project context
- **Tool call system**: the AI can call tools for reading/writing files, searching code, executing commands, querying databases, and more
- **Command interception**: automatically detects cmd / powershell / bash code blocks and executes them after confirmation
- **MCP support**: uses Claude Desktop compatible configuration format and supports stdio / http server types
- **Overlay panel**: shows command previews, execution results, and history; toggle with Ctrl+Shift+C or Esc
- **Automatic retry**: when JS execution fails and the code appears incomplete, it automatically waits 1 second, refetches, and retries (up to 3 times); only reports back to the AI if it still fails
- **Session persistence**: login state and settings are saved to the user data directory
- **Safety mechanisms**: 30-second command timeout, 60-second sandbox timeout, 1MB output buffer, dangerous command confirmation

---

## Installation and Running

### Requirements

- Node.js >= 16.0.0
- npm

### Steps

```bash
# Clone the repository (Pro repo URL; update once independently published)
git clone https://github.com/YOUR_GITHUB_USERNAME/tokfree.git
cd tokfree

# Install dependencies
npm install

# If npm blocks the electron postinstall script (allowScripts), approve it first:
#   npm install-scripts ls
#   npm install-scripts approve electron
#   npm install
# Otherwise the electron binary will not be downloaded and startup will fail.

# Start the app
npm start
```

### Optional: Use the ShardX Anti-Detection Browser

Pro's ShardX integration requires **ShardX Launcher** to be running locally (it exposes a local API). For high anti-detection scenarios, start ShardX Launcher first, then use the related tools in the app.

---

## Usage Guide

1. Launch the app and choose a platform (DeepSeek / Claude / ChatGPT / Qwen / Zhipu / custom Provider)
2. Log in to the corresponding web platform normally (or auto-login from the account pool)
3. Click "Initialize Project" and select a project directory; the AI will get the directory tree and system prompt
4. Chat with the AI and ask it to modify files, run commands, inspect code, etc.
5. Tool calls in AI replies are automatically detected and executed
6. Execution results are automatically sent back to the AI, which continues until the task is complete
7. For complex tasks, switch to **Multi-Agent mode** so the master brain can decompose and dispatch to workers in parallel

### Tool Call Example

When an AI reply contains a `tokfree` code block in the following format, the system executes it in the sandbox and sends the result back to the AI:

````markdown
```tokfree
const content = await read("src/utils/helper.js");
await write("src/utils/helper.js", content.replace("formatDate", "formatTime"));
```
````

---

## Tool System

Supported tools (called through `tokfree` code blocks):

| JS Function | Description |
|----------|----------|
| `read(path, options?)` | Read a text file (line-numbered window) |
| `readLines(path, options?)` | Read a file as a structured line array |
| `write(path, content)` | Create or overwrite a file |
| `edit(path, old, new, replaceAll?, dryRun?)` | Precisely replace file content |
| `glob(pattern, searchPath?)` | Find files by glob pattern |
| `grep(pattern, options?)` | Regex search over file contents |
| `bash(command, options?)` | Execute a shell command (cmd) |
| `pwsh(command, options?)` | Execute a PowerShell command |
| `todoWrite(todos)` | Manage a structured task list |
| `deleteFile(path)` | Delete a file (irreversible) |
| `webFetch(url)` | Fetch HTTP(S) URL content (HTML to Markdown) |
| `mysql(options)` | Execute MySQL SQL |
| `openBrowserWindow(url, options?)` | Open an Electron browser window |
| `injectJS(windowId, code)` | Inject JS into a specified window |
| `screenshot(windowId?)` | Take a screenshot and save as PNG |
| `attachFile(path)` | Upload a local file as an attachment |
| `mcpListServers()` | List configured MCP servers |
| `mcpGetTools(serverName)` | List tools of an MCP server |
| `mcpCall(server, tool, args)` | Call an MCP tool |
| `human_move / human_click / human_type / human_scroll` | Behavioral humanization (real input events) |
| `skill_* / preference_*` | Cross-project knowledge base |
| `lesson_*` | Lessons memory |
| `team_*` | Multi-agent collaboration |
| `watchdog_*` | Watchdog control |
| `log(...args)` | Output intermediate results to the execution log |

All file operations are relative to the currently bound project directory for safety.

---

## MCP Configuration

MCP configuration uses the **Claude Desktop compatible format** (can be shared/imported directly):

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/my-project"]
    }
  }
}
```

Both stdio (command + args) and http (url + headers) types are supported. Enable/disable state is stored separately and does not pollute the main configuration. Open the management panel via the "MCP" button in the overlay.

---

## Custom Provider

Want to integrate a new AI platform? Copy `src/providers/custom/provider.template.js` and fill in according to the template:

- Basic info such as `id` / `name` / `homeUrl`
- Selectors for the input box and send button
- Methods such as `matchesUrl()` and `extractSessionId()`
- Auto-parsing related methods (completion detection, message location, etc.)

See `src/providers/custom/provider.d.ts` for type declarations. Import the JS file from the platform selection page in the app to use it.

---

## Project Structure

```
tokfree/
├── main.js                 # Electron main process entry (thin shell, forwards to src/main/)
├── start.js                # Cross-platform startup script (logs to wyp/log/)
├── src/
│   ├── main/               # Main process (multi-window, IPC, watchdog, event log, account pool, multi-agent)
│   ├── preload/            # Renderer (overlay UI, DOM monitoring, fingerprint spoofing, anti-automation fixes)
│   ├── providers/          # Platform providers
│   └── prompt/             # Per-platform system prompt templates
├── tools/                  # Tool implementations (file/command/search/MCP/humanize/multi-agent/knowledge/lessons/watchdog)
├── test/                   # Unit tests
└── dist/                   # Build output
```

---

## Build and Release

- This repository has GitHub Actions configured. Pushing a `v*` tag automatically builds Windows and macOS installers and publishes them to Releases
- Local manual builds: `npm run build:win:local` or `npm run build:mac:local`
- Build output goes to the `dist/` directory

---

## Roadmap

See [Roadmap.md](Roadmap.md) for the next phase plan.

---

## Contributing

Issues and Pull Requests are welcome.

- Report bugs or suggest new features: Issues
- Submit code: Pull Requests

---

## Credits to the Original Author

**TokFree did not start from scratch — it stands on the shoulders of a giant.**

The entire foundational architecture of this project — the Electron desktop framework, multi-window isolation, overlay UI, Provider framework, tool system, system-prompt engineering, MCP integration, session persistence and more — comes from the open-source project **[Cuckoo Code](https://github.com/wangyongpeng90/tokfree)**. The original author single-handedly built a complete, elegant, and genuinely usable "zero-token-cost AI Agent desktop" solution. Its clean architecture and well-designed extension points are the very foundation on which this project continues to evolve.

Pro adds multi-agent collaboration, ShardX anti-detection browser integration, account pool with auto-login, behavioral humanization, Plan/Act dual mode, lessons memory, event logging, context compaction, and a cross-project knowledge base — but it **does not change the original philosophy**: zero token cost, web UI as agent, all operations in a locally controllable sandbox.

Sincere thanks to the original author **wangyongpeng90** and all [Cuckoo Code contributors](https://github.com/wangyongpeng90/tokfree/graphs/contributors). We also thank [@27584](https://github.com/27584) for framework-level contributions to the Provider send extension interface, streaming stability, custom Provider loading, and MCP tool recognition.

The original project is also licensed under **GNU General Public License v3.0**; TokFree strictly follows the same license and keeps all derivative work open source. If you like this project, please also give the [original project](https://github.com/wangyongpeng90/tokfree) a Star — that is where it all began.

---

## License

This project is licensed under the GNU General Public License v3.0. See the LICENSE file for details.

---

## Acknowledgements

- **wangyongpeng90** and Cuckoo Code contributors: for the entire foundational architecture and the open-source license
- [@27584](https://github.com/27584): framework-level improvements including the Provider send extension interface, dual-channel streaming stability, custom Provider renderer loading, and MCP tool recognition (PR #9)
- DeepSeek, Claude, ChatGPT, Qwen and Zhipu Qingyan for providing powerful AI capabilities
- Electron for the cross-platform desktop framework
- All contributors and users
