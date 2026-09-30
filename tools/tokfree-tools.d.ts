/**
 * TokFree 工具 API（TypeScript 声明）
 *
 * 本文件描述 ```tokfree 代码块中可以调用的全部全局函数与数据类型。
 * 运行时由 tools/JsRunner.js 在受限沙箱中注入这些函数；本声明用于帮助
 * AI 理解调用方式，与运行时行为保持一致。
 *
 * 使用规则速览：
 * - 所有工具函数都是异步的，调用时必须写 await
 * - 相对路径基于全局变量 projectDir（当前项目根目录）解析
 * - 多行文本使用反引号（`）模板字符串，不需要任何转义
 * - 工具出错时抛出异常（Error.message 为错误描述），可用 try/catch 处理；
 *   唯一例外是 bash()/pwsh()：非零退出不抛异常，通过返回文本中的 [exit code] 标记报告
 * - 用 log() 输出中间过程；脚本最后可用 return 返回结果值
 */

/** 当前项目根目录（初始化项目后由系统注入）。未初始化时为 null。 */
declare const projectDir: string | null;

/**
 * 输出中间结果到执行日志（不中断脚本）。
 * 日志内容随执行结果一起回传给 AI。
 * 注意：log() 只在 tokfree 代码块的 JS 层可用。不要在 bash()/pwsh() 的命令字符串内部调用它——那些命令是独立的 shell 脚本，无法访问 JS 函数。
 */
declare function log(...args: unknown[]): void;

// ================= 文件读写 =================

/** read 的选项 */
interface ReadOptions {
  /** 1-based 起始行号，默认 1 */
  offset?: number;
  /** 最大返回行数，默认 2000，上限 2000 */
  limit?: number;
}

/**
 * 读取 UTF-8 文本文件并返回带行号的内容窗口。
 * 通过 offset 和 limit 分段读取大文件。输出为格式化文本：
 * <path>...</path>
 * <type>file</type>
 * <content>
 * 行号: 内容
 * ...
 * (footer 提示是否继续读取)
 * </content>
 * @param filePath 相对（基于项目根目录）或绝对路径
 * @param options 可选，offset/limit
 * @throws 文件不存在、不是文件、offset 越界或读取失败时抛出异常
 */
declare function read(filePath: string, options?: ReadOptions): Promise<string>;

/** readLines 返回的单行数据 */
interface ReadLine {
  /** 1-based 行号 */
  number: number;
  /** 行文本（不含换行符） */
  text: string;
}

/** readLines 的返回结果 */
interface ReadLinesResult {
  /** 窗口内的行数据 */
  lines: ReadLine[];
  /** 文件总行数 */
  totalLines: number;
  /** 本次起始行号 */
  offset: number;
  /** 是否因字节上限被截断 */
  truncatedByBytes: boolean;
}

/**
 * 读取 UTF-8 文本文件并返回结构化行数组，供 AI 在内存中精确处理。
 * @param filePath 相对（基于项目根目录）或绝对路径
 * @param options 可选，offset/limit
 * @throws 文件不存在、不是文件、offset 越界或读取失败时抛出异常
 */
declare function readLines(filePath: string, options?: ReadOptions): Promise<ReadLinesResult>;

/**
 * 创建或完全覆盖 UTF-8 文本文件。
 * 返回格式化 envelope：<path>...</path><type>file</type><content>Created/Updated file</content>
 * @param filePath 相对（基于项目根目录）或绝对路径
 * @param content 完整 UTF-8 文本内容；空字符串合法（写入空文件）
 * @throws 路径为空、写入失败时抛出异常
 */
declare function write(filePath: string, content: string): Promise<string>;

/**
 * 在现有 UTF-8 文本文件中精确替换 old_string 为 new_string。
 * 默认 old_string 必须唯一匹配；多匹配需设置 replaceAll。
 * 返回 Claude-style 确认消息。
 * @param filePath 相对或绝对路径
 * @param oldString 要替换的字面文本
 * @param newString 替换后的字面文本（可空字符串删除匹配）
 * @param replaceAll 是否替换所有匹配，默认 false
 * @param dryRun 是否只预览不写入，默认 false；true 时返回将替换的处数和内容，不修改文件
 * @throws 文件不存在、old_string 未找到、多匹配未设置 replaceAll、old_string===new_string 时抛出异常
 */
