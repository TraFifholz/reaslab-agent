# Reaslab-Agent vs OpenClaw: Skill 机制详细对比

> 基于两个项目源码的全链路对比分析
> 分析日期: 2026-04-02

---

## 1. 总体架构哲学

| 维度 | OpenClaw | Reaslab-Agent |
|------|----------|---------------|
| **设计理念** | 「轻注入 + 按需读取」— prompt 只注入摘要，模型自行 `read` | 「专用工具 + 完整加载」— 封装 `skill` 工具，一次性返回全部内容 |
| **扩展方式** | 纯声明式 Markdown，丰富的元数据（OS/bins/env 约束） | 声明式 Markdown，轻量元数据 + 运行时动态管理 |
| **Token 策略** | 保守：严格预算控制，三级降级 | 激进：无预算限制，信任模型选择 |
| **刷新策略** | 自动：文件监视 + 版本号 + 快照缓存 | 手动：运行时 load/unload 工具 |
| **技术栈** | TypeScript + 纯函数/类模式 | TypeScript + Effect (函数式) + Zod |

**核心差异一句话总结**: OpenClaw 像「菜单点餐」—— 先看菜单（摘要列表），再叫服务员送菜（`read` SKILL.md）；Reaslab-Agent 像「自助取餐」—— 调用 `skill` 工具直接端走整盘菜。

---

## 2. Prompt 注入机制对比（核心差异）

### 2.1 注入内容

#### OpenClaw: 「摘要注入」

```
System Prompt 中注入:
┌─────────────────────────────────────────────────┐
│ ## Skills (mandatory)                            │
│ Before replying: scan <available_skills>...       │
│ - If exactly one skill clearly applies:          │
│   read its SKILL.md at <location> with `read`    │
│ - If none clearly apply: do not read any SKILL.md│
│                                                  │
│ <available_skills>                               │
│   <skill>                                        │
│     <name>github</name>                          │
│     <description>Manage GitHub issues...</descr> │
│     <location>~/.openclaw/skills/.../SKILL.md</> │
│   </skill>                                       │
│   ...最多 150 个 skill                            │
│ </available_skills>                              │
└─────────────────────────────────────────────────┘

注入量: 仅 名称 + 描述 + 路径
完整内容: 模型需要自行调用 read 工具读取
```

**源码**: `src/agents/system-prompt.ts` → `buildSkillsSection()`

#### Reaslab-Agent: 「摘要注入 + 工具加载」

```
System Prompt 中注入:
┌─────────────────────────────────────────────────┐
│ Skills provide specialized instructions...        │
│ Use the skill tool to load a skill when a task   │
│ matches its description.                         │
│                                                  │
│ <available_skills>                               │
│   <skill>                                        │
│     <name>mathflow</name>                        │
│     <description>Use when mathematical research  │
│       work needs stage-aware guidance.</descr>   │
│     <location>file:///app/skills/.../SKILL.md</> │
│   </skill>                                       │
│   ...无数量限制                                    │
│ </available_skills>                              │
└─────────────────────────────────────────────────┘

注入量: 名称 + 描述 + 路径（XML 格式，更详细）
完整内容: 模型调用专用 skill 工具加载
```

**源码**: `src/session/system.ts:62-81` → `SystemPrompt.skills()`

### 2.2 注入量控制

| 控制维度 | OpenClaw | Reaslab-Agent |
|----------|----------|---------------|
| **最大 skill 数** | 150 个 | **无限制** |
| **最大字符数** | 30,000 字符 | **无限制** |
| **单文件大小** | 256 KB 上限 | **无限制** |
| **降级策略** | 三级（见下） | **无** |

#### OpenClaw 三级降级策略

**源码**: `src/agents/skills/workspace.ts:567-613` → `applySkillsPromptLimits()`

```
第一级: Full 格式
┌──────────────────────────────────────┐
│ <skill>                              │
│   <name>github</name>               │
│   <description>Manage GitHub...</>   │  ← 包含描述
│   <location>~/.../SKILL.md</>        │
│ </skill>                             │
└──────────────────────────────────────┘
         │
         ▼ 超过 30,000 字符?
第二级: Compact 格式
┌──────────────────────────────────────┐
│ <skill>                              │
│   <name>github</name>               │  ← 去掉描述
│   <location>~/.../SKILL.md</>        │
│ </skill>                             │
└──────────────────────────────────────┘
         │
         ▼ 还超?
第三级: 二分搜索截断
┌──────────────────────────────────────┐
│ 保留尽可能多的 skill                  │
│ + "⚠️ Skills truncated: X of Y"     │  ← 追加警告
└──────────────────────────────────────┘
```

