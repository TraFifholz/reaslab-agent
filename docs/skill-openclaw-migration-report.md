# OpenClaw Skill 机制迁移报告

## 1. 项目背景

reaslab-agent 的 skill 系统原先缺少 token 预算控制、缓存、热刷新等机制。随着 skill 数量增长，system prompt 可能过大，且每次请求都重新格式化浪费资源。本次迁移借鉴 OpenClaw 的 5 个核心设计，提升 skill 系统的健壮性和性能。

## 2. 实现的 5 项功能

### 2.1 SKILL.md 文件大小限制 (256KB)

**问题**: 异常大的 SKILL.md 文件会消耗过多内存和 token 预算。

**实现**:
- 在 skill 加载链路的 3 个入口（`add()`、`parseRuntimeInfo()`、`scanRuntimeOverlay()`）加入 `fs.statSync()` 大小检查
- 超限文件被跳过并记录 `warn` 日志，不阻塞其他 skill 加载
- 默认限制: **256,000 字节**，可通过 `maxSkillFileBytes` 配置

**文件**: `src/skill/index.ts` — `checkFileSize()` 函数 (line 40-52)

### 2.2 路径压缩

**问题**: system prompt 中的 skill 路径使用完整绝对路径（如 `/home/user/.claude/skills/foo/SKILL.md`），浪费 token。

**实现**:
- `compactPath()` 将 `$HOME` 前缀替换为 `~`，每个 skill 节省 ~5-6 tokens
- `escapeXml()` 替代原先的 `pathToFileURL()`，输出更简洁
- 仅影响 system prompt 中的 `<location>` 标签，`Info.location` 字段保持绝对路径不变

**文件**: `src/skill/index.ts` — `compactPath()` (line 705), `escapeXml()` (line 711)

### 2.3 Token 预算控制 + 三级降级

**问题**: skill 数量增多时，system prompt 的 skills 段可能无限膨胀。

**实现 — 三级降级策略**:

| 级别 | 条件 | 格式 | 内容 |
|------|------|------|------|
| Tier 1 | 字符数 <= `maxSkillsPromptChars` | 完整格式 | name + description + location |
| Tier 2 | 完整格式超限 | 紧凑格式 | name + location (无 description) |
| Tier 3 | 紧凑格式仍超限 | 二分截断 | 紧凑格式 + 截断警告 |

- 先按 `maxSkillsInPrompt`（默认 150）截断数量
- 再按 `maxSkillsPromptChars`（默认 30,000）控制字符数
- 返回 `FmtBudgetResult` 包含 `{ text, truncated, compact }` 元信息

**文件**: `src/skill/index.ts` — `fmtCompact()` (line 740), `fmtWithBudget()` (line 760)

### 2.4 快照缓存 + 版本追踪

**问题**: 每次构建 system prompt 都重新遍历、合并、格式化所有 skill，浪费计算资源。

**实现**:
- **版本追踪**: `versionState` 维护单调递增版本号（`Date.now()` 时间戳）
  - `bumpVersion()` 在 `runtimeLoad()`、`runtimeUnload()`、`ensure()` 首次加载后自动调用
  - `getVersion()` 返回当前版本
- **快照缓存**: `SystemPrompt.skills()` 按 `workspaceID:sessionID` 缓存格式化结果
  - 版本未变 → 直接返回缓存字符串（零开销）
  - 版本变化 → 重建 prompt 并更新缓存

**文件**:
- `src/skill/index.ts` — `bumpVersion()` (line 143), `getVersion()` (line 150)
- `src/session/system.ts` — `snapshotCache` + `skills()` 缓存逻辑 (line 28-111)

### 2.5 文件监视热刷新

**问题**: 修改 SKILL.md 后需要重启服务才能生效。

**实现**:
- 使用 chokidar v4 监视 skill 目录（非 glob 模式，兼容 WSL2）
- 监视目标: `~/.claude/skills/`、`~/.agents/skills/`、`<project>/skills/`、配置路径
- 事件过滤: 仅响应 `SKILL.md` 文件的 add/change/unlink 事件
- 防抖: 默认 250ms，快速连续修改只触发一次 `bumpVersion()`
- 自动忽略: `.git`、`node_modules`、`dist`、`.venv`、`__pycache__`、`build`、`.cache`

**文件**: `src/skill/refresh.ts` (新文件，138 行)

## 3. 配置参数

所有参数在 `Config.SkillsConfig` 中定义，均有合理默认值：

```typescript
interface SkillsConfig {
  paths?: string[]              // skill 搜索路径
  urls?: string[]               // 远程 skill URL
  maxSkillFileBytes?: number    // 单文件大小限制，默认 256,000
  maxSkillsInPrompt?: number    // prompt 中最大 skill 数量，默认 150
  maxSkillsPromptChars?: number // prompt skills 段最大字符数，默认 30,000
  watch?: boolean               // 是否启用热刷新，默认 true
  watchDebounceMs?: number      // 防抖间隔(ms)，默认 250
}
```

## 4. 测试结果

### 4.1 新增测试

