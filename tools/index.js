/**
 * 工具库统一入口
 * 导出所有可用工具（主进程注册工具的唯一入口，与 src/main/tool-registry.js 配套）
 */
const { ToolRegistry } = require('./ToolRegistry');
const { JsRunner } = require('./JsRunner');
const { FileWriteTool } = require('./FileWriteTool');
const { WriteTool } = require('./WriteTool');
const { FileReadTool } = require('./FileReadTool');
const { ReadTool } = require('./ReadTool');
const { ReadLinesTool } = require('./ReadLinesTool');
const { FileEditTool } = require('./FileEditTool');
const { EditTool } = require('./EditTool');
const { GlobTool } = require('./GlobTool');
const { GlobToolNew } = require('./GlobToolNew');
const { GrepTool } = require('./GrepTool');
const { GrepToolNew } = require('./GrepToolNew');
const { TodoWriteTool } = require('./TodoWriteTool');
const { BashTool } = require('./BashTool');
const { PwshTool } = require('./PwshTool');
const { FileDeleteTool } = require('./FileDeleteTool');
const { WebFetchTool } = require('./WebFetchTool');
const { MySQLTool } = require('./MySQLTool');
const { OpenBrowserWindowTool } = require('./OpenBrowserWindowTool');
const { InjectJSTool } = require('./InjectJSTool');
const { McpCallTool } = require('./McpCallTool');
const { McpListServersTool, McpGetToolsTool } = require('./McpQueryTools');
const { OpenShardXBrowserTool, ReadShardXPageTool, CloseShardXBrowserTool } = require('./ShardXBrowserTool');
const { TeamListWorkersTool, TeamGetWorkersStatusTool, TeamDispatchTaskTool, TeamDispatchBatchTool, TeamGetTaskStatusTool, TeamGetProgressTool, TeamCreateWindowTool, TeamShowDispatchUITool, TeamReadInboxTool, TeamReplyToWorkerTool, TeamCancelTaskTool, TeamPlanCreateTool, TeamPlanStatusTool, TeamPlanClearTool, TeamPlanModuleDoneTool } = require('./TeamTools');
const { WatchdogHeartbeatTool, WatchdogBusyTool, WatchdogClearBusyTool, WatchdogStatusTool } = require('./WatchdogTools');
const { HumanMoveTool, HumanClickTool, HumanTypeTool, HumanScrollTool } = require('./HumanizeTools');
const { SkillListTool, SkillListEnabledTool, SkillReadTool, SkillCreateTool, SkillUpdateTool, SkillDeleteTool, SkillEnableTool, SkillDisableTool, SkillVersionListTool, SkillVersionRestoreTool, PreferenceReadTool, PreferenceAppendTool } = require('./SkillTools');
const { LessonRecordTool, LessonListTool, LessonDeleteTool, LessonSearchTool } = require('./LessonTools');
const { ObservationAddTool, ObservationListTool, ObservationMergeTool } = require('./ObservationTools');
const { ScreenshotTool } = require('./ScreenshotTool');
const { AttachFileTool } = require('./AttachFileTool');
const { AutoTraceListTool, AutoTraceGetTool, AutoRetrospectTool, AutoSkillForgeTool, AutoSkillForgeCommitTool, AutoSkillStatsTool, AutoSkillArchivePassTool, AutoSkillRecordUsageTool, AutoMetaRecordTool, AutoMetaAnalyzeTool, AutoMetaVersionTool, AutoMetaBumpTool, AutoGoalCreateTool, AutoGoalListTool, AutoGoalStatusTool, AutoGoalRoundTool, AutoGoalAbortTool } = require('./AutoEngTools');
const { CheckpointListTool, CheckpointRestoreTool } = require('./CheckpointTool');

// 创建全局工具注册表
const registry = new ToolRegistry();

