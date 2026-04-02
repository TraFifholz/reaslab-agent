import { describe, expect, test } from "bun:test"
import { Skill } from "../../src/skill/index"

function generateSkills(count: number, descLength = 50): Skill.Info[] {
  const skills: Skill.Info[] = []
  for (let i = 0; i < count; i++) {
    skills.push({
      name: `skill-${String(i).padStart(4, "0")}`,
      description: "d".repeat(descLength),
      location: `/opt/skills/skill-${String(i).padStart(4, "0")}/SKILL.md`,
      content: `Content of skill ${i}`,
    })
  }
  return skills
}

describe("skill prompt budget control", () => {
  test("fmtWithBudget uses full format when within budget", () => {
    const skills = generateSkills(10, 30)
    const result = Skill.fmtWithBudget(skills, {
      maxSkillsInPrompt: 150,
      maxSkillsPromptChars: 30_000,
    })

    expect(result.compact).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain("<description>")
    expect(result.text).toContain("<name>")
    expect(result.text).toContain("<location>")
  })

  test("fmtWithBudget falls back to compact when full format exceeds chars budget", () => {
    // 100 skills with long descriptions should exceed a small budget
    const skills = generateSkills(100, 200)
    const result = Skill.fmtWithBudget(skills, {
      maxSkillsInPrompt: 150,
      maxSkillsPromptChars: 5000,
    })

    expect(result.compact).toBe(true)
    expect(result.text).not.toContain("<description>")
    expect(result.text).toContain("<name>")
    expect(result.text).toContain("<location>")
  })

  test("fmtWithBudget truncates with binary search when compact still exceeds budget", () => {
    const skills = generateSkills(200, 100)
    const result = Skill.fmtWithBudget(skills, {
      maxSkillsInPrompt: 200,
      maxSkillsPromptChars: 2000,
    })

    expect(result.compact).toBe(true)
    expect(result.truncated).toBe(true)
    // The warning should mention truncation
    expect(result.text).toMatch(/truncated|included/i)
  })

  test("fmtWithBudget respects maxSkillsInPrompt count limit", () => {
    const skills = generateSkills(200, 30)
    const result = Skill.fmtWithBudget(skills, {
      maxSkillsInPrompt: 50,
      maxSkillsPromptChars: 100_000, // Large budget so count is the limiter
    })

    // Count the <skill> tags in the output
    const skillTagCount = (result.text.match(/<skill>/g) || []).length
    expect(skillTagCount).toBeLessThanOrEqual(50)
  })

  test("fmtWithBudget adds warning when truncated", () => {
    const skills = generateSkills(200, 100)
    const result = Skill.fmtWithBudget(skills, {
      maxSkillsInPrompt: 200,
      maxSkillsPromptChars: 1500,
    })

    expect(result.truncated).toBe(true)
    expect(result.text).toMatch(/skills truncated|included \d+ of \d+/i)
  })

  test("fmtWithBudget handles empty skill list", () => {
    const result = Skill.fmtWithBudget([], {
      maxSkillsInPrompt: 150,
      maxSkillsPromptChars: 30_000,
    })

    expect(result.compact).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.text).toContain("No skills")
  })

  test("fmtCompact produces XML with name and location only", () => {
    const skills = generateSkills(3, 50)
    const output = Skill.fmtCompact(skills)

    expect(output).toContain("<available_skills>")
    expect(output).toContain("<name>skill-0000</name>")
    expect(output).toContain("<location>")
    expect(output).not.toContain("<description>")
  })
})
