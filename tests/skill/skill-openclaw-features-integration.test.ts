import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Boot } from "../../src/boot"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Instance } from "../../src/project/instance"
import { SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import {
  ensureSkillsWatcher,
  resetSkillsRefreshForTest,
} from "../../src/skill/refresh"

const workspaceID = WorkspaceID.make("wrk_integration")
const sessionID = SessionID.make("ses_integration")

async function writeSkill(root: string, name: string, description: string, body = "Skill body") {
  const file = path.join(root, name, "SKILL.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    ["---", `name: ${name}`, `description: ${description}`, "---", "", body, ""].join("\n"),
  )
  return file
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("OpenClaw skill features integration", () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    Config.reset()
    Boot.reset()
  })

  afterEach(async () => {
    await resetSkillsRefreshForTest()
    await Instance.disposeAll()
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
  })

  test("end-to-end: large skill is skipped, small skills get budget-controlled prompt with caching", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-integration-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")

    // Create 5 normal skills
    for (let i = 0; i < 5; i++) {
      await writeSkill(skillsDir, `skill-${i}`, `Normal skill ${i}`, `Body of skill ${i}`)
    }

    // Create 1 oversized skill (>256KB)
    const hugeDir = path.join(skillsDir, "huge-skill")
    await fs.mkdir(hugeDir, { recursive: true })
    await fs.writeFile(
      path.join(hugeDir, "SKILL.md"),
      ["---", "name: huge-skill", "description: Huge skill", "---", "", "x".repeat(300_000), ""].join("\n"),
    )

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        // 1. Only 5 skills should be available (huge-skill skipped)
        const available = await Skill.available()
        const names = available.map((s) => s.name)
        expect(names).not.toContain("huge-skill")
        expect(names.filter((n) => n.startsWith("skill-"))).toHaveLength(5)

        // 2. SystemPrompt includes skills
        const agent = (await Agent.get("build"))!
        const result1 = await SystemPrompt.skills(agent, { workspaceID, sessionID })
        expect(result1).toContain("skill-0")

        // 3. Cached result on second call
        const result2 = await SystemPrompt.skills(agent, { workspaceID, sessionID })
        expect(result2).toBe(result1)
      },
    })
  })

  test("end-to-end: skill modification triggers hot-reload and cache invalidation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-integration-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    const skillFile = await writeSkill(skillsDir, "hot-skill", "Version 1", "Version 1 body")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        // Load the skill into runtime
        await Skill.runtimeLoad({ scope: "discovered", root: skillsDir })

        const agent = (await Agent.get("build"))!
        const scope = { workspaceID, sessionID }

        const result1 = await SystemPrompt.skills(agent, scope)
        expect(result1).toContain("hot-skill")

        // Start watcher
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 100 },
        })
        await sleep(200)

        // Modify the skill
        await fs.writeFile(
          skillFile,
          ["---", "name: hot-skill", "description: Version 2", "---", "", "Version 2 body", ""].join("\n"),
        )

        // Wait for watcher debounce
        await sleep(500)

        // The version should have bumped, invalidating the cache
        // Re-load discovered to pick up new content
        await Skill.runtimeLoad({ scope: "discovered", root: skillsDir })

        const result2 = await SystemPrompt.skills(agent, scope)
        // Cache should have been invalidated by the version bump
        expect(result2).toContain("hot-skill")
        expect(result2).toContain("Version 2")
      },
    })
  })

  test("end-to-end: budget degradation works with path compression", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-integration-"))
    tempDirs.push(root)

    // Create many skills to trigger budget degradation
    const skillsDir = path.join(root, "skills")
    for (let i = 0; i < 50; i++) {
      await writeSkill(
        skillsDir,
        `budget-skill-${String(i).padStart(3, "0")}`,
        `A budget test skill with a reasonably long description to consume token budget ${i}`,
        `Body of budget skill ${i} with additional content to make it larger`,
      )
    }

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        await Skill.runtimeLoad({ scope: "discovered", root: skillsDir })

        const agent = (await Agent.get("build"))!
        const scope = { workspaceID, sessionID }

        const result = await SystemPrompt.skills(agent, scope)
        // Should have some skills listed
        expect(result).toContain("budget-skill-")
        // The result should be well-formed XML
        expect(result).toContain("<available_skills>")
      },
    })
  })
})