**路径压缩优化**: `/Users/alice/.bun/install/global/...` → `~/.bun/...`，每个 skill 节省约 5-6 tokens。

#### Reaslab-Agent: 无降级

当前没有任何 token 预算控制。所有 skill 的摘要信息全部注入 system prompt，不做截断。

**潜在风险**: 如果 skill 数量增长到数十个以上，system prompt 可能过大。当前项目仅 9 个 math skill，尚未触及问题。

### 2.3 注入时机

| 时机 | OpenClaw | Reaslab-Agent |
|------|----------|---------------|
| **首次构建** | 会话首轮消息 (`isFirstTurnInSession`) | 每次请求 |
| **后续更新** | 仅当版本号过期时重建 | **每次请求都重建** |
| **上下文压缩** | Compaction 时重建 | N/A |
| **缓存机制** | SkillSnapshot 缓存于 SessionEntry | **无缓存** |

#### OpenClaw: 快照缓存 + 版本号比对

**源码**: `src/auto-reply/reply/session-updates.ts:81-108`

```
ensureSkillSnapshot()
    │
    ├─ isFirstTurn? → 构建快照 → 缓存到 SessionEntry
    │
    └─ 非首轮:
         ├─ getSkillsSnapshotVersion()  → 当前文件系统版本
         ├─ session.skillSnapshot.version → 缓存版本
         └─ 版本不同? → 重建快照 : → 复用缓存
```

**优势**: 避免每次对话都扫描文件系统，减少 I/O 开销。

#### Reaslab-Agent: 每次重建

**源码**: `src/session/prompt.ts:656-664` → `src/session/system.ts:62-81`

```
每次用户消息 → SystemPrompt.skills(agent, scope)
    ├─ Skill.available(agent)       // 遍历静态列表
    ├─ Skill.runtimeAll(scope)      // 遍历运行时 overlay
    ├─ 合并 + 权限过滤 + 排序
    └─ Skill.fmt(list)              // 格式化 XML
```

静态 skill 列表本身是懒加载一次性的（`ensure()` 缓存），但**格式化和合并**每次都重新执行。

---

## 3. Skill 调度机制对比（模型如何使用 Skill）

### 3.1 触发路径

```
                    OpenClaw                          Reaslab-Agent
              ┌─────────────────┐              ┌─────────────────────┐
              │  两种触发路径    │              │  一种触发路径        │
              ├─────────────────┤              ├─────────────────────┤
  路径A       │ 模型自动触发     │              │ 模型调用 skill 工具  │
  (自动)      │ 看到 skill 列表  │              │ 看到 skill 列表      │
              │ → 主动 read      │              │ → 调用 skill 工具    │
              │   SKILL.md      │              │   → 返回完整内容     │
              ├─────────────────┤              │   + 附带文件列表     │
  路径B       │ 用户斜杠命令     │              └─────────────────────┘
  (手动)      │ /github create.. │
              │ → 解析命令名     │              (无斜杠命令机制)
              │ → tool dispatch  │
              │   或 prompt 注入 │
              └─────────────────┘
```

### 3.2 OpenClaw: 双路径调度详解

#### 路径 A: 模型自动触发

```
System Prompt 指令:
  "Before replying: scan <available_skills> <description> entries.
   If exactly one skill clearly applies: read its SKILL.md..."
       │
       ▼
模型内部判断: "用户在问 GitHub PR 的事 → github skill 匹配"
       │
       ▼
模型调用 read 工具: read("~/.openclaw/skills/github/SKILL.md")
       │
       ▼
得到完整 SKILL.md 内容 → 按指令执行
```

**特点**: 
- 模型自主判断是否需要 skill，不强制
- 明确要求「最多读一个」，避免 token 浪费
- 依赖模型的理解能力匹配 skill

#### 路径 B: 用户斜杠命令触发

**源码**: `src/auto-reply/reply/get-reply-inline-actions.ts`

```
用户输入: "/github create issue about login bug"
       │
       ▼
resolveSlashCommandName("/github")
       │  (排除内置命令: /new, /status 等)
       ▼
resolveSkillCommandInvocation({
  commandBody: "/github create issue about login bug",
  skillCommands: [{ name: "github", dispatch: {...} }, ...]
})
       │
       ▼ 匹配到 github skill
       │
       ├─ dispatch.kind === "tool"?
       │    → 直接调用指定工具 (跳过 LLM，确定性执行)
       │
       └─ 无 dispatch?
            → 读取 SKILL.md → 注入对话作为 prompt
```