declare function edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean, dryRun?: boolean): Promise<string>;

// ================= 搜索 =================

/**
 * 按 glob 模式查找文件路径，返回纯文本路径列表（以 / 分隔，如 "src/utils/a.js"）。
 * 使用 ripgrep，包含隐藏文件和已忽略文件，只排除 VCS 元数据目录（.git、.svn 等）。
 * glob 语法：* 匹配单层内任意字符，** 匹配任意层级目录，? 匹配单个字符。
 * 结果包含 footer：未超限时 "(Found N files)"，超限时 "(Showing M of N paths...)"。
 * @param pattern glob 匹配模式，如 **/*.js、src/**/*.ts、*.json
 * @param searchPath 搜索起始目录（相对路径），默认项目根目录
 * @throws pattern 为空、搜索目录不存在或不是目录时抛出异常
 */
declare function glob(pattern: string, searchPath?: string): Promise<string>;

/** grep 的选项 */
interface GrepOptions {
  /** 搜索起始文件或目录（相对路径基于项目根目录），默认项目根目录 */
  path?: string;
  /** 过滤文件，单个正向 glob（如 "*.ts"、"*.{js,jsx}"），不支持否定和逗号列表 */
  include?: string;
}

/**
 * 用 ripgrep 正则表达式搜索文件内容。
 * 返回纯文本：header（Found N matches）+ 按文件分组的 "Line N: 内容"。
 * 无匹配返回 "No matches found"。
 * @param pattern ripgrep 正则表达式
 * @param options 可选，path/include
 * @throws pattern 为空、include 非法、ripgrep 执行失败时抛出异常
 */
declare function grep(pattern: string, options?: GrepOptions): Promise<string>;

// ================= 命令执行 =================

/** bash 的选项 */
interface BashOptions {
  /** 命令用途说明（清晰、简洁、主动语态，5-10 词） */
  description?: string;
  /** 工作目录（相对路径基于项目根目录），默认项目根目录 */
  workdir?: string;
  /** 超时毫秒数，默认 30000 */
  timeoutMs?: number;
}

/**
 * 执行 shell 命令（Windows 使用 cmd.exe）。
 * 返回纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）。
 * 必须用 log() 方法打印才能看到返回内容。
 * 非零退出不抛异常，通过 [exit code] 标记报告。
 * 危险命令会被安全策略拒绝并抛异常。
 * @param command 要执行的 shell 命令
 * @param options 可选，{ description?: string, workdir?: string, timeoutMs?: number }
 * @returns 纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）
 * @throws 危险命令被安全策略拒绝时抛出异常
 */
declare function bash(command: string, options?: BashOptions): Promise<string>;

/** pwsh 的选项 */
interface PwshOptions {
  /** 命令用途说明（清晰、简洁、主动语态，5-10 词） */
  description?: string;
  /** 工作目录（相对路径基于项目根目录），默认项目根目录 */
  workdir?: string;
  /** 超时毫秒数，默认 30000 */
  timeoutMs?: number;
}

/**
 * 执行 PowerShell 命令（powershell -NoProfile -Command）。
 * 返回纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）。
 * 必须用 log() 方法打印才能看到返回内容。
 * 非零退出不抛异常，通过 [exit code] 标记报告。
 * 危险命令会被安全策略拒绝并抛异常。
 * @param command 要执行的 PowerShell 命令
 * @param options 可选，{ description?: string, workdir?: string, timeoutMs?: number }
 * @returns 纯文本：stdout + [stderr] 分节 + 状态标记（[exit code]、[timed out]）
 * @throws 危险命令被安全策略拒绝时抛出异常
 */
declare function pwsh(command: string, options?: PwshOptions): Promise<string>;

// ================= 任务管理 =================

/** todo 条目状态 */
type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** todo 条目 */
interface TodoItem {
  /** 任务内容，简短的祈使句 */
  content: string;
  /** pending（未开始）| in_progress（进行中）| completed（已完成） */
  status: TodoStatus;
}

