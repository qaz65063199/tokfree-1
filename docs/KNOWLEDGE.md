# 全局知识库（Knowledge Base）

> 跨项目共享的「用户偏好 + 技能库」。经验不再沉在单个项目的 `.tokfreeCode/` 里，
> 而是在所有项目之间复用。

## 一、三层知识体系

TokFree 的知识分为三层，作用范围和存储位置各不相同：

| 层级 | 内容 | 作用范围 | 存储位置 |
| --- | --- | --- | --- |
| **全局偏好** | 写作风格、沟通习惯、工作方式等通用偏好 | 所有项目（无条件注入） | `<userData>/knowledge/preferences.md` |
| **全局技能** | 可复用的工作方法（报告模板、审查流程等） | 全局注册，**按项目启用** | `<userData>/knowledge/skills/<name>.md` + `skills.json` |
| **项目知识** | 单项目特有的说明、约定、踩坑记录 | 仅该项目 | `<projectDir>/.tokfreeCode/TOKFREE.md` 等 |

- **全局偏好**：无条件注入，任何项目初始化时都会带上。
- **全局技能**：先进入全局技能库，再由某个项目"启用"后才注入该项目提示词——避免所有项目都被无关技能淹没。
- **项目知识**：仍是项目私有，不跨项目。

三者通过 `project-context` 初始化时调用 `knowledge.buildKnowledgeSection(projectDir)` 组装成一段 Markdown 注入系统提示词。

## 二、技能：创建、启用、跨项目复用

### 创建技能

```js
// 通过工具接口（AI 侧）
createSkill('code-review', '# 代码审查流程\n\n1. 先看 diff 范围...', {
  description: '通用代码审查检查清单',
  tags: ['review', 'workflow'],
});
```

技能名只允许 **字母 / 数字 / 下划线 / 连字符**（建议 kebab-case），重名会被拒绝。

技能正文是 Markdown，可以放清单、模板、步骤说明等。元数据（description / tags / createdAt）存在注册表 `skills.json`。

### 启用 / 禁用（按项目）

技能创建后是**全局**的，但只有在某个项目里"启用"才会注入该项目：

```js
enableSkill(projectDir, 'code-review');   // 在本项目启用
getEnabledSkills(projectDir);             // -> ['code-review']
disableSkill(projectDir, 'code-review');  // 在本项目禁用
```

启用状态写在该项目自己的文件里：

```
<projectDir>/.tokfreeCode/enabled-skills.json   // { "enabled": ["code-review", ...] }
```

所以同一个技能，可以在项目 A 启用、项目 B 不启用。

### 跨项目复用

1. 在项目 A 中发现一套好方法 → `createSkill` 存进全局技能库。
2. 在项目 B 中 `enableSkill(projectDir, 'xxx')` → 项目 B 初始化时自动带上。
3. 不再需要时 `disableSkill` 即可，技能本身仍保留在全局库中供其他项目使用。

## 三、与 MemPalace 的分工

| | 全局知识库（本模块） | MemPalace 长期记忆 |
| --- | --- | --- |
| **定位** | 结构化的、可主动注入提示词的**偏好与技能** | 非结构化的、按需检索的**历史记忆** |
| **读取方式** | 项目初始化时**自动注入** | 需要时用 `mempalace_search` **主动检索** |
| **内容形态** | 人工/AI 整理的 Markdown（模板、清单） | 事实性记录（决策、结论、踩坑） |
| **典型场景** | "我写报告要三段式" | "上次我们决定用 X 方案" |

简单说：

- **知识库**回答"**我应该怎么做**"——把稳定的方法固化成技能，自动生效。
- **MemPalace**回答"**以前发生过什么**"——需要时再去检索。

两者互补：重要决策既可用 `mempalace_add_drawer` 存档，若沉淀成通用方法也可同时 `createSkill`。

## 四、文件存储位置

```
<userData>/knowledge/                 # userData 由 electron app.getPath('userData') 决定
├── preferences.md                    # 全局偏好（首次读取时自动生成默认模板）
├── skills.json                       # 技能注册表
└── skills/
    ├── code-review.md                # 技能正文
    └── report-template.md

<projectDir>/.tokfreeCode/
└── enabled-skills.json               # 本项目启用的技能列表
```

> **Windows 上** `<userData>` 通常是 `%APPDATA%\<appName>`；
> 本项目通过 `app.setPath('userData', ...)` 指向会话目录，实际路径以启动日志
> `[TokFree] Session 数据目录: ...` 为准。

## 五、常见用法示例

### 1. 记录一条全局偏好

```js
appendPreference('回答尽量简洁，不要客套话');
// preferences.md 末尾追加一行 "- 回答尽量简洁，不要客套话"
```

### 2. 把一次工作的好方法沉淀成技能

```js
createSkill(
  'weekly-report',
  '# 周报模板\n\n## 本周完成\n- \n\n## 下周计划\n- \n\n## 风险\n- ',
  { description: '标准周报结构', tags: ['report'] }
);
```

### 3. 在另一个项目里复用

```js
enableSkill('C:/work/project-b', 'weekly-report');
// project-b 下次初始化即自动注入该周报模板
```

### 4. 查看与清理

```js
listSkills();                         // 全部技能元数据
readSkill('weekly-report');           // 读取正文
getEnabledSkills(projectDir);         // 本项目已启用
disableSkill(projectDir, 'weekly-report');
deleteSkill('weekly-report');         // 从全局库彻底删除
```

### 5. AI 自动注入的知识章节

项目初始化时，`buildKnowledgeSection(projectDir)` 生成的章节大致形如：

```markdown
## 用户全局偏好（跨项目）

<preferences.md 内容>

---

## 本项目已启用的技能（跨项目可复用）

### 技能：weekly-report

<技能正文>

---

## 技能库使用（主动沉淀经验）
...
```

无偏好时提示"用户尚未填写偏好"；项目无启用技能时省略技能章节。

## 六、API 速查

| 函数 | 说明 |
| --- | --- |
| `readPreferences()` | 读取全局偏好（不存在则创建默认模板） |
| `writePreferences(content)` | 覆盖写入全局偏好 |
| `appendPreference(text)` | 追加一条偏好（自动加 `- ` 前缀） |
| `listSkills()` | 列出全部技能元数据 |
| `readSkill(name)` | 读取技能正文（不存在返回 `null`） |
| `createSkill(name, content, meta?)` | 创建技能 |
| `updateSkill(name, content?, meta?)` | 更新正文 / 元数据 |
| `deleteSkill(name)` | 删除技能 |
| `getEnabledSkills(projectDir)` | 读取本项目已启用技能 |
| `enableSkill(projectDir, name)` | 本项目启用 |
| `disableSkill(projectDir, name)` | 本项目禁用 |
| `buildKnowledgeSection(projectDir)` | 组装注入用 Markdown 章节 |

> 所有写操作返回 `{ success, ... }` 结构，失败时带 `error` 字段，不抛异常。
