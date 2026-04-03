# OpenClaw Skill 机制深度分析

> 基于 OpenClaw 源码 (github.com/openclaw/openclaw) 的全链路追踪分析
> 分析日期: 2026-04-02

## 1. 概述

OpenClaw 是一个拥有 34.5 万+ Stars 的开源个人 AI 助理项目。其 Skill 机制是核心扩展能力，允许通过纯 Markdown 文件声明式地定义 AI 行为扩展。

**核心设计理念**: Prompt 只注入 skill 列表（名称+描述+路径），不注入完整内容。模型按需用 `read` 工具读取具体 SKILL.md，节省 token。

## 2. Skill 数据结构

### 2.1 物理形态

每个 Skill 是一个目录，包含 `SKILL.md` 文件：

```
skills/
  github/
    SKILL.md          ← 核心：YAML frontmatter + Markdown 指令
    scripts/           ← 可选：附带脚本/模板
    references/        ← 可选：参考资料
```

### 2.2 核心类型定义

**源码位置**: `src/agents/skills/types.ts`

```typescript
// Skill 条目：加载后的完整表示
type SkillEntry = {
  skill: Skill;                        // 名称、描述、文件路径、来源
  frontmatter: ParsedSkillFrontmatter; // YAML frontmatter 解析结果
  metadata?: OpenClawSkillMetadata;    // OpenClaw 特有元数据
  invocation?: SkillInvocationPolicy;  // 调用策略
};

// OpenClaw 元数据
type OpenClawSkillMetadata = {
  always?: boolean;      // 是否始终加载
  skillKey?: string;     // 唯一键
  primaryEnv?: string;   // 主要环境变量
  os?: string[];         // 操作系统限制 (darwin/linux/win32)
  requires?: {
    bins?: string[];     // 必需的二进制文件 (e.g. ["gh", "git"])
    anyBins?: string[];  // 任一满足即可
    env?: string[];      // 必需的环境变量
    config?: string[];   // 必需的配置项
  };
  install?: SkillInstallSpec[];  // 自动安装规范
};

// 调用策略
type SkillInvocationPolicy = {
  userInvocable: boolean;           // 用户可通过 /命令 调用
  disableModelInvocation: boolean;  // 禁止模型自动触发
};

// Skill 快照：缓存在 Session 中
type SkillSnapshot = {
  prompt: string;          // 格式化后的 prompt 文本
  skills: Array<{ name: string; primaryEnv?: string; requiredEnv?: string[] }>;
  skillFilter?: string[];  // 过滤器
  resolvedSkills?: Skill[];
  version?: number;        // 版本号（时间戳）
};
```

### 2.3 SKILL.md 示例

```yaml
---
name: github
description: Manage GitHub issues and pull requests using the gh CLI.
user-invocable: true
metadata:
  openclaw:
    requires:
      bins: [gh]
    primaryEnv: GITHUB_TOKEN
    install:
      - kind: brew
        formula: gh
---

# GitHub Skill

When the user asks about GitHub issues or PRs, use the `gh` CLI...
```

## 3. Skill 注入/注册机制

### 3.1 多层来源与优先级

**源码位置**: `src/agents/skills/workspace.ts:460-511`

```
优先级从低到高 (同名覆盖):
┌───────────────────┬──────────────────────────────────┬───────────┐
│ 来源              │ 路径                             │ 优先级    │
├───────────────────┼──────────────────────────────────┼───────────┤
│ extra dirs        │ skills.load.extraDirs 配置       │ 最低      │
│ bundled           │ OpenClaw 安装目录/skills/         │ ↑        │
│ managed           │ ~/.openclaw/skills/               │ ↑        │
│ agents-personal   │ ~/.agents/skills/                 │ ↑        │
│ agents-project    │ <workspace>/.agents/skills/       │ ↑        │
│ workspace         │ <workspace>/skills/               │ 最高      │
└───────────────────┴──────────────────────────────────┴───────────┘
```

使用 `Map<name, Skill>` 实现，后加入的覆盖先加入的，形成分层 overlay。

### 3.2 加载流程

**源码位置**: `src/agents/skills/local-loader.ts`

```
1. 扫描目标目录的子文件夹
2. 查找每个子文件夹中的 SKILL.md
3. 安全检查:
   - realpath 验证，路径不能逃逸出根目录（防止符号链接攻击）
   - 文件大小上限 256KB (maxSkillFileBytes)
   - 忽略 .git, node_modules 等目录
4. 解析 frontmatter → 提取 name, description, metadata
5. 构建 SkillEntry 数组
```

### 3.3 资格过滤

**源码位置**: `src/agents/skills/config.ts:72-104`

`shouldIncludeSkill()` 依次检查:

