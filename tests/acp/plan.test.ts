import { describe, expect, test } from "bun:test"
import { todoToPlanEntries } from "../../src/acp/plan"

describe("todoToPlanEntries", () => {
  test("preserves content, priority, status, and ordering", () => {
    const entries = todoToPlanEntries([
      { content: "First", priority: "high", status: "pending" },
      { content: "Second", priority: "low", status: "completed" },
    ])

    expect(entries).toEqual([
      { content: "First", priority: "high", status: "pending" },
      { content: "Second", priority: "low", status: "completed" },
    ])
  })

  test("maps cancelled todos to completed ACP plan entries", () => {
    const entries = todoToPlanEntries([
      { content: "Cancelled task", priority: "medium", status: "cancelled" },
    ])

    expect(entries).toEqual([
      { content: "Cancelled task", priority: "medium", status: "completed" },
    ])
  })

  test("normalizes unexpected stored todo values to ACP-safe defaults", () => {
    const entries = todoToPlanEntries([
      { content: "Unexpected", priority: "urgent", status: "stuck" },
    ])

    expect(entries).toEqual([
      { content: "Unexpected", priority: "medium", status: "pending" },
    ])
  })
})
