---
title: reaslab-agent — 三级知识库索引
scope: reaslab-agent 仓库内部 spec（Bun + TypeScript ACP 框架）
updated: 2026-04-28
update_reason: 三级 KB 首次建 INDEX；现有 6 个文件全部是 Skill 机制专题，需明确分类
---

# reaslab-agent — 三级知识库索引

> reaslab-agent 是 ACP Agent 框架（Bun + TypeScript），通过 ACP stdio 通信，含 Skill 系统。
>
> **Normal 栈中的角色**：仅作 `agent_configs.reaslab-agent` 行的镜像源（`ghcr.io/reaslab/reaslab-agent:main`），compose **不常驻**；用户在 UI 选 "ReasLab Agent" 时由 reaslab-be 临时 spawn。
>
> **Advanced 栈中的角色**：由 reaslab-be spawn 启动 ACP stdio。
>
> - 一级（跨版本）→ [`../../../docs/INDEX.md`](../../../docs/INDEX.md)
> - 二级（Normal）→ [`../../docs/INDEX.md`](../../docs/INDEX.md)
> - 三级（本文件）→ reaslab-agent 仓库内部 spec

## 当前知识库聚焦：Skill 机制

本目录现有文档全部是 **Skill 机制对比 / 迁移**专题，缘起 2026-03 用户希望把 OpenClaw 的 Skill 机制移植进 reaslab-agent。

### 速查表

| 我想… | 去哪里 |
|---|---|
| 看 reaslab-agent **现状** Skill 机制 | [skill-system-technical-report.md](./skill-system-technical-report.md) ⭐ |
| 看 reaslab-agent Skill 怎么实现（源码追踪）| [analysis-reaslab-agent-skill-mechanism.md](./analysis-reaslab-agent-skill-mechanism.md) |
| 看 OpenClaw Skill 怎么实现（源码追踪）| [analysis-openclaw-skill-mechanism.md](./analysis-openclaw-skill-mechanism.md) |
| 看两者 **对比 / 差异**（决策依据）| [comparison-skill-mechanism.md](./comparison-skill-mechanism.md) |
| 看 OpenClaw → reaslab-agent **迁移方案**| [skill-openclaw-migration-report.md](./skill-openclaw-migration-report.md) |

### 推荐阅读顺序

1. [skill-system-technical-report.md](./skill-system-technical-report.md) — 先了解现状
2. [analysis-reaslab-agent-skill-mechanism.md](./analysis-reaslab-agent-skill-mechanism.md) — 看现状的源码细节
3. [analysis-openclaw-skill-mechanism.md](./analysis-openclaw-skill-mechanism.md) — 看 OpenClaw 怎么做的（参照系）
4. [comparison-skill-mechanism.md](./comparison-skill-mechanism.md) — 比较两者
5. [skill-openclaw-migration-report.md](./skill-openclaw-migration-report.md) — 迁移方案

## 协议契约（前端对齐）

| 文档 | 一句话 |
|---|---|
| [superpowers/contracts/2026-03-26-tool-output-and-plan-ui-frontend-contract.md](./superpowers/contracts/2026-03-26-tool-output-and-plan-ui-frontend-contract.md) | 2026-03-26 工具输出 / Plan UI 前端契约 |

## 缺什么（后续补）

- ❌ 仓库整体架构总览（src/ 入口、ACP 适配层、模型调用如何走）— Bun 项目无 README 级介绍
- ❌ Skill 机制**当前版本**（2026-03 至今）的最终现状记录
- ❌ 与 paper-agent / mma 共享的 ACP `_meta` 协议记录（应 cross-link 到二级 [规范/ACP 子agent 展示契约.md](../../docs/规范/ACP%20子agent%20展示契约.md)）

## 维护纪律

1. 写新 spec → 优先放本目录，按"主题"分类（skill-* / arch-* / fix-* / migration-*）
2. 新加文档 → 同步本 INDEX 速查表
3. ACP 协议相关 → 同时引用二级 `规范/`，不重复写