| 检查项 | 说明 |
|--------|------|
| `enabled: false` | 配置中明确禁用 |
| bundled allowlist | 内置 skill 白名单 |
| OS 平台 | `metadata.openclaw.os` 与当前平台匹配 |
| 必需二进制 | `requires.bins` 全部在 PATH 上 |
| 必需环境变量 | `requires.env` 全部存在 |
| 必需配置项 | `requires.config` 全部为 truthy |

### 3.4 插件 Skills

**源码位置**: `src/agents/skills/plugin-skills.ts`

插件通过 manifest 文件声明 `skills` 字段注册额外 skill 目录。路径安全检查确保不逃逸插件根目录。

## 4. Skill Prompt 注入机制

### 4.1 注入链路

```
用户发消息 (WhatsApp/Telegram/Slack/...)
    │
    ▼
session-updates.ts: ensureSkillSnapshot()
    ├─ ensureSkillsWatcher()          // 确保文件监视器启动
    ├─ getSkillsSnapshotVersion()     // 获取当前版本号
    ├─ 判断: isFirstTurn || version过期?
    └─ buildWorkspaceSkillSnapshot()  // 构建快照
         │
         ▼
commands-system-prompt.ts: resolveCommandsSystemPromptBundle()
    ├─ skillsPrompt = skillsSnapshot.prompt
    └─ buildAgentSystemPrompt({ skillsPrompt, ... })
         │
         ▼
system-prompt.ts: buildAgentSystemPrompt()
    └─ buildSkillsSection({ skillsPrompt })
        → 输出 "## Skills (mandatory)" 段落
        → 注入 <available_skills> XML
```

### 4.2 注入时机

| 时机 | 触发条件 | 源码位置 |
|------|---------|----------|
| 会话首轮 | `isFirstTurnInSession === true` | `session-updates.ts:84-108` |
| 版本过期 | `snapshotVersion > cached version` | `session-updates.ts:81-82` |
| 上下文压缩 | Compaction 重建 system prompt | `compact.ts:414-644` |

### 4.3 注入内容

注入到 system prompt 的结构:

```markdown
## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.

<available_skills>
  <skill>
    <name>github</name>
    <description>Manage GitHub issues and PRs</description>
    <location>~/.openclaw/skills/github/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

**关键设计**: 模型只看到 skill 列表，不看到 SKILL.md 的完整内容。模型需要主动用 `read` 工具读取。

### 4.4 Token 预算控制

**源码位置**: `src/agents/skills/workspace.ts:567-613`

| 限制项 | 默认值 |
|--------|--------|
| `maxCandidatesPerRoot` | 300 个目录/来源 |
| `maxSkillsLoadedPerSource` | 200 个 skill/来源 |
| `maxSkillsInPrompt` | **150 个** skill |
| `maxSkillsPromptChars` | **30,000 字符** |
| `maxSkillFileBytes` | 256 KB / SKILL.md |

**三级降级策略**:

```
Full 格式（名称+描述+路径）
  → 超 30,000 字符?
Compact 格式（只有名称+路径，去掉描述）
  → 还超?
二分搜索截断（保留尽可能多的 skill）
  + 附加警告: "⚠️ Skills truncated: included X of Y"
```

**路径压缩优化**: `/Users/alice/.bun/.../skills/github/SKILL.md` → `~/.bun/.../skills/github/SKILL.md`，每个 skill 节省约 5-6 tokens。

## 5. Skill 命令调度机制

### 5.1 两种触发路径

#### 路径 A: 模型自动触发

模型在 system prompt 中看到 `<available_skills>` 列表，当任务匹配时主动调用 `read` 工具读取 SKILL.md 获取详细指令。

#### 路径 B: 用户斜杠命令触发

**源码位置**: `src/auto-reply/reply/get-reply-inline-actions.ts`

```
用户输入 "/github create issue ..."
    │
    ▼
resolveSlashCommandName("/github") = "github"
    │ (非内置命令)
    ▼
resolveSkillCommandInvocation({
  commandBody: "/github create issue ...",
  skillCommands
})
    │ 匹配到 github skill
    ▼
检查 dispatch 类型:
  ├─ dispatch.kind === "tool" → 直接调用指定工具 (确定性执行)
  └─ 无 dispatch → 读取 SKILL.md 作为 prompt 注入对话
```

### 5.2 Tool Dispatch 模式

SKILL.md 中声明:

```yaml
command-dispatch: tool
command-tool: exec
command-arg-mode: raw
```

执行时跳过 LLM，直接调用工具执行参数。

### 5.3 命令名称解析

**源码位置**: `src/auto-reply/skill-commands-base.ts:27-96`

- 清洗: `My Cool Skill!` → `my_cool_skill`
- 最大 32 字符
- 与内置命令去重 (`/new`, `/status` 等)
- 同名 skill 追加后缀 `_2`, `_3`
- 支持 `/skill github-issues create` 间接调用语法
- 模糊匹配: 下划线/空格/连字符互换

## 6. 热刷新机制

### 6.1 完整链路

**源码位置**: `src/agents/skills/refresh.ts`

```
SKILL.md 被修改/新增/删除
    │
    ▼ (1) chokidar 文件监视
