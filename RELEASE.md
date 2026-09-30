# TokFree 发版手册（R2 自动更新）

本手册描述如何发布新版本，并通过 **Cloudflare R2** 分发自动更新。

> 更新机制：electron-updater + **generic provider**，更新检查地址为 https://dl.tokfree.win/
> 说明：generic provider 不会自动上传（electron-builder 不知道往哪传），所以发版流程是
> **本地打包 → 手动上传到 R2**。

---

## 一、完整发版流程

### 1. 递增版本号

编辑 `package.json` 的 `version`（**必须递增**，且大于用户当前版本，否则不触发更新）：

```diff
- "version": "0.3.8",
+ "version": "0.3.9",
```

### 2. 本地打包（不上传）

```bash
npm run build:win:local
```

产物输出到 `dist/`。

### 3. 确认产物

`dist/` 下应至少包含：

- `tokfree-win-v0.3.9.exe`（NSIS 安装包）
- `latest.yml`（**更新清单，必需**）
- `*.blockmap`（增量更新，可选）

> ⚠️ Portable 版（`*-portable.exe`）**不支持**自动更新，仅 NSIS 安装版支持。

### 4. 上传到 R2

**方式 A（推荐）：一键脚本（S3 API，无需安装 wrangler）**

首次使用：复制 `.env.example` 为 `.env`，填入 R2 密钥（`.env` 已被 gitignore，不会泄露）：

```bash
cp .env.example .env
# 编辑 .env 填入 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
```

> 密钥创建：Cloudflare → R2 → **Manage R2 API Tokens** → 创建 token（选 **Object Read & Write**），
> 会得到 Access Key ID 与 Secret Access Key。Account ID 在 R2 控制台右侧。

（可选）先验证将上传哪些文件，**不真正上传**：

```bash
npm run upload:r2 -- --dry-run
```

确认无误后真正上传：

```bash
npm run upload:r2
```

脚本用 `@aws-sdk/client-s3` 把 `dist/` 里的 `*.exe`、`latest.yml`、`*.blockmap` 上传到 R2。

> ⚠️ **对象必须放在桶根目录（不加前缀）**：electron-updater 的 generic provider 会请求
> `https://dl.tokfree.win/latest.yml`，且 latest.yml 里的文件名是相对路径。
> 若设置 `R2_PREFIX`，更新将失败（除非同步修改 `package.json` 的 publish url）。

**方式 B：Cloudflare Dashboard 手动拖拽（不想配密钥时可用）**

打开 R2 桶 → 上传对象 → 把 `dist/` 下的 `latest.yml`、`*.exe`、`*.blockmap` 拖上去。
同样必须放在**桶根目录**，不要放子目录。

### 5. 验证

浏览器打开：

```
https://dl.tokfree.win/latest.yml
```

应能看到新版本号（`version: 0.3.9`）。若看不到，检查 R2 自定义域名是否绑定生效、缓存是否需刷新。

### 6. 用户端验证

重启软件 → 启动 5 秒后自动检查 → 若有新版本，弹窗提示「发现新版本 vX.Y.Z」→ 用户确认下载 → 下载完成提示「立即重启」。

也可手动触发：**设置 → 软件更新 → 检查更新**。

---

## 二、环境变量（upload-r2.js）

配置来源优先级：**环境变量 > 项目根目录 `.env` 文件**。

| 变量 | 必填 | 说明 | 默认 |
| --- | --- | --- | --- |
| `R2_ACCOUNT_ID` | ✅ | R2 账户 ID | 无 |
| `R2_ACCESS_KEY_ID` | ✅ | S3 API Access Key ID | 无 |
| `R2_SECRET_ACCESS_KEY` | ✅ | S3 API Secret Access Key | 无 |
| `R2_BUCKET` | 否 | R2 存储桶名 | `tokfree-dl` |
| `DIST_DIR` | 否 | 产物目录 | `dist` |
| `R2_PREFIX` | 否 | 对象前缀 | 空（**建议留空**） |

`--dry-run`：只打印将要上传的文件清单（bucket / key / 大小 / ContentType），不真正上传，无需密钥。

> **安全**：真实密钥只写在 `.env`（已 gitignore）。`.env.example` 仅占位符，可安全提交。
> **不要**设置 `R2_PREFIX`——否则 latest.yml 不在桶根，electron-updater 找不到（除非改 publish url）。

---

## 三、常见问题

### Q1：Portable 版能自动更新吗？
**不能。** electron-updater 依赖安装器（NSIS）来替换文件。Portable 版是单文件绿色版，无安装流程。用户需手动下载新版 portable exe。

### Q2：macOS 用户能自动更新吗？
自动更新**需要代码签名**（Apple Developer 证书 + 公证）。未签名的 macOS 应用会被 Gatekeeper 拦截，无法静默更新。当前先支持 Windows。

### Q3：GitHub 与 R2 的区别？
- **GitHub Releases**：electron-builder 内置 provider，可 `--publish always` 自动上传。但公开仓库会泄露源码/发布记录。
- **R2（generic provider）**：自定义域名分发，不暴露仓库。代价是 **不能自动上传**，需手动/脚本上传。

### Q4：为什么改完 version 用户没收到更新？
排查顺序：
1. `latest.yml` 是否上传成功（打开 https://dl.tokfree.win/latest.yml 确认）；
2. `latest.yml` 里的 `version` 是否大于用户当前版本；
3. `latest.yml` 里的 `path`/`sha512` 是否与实际 exe 匹配（脚本上传时保持一致）；
4. 用户网络能否访问 `dl.tokfree.win`；
5. 用户端日志 `[Updater]` 输出（打包版走 console）。

### Q5：更新服务器地址在哪配置？
`package.json` → `build.publish`：

```json
"publish": [
  { "provider": "generic", "url": "https://dl.tokfree.win/" }
]
```

改地址后需重新打包，`app-update.yml` 会随包写入该地址。

### Q6：增量更新（blockmap）有必要吗？
有。`*.blockmap` 让 electron-updater 只下载差异块，显著减小更新体积。建议一并上传（脚本默认包含）。