/**
 * 记录并更新当前工作的结构化任务列表。
 * 每次发送完整列表，替换之前的列表（无部分更新）。
 * 串行模式：最多一条 in_progress。
 * @param todos 完整任务列表
 * @returns 统计确认消息，如 "Updated todo list: 2 pending, 1 in progress, 0 completed."
 * @throws content 为空、重复、状态非法、超过一条 in_progress 时抛出异常
 */
declare function todoWrite(todos: TodoItem[]): Promise<string>;

// ================= 删除 =================

/** deleteFile 的返回值 */
interface FileDeleteResult {
  message: string;
  /** 被删除文件的绝对路径 */
  path: string;
}

/**
 * 删除指定文件（不可恢复，请谨慎使用；只能删除文件，不能删除目录）。
 * @throws 文件不存在或路径不是文件时抛出异常
 */
declare function deleteFile(filePath: string): Promise<FileDeleteResult>;

// ================= MySQL =================

/** MySQL 连接与查询参数 */
interface MySQLOptions {
  /** MySQL 主机地址，默认 localhost */
  host?: string;
  /** MySQL 端口，默认 3306 */
  port?: number;
  /** 用户名 */
  user: string;
  /** 密码 */
  password?: string;
  /** 数据库名 */
  database: string;
  /** 要执行的 SQL 语句 */
  sql: string;
  /** SELECT 返回行数上限，默认 100，最大 1000 */
  limit?: number;
}

/**
 * 执行 MySQL SQL 语句。
 * SELECT/SHOW/DESCRIBE/EXPLAIN 等查询返回纯文本表格；
 * INSERT/UPDATE/DELETE/DDL 返回 affectedRows 等执行统计。
 * @param options 连接参数 + sql
 * @returns 纯文本表格（查询）或执行统计（写操作）
 * @throws 连接失败、SQL 错误时抛出异常
 */
declare function mysql(options: MySQLOptions): Promise<string>;

// ================= WebFetch =================

/**
 * 获取指定 HTTP(S) URL 的内容并解码为文本。
 * HTML 会转换为 Markdown（turndown + GFM）。
 * 返回纯文本：Fetched <url> (HTTP <status>) + 正文。
 * 内容超过上限（约 20000 字符）会截断并附 footer。
 * @param url 要获取的 HTTP(S) URL
 * @throws URL 为空、非 http/https、请求超时或失败时抛出异常
 */
declare function webFetch(url: string): Promise<string>;

/**
 * 打开一个 Electron 浏览器窗口并返回窗口 ID。 打开浏览器后可以使用 injectJS 工具对窗口内容注入js , 以具备操控网页能力
 * @param url 要打开的网页 URL
 * @param options 可选，{ id?: string, width?: number, height?: number }
 * @returns 返回 { windowId: string, message: string }，用返回的 windowId 传给 injectJS
 */
declare function openBrowserWindow(url: string, options?: { id?: string; width?: number; height?: number }): Promise<any>;

/**
 * 向指定窗口注入 JS 代码并返回执行结果（支持 async/await）。 如果需要可以使用js模拟点击等任何操作.
 * @param windowId 目标窗口 ID
 * @param code 要注入的 JS 代码（支持 await，返回值会被返回）
 * @returns JS 执行结果
 */
declare function injectJS(windowId: string, code: string): Promise<any>;

// ================= 行为拟人化（真实输入事件） =================

/**
 * 沿贝塞尔轨迹移动鼠标到指定坐标（发送真实 mouseMove 输入事件，isTrusted=true）。
 * @param windowId 目标窗口 ID
 * @param x 目标 x（视口坐标）
 * @param y 目标 y（视口坐标）
 * @param opts 可选，{ speed?: 'fast' | 'normal' | 'slow' }
 */
declare function human_move(windowId: string, x: number, y: number, opts?: { speed?: 'fast' | 'normal' | 'slow' }): Promise<any>;

