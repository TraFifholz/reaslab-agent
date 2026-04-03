# reaslab-agent Skill 机制技术报告

## 目录

1. [概述](#1-概述)
2. [架构总览](#2-架构总览)
3. [SKILL.md 文件格式](#3-skillmd-文件格式)
4. [Skill 加载与来源](#4-skill-加载与来源)
5. [核心数据流](#5-核心数据流)
6. [Effect 层与状态管理](#6-effect-层与状态管理)
7. [Runtime Overlay 系统](#7-runtime-overlay-系统)
8. [Token 预算控制与三级降级](#8-token-预算控制与三级降级)
9. [快照缓存与版本追踪](#9-快照缓存与版本追踪)
10. [文件监视热刷新](#10-文件监视热刷新)
11. [安全与限制机制](#11-安全与限制机制)
12. [远程 Skill 发现](#12-远程-skill-发现)
13. [SkillTool — LLM 调用入口](#13-skilltool--llm-调用入口)
14. [Runtime Skill Tools](#14-runtime-skill-tools)
15. [System Prompt 集成](#15-system-prompt-集成)
16. [配置体系](#16-配置体系)
17. [内置 Skills](#17-内置-skills)
18. [测试体系](#18-测试体系)
19. [Docker 容器内运行行为](#19-docker-容器内运行行为)
20. [已知限制与设计取舍](#20-已知限制与设计取舍)

---

## 1. 概述

reaslab-agent 的 Skill 系统是一个可扩展的指令注入框架，允许将**领域特定的工作流和指令**以 Markdown 文件（`SKILL.md`）的形式组织，并在 LLM 对话中按需加载。

核心设计目标：
- **按需加载**：Skill 不会全部注入 system prompt，而是由 LLM 根据任务匹配度主动调用 Skill Tool 加载
- **多来源合并**：支持内置 skill、项目 skill、全局 skill、远程 skill、运行时动态 skill
- **热刷新**：文件修改后无需重启即可生效
- **Token 预算控制**：大量 skill 时自动降级格式，避免 system prompt 膨胀

---

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────┐
│                    LLM 请求循环                          │
│  prompt.ts shell()                                       │
│                                                          │
│  ┌──────────────┐    ┌────────────────────┐              │
│  │ resolveTools │    │ SystemPrompt.skills│              │
│  │  (每轮重建)   │    │   (每轮重建)        │              │
│  └──────┬───────┘    └────────┬───────────┘              │
│         │                     │                          │
│         ▼                     ▼                          │
│  SkillTool.init()     Skill.available() + fmtWithBudget  │
│  → Skill.available()  → 快照缓存检查                      │
│  → 构建工具描述         → 版本比对                         │
│         │                     │                          │
│         └─────────┬───────────┘                          │
│                   ▼                                      │
│            Skill.ensure()                                │
│            ┌──────────────────┐                          │
│            │ needsReloadDirs? │── Y ──▶ 清空+重新加载      │
│            │ poll过期检查?     │── Y ──▶ 清空+重新加载      │
│            │ state.task?      │── Y ──▶ 返回缓存           │
│            └──────────────────┘                          │
│                   ▼                                      │
│              load() 扫描                                  │
│   ┌────┬────┬─────┬─────┬─────┐                         │
│   │全局│项目│内置  │配置  │远程  │                         │
│   │skill│skill│skill│paths│urls │                         │
│   └────┴────┴─────┴─────┴─────┘                         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────┐
│   chokidar 文件监视器        │    ┌───────────────────┐
│   监视目录列表：              │    │ poll-based 检查    │
│   ~/.claude/skills           │    │ (每10s stat检查)   │
│   ~/.agents/skills           │    │ skillFilesChanged()│
│   {project}/skills           │    └────────┬──────────┘
│   {project}/.claude/skills   │             │
│   {project}/.agents/skills   │             │
│   {builtin}/skills           │             │
│   config.paths...            │             │
│                              │             │
│   SKILL.md变化 → debounce    │             │
│   → markNeedsReload()        │             │
│   → try bumpVersion()        │             │
└─────────────────────────────┘             │
                                    ensure() 下次调用时触发
```

### 源文件清单

| 文件 | 职责 | 行数 |
|------|------|------|
| `src/skill/index.ts` | 核心模块：加载、缓存、格式化、版本追踪、Effect层 | ~888 |
| `src/skill/refresh.ts` | chokidar 文件监视 + 防抖 | ~153 |
| `src/skill/discovery.ts` | 远程 skill 下载（HTTP index.json） | ~116 |
| `src/tool/skill.ts` | SkillTool — LLM 调用 skill 的工具 | ~105 |
| `src/tool/skill-runtime.ts` | 运行时 skill 管理工具（load/unload/finder） | ~441 |
| `src/session/system.ts` | System Prompt 中的 skill 列表生成 + 快照缓存 | ~115 |
| `src/config/config.ts` | SkillsConfig 配置接口 | ~106 |
| `src/config/markdown.ts` | SKILL.md frontmatter 解析器 | ~49 |

---

## 3. SKILL.md 文件格式

每个 Skill 是一个目录，其中必须包含 `SKILL.md` 文件：

```
skills/
  mathflow/
    SKILL.md          ← 必需
    scripts/          ← 可选，bundled 资源
    reference/        ← 可选
  problem-analysis/
    SKILL.md
```

### Frontmatter 格式

```markdown
---
name: mathflow
description: Use when mathematical research work needs stage-aware guidance.
---

## Use when

Use this skill when a task involves mathematical research...

## Inputs

- The problem statement...

## Outputs

- A brief stage assessment...

## Hard rules

- Always assess the current stage...
```

**必需字段**：
- `name: string` — Skill 唯一标识符，用于调用和去重
- `description: string` — 简短描述，LLM 用此判断是否匹配当前任务

**正文内容**：frontmatter 之后的 Markdown 正文即为 Skill 的完整指令，在 LLM 调用 SkillTool 时注入对话。

### 解析流程

```
SKILL.md → ConfigMarkdown.parse()
         → 正则提取 frontmatter (---\n...\n---\n)
         → 基础 YAML key:value 解析
         → Zod schema 校验 { name, description }
         → 构造 Skill.Info { name, description, location, content }
```

`location` 保存 SKILL.md 的绝对路径，`content` 保存 frontmatter 之后的正文。

---

## 4. Skill 加载与来源

`load()` 函数（`src/skill/index.ts:626`）按以下顺序扫描 skill 来源：

### 4.1 全局 Skills（External）

```typescript
// 扫描 ~/.claude/skills/**/SKILL.md 和 ~/.agents/skills/**/SKILL.md
for (const dir of [".claude", ".agents"]) {
  scan(state, path.join(homedir, dir), "skills/**/SKILL.md", { dot: true, scope: "global" })
}
```

### 4.2 项目级 Skills（Project-local）

```typescript
// 从 directory 向上遍历到 worktree，查找 .claude/ 和 .agents/ 目录
for await (const root of Filesystem.up({ targets: [".claude", ".agents"], start: directory, stop: worktree })) {
  scan(state, root, "skills/**/SKILL.md", { dot: true, scope: "project" })
}
```

### 4.3 内置 Skills（Built-in）

```typescript
// Docker 镜像中打包在 /app/skills/ 下
const builtinSkillsDir = path.resolve(__dirname, "..", "..", "skills")
scan(state, builtinSkillsDir, "**/SKILL.md")
```

### 4.4 配置路径（Config paths）

```typescript
// config.skills.paths 中定义的额外目录
for (const item of cfg.skills?.paths ?? []) {
  scan(state, resolvedDir, "**/SKILL.md")
}
```

默认配置包含 `paths: ["skills"]`，即项目根目录下的 `skills/` 目录。

### 4.5 远程 Skills（Config URLs）

```typescript
// config.skills.urls 中定义的远程 index.json
for (const url of cfg.skills?.urls ?? []) {
  for (const dir of await discovery.pull(url)) {
    scan(state, dir, "**/SKILL.md")
  }
}
```

### 加载优先级

后扫描的 skill 会覆盖先前同名的 skill（通过 `state.skills[name] = info`），并产生 `duplicate skill name` 警告日志。实际优先级：

```
远程 URLs > 配置 paths > 内置 > 项目级 .claude/.agents > 全局 ~/.claude/~/.agents
```

---

## 5. 核心数据流

### 5.1 首次加载

```
Instance 初始化
  → InstanceState.make() → create(discovery, directory, worktree)
    → 构造 State { skills: {}, dirs: Set, lastLoadMs: 0 }
    → 返回 Cache = { ...state, ensure }

首次 Skill.available() 调用
  → ensure() → state.task === undefined
    → state.task = load().then(() => bumpVersion())
      → scan 全局 → scan 项目 → scan 内置 → scan 配置 → scan 远程
      → ensureSkillsWatcher() 启动文件监视
      → bumpVersion() 设置版本号
    → 返回 promise
  → await promise
  → Object.values(state.skills) → 排序 → 权限过滤 → 返回列表
```

### 5.2 热刷新（Watcher 触发）

```
SKILL.md 文件变化
  → chokidar event (add/change/unlink)
  → isSkillFile() 过滤
  → schedule() 防抖 (250ms)
  → Skill.markNeedsReload(directory)  ← module-level Set
  → try Skill.bumpVersion()           ← 失败（无 Instance 上下文）

下一轮 LLM 请求
  → resolveTools() → SkillTool.init() → Skill.available() → ensure()
    → needsReloadDirs.has(directory) === true
    → 清空 state.task、state.skills、state.dirs
    → 重新 load() → bumpVersion()
    → 返回全新的 skill 列表
  → SystemPrompt.skills()
    → Skill.hasNeedsReload() → false（已被 ensure 消费）
    → 但 version 已 bump → 缓存失效 → 重建 prompt
```

### 5.3 Poll-based 刷新（Watcher 失效时的降级路径）

```
ensure() 被调用
  → state.task 存在 + Date.now() - lastLoadMs > 10000
  → skillFilesChanged(state)
    → fs.statSync 每个已知 skill 文件，比对 mtime
    → fs.statSync 每个 skill 目录，比对 mtime
  → 检测到变化 → 清空并重新加载
  → 未检测到 → lastLoadMs = Date.now()（推迟下次检查）
```

---

## 6. Effect 层与状态管理

### 6.1 技术栈

项目使用 **Effect 4.0.0-beta.35** 作为核心框架，Skill 模块基于 Effect 的 Service/Layer 模式构建。

### 6.2 状态管理层次

```
Module Level (进程全局)
├── needsReloadDirs: Set<string>       ← watcher 写入，ensure() 读取
└── watchers: Map<string, WatchState>  ← 文件监视器实例

Instance Level (AsyncLocalStorage)
├── versionState: { version: number }  ← bumpVersion/getVersion
├── runtimeState: RuntimeOverlay       ← 运行时 skill 覆盖层
└── snapshotCache: Map<string, { prompt, version }>  ← system.ts 中

InstanceState (Effect ScopedCache)
└── Skill.state → Cache { skills, dirs, task, lastLoadMs, ensure }
    └── ScopedCache key = Instance.directory
    └── timeToLive = Duration.infinity（永不自动过期）
    └── 通过 registerDisposer 在 Instance dispose 时清除
```

### 6.3 关键设计：spread copy + in-place mutation

```typescript
const create = (discovery, directory, worktree): Cache => {
  const state: State = { skills: {}, dirs: new Set(), lastLoadMs: 0 }
  // ...
  const ensure = () => {
    // ensure 闭包捕获原始 state 变量
    // 通过 in-place 修改（delete keys, .clear()）保证 Cache 引用同步
    for (const key of Object.keys(state.skills)) delete state.skills[key]
    state.dirs.clear()
  }
  return { ...state, ensure }  // spread copy，skills/dirs 是同一引用
}
```

`{ ...state, ensure }` 创建的 spread copy 被 `ScopedCache` 缓存。`ensure()` 通过 in-place 修改原始 `state.skills`（与 spread copy 共享同一对象引用），确保缓存的 Cache 对象也能看到更新后的数据。

### 6.4 Effect Service 接口

```typescript
export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}
```

所有公开 API 通过 `makeRunPromise(Service, defaultLayer)` 桥接为 async 函数：

```typescript
export async function get(name: string) { return runPromise((skill) => skill.get(name)) }
export async function all() { return runPromise((skill) => skill.all()) }
export async function available(agent?: Agent.Info) { return runPromise((skill) => skill.available(agent)) }
```

---

## 7. Runtime Overlay 系统

Runtime Overlay 是一个独立于静态加载的动态 skill 管理机制，允许在运行时**按作用域**加载和卸载 skill。

### 7.1 作用域层次

```
discovered (全局发现层)
  └── workspace (工作区级，key = workspaceID)
       └── session (会话级，key = workspaceID:sessionID)
```

每层可以：
- **添加 skill**：从文件路径加载
- **隐藏 skill**：通过 `hide` 参数遮蔽上层 skill
- **卸载 skill**：移除已添加的 skill

### 7.2 合并逻辑

```typescript
// SystemPrompt.skills() 中的合并：
const base = await Skill.available(agent)        // 静态加载的 skill
const runtime = await Skill.runtimeAll(scope)     // 运行时 overlay
const merged = new Map(base.map(s => [s.name, s]))
for (const skill of runtime) {
  if (permission denied) continue
  merged.set(skill.name, skill)                   // runtime 覆盖 static
}
```

### 7.3 冲突检测

Runtime skill 加载前会检测：
- 是否与已有 Command 冲突
- 是否与同作用域内其他 skill 名称冲突
- 同一来源（相同 file path）的重复加载会覆盖

---

## 8. Token 预算控制与三级降级

当 skill 数量增长时，system prompt 中的 skill 列表可能过大。`fmtWithBudget()` 实现了三级降级策略：

### Tier 1：完整格式

```xml
<available_skills>
  <skill>
    <name>mathflow</name>
    <description>Use when mathematical research work needs stage-aware guidance.</description>
    <location>~/skills/mathflow/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

- 条件：`list.length ≤ maxSkillsInPrompt` 且 `fullText.length ≤ maxSkillsPromptChars`
- 返回：`{ compact: false, truncated: false }`

### Tier 2：紧凑格式（省略 description）

```xml
<available_skills>
  <skill>
    <name>mathflow</name>
    <location>~/skills/mathflow/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

- 条件：完整格式超限但紧凑格式在预算内
- 返回：`{ compact: true, truncated: false }`

### Tier 3：二分截断

- 条件：紧凑格式仍超限
- 行为：二分搜索找到最大可容纳的 skill 数量
- 追加警告：`"Skills truncated: included N of M (compact format, descriptions omitted)."`
- 返回：`{ compact: true, truncated: true }`

### 默认限制

| 配置项 | 默认值 | 含义 |
|--------|--------|------|
| `maxSkillsInPrompt` | 150 | Tier 1 数量上限 |
| `maxSkillsPromptChars` | 30,000 | 字符总预算 |

### 路径压缩

`compactPath()` 将 home 目录前缀替换为 `~`，节省每个 skill 约 5-6 tokens：

```
/home/reaslab/.claude/skills/foo/SKILL.md → ~/.claude/skills/foo/SKILL.md
```

---

## 9. 快照缓存与版本追踪

### 9.1 版本号

```typescript
const versionState = Instance.state(() => ({ version: 0 }))

export function bumpVersion(): number {
  const state = versionState()
  const now = Date.now()
  state.version = now <= state.version ? state.version + 1 : now
  return state.version
}
```

- 使用 `Date.now()` 保证单调递增
- 在以下时机 bump：
  - `ensure()` → `load()` 完成后
  - `runtimeLoad()` 完成后
  - `runtimeUnload()` 完成后

### 9.2 Prompt 快照缓存（`system.ts`）

```typescript
// Cache key: "${workspaceID}:${sessionID}"
const snapshotCache = Instance.state(() => new Map<string, { prompt: string; version: number }>())

export async function skills(agent, scope?) {
  const currentVersion = Skill.getVersion()
  const cached = cache.get(cacheKey)
  const needsReload = Skill.hasNeedsReload(Instance.directory)

  // 三个条件全部满足才命中缓存：
  // 1. 无 reload 标记
  // 2. 有缓存且版本 >= 当前版本
  // 3. 版本 > 0（已经过至少一次加载）
  if (!needsReload && cached && cached.version >= currentVersion && currentVersion > 0) {
    return cached.prompt
  }

  // 缓存未命中 → 重建
  const base = await Skill.available(agent)
  const runtime = await Skill.runtimeAll(scope)
  // ... merge + fmtWithBudget ...
  cache.set(cacheKey, { prompt, version: Skill.getVersion() })
  return prompt
}
```

不同 session 拥有独立的缓存条目（因为 runtime overlay 可能不同）。

---

## 10. 文件监视热刷新

### 10.1 监视目录

`resolveWatchDirs()` 生成监视列表：

| 目录 | 来源 |
|------|------|
| `~/.claude/skills` | 全局 skill（home 级） |
| `~/.agents/skills` | 全局 skill（home 级） |
| `{directory}/skills` | 项目 skill |
| `{directory}/.claude/skills` | 项目级 .claude |
| `{directory}/.agents/skills` | 项目级 .agents |
| `{__dirname}/../../skills` | 内置 skill（Docker 镜像） |
| `config.skills.paths[*]` | 配置的额外路径 |

### 10.2 chokidar 配置

```typescript
chokidar.watch(watchDirs, {
  ignoreInitial: true,
  ignored: [/\.git/, /node_modules/, /dist/, /\.venv/, /venv/, /__pycache__/, /build/, /\.cache/],
})
```

- `ignoreInitial: true` — 不触发已有文件的 add 事件
- 仅响应 `add`、`change`、`unlink` 且文件名为 `SKILL.md` 的事件

### 10.3 防抖机制

```typescript
const schedule = (changedPath?) => {
  state.pendingPath = changedPath ?? state.pendingPath
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => {
    Skill.markNeedsReload(directory)   // module-level Set
    try { Skill.bumpVersion() } catch {}  // 失败是预期的（无 Instance 上下文）
  }, debounceMs)  // 默认 250ms
}
```

快速连续修改（如编辑器自动保存）只会触发一次 reload。

### 10.4 双层保障

| 机制 | 触发条件 | 延迟 | 可靠性 |
|------|---------|------|--------|
| chokidar watcher | 文件系统事件 | ~250ms（debounce） | 依赖 inotify，Docker/WSL2 下可能丢事件 |
| poll-based 检查 | `ensure()` 被调用 + 距上次加载 > 10s | ≤10s | 完全可靠（stat 调用） |

`skillFilesChanged()` 通过 `fs.statSync` 检查：
- 所有已知 skill 文件的 mtime（检测修改/删除）
- 所有 skill 目录的 mtime（检测新增/删除文件）

### 10.5 Watcher 生命周期

- **创建**：`load()` 完成后调用 `ensureSkillsWatcher()`
- **复用**：若监视目录和配置未变，`ensureSkillsWatcher()` 为 no-op
- **替换**：若配置变化，关闭旧 watcher，创建新 watcher
- **禁用**：`config.watch === false` 时关闭并清理
- **清理**：`resetSkillsRefreshForTest()` 关闭所有 watcher（测试用）

---

## 11. 安全与限制机制

### 11.1 文件大小限制

```typescript
export const DEFAULT_MAX_SKILL_FILE_BYTES = 256_000  // 256KB

function checkFileSize(filePath: string, maxBytes?: number): boolean {
  const stat = fs.statSync(filePath)
  if (stat.size > limit) {
    log.warn("skipping oversized SKILL.md", { path, size, maxBytes })
    return false
  }
}
```

- 在 `add()`（静态加载）和 `scanRuntimeOverlay()`（运行时加载）中检查
- 超限的 skill 被跳过，不影响其他 skill 的加载
- 可通过 `maxSkillFileBytes` 配置调整

### 11.2 权限过滤

```typescript
// Skill.available() 中
list.filter(skill => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")

// SystemPrompt.skills() 中的 runtime skill
if (Permission.evaluate("skill", skill.name, agent.permission).action === "deny") continue

// SkillTool 执行时的权限请求
await ctx.ask({ permission: "skill", patterns: [params.name], always: [params.name] })
```

Agent 的 permission 配置可以限制其能使用的 skill 集合。

### 11.3 名称冲突处理

- 静态加载：同名 skill 后者覆盖前者，记录 warn 日志
- 运行时加载：检测 discovered/workspace/session 作用域内的冲突，冲突时抛错
- Command 冲突：runtime skill 不能与已有 Command 同名

---

## 12. 远程 Skill 发现

`src/skill/discovery.ts` 实现从远程 HTTP 服务拉取 skill 包。

### 工作流程

```
config.skills.urls = ["https://skills.example.com/math"]

1. GET https://skills.example.com/math/index.json
   → { "skills": [{ "name": "calculus", "files": ["SKILL.md", "scripts/run.sh"] }] }

2. 对每个 skill，下载所有文件到本地缓存：
   GET https://skills.example.com/math/calculus/SKILL.md
   → 保存到 {cache}/skills/calculus/SKILL.md

3. 返回下载完成的目录列表 → load() 进一步 scan
```

### 缓存策略

- 缓存路径：`Global.Path.cache + "/skills/"`
- 已下载文件不重复下载（`fs.exists` 检查）
- 并发控制：skill 级 4 并发，文件级 8 并发
- 网络失败时静默跳过（log error）

---

## 13. SkillTool — LLM 调用入口

`src/tool/skill.ts` 定义了 `skill` 工具，是 LLM 加载 skill 指令的主要入口。

### 工具描述（每轮重建）

```typescript
export const SkillTool = Tool.define("skill", async (ctx) => {
  const list = await Skill.available(ctx?.agent)  // 每轮调用，获取最新列表

  const description = list.length === 0
    ? "...No skills are currently available."
    : [..., Skill.fmt(list, { verbose: false })]  // Markdown 格式列出 skill

  return { description, parameters: z.object({ name: z.string() }), execute }
})
```

`Tool.define` 的 `init` 函数在 `ToolRegistry.tools()` 中**每轮 LLM 请求都会调用**（非缓存），确保工具描述反映最新 skill 列表。

### 执行流程

```
LLM 调用 skill tool { name: "mathflow" }
  → Skill.get("mathflow") → ensure() → state.skills["mathflow"]
  → 权限请求 → ctx.ask({ permission: "skill", patterns: ["mathflow"] })
  → 读取 skill 目录下的文件列表（Ripgrep.files, limit 10）
  → 返回注入内容：
    <skill_content name="mathflow">
    # Skill: mathflow
    {content}
    Base directory: file:///app/skills/mathflow
    <skill_files>
      <file>/app/skills/mathflow/scripts/run.sh</file>
    </skill_files>
    </skill_content>
```

---

## 14. Runtime Skill Tools

`src/tool/skill-runtime.ts` 提供三个运行时 skill 管理工具：

| 工具 | 功能 |
|------|------|
| `skill-finder` | 查找当前作用域下的 runtime skill |
| `load-skill` | 从本地路径加载 skill 到 workspace/session 作用域 |
| `unload-skill` | 隐藏/卸载指定 skill |

这些工具仅在 `OPENCODE_ENABLE_QUESTION_TOOL` 或 client 为 app/cli/desktop 时启用。

### load-skill 安全检查

1. 文件访问权限请求（read permission）
2. 路径拒绝记忆（denied path 不重复请求）
3. Command 名称冲突检测
4. 同作用域 skill 名称冲突检测
5. Skill 加载权限请求（skill permission）

---

## 15. System Prompt 集成

`src/session/system.ts` 中 `SystemPrompt.skills()` 负责将 skill 列表注入 system prompt。

### 注入位置

```typescript
// prompt.ts 中，每轮构建 system prompt
const skills = await SystemPrompt.skills(agent, { workspaceID, sessionID })
const system = [
  ...(await SystemPrompt.environment(model)),    // 环境信息
  ...(skills ? [skills] : []),                    // skill 列表
  ...(await InstructionPrompt.system()),          // 其他指令
]
```

### 输出格式

```
Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>mathflow</name>
    <description>...</description>
    <location>~/skills/mathflow/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

### 双通道呈现

LLM 同时从两个渠道获知 skill 信息：

1. **System Prompt**（`SystemPrompt.skills()`）— XML 格式的 skill 列表（经过 fmtWithBudget 预算控制）
2. **Tool Description**（`SkillTool.init()`）— Markdown 格式的 skill 列表（附在 skill 工具描述中）

两者每轮都从 `Skill.available()` 获取最新数据。

---

## 16. 配置体系

### SkillsConfig 接口

```typescript
export interface SkillsConfig {
  /** 额外 skill 目录路径（支持 ~ 和相对路径） */
  paths?: string[]
  /** 远程 skill index.json URL */
  urls?: string[]
  /** 单个 SKILL.md 文件大小限制（默认 256KB） */
  maxSkillFileBytes?: number
  /** System prompt 中最大 skill 数量（默认 150） */
  maxSkillsInPrompt?: number
  /** System prompt 中 skill 列表最大字符数（默认 30,000） */
  maxSkillsPromptChars?: number
  /** 启用文件监视热刷新（默认 true） */
  watch?: boolean
  /** 文件监视防抖间隔 ms（默认 250） */
  watchDebounceMs?: number
  /** Poll-based 过期检查间隔 ms（默认 10,000，0 禁用） */
  stalePollIntervalMs?: number
}
```

### 默认配置

```typescript
Config.get() → {
  workspace: process.env.PROJECT_WORKSPACE || "/workspace",
  skills: {
    paths: ["skills"],  // 默认扫描项目根目录下的 skills/
  },
}
```

---

## 17. 内置 Skills

项目包含 9 个内置 skill，全部面向**数学研究工作流**：

| Skill | 描述 |
|-------|------|
| `mathflow` | 阶段感知的数学研究路由器，按需选择下一阶段 skill |
| `problem-analysis` | 问题澄清与假设分离，在建模前确保问题定义清晰 |
| `mathematical-modeling` | 数学建模指导 |
| `derivation-and-proof-checking` | 推导和证明检查 |
| `numerical-experimentation` | 数值实验设计与执行 |
| `result-validation` | 结果验证 |
| `self-audit-loop` | 对抗性审计，寻找反例和过度声称 |
| `report-writing` | 研究报告撰写 |
| `research-planning` | 研究计划制定 |

`mathflow` 作为编排 skill，根据当前研究阶段动态选择并加载其他 stage skill。

---

## 18. 测试体系

### 测试文件

共 8 个测试文件，1570 行，48 个测试用例：

| 文件 | 测试内容 | 用例数 |
|------|---------|--------|
| `skill-size-limit.test.ts` | SKILL.md 文件大小限制 | 5 |
| `skill-path-compression.test.ts` | 路径压缩 compactPath() | 5 |
| `skill-budget.test.ts` | Token 预算控制 fmtWithBudget() | 7 |
| `skill-snapshot.test.ts` | 版本追踪 + 快照缓存 | 7 |
| `skill-refresh.test.ts` | 文件监视热刷新 | 8 |
| `skill-openclaw-features-integration.test.ts` | 端到端集成测试 | 3 |
| `skill-runtime.test.ts` | Runtime overlay 系统 | 7 |
| `workspace-skill-discovery.test.ts` | 工作区 skill 发现 | 6 |

### 测试框架与模式

- 框架：`bun:test`
- 每个测试通过 `Instance.provide()` 创建隔离的 Instance 上下文
- 使用 `fs.mkdtemp()` 创建临时目录，`afterEach` 清理
- 文件监视测试使用较长的 sleep（1-1.5s）以适应 WSL2 的 inotify 延迟

### 运行命令

```bash
bun test --timeout 30000 tests/skill/    # 运行所有 skill 测试
bunx tsc --noEmit                         # 类型检查
```

---

## 19. Docker 容器内运行行为

### 容器架构

```
reaslab-be (后端)
  → docker run reaslab-agent:latest tail -f /dev/null   (创建容器)
  → docker exec ... bun run src/main.ts                  (启动 agent)
```

容器命名：`reaslab-ai--{project_uuid}--{user_id}--{agent_id}`

### 文件系统映射

| 容器路径 | 说明 |
|---------|------|
| `/app/` | 应用代码（镜像内） |
| `/app/skills/` | 内置 skill（镜像内打包） |
| `/app/data/` | 数据目录（SQLite 等） |
| `$PROJECT_WORKSPACE` | 用户工作区（bind mount, rw） |

### Skill 加载路径（容器内）

1. 全局：`/home/reaslab/.claude/skills/`、`/home/reaslab/.agents/skills/`
2. 项目级：`$PROJECT_WORKSPACE/.claude/skills/`、`$PROJECT_WORKSPACE/.agents/skills/`
3. 内置：`/app/skills/`（mathflow 等 9 个）
4. 配置：`$PROJECT_WORKSPACE/skills/`（默认 config.paths）

用户可通过在工作区目录下创建 `skills/{name}/SKILL.md` 来添加自定义 skill。

---

## 20. 已知限制与设计取舍

### 20.1 AsyncLocalStorage 与 watcher 的上下文隔离

`bumpVersion()` 和 `getVersion()` 依赖 `Instance.state()`（底层使用 AsyncLocalStorage）。chokidar 的回调在 `setTimeout` 中执行，不在任何 Instance 的 AsyncLocalStorage 上下文中，因此 `bumpVersion()` 会失败。

**当前解决方案**：watcher 只设置 module-level 的 `needsReloadDirs` 标记，`bumpVersion()` 包在 try/catch 中允许失败。版本号在下一次 `ensure()` 的 `load().then()` 中正确 bump（此时有 Instance 上下文）。

### 20.2 spread copy 的 task 字段脱钩

`create()` 返回 `{ ...state, ensure }`，spread copy 的 `.task` 字段与原始 `state.task` 在 `ensure()` 修改后脱钩。但这不影响正确性，因为 `ensure()` 闭包始终读写原始 `state`，而非 spread copy。

### 20.3 Docker/WSL2 下 inotify 的可靠性

Linux 原生 Docker 的 bind mount 支持 inotify，但在 WSL2 + Docker Desktop 组合下可能出现事件丢失。poll-based 检查（默认 10s 间隔）作为降级方案保障最终一致性。

### 20.4 远程 skill 无热刷新

通过 `config.skills.urls` 拉取的远程 skill 下载到本地缓存后，不会自动检查远程更新。需要清除缓存并重启才能获取远程变更。

### 20.5 Frontmatter 解析器的简化

`ConfigMarkdown.parse()` 使用简单的正则和行级 key:value 解析，不支持复杂 YAML 特性（嵌套对象、数组、多行值等）。对于 SKILL.md 的简单 `name`/`description` 字段足够使用。

---

## 附录：数据类型定义

```typescript
// Skill 信息
type Info = {
  name: string        // Skill 唯一标识
  description: string // 简短描述
  location: string    // SKILL.md 绝对路径
  content: string     // frontmatter 后的正文内容
}

// 内部状态
type State = {
  skills: Record<string, Info>  // name → Info 映射
  dirs: Set<string>             // 已扫描的 skill 目录集合
  task?: Promise<void>          // 当前加载任务（resolved = 已加载）
  lastLoadMs: number            // 上次加载完成的时间戳
}

// 缓存对象（暴露给 Effect 层）
type Cache = State & {
  ensure: () => Promise<void>   // 确保 skill 已加载（含热刷新逻辑）
}

// 格式化结果
type FmtBudgetResult = {
  text: string       // 格式化后的文本
  truncated: boolean  // 是否被截断
  compact: boolean    // 是否使用紧凑格式
}
```
