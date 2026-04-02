import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Skill } from "../../src/skill/index"

function makeInfo(name: string, location: string): Skill.Info {
  return {
    name,
    description: `Description of ${name}`,
    location,
    content: `Content of ${name}`,
  }
}

describe("skill path compression", () => {
  test("compactPath replaces home directory prefix with ~", () => {
    const home = os.homedir()
    const location = path.join(home, ".claude", "skills", "foo", "SKILL.md")
    const info = makeInfo("foo", location)

    const output = Skill.fmt([info], { verbose: true })
    expect(output).toContain("~/.claude/skills/foo/SKILL.md")
    expect(output).not.toContain(home)
  })

  test("compactPath leaves paths outside home directory unchanged", () => {
    const location = "/opt/skills/foo/SKILL.md"
    const info = makeInfo("foo", location)

    const output = Skill.fmt([info], { verbose: true })
    expect(output).toContain("/opt/skills/foo/SKILL.md")
  })

  test("fmt verbose mode uses compressed paths in location tags", () => {
    const home = os.homedir()
    const infos = [
      makeInfo("alpha", path.join(home, "skills", "alpha", "SKILL.md")),
      makeInfo("beta", path.join(home, "skills", "beta", "SKILL.md")),
    ]

    const output = Skill.fmt(infos, { verbose: true })
    expect(output).toContain("<location>~/skills/alpha/SKILL.md</location>")
    expect(output).toContain("<location>~/skills/beta/SKILL.md</location>")
  })

  test("fmt non-verbose mode is unaffected by path compression", () => {
    const home = os.homedir()
    const infos = [makeInfo("foo", path.join(home, "skills", "foo", "SKILL.md"))]

    const output = Skill.fmt(infos, { verbose: false })
    // Non-verbose is markdown, should not have <location> tags
    expect(output).not.toContain("<location>")
    expect(output).toContain("**foo**")
  })

  test("Info.location retains absolute path after fmt", () => {
    const home = os.homedir()
    const location = path.join(home, "skills", "foo", "SKILL.md")
    const info = makeInfo("foo", location)

    Skill.fmt([info], { verbose: true })
    // The original info should not be mutated
    expect(info.location).toBe(location)
    expect(info.location.startsWith("/")).toBe(true)
  })
})