**命令名称解析规则**:
- `My Cool Skill!` → `my_cool_skill` (清洗)
- 最大 32 字符
- 同名追加后缀: `_2`, `_3`
- 模糊匹配: 下划线/空格/连字符互换
- 支持 `/skill github-issues create` 间接语法

### 3.3 Reaslab-Agent: 单路径工具调度详解

**源码**: `src/tool/skill.ts`

```
System Prompt 指令:
  "Use the skill tool to load a skill when a task matches its description."
       │
       ▼
模型判断: "用户在做数学推导 → derivation-and-proof-checking skill 匹配"
       │
       ▼
模型调用 skill 工具: skill({ name: "derivation-and-proof-checking" })
       │
       ▼
SkillTool.execute()
  ├─ Permission 检查 (ctx.ask)
  ├─ Skill.get(name) → 读取完整 SKILL.md
  ├─ Ripgrep.files(dir) → 列出 skill 目录文件（最多 10 个）
  └─ 返回:
       ┌──────────────────────────────────────────┐
       │ <skill_content name="derivation-...">    │
       │ # Skill: derivation-and-proof-checking   │
       │ [完整 SKILL.md 内容]                      │
       │ Base directory: /app/skills/derivation-.. │
       │ <skill_files>                            │
       │   SKILL.md                               │
       │   templates/proof-template.md            │
       │   references/common-mistakes.md          │
       │ </skill_files>                           │
       │ </skill_content>                         │
       └──────────────────────────────────────────┘
```

**vs OpenClaw `read`**: 
- `skill` 工具返回的不仅是 SKILL.md 内容，还**附带了目录中其他文件的列表**
- 模型可以后续 `read` 这些附带文件获取更多上下文
- 有**权限检查**环节，OpenClaw 的 `read` 没有 skill 级别的权限控制

### 3.4 调度机制总结

| 对比项 | OpenClaw | Reaslab-Agent |
|--------|----------|---------------|
| **触发方式** | 自动 `read` + 斜杠命令 | 专用 `skill` 工具 |
| **确定性执行** | 有 (tool dispatch 模式) | 无 |
| **权限检查** | 无 (read 无 skill 级权限) | 有 (Permission.evaluate) |
| **返回内容** | 纯 SKILL.md 文本 | SKILL.md + 附带文件列表 |
| **token 消耗** | 仅在需要时读取（按需） | 仅在需要时加载（按需） |
| **用户直接触发** | `/skill_name args` | 无（仅通过模型选择） |

---

## 4. 热刷新机制对比（核心差异）

### 4.1 OpenClaw: 自动热刷新

**源码**: `src/agents/skills/refresh.ts`

```
┌─ 文件系统监视层 ─────────────────────────────────────────┐
│                                                          │
│  ensureSkillsWatcher()                                   │
│    │                                                     │
│    ├─ chokidar.watch([                                   │
│    │    "<workspace>/skills/*/SKILL.md",                  │
│    │    "<workspace>/.agents/skills/*/SKILL.md",          │
│    │    "~/.openclaw/skills/*/SKILL.md",                  │
│    │    "~/.agents/skills/*/SKILL.md",                    │
│    │    plugin skill dirs...                              │
│    │  ])                                                  │
│    │                                                     │
│    ├─ 事件: add / change / unlink                         │
│    │                                                     │
│    └─ 忽略: .git, node_modules, dist, .venv,             │
│       __pycache__, build, .cache                         │
│                                                          │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌─ 防抖层 ─────────────────────────────────────────────────┐
│                                                          │
│  schedule()                                              │
│    clearTimeout(state.timer)                             │
│    setTimeout(() => bumpVersion(), 250ms)   ← 250ms 防抖 │
│                                                          │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌─ 版本管理层 ─────────────────────────────────────────────┐
│                                                          │
│  bumpSkillsSnapshotVersion()                             │
│    version = Date.now()          ← 时间戳作版本号         │
│    workspaceVersions.set(dir, version)                   │
│    emit({ workspaceDir, reason: "watch" })               │
│                                                          │
└──────────┬───────────┬───────────────────────────────────┘
           │           │
           ▼           ▼
┌─ 消费层 A ──────┐  ┌─ 消费层 B ──────────────────────────┐
│ Gateway 监听器  │  │ 下次对话                             │
│ 30s debounce    │  │ ensureSkillSnapshot()                │
│ → refresh       │  │   version > cached?                  │
│   remote nodes  │  │   → 是: 重建 snapshot + 新 prompt    │
│                 │  │   → 否: 复用缓存                     │
└─────────────────┘  └─────────────────────────────────────┘
```