/**
 * 拟人点击：移动到目标（CSS 选择器或 {x,y}）→停顿→mouseDown→延迟→mouseUp。
 * @param windowId 目标窗口 ID
 * @param target CSS 选择器字符串，或 { x, y } 坐标对象
 * @param opts 可选，{ speed?: 'fast' | 'normal' | 'slow' }
 */
declare function human_click(windowId: string, target: string | { x: number; y: number }, opts?: { speed?: 'fast' | 'normal' | 'slow' }): Promise<any>;

/**
 * 拟人输入文本：按打字节奏逐字符发送真实按键事件。
 * @param windowId 目标窗口 ID
 * @param text 要输入的文本
 * @param opts 可选，{ selector?: string; speed?: 'fast' | 'normal' | 'slow' }
 */
declare function human_type(windowId: string, text: string, opts?: { selector?: string; speed?: 'fast' | 'normal' | 'slow' }): Promise<any>;

/**
 * 拟人滚动：按渐进节奏分步发送真实 mouseWheel 事件。
 * @param windowId 目标窗口 ID
 * @param deltaY 总滚动量（像素）；正数向下，负数向上
 * @param opts 可选，{ speed?: 'fast' | 'normal' | 'slow' }
 */
declare function human_scroll(windowId: string, deltaY: number, opts?: { speed?: 'fast' | 'normal' | 'slow' }): Promise<any>;


// ================= MCP =================

/**
 * 调用 MCP server 提供的工具。
 * 使用前先调用 mcpListServers() 和 mcpGetTools() 查询可用能力。
 * @param server MCP server 名称
 * @param tool 要调用的工具名
 * @param args 工具参数对象
 * @returns 工具执行结果（纯文本）
 * @throws 连接失败、工具不存在或调用出错时抛出异常
 */
declare function mcpCall(server: string, tool: string, args?: Record<string, unknown>): Promise<string>;

/**
 * 列出所有已配置的 MCP server（含启用状态、连接状态和工具数量）。
 * 使用 MCP 前先调用此函数查看当前可用 server。
 * @returns 纯文本 server 列表
 */
declare function mcpListServers(): Promise<string>;

/**
 * 查看指定 MCP server 提供的工具列表（含描述和参数）。
 * 确认工具能力后再调用 mcpCall。
 * @param serverName MCP server 名称
 * @returns 纯文本工具列表
 * @throws server 不存在或连接失败时抛出异常
 */
declare function mcpGetTools(serverName: string): Promise<string>;

// ================= 教训记忆（Reflexion 自进化） =================

/**
 * 记录一条教训（任务失败/被纠正后沉淀，供下次同类任务主动注入提示词）。
 * @param lesson 一句话教训（做什么/别做什么 + 原因）
 * @param context 触发场景（什么任务/什么错误下学到的）
 * @param tags 可选，关键词标签数组
 * @param scope 可选，'global'（默认，跨项目）或 'project'（仅当前项目）
 * @returns 记录结果（含 id）
 */
declare function lesson_record(lesson: string, context: string, tags?: string[], scope?: 'global' | 'project'): Promise<any>;

/**
 * 列出全部教训。
 * @returns { total, lessons }
 */
declare function lesson_list(): Promise<any>;

/**
 * 删除一条教训（不可恢复）。
 * @param id 教训 id
 */
declare function lesson_delete(id: string): Promise<any>;

/**
 * 按关键词检索相关教训（按 scope/tags 匹配排序）。
 * @param keywords 关键词数组
 * @param limit 返回条数上限，默认 5
 * @returns { total, lessons }
 */
declare function lesson_search(keywords: string[], limit?: number): Promise<any>;

// ================= 观察日志（Observational Memory） =================

/**
 * 记录一条观察（决策/偏好/踩坑/待办/上下文），长期沉淀、跨会话注入。
 * @param category 类别（中文合法值）：决策 / 偏好 / 踩坑 / 待办 / 上下文
 * @param summary 观察内容（简明一句话）
 */
declare function observation_add(category: string, summary: string): Promise<any>;

/** 列出本 profile 最近的观察记录（limit 默认 10）。 */
declare function observation_list(limit?: number): Promise<any>;

/** 把累积的观察归纳为一条高层反思（Reflector）。 */
declare function observation_merge(summary: string): Promise<any>;

