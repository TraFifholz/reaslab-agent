# Reaslab-Agent Skill 机制深度分析

> 基于 reaslab-agent 项目源码的全链路追踪分析
> 分析日期: 2026-04-02

## 1. 概述

Reaslab-Agent 的 Skill 系统提供了一套**声明式 + 工具驱动**的扩展机制。与 OpenClaw 的「Prompt 列表注入 + 模型自行 read」不同，Reaslab-Agent 采用**专用 `skill` 工具**加载 skill 完整内容到对话上下文中。

同时，Reaslab-Agent 提供了**运行时动态 skill 管理**（load/unload），支持 workspace 和 session 两级作用域。

**技术栈**: TypeScript + Effect (函数式编程框架) + Zod (Schema 校验)

## 2. Skill 数据结构

### 2.1 物理形态

与 OpenClaw 相同，每个 Skill 是一个目录，包含 `SKILL.md` 文件:

```
skills/
  mathflow/
    SKILL.md          ← YAML frontmatter + Markdown 指令
  problem-analysis/
    SKILL.md
  derivation-and-proof-checking/
    SKILL.md
  ...
```

当前项目包含 9 个 skill，主要面向**数学研究工作流**：
- `mathflow` — 数学研究阶段路由器
- `problem-analysis` — 问题分析
- `mathematical-modeling` — 数学建模
- `derivation-and-proof-checking` — 推导与证明检查
- `research-planning` — 研究规划
- `numerical-experimentation` — 数值实验
- `result-validation` — 结果验证
- `self-audit-loop` — 自审计循环
- `report-writing` — 报告撰写

### 2.2 核心类型定义

**源码位置**: `src/skill/index.ts:31-37`

```typescript
export const Info = z.object({
  name: z.string(),        // Skill 名称
  description: z.string(), // 一行描述
  location: z.string(),    // SKILL.md 绝对路径
  content: z.string(),     // SKILL.md 完整 Markdown 内容
})
export type Info = z.infer<typeof Info>
```

对比 OpenClaw 的 `SkillEntry` 复杂结构，Reaslab-Agent 的 Skill 数据结构更简洁，没有 OS 限制、二进制依赖、安装规范等元数据。

### 2.3 SKILL.md 示例

```yaml
---
name: mathflow
description: Use when mathematical research work needs stage-aware guidance before proceeding.
---

## Use when

Use this skill when a task involves mathematical research, derivations...

## Hard rules

- Always assess the current stage before choosing the next step.
- Route mathematical research tasks into the correct stage...
```

## 3. Skill 加载/注册机制

### 3.1 加载来源

**源码位置**: `src/skill/index.ts:533-578`

```
加载顺序:
┌───────────────────┬──────────────────────────────────────────┐
│ 来源              │ 路径 / 机制                               │
├───────────────────┼──────────────────────────────────────────┤
│ 全局外部          │ ~/.claude/skills/**  ~/.agents/skills/** │
│ 项目外部          │ 向上遍历目录树寻找 .claude/.agents       │
│ 内置 skills       │ <项目根>/skills/**/SKILL.md              │
│ 配置额外路径      │ config.skills.paths 中指定的目录          │
│ 远程 URL          │ config.skills.urls 指定的 HTTP 索引       │
└───────────────────┴──────────────────────────────────────────┘
```

**同名覆盖**: 使用 `Record<string, Info>` 结构，后加载的覆盖先加载的（带 warn 日志）。

**vs OpenClaw**: OpenClaw 有 6 层明确优先级; Reaslab-Agent 按加载顺序隐式覆盖。

### 3.2 远程 Skill 发现

**源码位置**: `src/skill/discovery.ts`

Reaslab-Agent 独有的 **URL-based skill discovery** 机制:

