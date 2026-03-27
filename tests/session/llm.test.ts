import { describe, expect, test } from "bun:test"
import { LLM } from "../../src/session/llm"

describe("LLM.repairToolCall", () => {
  test("routes malformed tool input to invalid with valid JSON payload", () => {
    const repaired = LLM.repairToolCall(
      {
        toolCall: {
          toolName: "read",
          input: "{",
        },
        error: {
          message: "JSON parsing failed: Text: {. Error message: JSON Parse error: Expected '}'",
        },
      },
      {
        invalid: {} as any,
      },
    )

    expect(repaired.toolName).toBe("invalid")
    expect(() => JSON.parse(repaired.input)).not.toThrow()
    expect(JSON.parse(repaired.input)).toEqual({
      tool: "read",
      error: "JSON parsing failed: Text: {. Error message: JSON Parse error: Expected '}'",
    })
  })

  test("normalizes tool name casing when lowercase tool exists", () => {
    const repaired = LLM.repairToolCall(
      {
        toolCall: {
          toolName: "Read",
          input: '{"filePath":"notes.txt"}',
        },
        error: {
          message: "tool not found",
        },
      },
      {
        read: {} as any,
        invalid: {} as any,
      },
    )

    expect(repaired.toolName).toBe("read")
    expect(repaired.input).toBe('{"filePath":"notes.txt"}')
  })
})