// ================= 跨项目技能库与全局偏好 =================

/** 列出全部技能（跨项目共享的技能库）。 */
declare function skill_list(): Promise<any>;
/** 列出当前项目已启用的技能。 */
declare function skill_list_enabled(): Promise<any>;
/** 读取某个技能全文。 */
declare function skill_read(name: string): Promise<any>;
/** 创建技能（跨项目共享）。 */
declare function skill_create(name: string, content: string, meta?: { description?: string; tags?: string[] }): Promise<any>;
/** 更新技能（正文/描述/标签）。 */
declare function skill_update(name: string, content?: string, meta?: { description?: string; tags?: string[] }): Promise<any>;
/** 删除技能（不可恢复）。 */
declare function skill_delete(name: string): Promise<any>;
/** 在本项目启用某个技能。 */
declare function skill_enable(name: string): Promise<any>;
/** 在本项目禁用某个技能。 */
declare function skill_disable(name: string): Promise<any>;
/** 列出某技能的历史版本快照。 */
declare function skill_version_list(name: string): Promise<any>;
/** 回退技能到指定历史版本（快照）。 */
declare function skill_version_restore(name: string, version: string): Promise<any>;
/** 读取全局偏好（跨项目生效）。 */
declare function preference_read(): Promise<any>;
/** 追加一条全局偏好（跨项目生效）。 */
declare function preference_append(text: string): Promise<any>;

// ================= 团队协作（多 Agent 编排 / Manager-Worker） =================

/** 列出已打开的 Worker 窗口。 */
declare function team_list_workers(): Promise<any>;
/** 查每个 Worker 的忙/闲状态（派活前先看谁空闲）。 */
declare function team_get_workers_status(): Promise<any>;
/** 派发任务给指定 Worker（自动开新对话 + 初始化项目上下文 + 发送任务）。 */
declare function team_dispatch_task(profileId: string, prompt: string, projectDir?: string, module?: string): Promise<any>;
/** 批量派发任务（无依赖模块并行）。 */
declare function team_dispatch_batch(tasks: Array<{ profileId?: string; providerId?: string; prompt: string; projectDir?: string; module?: string }>): Promise<any>;
/** 汇总当前所有子任务进度。 */
declare function team_get_progress(): Promise<any>;
/** 取消任务。 */
declare function team_cancel_task(taskId: string): Promise<any>;
/** 查单任务状态。 */
declare function team_get_task_status(taskId: string): Promise<any>;
/** 新建 Worker 窗口。 */
declare function team_create_window(providerId: string, name?: string): Promise<any>;
/** 读该任务最新回报。 */
declare function team_read_inbox(taskId: string): Promise<any>;
/** 向该 Worker 追加指令/答疑（不重开对话）。 */
declare function team_reply_to_worker(taskId: string, message: string): Promise<any>;
/** 打开 Worker 调度台 UI。 */
declare function team_show_dispatch_ui(): Promise<any>;
/** 建/更新编排计划（任务 DAG）。 */
declare function team_plan_create(goal: string, modules: Array<{ id?: string; name: string; desc?: string; deps?: string[]; acceptance?: string }>): Promise<any>;
/** 查计划各模块进度。 */
declare function team_plan_status(): Promise<any>;
/** 清空当前计划。 */
declare function team_plan_clear(): Promise<any>;

// ================= 自工程化（自写/自修复/自迭代 Skill） =================