```
config.skills.urls: ["https://example.com/skills/"]
    │
    ▼
Discovery.pull(url)
    ├─ GET https://example.com/skills/index.json
    │   → { skills: [{ name: "...", files: ["SKILL.md", ...] }] }
    ├─ 并发下载每个 skill 的文件 (concurrency=4 skills, 8 files)
    ├─ 缓存到 ~/.cache/opencode/skills/
    └─ 返回下载后的本地目录列表
```

OpenClaw 没有类似的远程 skill registry（它有 ClawHub 但那是安装流程，不是运行时发现）。

### 3.3 权限过滤

**源码位置**: `src/skill/index.ts:624-629`

```typescript
const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
  const cache = yield* ensure()
  const list = Object.values(cache.skills).toSorted((a, b) => a.name.localeCompare(b.name))
  if (!agent) return list
  return list.filter((skill) =>
    Permission.evaluate("skill", skill.name, agent.permission).action !== "deny"
  )
})
```

通过 `Permission.evaluate()` 进行基于 agent 的权限过滤，每个 agent 可以限制可用的 skill 子集。

## 4. Skill Prompt 注入机制

### 4.1 注入链路

**源码位置**: `src/session/prompt.ts:656-664` + `src/session/system.ts:62-81`

```
用户发消息
    │
    ▼
session/prompt.ts: 构建 LLM 请求
    │
    ▼
SystemPrompt.skills(agent, { workspaceID, sessionID })
    ├─ Skill.available(agent)      // 获取静态 skill 列表
    ├─ Skill.runtimeAll(scope)     // 获取运行时动态 skill
    ├─ 合并 + 权限过滤 + 排序
    └─ Skill.fmt(list, { verbose: true })  // 格式化为 XML
         │
         ▼
    注入 system prompt:
    [环境信息, skills prompt, 指令 prompt]
```

### 4.2 注入内容

System prompt 中的 skills 部分:

```
Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.

<available_skills>
  <skill>
    <name>mathflow</name>
    <description>Use when mathematical research work needs stage-aware guidance.</description>
    <location>file:///app/skills/mathflow/SKILL.md</location>
  </skill>
  <skill>
    <name>problem-analysis</name>
    <description>Analyze and decompose mathematical problems.</description>
    <location>file:///app/skills/problem-analysis/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

### 4.3 注入时机

**每次对话请求**都会重新调用 `SystemPrompt.skills()`，没有像 OpenClaw 那样的快照缓存和版本号机制。

### 4.4 vs OpenClaw 注入方式

| 维度 | OpenClaw | Reaslab-Agent |
|------|----------|---------------|
| 注入内容 | 名称+描述+路径 (简要) | 名称+描述+路径 (详细 XML) |
| 加载完整内容的方式 | 模型自行用 `read` 工具读 SKILL.md | 模型调用 `skill` 工具加载 |
| Token 预算控制 | 有 (30K 字符限制, 三级降级) | **无** |
| 快照缓存 | 有 (Session 级, 版本号比对) | **无** (每次重建) |

## 5. Skill 调度机制

### 5.1 Skill 工具 (核心调度方式)

**源码位置**: `src/tool/skill.ts`

Reaslab-Agent 的核心区别: 使用专用的 **`skill` 工具**作为 skill 加载入口。

```typescript
export const SkillTool = Tool.define("skill", async (ctx) => {
  const list = await Skill.available(ctx?.agent)
  // 工具描述中列出所有可用 skill
  const description = [
    "Load a specialized skill that provides domain-specific instructions.",
    "Invoke this tool to load a skill when a task matches...",
    Skill.fmt(list, { verbose: false }),  // Markdown 列表格式
  ].join("\n")

  return {
    description,
    parameters: z.object({ name: z.string() }),
    async execute(params, ctx) {
      const skill = await Skill.get(params.name)
      // 1. 权限检查
      await ctx.ask({ permission: "skill", patterns: [params.name], ... })
      // 2. 列出 skill 目录下的附带文件 (最多 10 个)
      const files = await Ripgrep.files({ cwd: dir, ... })
      // 3. 返回完整 skill 内容 + 文件列表
      return {
        output: [
          `<skill_content name="${skill.name}">`,
          `# Skill: ${skill.name}`,
          skill.content.trim(),    // ← 完整 SKILL.md 内容
          `Base directory: ${base}`,
          `<skill_files>`, files, `</skill_files>`,
          `</skill_content>`,
        ].join("\n"),
      }
    },
  }
})
```

**调度流程**:

```
模型看到 skill 列表 (system prompt 或 tool description)
    │
    ▼
