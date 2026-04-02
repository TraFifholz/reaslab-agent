import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Skill } from "../../src/skill/index"

function skillInfo(name: string, description: string, location: string, content: string): Skill.Info {
  return { name, description, location, content }
}

async function writeSkill(
  root: string,
  dirname: string,
  input: { name: string; description: string; body: string },
) {
  const dir = path.join(root, dirname)
  const location = path.join(dir, "SKILL.md")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    location,
    ["---", `name: ${input.name}`, `description: ${input.description}`, "---", "", input.body, ""].join("\n"),
  )
  return location
}

function createRuntime(base: Skill.Info[] = []) {
  return Skill.runtimeOverlay({ discovered: base })
}

describe("SKILL.md file size limit", () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
    tempDirs.length = 0
  })

  test("skills under size limit are loaded normally", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-size-"))
    tempDirs.push(root)

    await writeSkill(root, "small-skill", {
      name: "small-skill",
      description: "A small skill",
      body: "Small skill body content",
    })

    const runtime = createRuntime()
    await runtime.load({ scope: "discovered", root })

    const all = await runtime.all()
    expect(all.some((s) => s.name === "small-skill")).toBe(true)
  })

  test("skills exceeding size limit are skipped", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-size-"))
    tempDirs.push(root)

    const dir = path.join(root, "huge-skill")
    await fs.mkdir(dir, { recursive: true })
    // Create a SKILL.md > 256KB
    const largeBody = "x".repeat(300_000)
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      ["---", "name: huge-skill", "description: A huge skill", "---", "", largeBody, ""].join("\n"),
    )

    const runtime = createRuntime()
    await runtime.load({ scope: "discovered", root })

    const all = await runtime.all()
    expect(all.some((s) => s.name === "huge-skill")).toBe(false)
  })

  test("custom maxSkillFileBytes is respected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-size-"))
    tempDirs.push(root)

    // Create a 5KB SKILL.md
    const body = "y".repeat(5000)
    await writeSkill(root, "medium-skill", {
      name: "medium-skill",
      description: "A medium skill",
      body,
    })

    // With maxBytes = 1000, this should be skipped
    const info = await Skill.parseRuntimeInfo(path.join(root, "medium-skill", "SKILL.md"), {
      maxBytes: 1000,
    })
    expect(info).toBeUndefined()
  })

  test("oversized skill does not block other skills from loading", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-size-"))
    tempDirs.push(root)

    await writeSkill(root, "normal-skill", {
      name: "normal-skill",
      description: "Normal skill",
      body: "Normal body",
    })

    const hugeDir = path.join(root, "huge-skill")
    await fs.mkdir(hugeDir, { recursive: true })
    const largeBody = "z".repeat(300_000)
    await fs.writeFile(
      path.join(hugeDir, "SKILL.md"),
      ["---", "name: huge-skill", "description: Huge skill", "---", "", largeBody, ""].join("\n"),
    )

    const runtime = createRuntime()
    await runtime.load({ scope: "discovered", root })

    const all = await runtime.all()
    const names = all.map((s) => s.name)
    expect(names).toContain("normal-skill")
    expect(names).not.toContain("huge-skill")
  })

  test("parseRuntimeInfo respects maxBytes parameter", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "skill-size-"))
    tempDirs.push(root)

    const largeBody = "a".repeat(300_000)
    const location = await writeSkill(root, "oversized", {
      name: "oversized",
      description: "Oversized skill",
      body: largeBody,
    })

    const info = await Skill.parseRuntimeInfo(location, { maxBytes: 256_000 })
    expect(info).toBeUndefined()

    // Without limit, it should load
    const infoNoLimit = await Skill.parseRuntimeInfo(location)
    expect(infoNoLimit).toBeDefined()
    expect(infoNoLimit?.name).toBe("oversized")
  })
})
