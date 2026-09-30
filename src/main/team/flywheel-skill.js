'use strict';

/**
 * 进化飞轮 SOP 技能（Evolution Flywheel）
 *
 * 背景：TokFree 的「自进化飞轮」此前是"自由发挥"引导——给 AI 一堆项目信号就让它
 * 自己想干什么，导致跨项目乱想、乱上传。本模块把飞轮的执行方法固化成一份固定
 * SOP 技能（evolution-flywheel），每次飞轮触发时强制 AI 先读它、按它执行。
 *
 * v2 变更：
 * - SOP 由 5 步改为「分步式 6 步」——每步自包含、只做一件事，便于引导器每次只喂一步；
 * - 新增第 6 步「评估与清理」——每轮结束评估已完成待办/升级，清理淘汰文件；
 * - 第 4 步按模式分流（单 Agent 自己执行 / 多 Agent 建 goal 派发）；
 * - seedSkill 增加版本升级：已存在旧版本 skill 时用 updateSkill 覆盖正文与元数据。
 *
 * 设计：
 * - 纯 Node 模块，惰性 require src/main/knowledge.js（可注入便于测试）。
 * - seedSkill() 幂等：不存在则创建 + 全局启用；已存在但版本旧则升级；已是最新则不动。
 * - 全程 try/catch 容错，失败不抛。
 */

const FLYWHEEL_SKILL_NAME = 'evolution-flywheel';

/** SOP 版本号（用于 seedSkill 判断是否需要升级已安装的旧版 skill） */
const FLYWHEEL_SKILL_VERSION = 2;

/** 版本标记 tag（knowledge 只持久化 description/tags，故版本寄存在 tag 里） */
const FLYWHEEL_SKILL_VERSION_TAG = 'sop-v' + FLYWHEEL_SKILL_VERSION;