模型决定调用 skill 工具: { name: "mathflow" }
    │
    ▼
SkillTool.execute({ name: "mathflow" })
    ├─ Permission 检查
    ├─ 读取 SKILL.md 完整内容
    ├─ 列出 skill 目录下的文件 (最多 10 个)
    └─ 返回 <skill_content> 包裹的完整指令
         │
         ▼
模型按照注入的指令执行
```

**vs OpenClaw**: OpenClaw 让模型自己用 `read` 工具读取 SKILL.md; Reaslab-Agent 封装了专用的 `skill` 工具，**同时返回 skill 内容和附带的文件列表**。

### 5.2 运行时 Skill 管理工具

**源码位置**: `src/tool/skill-runtime.ts`

Reaslab-Agent 独有的**运行时动态 skill 管理**，提供三个额外工具:

| 工具 | 功能 | 作用域 |
|------|------|--------|
| `skill-finder` | 查找运行时 skill | workspace / session |
| `load-skill` | 从本地路径加载新 skill | workspace / session |
| `unload-skill` | 隐藏/卸载 skill | workspace / session |

```
load-skill 流程:
    ├─ 权限检查 (read + skill)
    ├─ 解析 SKILL.md frontmatter
    ├─ 冲突检测 (名称冲突)
    ├─ Skill.runtimeLoad({ scope, root, file, ... })
    └─ skill 进入运行时 overlay

unload-skill 流程:
    ├─ 权限检查
    └─ hideSkill(name) → 加入 hidden set