ensureSkillsWatcher()
  chokidar.watch([
    "<workspace>/skills/*/SKILL.md",
    "<workspace>/.agents/skills/*/SKILL.md",
    "~/.openclaw/skills/*/SKILL.md",
    "~/.agents/skills/*/SKILL.md",
    plugin skill dirs...
  ])
  事件: add / change / unlink
    │
    ▼ (2) 防抖 (默认 250ms)
schedule()
  clearTimeout(state.timer)
  setTimeout(() => bumpVersion(), 250)
    │
    ▼ (3) 版本号递增
bumpSkillsSnapshotVersion()
  version = Date.now()  // 时间戳作为版本号
  workspaceVersions.set(workspaceDir, version)
  emit({ workspaceDir, reason: "watch" })
    │
    ├──────────────────────────┐
    ▼                          ▼
(4a) Gateway 监听器         (4b) 下次对话时
  30s debounce →              ensureSkillSnapshot()
  refresh remote               检测: version > cached?
  node bins                    → 重建 snapshot
                               → 新 prompt 注入
```

### 6.2 监视器关键设计

| 设计决策 | 说明 |
|----------|------|
| **谁启动** | `ensureSkillsWatcher()` 在首次对话时懒启动，不是 Gateway 启动时 |
| **监视什么** | 只监视 `*/SKILL.md` glob，不监视所有文件，避免 FD 耗尽 |
| **忽略什么** | `.git`, `node_modules`, `dist`, `.venv`, `__pycache__`, `build`, `.cache` |
| **防抖** | 文件系统层 250ms + Gateway 远程探测层 30s，双层独立 |
| **幂等性** | 路径和配置没变则不重复创建 watcher |
| **版本号** | `Date.now()` 时间戳，单调递增，无需计数器 |
| **配置** | `skills.load.watch: false` 关闭; `skills.load.watchDebounceMs` 自定义 |

### 6.3 快照缓存

SkillSnapshot 缓存在 SessionEntry 中，避免每次对话都重新扫描文件系统。只有当版本号不匹配时才重建。

## 7. 架构总图

```
┌──────────────────────────────────────────────────────────────┐
│                      物理存储层                               │
│  skills/<name>/SKILL.md   ← YAML frontmatter + Markdown     │
│  6 个来源: extra < bundled < managed < personal < project    │
│           < workspace (同名高优先级覆盖)                      │
└──────────────────┬───────────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────────┐
│                      加载/注册层                              │
│  loadSkillEntries() → 扫描 → 安全检查 → 合并去重             │
│  shouldIncludeSkill() → OS/bins/env/config/allowlist 过滤    │
└──────────────────┬───────────────────────────────────────────┘
                   │
┌──────────────────▼───────────────────────────────────────────┐
│                      快照/缓存层                              │
│  SkillSnapshot = { prompt, skills[], version }               │
│  缓存在 SessionEntry, 版本号对比决定是否重建                  │
└──────────┬───────────────────────┬───────────────────────────┘
           │                       │
┌──────────▼──────────┐  ┌────────▼────────────────────────────┐
│   Prompt 注入路径    │  │   命令调度路径                       │
│  buildAgentSystem-  │  │  "/skill_name args"                  │
│  Prompt()           │  │  → resolveSkillCommandInvocation()   │
│  → "## Skills"      │  │  → tool dispatch 或 prompt 注入      │
│  → <available_skills>│  │                                      │
│  → 模型自行 read    │  │                                      │
└─────────────────────┘  └──────────────────────────────────────┘
           │
┌──────────▼──────────────────────────────────────────────────┐
│                      热刷新层                                │
│  chokidar watch SKILL.md → 250ms debounce → bumpVersion    │
│  → emit → 下次对话检测版本 → 重建 snapshot → 新 prompt       │
└─────────────────────────────────────────────────────────────┘
```

## 8. 设计亮点总结

| 特性 | 实现方式 | 意义 |
|------|---------|------|
| Prompt 注入式调度 | 列表注入 prompt，模型按需 read | 节省 token，150 skill 仅 ~30K 字符 |
| 分层 overlay | 6 层来源同名覆盖 | 灵活定制，workspace 可覆盖 bundled |
| 声明式 Skill | 纯 Markdown + YAML frontmatter | 无需写代码，降低门槛 |
| 安全沙箱 | 路径逃逸检查、符号链接验证、大小限制 | 防止恶意 skill |
| Token 预算控制 | full → compact → 截断三级降级 | 大量 skill 场景下不超限 |
| 热刷新 | chokidar + debounce + 版本号 + 事件广播 | 修改 SKILL.md 即时生效 |
| 快照缓存 | Session 级缓存 + 版本号比对 | 避免重复扫描文件系统 |
| 双层防抖 | 文件系统 250ms + Gateway 远程 30s | 各层独立，避免抖动 |