/** 从技能 tags 中解析 SOP 版本号（找不到返回 0） */
function versionFromTags(tags) {
  if (!Array.isArray(tags)) return 0;
  for (const t of tags) {
    const m = /^sop-v(\d+)$/.exec(String(t || ''));
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

/** 进化飞轮 SOP 正文（Markdown）· v2 分步版 */
const FLYWHEEL_SKILL_CONTENT = [
  '# 进化飞轮 SOP（Evolution Flywheel）· v2 分步版',
  '',
  '## 使用场景',
  '收到「战略巡检简报」或「自驱循环」指令时，严格按本 SOP 执行。',
  '',
  '## 铁律',
  '- 只针对本项目目录，绝不涉及其他项目。',
  '- 一次只做一步，做完停下来看下一步（不要跳步、不要一次全做完）。',
  '- 每步必须有实际产出。',
  '',
  '## 本飞轮的 6 步总览',
  '1. 网上调研',
  '2. 本地盘点',
  '3. 补充待办',
  '4. 执行（按模式分流）',
  '5. 复盘沉淀',
  '6. 评估与清理',
  '',
  '> 引导器每次只会给你「当前这一步」。做完当前步后，读本 skill 查看下一步，',
  '> 不要自行把 6 步一次做完。',
  '',
  '## 第 1 步 · 网上调研',
  '做什么：用 web_fetch 调研本项目领域/技术栈前沿，至少 2 条可借鉴。',
  '产出：≥2 条借鉴点（含来源 URL）。',
  '做完后：读 skill 查看第 2 步。',
  '',
  '## 第 2 步 · 本地盘点',
  '做什么：git log --oneline -10 + git status（进度与未提交改动）；grep TODO/FIXME（隐患）；看现有待办（todo_write 现状）+ 目录结构。',
  '产出：本项目现状 + 薄弱环节清单。',
  '做完后：读 skill 查看第 3 步。',
  '',
  '## 第 3 步 · 补充待办',
  '做什么：用 todo_write 把「调研差距 + 盘点问题」落成 3-5 条具体可执行待办（每条可判定完成）。',
  '产出：3-5 条带验收标准的待办。',
  '做完后：读 skill 查看第 4 步。',
  '',
  '## 第 4 步 · 执行（按模式分流）',
  '做什么：',
  '- 单 Agent 模式：自己挑最高优先级的一条待办，动手做完并验证。',
  '- 多 Agent 模式：用 auto_goal_create 建目标（带 projectDir），派发给子 Agent 执行。',
  '产出：单 Agent = 一条待办的实际改动 + 验证结果；多 Agent = 一个带 projectDir 的 goal。',
  '做完后：读 skill 查看第 5 步。',
  '',
  '## 第 5 步 · 复盘沉淀',
  '做什么：auto_trace_list → auto_retrospect 复盘；有可复用流程用 auto_skill_forge 沉淀。',
  '产出：复盘结论 +（可选）技能草稿。',
  '做完后：读 skill 查看第 6 步。',
  '',
  '## 第 6 步 · 评估与清理',
  '做什么：',
  '- 评估本轮哪些待办已完成、哪些功能已升级（对照 todo_write 现状与 git 改动）。',
  '- 清理：已淘汰的无关文件、过期目标、临时文件（如 test_out*.txt、checkpoints/ 旧快照）。',
  '- 用 todo_write 更新待办状态（完成项标记）。',
  '产出：一份"已完成/已清理"清单 + 更新后的待办。',
  '完成后：本轮飞轮结束，等待引导器触发下一轮。',
  '',
].join('\n');

/** 技能元数据 */
const FLYWHEEL_SKILL_META = {
  description: '进化飞轮固定 SOP（v2 分步版）：收到战略巡检简报/自驱循环指令时，按 6 步（网上调研→本地盘点→补充待办→执行(单/多Agent分流)→复盘沉淀→评估与清理）分步严格执行，每步自包含、做完读 skill 拿下一步，只针对本项目目录。Use when running the evolution flywheel or self-driven loop.',
  tags: ['flywheel', 'evolution', 'sop', 'self-loop', 'curator', FLYWHEEL_SKILL_VERSION_TAG],
  version: FLYWHEEL_SKILL_VERSION,
};

/**
 * 幂等 seed：确保 evolution-flywheel 技能存在且为最新版本、并全局启用。
 *
 * - 不存在 → createSkill + enableSkillGlobal
 * - 已存在但版本旧（tags 里的 sop-vN < 当前）→ updateSkill 覆盖正文与元数据
 * - 已是最新版本 → 不动（仅确保全局启用）
 *
 * @param {object} [opts]
 *   - knowledge：注入的 knowledge 模块（默认惰性 require src/main/knowledge.js）
 * @returns {{created:boolean, upgraded:boolean, name:string, enabled:boolean, error?:string}}
 */
function seedSkill(opts) {
  const o = opts || {};
  const name = FLYWHEEL_SKILL_NAME;
  try {
    let kb = o.knowledge;
    if (!kb) {
      // 惰性 require：knowledge.js 顶层 require electron，不在测试/非 electron 环境下崩溃
      kb = require('../knowledge');
    }

    if (!kb || typeof kb.createSkill !== 'function') {
      return { created: false, upgraded: false, name, enabled: false, error: 'knowledge.createSkill 不可用' };
    }

    let created = false;
    let upgraded = false;
    const list = typeof kb.listSkills === 'function' ? kb.listSkills() : [];
    const item = Array.isArray(list) ? list.find(function (s) { return s && s.name === name; }) : null;

    if (!item) {
      const res = kb.createSkill(name, FLYWHEEL_SKILL_CONTENT, FLYWHEEL_SKILL_META);
      if (res && res.success) {
        created = true;
      } else if (res && res.error) {
        // 已存在（并发/竞态）视为未创建但不报错
        if (String(res.error).indexOf('已存在') === -1) {
          return { created: false, upgraded: false, name, enabled: false, error: res.error };
        }
      }
    } else {
      // 已存在：检查版本，旧版本则升级
      const cur = versionFromTags(item.tags);
      if (cur < FLYWHEEL_SKILL_VERSION && typeof kb.updateSkill === 'function') {
        const ur = kb.updateSkill(name, FLYWHEEL_SKILL_CONTENT, FLYWHEEL_SKILL_META);
        if (ur && ur.success) {
          upgraded = true;
        } else if (ur && ur.error) {
          return { created: false, upgraded: false, name, enabled: false, error: ur.error };
        }
      }
    }

    // 全局启用（幂等）
    let enabled = false;
    if (typeof kb.enableSkillGlobal === 'function') {
      const er = kb.enableSkillGlobal(name);
      enabled = !!(er && (er.success || er.already));
    }

    return { created, upgraded, name, enabled };
  } catch (err) {
    return { created: false, upgraded: false, name, enabled: false, error: err && err.message };
  }
}

module.exports = {
  FLYWHEEL_SKILL_NAME,
  FLYWHEEL_SKILL_VERSION,
  FLYWHEEL_SKILL_CONTENT,
  FLYWHEEL_SKILL_META,
  seedSkill,
};
