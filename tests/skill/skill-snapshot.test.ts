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

const workspaceID = WorkspaceID.make("wrk_snapshot_test")
const sessionA = SessionID.make("ses_snapshot_a")
const sessionB = SessionID.make("ses_snapshot_b")

async function writeSkill(root: string, name: string, description: string, body = "Skill body") {
  const file = path.join(root, name, "SKILL.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    ["---", `name: ${name}`, `description: ${description}`, "---", "", body, ""].join("\n"),
  )
  return file
}

describe("skill snapshot caching and version tracking", () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    Config.reset()
    Boot.reset()
  })

  afterEach(async () => {
    await Instance.disposeAll()
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
  })

  test("bumpVersion increments version monotonically", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"))
    tempDirs.push(root)

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        const v1 = Skill.bumpVersion()
        // Small delay to ensure Date.now() differs
        await new Promise((resolve) => setTimeout(resolve, 2))
        const v2 = Skill.bumpVersion()
        expect(v2).toBeGreaterThan(v1)
      },
    })
  })

  test("getVersion returns 0 before any bump", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"))
    tempDirs.push(root)

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        expect(Skill.getVersion()).toBe(0)
      },
    })
  })

  test("runtimeLoad bumps version", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"))
    tempDirs.push(root)

    const skillRoot = path.join(root, "skills")
    await writeSkill(skillRoot, "test-skill", "A test skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        const v1 = Skill.getVersion()
        await Skill.runtimeLoad({
          scope: "discovered",
          root: skillRoot,
        })
        expect(Skill.getVersion()).toBeGreaterThan(v1)
      },
    })
  })

  test("runtimeUnload bumps version", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"))
    tempDirs.push(root)

    const skillRoot = path.join(root, "skills")
    await writeSkill(skillRoot, "test-skill", "A test skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        await Skill.runtimeLoad({ scope: "discovered", root: skillRoot })
        const v1 = Skill.getVersion()
        await Skill.runtimeUnload({ scope: "discovered", names: ["test-skill"] })
        expect(Skill.getVersion()).toBeGreaterThan(v1)
      },
    })
  })

  test("SystemPrompt.skills returns cached result on repeated calls with same version", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"))
    tempDirs.push(root)

    await writeSkill(path.join(root, "skills"), "cached-skill", "A cached skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        const agent = (await Agent.get("build"))!
        const scope = { workspaceID, sessionID: sessionA }

        const result1 = await SystemPrompt.skills(agent, scope)
        const result2 = await SystemPrompt.skills(agent, scope)

        // Should be the same string (cached)
        expect(result1).toBe(result2)
      },
    })
  })

  test("SystemPrompt.skills rebuilds after version bump", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"))
    tempDirs.push(root)

    const skillRoot = path.join(root, "discovered-skills")
    await writeSkill(skillRoot, "initial-skill", "Initial skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        const agent = (await Agent.get("build"))!
        const scope = { workspaceID, sessionID: sessionA }

        await Skill.runtimeLoad({ scope: "discovered", root: skillRoot })
        const result1 = await SystemPrompt.skills(agent, scope)
        expect(result1).toContain("initial-skill")

        // Add a new skill and reload
        await writeSkill(skillRoot, "new-skill", "New skill")
        await Skill.runtimeLoad({ scope: "discovered", root: skillRoot })

        const result2 = await SystemPrompt.skills(agent, scope)
        expect(result2).toContain("new-skill")
        expect(result2).not.toBe(result1)
      },
    })
  })

  test("different sessions get independent cache entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-snapshot-"))
    tempDirs.push(root)

    const skillRootA = path.join(root, "session-a-skills")
    const skillRootB = path.join(root, "session-b-skills")
    await writeSkill(skillRootA, "skill-a", "Skill for session A")
    await writeSkill(skillRootB, "skill-b", "Skill for session B")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        await Skill.runtimeLoad({
          scope: "session",
          root: skillRootA,
          workspaceID,
          sessionID: sessionA,
        })
        await Skill.runtimeLoad({
          scope: "session",
          root: skillRootB,
          workspaceID,
          sessionID: sessionB,
        })

        const agent = (await Agent.get("build"))!
        const resultA = await SystemPrompt.skills(agent, { workspaceID, sessionID: sessionA })
        const resultB = await SystemPrompt.skills(agent, { workspaceID, sessionID: sessionB })

        expect(resultA).toContain("skill-a")
        expect(resultB).toContain("skill-b")
      },
    })
  })
})