```

### 5.3 运行时 Overlay 系统

**源码位置**: `src/skill/index.ts:281-508`

```
┌─────────────────────────────────────────────┐
│              RuntimeOverlay                  │
│                                             │
│  discovered (静态扫描)                       │
│    └─ Map<name, Info>                       │
│                                             │
│  workspace overlay (per workspaceID)        │
│    └─ sources: Map<sourceKey, {             │
│         skills: Map<name, Info>,            │
│         hidden: Set<name>                   │
│       }>                                    │
│                                             │
│  session overlay (per workspaceID:sessionID)│
│    └─ sources: Map<sourceKey, {             │
│         skills: Map<name, Info>,            │
│         hidden: Set<name>                   │
│       }>                                    │
│                                             │
│  合并规则:                                   │
│    discovered → +workspace overlay          │
│               → +session overlay            │
│    (后层可覆盖/隐藏前层)                      │
└─────────────────────────────────────────────┘
```

**vs OpenClaw**: OpenClaw 没有 session 级别的动态 load/unload 机制。

## 6. 热刷新机制

### 6.1 当前状态: 无热刷新

Reaslab-Agent **没有文件监视器/热刷新机制**。代码中没有 chokidar 或类似的 file watcher。

Skill 加载是**懒加载一次性**的:

```typescript
// src/skill/index.ts:581-588
const ensure = () => {
  if (state.task) return state.task   // 已加载则跳过
  state.task = load().catch((err) => {
    state.task = undefined
    throw err
  })
  return state.task
}
```

一旦初始化完成，静态 skill 列表不会自动更新。

### 6.2 运行时动态更新

虽然没有文件监视，但通过**运行时 skill 管理工具**可以动态更新:

- `load-skill`: 手动加载新 skill 到当前 session/workspace
- `unload-skill`: 隐藏不需要的 skill

### 6.3 vs OpenClaw 热刷新

| 维度 | OpenClaw | Reaslab-Agent |
|------|----------|---------------|
| 文件监视 | chokidar watch `*/SKILL.md` | **无** |
| 防抖 | 250ms debounce | N/A |
| 版本号 | `Date.now()` 时间戳 | **无** |
| 快照缓存 | Session 级缓存 + 版本比对 | **无缓存** |
| 事件广播 | listeners + emit | **无** |
| 动态管理 | 无 | load-skill / unload-skill 工具 |

## 7. 架构对比总图

```
┌─ Reaslab-Agent ─────────────────────────────────────────────┐
│                                                              │
│  ┌─ 物理存储 ───────────────────────────────────────────┐   │
│  │ skills/<name>/SKILL.md                                │   │
│  │ 来源: global → project → builtin → config → URL      │   │
│  └──────────────────────┬────────────────────────────────┘   │
│                         │                                    │
│  ┌─ 懒加载层 ───────────▼────────────────────────────────┐   │
│  │ Skill.ensure() → scan() → add() → Record<name, Info> │   │
│  │ (一次性加载, 无文件监视, 无版本号)                      │   │
│  └──────────────────────┬────────────────────────────────┘   │
│                         │                                    │
│  ┌─ 运行时 Overlay ─────▼────────────────────────────────┐   │
│  │ discovered → workspace overlay → session overlay      │   │
│  │ (支持动态 load/unload)                                 │   │
│  └──────────┬───────────────────────┬────────────────────┘   │
│             │                       │                        │
│  ┌──────────▼──────────┐  ┌────────▼─────────────────────┐  │
│  │ System Prompt 注入   │  │ Skill 工具调度               │  │
│  │                     │  │                              │  │
│  │ SystemPrompt.skills │  │ skill 工具:                   │  │
│  │ → verbose XML 列表  │  │   输入 name                  │  │
│  │ → 每次请求重建      │  │   → 加载完整 SKILL.md 内容   │  │
│  │                     │  │   → 附带文件列表              │  │
│  │ 无 token 预算控制   │  │   → <skill_content> 输出     │  │
│  └─────────────────────┘  │                              │  │
│                           │ Runtime 工具:                 │  │
│                           │   skill-finder                │  │
│                           │   load-skill                  │  │
│                           │   unload-skill                │  │
│                           └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

## 8. 特点与改进空间

### 8.1 Reaslab-Agent 的独特优势

| 特点 | 说明 |
|------|------|
| **专用 Skill 工具** | 封装加载逻辑，返回完整内容 + 附带文件列表，比 `read` 更丰富 |
| **运行时动态管理** | workspace/session 两级 load/unload，OpenClaw 不具备 |
| **远程 Skill 发现** | URL-based index.json 机制，支持远程 skill 仓库 |
| **Effect 框架集成** | 利用 Effect 的依赖注入和错误处理，代码更健壮 |
| **权限系统集成** | per-agent 权限控制，精确控制每个 agent 可用的 skill |

### 8.2 可借鉴 OpenClaw 改进的方向

| 改进方向 | OpenClaw 做法 | 当前 Reaslab-Agent 状态 |
|----------|--------------|------------------------|
| **热刷新** | chokidar + debounce + 版本号 | 无文件监视 |
| **Token 预算控制** | 30K 字符限制, full → compact → 截断 | 无限制 |
| **快照缓存** | Session 级缓存 + 版本号比对 | 每次对话重建 |
| **路径压缩** | `~/` 替换 home 路径前缀 | 使用 `file://` URL |
| **安全检查** | 符号链接验证, 路径逃逸检查, 文件大小上限 | 基本检查 |
| **Compact 格式降级** | 超限时去掉描述只保留名称 | 无降级策略 |
| **斜杠命令触发** | `/skill_name args` 直接触发 | 仅通过工具触发 |
