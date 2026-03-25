import { describe, test, expect } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"

describe("Agent", () => {
  test("default agent key resolves back to a registered agent", async () => {
    const result = await Instance.provide({
      directory: "/workspace",
      fn: async () => {
        const defaultAgent = await Agent.defaultAgent()
        const resolved = await Agent.get(defaultAgent)
        return { defaultAgent, resolved }
      },
    })

    expect(result.defaultAgent).toBe("build")
    expect(result.resolved).toBeDefined()
    expect(result.resolved?.name).toBe("build")
  })
})