#### 关键设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| **谁启动 watcher** | 首次对话时懒启动 | 不是 Gateway 启动时，避免无用 I/O |
| **监视粒度** | 仅 `*/SKILL.md` glob | 不监视所有文件，防止 FD 耗尽 |
| **防抖时间** | 250ms (可配置) | 平衡响应速度和 I/O 抖动 |
| **版本号** | `Date.now()` 时间戳 | 单调递增，无需原子计数器 |
| **双层防抖** | 文件系统 250ms + Gateway 30s | 各层职责独立 |
| **幂等性** | 路径+配置相同则不重建 watcher | 避免重复监听 |
| **关闭方式** | `skills.load.watch: false` | 配置项可关闭 |

### 4.2 Reaslab-Agent: 无自动热刷新

**源码**: `src/skill/index.ts:581-588`

```
┌─ 一次性加载 ─────────────────────────────────────────────┐
│                                                          │
│  const ensure = () => {                                  │
│    if (state.task) return state.task   ← 已加载则跳过     │
│    state.task = load().catch((err) => {                  │
│      state.task = undefined                              │
│      throw err                                           │
│    })                                                    │
│    return state.task                                     │
│  }                                                       │
│                                                          │
│  无 chokidar / 无 FSWatcher / 无版本号 / 无事件广播       │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**替代方案: 运行时手动管理**

```
┌─ 运行时 Skill 管理工具 ─────────────────────────────────┐
│                                                          │
│  load-skill 工具:                                        │
│    ├─ 输入: { path: "/path/to/SKILL.md", scope: "..." }  │
│    ├─ 解析 frontmatter                                   │
│    ├─ 冲突检测（名称重复）                                │
│    └─ 加入运行时 overlay (workspace 或 session 层)        │
│                                                          │
│  unload-skill 工具:                                      │
│    ├─ 输入: { name: "skill-name" }                       │
│    └─ 加入 hidden set，skill 从列表中消失                 │
│                                                          │
│  skill-finder 工具:                                      │
│    └─ 搜索指定路径下的 SKILL.md 文件                      │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 4.3 热刷新对比总结

| 维度 | OpenClaw | Reaslab-Agent |
|------|----------|---------------|
| **刷新方式** | 自动（文件监视） | 手动（运行时工具） |
| **延迟** | ~250ms（文件变更后） | 即时（模型主动调用时） |
| **无需用户干预** | 是 | 否（需模型/用户触发 load-skill） |
| **文件监视器** | chokidar | 无 |
| **防抖机制** | 双层（250ms + 30s） | N/A |
| **版本追踪** | Date.now() 时间戳 | 无 |
| **快照缓存** | SessionEntry 中缓存 | 无 |
| **跨 session 感知** | Gateway 事件广播 | 仅当前 session 的 overlay |
| **配置开关** | `skills.load.watch: false` | N/A |
| **动态 load/unload** | 无 | workspace/session 两级作用域 |

**设计取舍**:
- OpenClaw 面向**桌面用户**，skill 可能来自多个来源且频繁修改 → 自动热刷新价值大
- Reaslab-Agent 面向**研究工作流**，skill 相对固定（9 个数学阶段） → 运行时动态管理足够

---

## 5. Skill 加载来源与优先级对比

### 5.1 OpenClaw: 6 层明确优先级

```
优先级低 → 高:

  extra dirs        配置中额外指定的目录
       ▼
  bundled           OpenClaw 安装目录/skills/  (内置 skill)
       ▼
  managed           ~/.openclaw/skills/         (全局管理)
       ▼
  agents-personal   ~/.agents/skills/           (个人 agent skill)
       ▼
  agents-project    <workspace>/.agents/skills/ (项目 agent skill)
       ▼
  workspace         <workspace>/skills/          (项目 skill, 最高优先级)
```

同名 skill 按优先级覆盖: `workspace > agents-project > agents-personal > managed > bundled > extra`

### 5.2 Reaslab-Agent: 5 层隐式顺序覆盖