| 测试文件 | 测试数 | 通过 | 覆盖功能 |
|---------|--------|------|---------|
| `skill-size-limit.test.ts` | 5 | 5 | 文件大小限制 |
| `skill-path-compression.test.ts` | 5 | 5 | 路径压缩 |
| `skill-budget.test.ts` | 7 | 7 | 预算控制 + 三级降级 |
| `skill-snapshot.test.ts` | 7 | 7 | 快照缓存 + 版本追踪 |
| `skill-refresh.test.ts` | 7 | 7 | 文件监视热刷新 |
| `skill-openclaw-features-integration.test.ts` | 3 | 3 | 端到端集成测试 |
| **合计** | **34** | **34** | **100% 通过** |

### 4.2 回归测试

| 测试目录 | 通过/总数 | 说明 |
|---------|-----------|------|
| `tests/skill/` | 47/47 | 全部通过（含已有 + 新增） |
| `tests/session/` | 6/6 | 全部通过 |
| `tests/config/` | 6/6 | 全部通过 |
| `tests/tool/` | 54/64 | 10 个失败均为**预先存在**，与本次改动无关 |

**结论: 零回归**。

### 4.3 修改文件统计

| 文件 | 操作 | 行数 |
|------|------|------|
| `src/config/config.ts` | 修改 | 104 |
| `src/skill/index.ts` | 修改 | 824 |
| `src/session/system.ts` | 修改 | 112 |
| `src/skill/refresh.ts` | 新建 | 138 |
| 6 个测试文件 | 新建 | 1,065 |

## 5. 如何测试使用

### 5.1 运行自动化测试

```bash
# 运行全部新增测试（34 个 test case）
bun test --timeout 30000 tests/skill/skill-size-limit.test.ts
bun test --timeout 30000 tests/skill/skill-path-compression.test.ts
bun test --timeout 30000 tests/skill/skill-budget.test.ts
bun test --timeout 30000 tests/skill/skill-snapshot.test.ts
bun test --timeout 30000 tests/skill/skill-refresh.test.ts
bun test --timeout 30000 tests/skill/skill-openclaw-features-integration.test.ts

# 一次性运行所有 skill 测试
bun test --timeout 30000 tests/skill/

# 运行全部测试确认无回归
bun test --timeout 30000 tests/session/ tests/config/
```

### 5.2 手动验证：文件大小限制

```bash
# 1. 创建一个正常 skill
mkdir -p skills/my-skill
cat > skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: A normal test skill
---

This skill does something useful.
EOF

# 2. 创建一个超大 skill (>256KB)
mkdir -p skills/huge-skill
python3 -c "
content = '---\nname: huge-skill\ndescription: Too large\n---\n\n' + 'x' * 300000
open('skills/huge-skill/SKILL.md', 'w').write(content)
"

# 3. 启动服务后检查日志，应看到:
#    WARN skipping oversized SKILL.md { path: ".../huge-skill/SKILL.md", size: 300xxx, maxBytes: 256000 }
#    my-skill 正常加载，huge-skill 被跳过
```

### 5.3 手动验证：热刷新

```bash
# 1. 启动 reaslab-agent 服务

# 2. 在另一个终端修改 skill 文件
echo "---
name: my-skill
description: Updated description v2
---

New content here.
" > skills/my-skill/SKILL.md

# 3. 观察服务日志，应在 ~250ms 后看到:
#    INFO SKILL.md changed, bumping version { path: ".../my-skill/SKILL.md" }
#    下一次 agent 请求将自动使用更新后的 skill 内容（缓存已失效）
```

### 5.4 手动验证：预算降级

```bash
# 创建大量 skill 触发降级
for i in $(seq -w 1 200); do
  mkdir -p skills/test-skill-$i
  cat > skills/test-skill-$i/SKILL.md << EOF
---
name: test-skill-$i
description: This is test skill number $i with a reasonably long description to consume token budget
---

Body of test skill $i with additional content.
EOF
done

# 启动服务后，system prompt 中的 skills 段会自动降级:
# - 如果 200 个 skill 的完整格式超过 30,000 字符 → 自动切换到紧凑格式
# - 如果紧凑格式仍超限 → 二分截断 + 显示警告
# - 最多包含 150 个 skill（默认 maxSkillsInPrompt）
```

### 5.5 验证缓存生效

在代码中或通过调试工具：

```typescript
import { Skill } from "./src/skill"

// 首次调用: 触发完整构建
const v1 = Skill.getVersion()  // > 0 (表示已初始化)

// SystemPrompt.skills() 连续调用两次
// 第二次应命中缓存（可通过日志确认无重建输出）

// 修改 skill 文件后:
// Skill.getVersion() 返回更大的值
// SystemPrompt.skills() 自动重建
```

## 6. 架构决策说明

| 决策 | 原因 |
|------|------|
| 目录监视替代 glob 模式 | chokidar v4 glob 模式在 WSL2 上不触发事件 |
| `Date.now()` 作为版本号 | 单调递增、无需额外计数器、自然排序 |
| `fs.statSync` 同步检查大小 | 在加载链路中调用频率低，避免异步复杂度 |
| 保持 `fmt()` 向后兼容 | `SkillTool` 等现有调用方不受影响 |
| 缓存按 `workspaceID:sessionID` 分区 | 不同会话可能有不同的 runtime skill 集合 |