/** 列出最近执行轨迹。 */
declare function auto_trace_list(limit?: number): Promise<any>;
/** 读取某条执行轨迹详情。 */
declare function auto_trace_get(taskId: string): Promise<any>;
/** 复盘某轨迹：返回分析 + 给复盘 Agent 的 Prompt。 */
declare function auto_retrospect(taskId: string): Promise<any>;
/** 从复盘发现生成技能草稿并做沙盒验证（不直接入库）。 */
declare function auto_skill_forge(analysis: any): Promise<any>;
/** 验证通过则入库技能（沙盒验证 ≥80% 才允许）。 */
declare function auto_skill_forge_commit(draft: any): Promise<any>;
/** 看技能使用统计（成功率/耗时）。 */
declare function auto_skill_stats(): Promise<any>;
/** 淘汰长期低效技能（归档可恢复）。 */
declare function auto_skill_archive_pass(): Promise<any>;
/** 记录一次技能使用（成功/失败/耗时）。 */
declare function auto_skill_record_usage(name: string, success: boolean, durationMs?: number): Promise<any>;
/** 元技能进化（Level 3）：记录一次自工程化活动结果。 */
declare function auto_meta_record(activity: string, success: boolean, usefulScore?: number, taskId?: string, note?: string): Promise<any>;
/** 分析"复盘/生成/优化"方法本身是否有效，给出元改进建议。 */
declare function auto_meta_analyze(): Promise<any>;
/** 查看当前元技能（方法）版本与历史。 */
declare function auto_meta_version(): Promise<any>;
/** 升级元技能版本（记录对"方法本身"的改进）。 */
declare function auto_meta_bump(reason: string, patchMethods?: any): Promise<any>;

// ================= 自驱循环（无人干预持续进化） =================

/**
 * 创建自驱循环目标：人类设定一次，系统无人干预持续追到达标。
 * @param title 目标标题
 * @param successCriteria 达标标准数组（每条一个可验证条件）
 * @param maxRounds 最大轮次（默认 20）
 * @param maxMs 最长运行毫秒（默认 6 小时）
 */
declare function auto_goal_create(title: string, successCriteria?: string[], maxRounds?: number, maxMs?: number, testQueries?: string[]): Promise<any>;

/** 列出自驱循环目标及进度。 */
declare function auto_goal_list(status?: string): Promise<any>;

/** 查看目标详情 + 下一轮决策。 */
declare function auto_goal_status(goalId: string): Promise<any>;

/**
 * 记录一轮（执行结果 + 达标证据），系统据此判定是否继续循环。
 * @param criteriaResults 各标准判定 {标准: true/false}
 * @param aiScore AI 自评分 0-1
 * @param actions 本轮做了什么（retrospect/forge/optimize）
 */
declare function auto_goal_round(goalId: string, criteriaResults?: any, aiScore?: number, actions?: string[], note?: string): Promise<any>;

/** 中止自驱循环目标。 */
declare function auto_goal_abort(goalId: string, reason?: string): Promise<any>;

// ================= 看门狗（AI 生命监护） =================
// 适用范围：仅【单聊模式】下 AI 长时间执行任务时使用。
// 多 Agent 模式（总经理）/ 看门狗不可用时：不要依赖看门狗，降级为轮询
// team_get_workers_status() 查看各 Worker 的 generating / currentTaskId / lastActivityAgo 判断进度与卡住。

/** 心跳：刷新监护计时（单聊模式长任务期间调用，避免被误判停顿）。 */
declare function watchdog_heartbeat(): Promise<any>;
/** 标记长任务（期间不打扰，自动续心跳）。 */
declare function watchdog_busy(note?: string, secs?: number): Promise<any>;
/** 清除长任务标记。 */
declare function watchdog_clear_busy(): Promise<any>;
/** 查看看门狗状态。 */
declare function watchdog_status(): Promise<any>;

// ================= 附件与截图 =================

/**
 * 对指定窗口截图并保存为文件。
 * @param windowId 窗口 ID
 * @param filePath 保存路径（可选）
 */
declare function screenshot(windowId: string, filePath?: string): Promise<any>;

/**
 * 把本地文件作为附件上传到当前聊天（AI 可收到图/文件）。
 * @param filePath 本地文件绝对路径
 */
declare function attachFile(filePath: string): Promise<any>;

// ================= 便捷别名（与工具名一一对应） =================

/** readFile 是 read 的别名。 */
declare function readFile(filePath: string, encoding?: string): Promise<string>;
/** readFileWithLines 是 readLines 的别名。 */
declare function readFileWithLines(filePath: string, encoding?: string): Promise<any>;
/** writeFile 是 write 的别名。 */
declare function writeFile(filePath: string, content: string): Promise<string>;
/** editFile 是 edit 的别名。 */
declare function editFile(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<string>;