```
加载顺序 (后覆盖前):

  全局外部         ~/.claude/skills/**  ~/.agents/skills/**
       ▼
  项目外部         向上遍历目录树寻找 .claude/.agents
       ▼
  内置 skills      <项目根>/skills/**/SKILL.md
       ▼
  配置额外路径     config.skills.paths 中指定的目录
       ▼
  远程 URL         config.skills.urls 指定的 HTTP 索引  ← OpenClaw 没有
```

**关键区别**: Reaslab-Agent 支持**远程 URL skill 发现**:

```
config.skills.urls: ["https://example.com/skills/"]
       │
       ▼
Discovery.pull(url)
  ├─ GET .../index.json → { skills: [{name, files}] }
  ├─ 并发下载 (4 skills × 8 files)
  ├─ 缓存到 ~/.cache/opencode/skills/
  └─ 返回本地目录列表
```

### 5.3 资格过滤

| 过滤项 | OpenClaw | Reaslab-Agent |
|--------|----------|---------------|
| OS 平台限制 | `metadata.openclaw.os: [darwin, linux]` | 无 |
| 必需二进制 | `requires.bins: [gh, git]` | 无 |
| 必需环境变量 | `requires.env: [GITHUB_TOKEN]` | 无 |
| 配置项检查 | `requires.config: [...]` | 无 |
| 白名单过滤 | bundled allowlist | 无 |
| 启用/禁用 | `enabled: false` 配置 | 无 |
| **权限过滤** | 无 | `Permission.evaluate("skill", name, agent.permission)` |

OpenClaw 侧重**环境兼容性**过滤（这个 skill 在当前机器上能不能用）；
Reaslab-Agent 侧重**权限控制**过滤（这个 agent 有没有权限用这个 skill）。

---

## 6. 运行时 Skill Overlay 系统（Reaslab-Agent 独有）

OpenClaw 没有类似的运行时动态管理机制，这是 Reaslab-Agent 的独特设计。

### 6.1 三层 Overlay 架构

**源码**: `src/skill/index.ts:281-508`

```
┌─ Layer 1: Discovered (静态) ──────────────────────┐
│ 启动时一次性扫描所有来源                             │
│ Map<name, Info>                                    │
│ 不可变 (加载后不再更新)                              │
└──────────────────────────────────┬─────────────────┘
                                   │
┌─ Layer 2: Workspace Overlay ─────▼─────────────────┐
│ 作用域: per workspaceID                             │
│ sources: Map<sourceKey, {                           │
│   skills: Map<name, Info>,   ← 动态加载的 skill      │
│   hidden: Set<name>          ← 被隐藏的 skill        │
│ }>                                                  │
│ 通过 load-skill / unload-skill 工具修改              │
└──────────────────────────────────┬─────────────────┘
                                   │
┌─ Layer 3: Session Overlay ───────▼─────────────────┐
│ 作用域: per workspaceID:sessionID                   │
│ 结构同 Workspace Overlay                            │
│ 仅影响当前会话                                       │
└────────────────────────────────────────────────────┘

合并规则:
  结果 = discovered
       + workspace overlay (覆盖/隐藏 discovered 中的同名项)
       + session overlay   (覆盖/隐藏前两层的同名项)
```

### 6.2 使用场景

```
场景 1: 团队共享 skill
  → load-skill(path, scope="workspace")
  → 该 workspace 下所有 session 可见

场景 2: 临时实验
  → load-skill(path, scope="session")
  → 仅当前 session 可见，关闭后消失

场景 3: 隐藏不需要的 skill
  → unload-skill(name)
  → skill 加入 hidden set，不再出现在列表中
```

---

## 7. 安全机制对比

| 安全维度 | OpenClaw | Reaslab-Agent |
|----------|----------|---------------|
| **符号链接检查** | `realpath()` 验证不逃逸根目录 | 基本检查 |
| **路径逃逸防护** | 严格 containment check | 基本 |
| **文件大小限制** | 256 KB (`maxSkillFileBytes`) | 无 |
| **目录遍历深度** | 限制扫描目录数 (300/来源) | 无限制 |
| **插件 skill 隔离** | 路径不可逃逸插件根目录 | N/A |
| **权限系统** | 无 skill 级权限 | 有 (`Permission.evaluate`) |
| **加载前授权** | 无 (read 无需 skill 权限) | 有 (`ctx.ask` 权限检查) |

---

## 8. SKILL.md 格式对比

### OpenClaw: 丰富元数据