// 注册所有工具
registry.register(new FileWriteTool());
registry.register(new WriteTool());
registry.register(new FileReadTool());
registry.register(new ReadTool());
registry.register(new ReadLinesTool());
registry.register(new FileEditTool());
registry.register(new EditTool());
registry.register(new GlobTool());
registry.register(new GlobToolNew());
registry.register(new GrepTool());
registry.register(new GrepToolNew());
registry.register(new TodoWriteTool());
registry.register(new BashTool());
registry.register(new PwshTool());
registry.register(new FileDeleteTool());
registry.register(new WebFetchTool());
registry.register(new MySQLTool());
registry.register(new OpenBrowserWindowTool());
registry.register(new InjectJSTool());
registry.register(new McpCallTool());
registry.register(new McpListServersTool());
registry.register(new McpGetToolsTool());
registry.register(new OpenShardXBrowserTool());
registry.register(new ReadShardXPageTool());
registry.register(new CloseShardXBrowserTool());
registry.register(new TeamListWorkersTool());
registry.register(new TeamGetWorkersStatusTool());
registry.register(new TeamDispatchTaskTool());
registry.register(new TeamDispatchBatchTool());
registry.register(new TeamGetTaskStatusTool());
registry.register(new TeamGetProgressTool());
registry.register(new TeamCreateWindowTool());
registry.register(new TeamShowDispatchUITool());
registry.register(new TeamReadInboxTool());
registry.register(new TeamReplyToWorkerTool());
registry.register(new TeamCancelTaskTool());
registry.register(new TeamPlanCreateTool());
registry.register(new TeamPlanStatusTool());
registry.register(new TeamPlanClearTool());
registry.register(new TeamPlanModuleDoneTool());
registry.register(new WatchdogHeartbeatTool());
registry.register(new WatchdogBusyTool());
registry.register(new WatchdogClearBusyTool());
registry.register(new WatchdogStatusTool());
registry.register(new SkillListTool());
registry.register(new SkillListEnabledTool());
registry.register(new SkillReadTool());
registry.register(new SkillCreateTool());
registry.register(new SkillUpdateTool());
registry.register(new SkillDeleteTool());
registry.register(new SkillEnableTool());
registry.register(new SkillDisableTool());
registry.register(new SkillVersionListTool());
registry.register(new SkillVersionRestoreTool());
registry.register(new PreferenceReadTool());
registry.register(new PreferenceAppendTool());
registry.register(new LessonRecordTool());
registry.register(new LessonListTool());
registry.register(new LessonDeleteTool());
registry.register(new LessonSearchTool());
registry.register(new ObservationAddTool());
registry.register(new ObservationListTool());
registry.register(new ObservationMergeTool());
registry.register(new HumanMoveTool());
registry.register(new HumanClickTool());
registry.register(new HumanTypeTool());
registry.register(new HumanScrollTool());
registry.register(new ScreenshotTool());
registry.register(new AttachFileTool());
registry.register(new AutoTraceListTool());
registry.register(new AutoTraceGetTool());
registry.register(new AutoRetrospectTool());
registry.register(new AutoSkillForgeTool());
registry.register(new AutoSkillForgeCommitTool());
registry.register(new AutoSkillStatsTool());
registry.register(new AutoSkillArchivePassTool());
registry.register(new AutoSkillRecordUsageTool());
registry.register(new AutoMetaRecordTool());
registry.register(new AutoMetaAnalyzeTool());
registry.register(new AutoMetaVersionTool());
registry.register(new AutoMetaBumpTool());
registry.register(new AutoGoalCreateTool());
registry.register(new AutoGoalListTool());
registry.register(new AutoGoalStatusTool());
registry.register(new AutoGoalRoundTool());
registry.register(new AutoGoalAbortTool());
registry.register(new CheckpointListTool());
registry.register(new CheckpointRestoreTool());

// 导出
module.exports = {
  ToolRegistry,
  JsRunner,
  registry,
  FileWriteTool,
  WriteTool,
  FileReadTool,
  ReadLinesTool,
  FileEditTool,
  EditTool,
  GlobTool,
  GlobToolNew,
  GrepTool,
  GrepToolNew,
  TodoWriteTool,
  BashTool,
  PwshTool,
  FileDeleteTool,
  WebFetchTool,
  // 便捷方法
  getAllTools: () => registry,
  getToolDescriptions: () => registry.getDescriptions(),
  getFormattedToolsForPrompt: () => registry.getFormattedToolsForPrompt(),
  executeTool: (name, params) => registry.execute(name, params)
};

