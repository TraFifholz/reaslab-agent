import { describe, test, expect } from "bun:test"
import { buildBuiltinTools } from "../../src/acp/builtin-tools"

describe("buildBuiltinTools", () => {
  test("guards context-sensitive tools when no real ACP tool context is provided", async () => {
    const tools = await buildBuiltinTools(new AbortController().signal, "/workspace")

    await expect(
      tools.read.execute({
        filePath: "/workspace/README.md",
      }),
    ).rejects.toThrow("requires a real ACP tool context")
  })
})