```yaml
---
name: github
description: Manage GitHub issues and pull requests using the gh CLI.
user-invocable: true          # ← 支持斜杠命令触发
command-dispatch: tool         # ← 确定性 tool dispatch
command-tool: exec
command-arg-mode: raw
metadata:
  openclaw:
    requires:
      bins: [gh]              # ← 环境依赖声明
    primaryEnv: GITHUB_TOKEN  # ← 关键环境变量
    os: [darwin, linux]       # ← OS 限制
    install:
      - kind: brew            # ← 自动安装规范
        formula: gh
---

# GitHub Skill
When the user asks about GitHub issues or PRs, use the `gh` CLI...
```

### Reaslab-Agent: 轻量元数据

```yaml
---
name: mathflow
description: Use when mathematical research work needs stage-aware guidance.
---

## Use when
Use this skill when a task involves mathematical research...

## Hard rules
- Always assess the current stage before choosing the next step.
```

**差异**: Reaslab-Agent 只需要 `name` + `description`，没有 OS/环境/安装/调用策略等元数据。更简洁但也意味着功能更少。

---

## 9. 完整生命周期对比

### OpenClaw: 一次完整的 Skill 使用

```
1. 启动 → 扫描 6 层来源 → 安全检查 + 资格过滤 → 构建 SkillEntry[]
2. 首次对话 → 启动 chokidar watcher → 构建 SkillSnapshot → 缓存
3. 构建 System Prompt → 注入 <available_skills> (名称+描述+路径)
4. 模型看到列表 → 判断匹配 → 调用 read("~/.../SKILL.md")
5. 得到完整内容 → 按指令执行
6. SKILL.md 被修改 → chokidar 检测 → 250ms 防抖 → bump version
7. 下次对话 → 检测版本过期 → 重建 SkillSnapshot → 新 prompt
```

### Reaslab-Agent: 一次完整的 Skill 使用

```
1. 首次调用 → 懒加载扫描 5 层来源 → 构建 Record<name, Info>
2. 每次请求 → SystemPrompt.skills() → 合并静态+运行时 → 格式化 XML
3. 构建 System Prompt → 注入 <available_skills>
4. 模型看到列表 → 判断匹配 → 调用 skill({ name: "mathflow" })
5. 权限检查 → 加载完整内容 + 文件列表 → 返回 <skill_content>
6. 模型按指令执行 → 可选: read 附带文件获取更多上下文
7. 需要新 skill → 模型调用 load-skill → 加入运行时 overlay
```

---

## 10. 总结: 适用场景与改进方向

### 10.1 各自适用场景

| 场景 | 更适合 | 原因 |
|------|--------|------|
| **大量 skill (50+)** | OpenClaw | Token 预算控制 + 三级降级 |
| **频繁修改 skill** | OpenClaw | 自动热刷新 |
| **多 agent 协作** | Reaslab-Agent | 权限系统 + per-agent skill 过滤 |
| **动态工作流** | Reaslab-Agent | 运行时 load/unload |
| **远程 skill 分发** | Reaslab-Agent | URL-based discovery |
| **跨平台兼容** | OpenClaw | OS/bins/env 资格过滤 |
| **安全敏感环境** | 两者互补 | OpenClaw 路径安全 + Reaslab 权限控制 |

### 10.2 Reaslab-Agent 可借鉴 OpenClaw 的改进

| 改进 | 优先级 | 难度 | 收益 |
|------|--------|------|------|
| Token 预算控制 | 高 | 低 | skill 数量增长时防止 system prompt 过大 |
| 快照缓存 | 中 | 低 | 减少每次请求的格式化开销 |
| 文件监视热刷新 | 中 | 中 | 开发阶段修改 SKILL.md 即时生效 |
| 三级降级策略 | 中 | 低 | 大量 skill 场景下的优雅降级 |
| 路径压缩 | 低 | 低 | 节省少量 token |
| SKILL.md 大小限制 | 低 | 低 | 防止异常大文件消耗资源 |

### 10.3 OpenClaw 可借鉴 Reaslab-Agent 的改进

| 改进 | 优先级 | 难度 | 收益 |
|------|--------|------|------|
| 专用 skill 工具 | 中 | 中 | 返回更丰富信息（文件列表），统一入口 |
| 运行时 load/unload | 中 | 高 | 动态工作流支持 |
| 权限系统集成 | 中 | 高 | 多 agent 场景下的精确控制 |
| 远程 skill 发现 | 低 | 中 | skill 分发和共享 |
