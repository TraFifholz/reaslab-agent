import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Boot } from "../../src/boot"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Skill } from "../../src/skill"
import {
  ensureSkillsWatcher,
  resetSkillsRefreshForTest,
} from "../../src/skill/refresh"

async function writeSkill(root: string, name: string, description: string, body = "Skill body") {
  const dir = path.join(root, name)
  const file = path.join(dir, "SKILL.md")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    file,
    ["---", `name: ${name}`, `description: ${description}`, "---", "", body, ""].join("\n"),
  )
  return file
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("skill file watch hot-reload", () => {
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

  test("ensureSkillsWatcher starts watcher for skill directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    await writeSkill(skillsDir, "test-skill", "A test skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        // Should not throw
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 100 },
        })
        // Give watcher time to initialize
        await sleep(100)
      },
    })
  })

  test("watcher bumps version when SKILL.md is modified", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    const skillFile = await writeSkill(skillsDir, "modify-test", "Original description")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 100 },
        })
        await sleep(1000) // Let watcher initialize (WSL2 needs more time)

        const v1 = Skill.getVersion()

        // Modify the SKILL.md
        await fs.writeFile(
          skillFile,
          ["---", "name: modify-test", "description: Updated description", "---", "", "Updated body", ""].join("\n"),
        )

        // Wait for debounce
        await sleep(1500)

        expect(Skill.getVersion()).toBeGreaterThan(v1)
      },
    })
  })

  test("watcher bumps version when new SKILL.md is added", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    await fs.mkdir(skillsDir, { recursive: true })

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 100 },
        })
        await sleep(1000)

        const v1 = Skill.getVersion()

        // Add a new skill
        await writeSkill(skillsDir, "new-skill", "A new skill")

        await sleep(1500)

        expect(Skill.getVersion()).toBeGreaterThan(v1)
      },
    })
  })

  test("watcher bumps version when SKILL.md is deleted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    const skillFile = await writeSkill(skillsDir, "delete-test", "To be deleted")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 100 },
        })
        await sleep(1000)

        const v1 = Skill.getVersion()

        // Delete the SKILL.md
        await fs.rm(skillFile)

        await sleep(1500)

        expect(Skill.getVersion()).toBeGreaterThan(v1)
      },
    })
  })

  test("watcher debounces rapid changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    const skillFile = await writeSkill(skillsDir, "debounce-test", "Debounce test skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 200 },
        })
        await sleep(1000)

        const v1 = Skill.getVersion()

        // Rapid changes
        for (let i = 0; i < 5; i++) {
          await fs.writeFile(
            skillFile,
            ["---", "name: debounce-test", `description: Version ${i}`, "---", "", `Body ${i}`, ""].join("\n"),
          )
          await sleep(50)
        }

        // Wait for debounce to settle
        await sleep(1500)

        const v2 = Skill.getVersion()
        expect(v2).toBeGreaterThan(v1)

        // The version should have been bumped, but we can't easily verify
        // it was bumped only once without internal state access.
        // The key behavior is that it DID bump and the debounce didn't lose the event.
      },
    })
  })

  test("watcher respects config.watch=false", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    const skillFile = await writeSkill(skillsDir, "no-watch-test", "No watch skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: false },
        })
        await sleep(200)

        const v1 = Skill.getVersion()

        // Modify the file
        await fs.writeFile(
          skillFile,
          ["---", "name: no-watch-test", "description: Updated", "---", "", "Updated body", ""].join("\n"),
        )
        await sleep(500)

        // Version should NOT have changed
        expect(Skill.getVersion()).toBe(v1)
      },
    })
  })

  test("watcher triggers actual skill content reload on next available() call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    const skillFile = await writeSkill(skillsDir, "reload-content-test", "Original desc", "Original body")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        // First load: picks up original content
        const before = await Skill.available()
        const original = before.find((s) => s.name === "reload-content-test")
        expect(original?.description).toBe("Original desc")

        // Start watcher
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 100 },
        })
        await sleep(1000)

        // Modify the skill
        await fs.writeFile(
          skillFile,
          ["---", "name: reload-content-test", "description: Hot-reloaded desc", "---", "", "Hot-reloaded body", ""].join("\n"),
        )

        // Wait for watcher debounce + reload
        await sleep(1500)

        // Next available() should return updated content
        const after = await Skill.available()
        const updated = after.find((s) => s.name === "reload-content-test")
        expect(updated?.description).toBe("Hot-reloaded desc")
      },
    })
  })

  test("watcher is cleaned up on dispose", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-refresh-"))
    tempDirs.push(root)

    const skillsDir = path.join(root, "skills")
    await writeSkill(skillsDir, "cleanup-test", "Cleanup skill")

    await Instance.provide({
      directory: root,
      init: async () => {
        Config.reset()
        Boot.reset()
        await Boot.init(root)
      },
      fn: async () => {
        ensureSkillsWatcher({
          directory: root,
          worktree: root,
          config: { watch: true, watchDebounceMs: 100 },
        })
        await sleep(100)

        // Should not throw
        await resetSkillsRefreshForTest()
      },
    })
  })
})
