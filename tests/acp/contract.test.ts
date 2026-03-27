import { describe, expect, test } from "bun:test"
import { ACPServer } from "../../src/acp/server"
import { Boot } from "../../src/boot"
import { Instance } from "../../src/project/instance"
import { Todo } from "../../src/session/todo"
import { createACPHarness } from "../helpers/acp-harness"

describe("ACP harness contract", () => {
  test("initialize exposes reaslab-uni bootstrap capabilities", async () => {
    const harness = createACPHarness()

    const result = await harness.start({
      cwd: "C:/tmp/reaslab-agent/acp-contract-harness",
    })

    expect(result.initializeResult.protocolVersion).toBe("0.1.0")
    expect(result.initializeResult.capabilities).toEqual({
      streaming: true,
      tools: true,
      skills: true,
    })
    expect(result.initializeResult.serverInfo).toEqual({
      name: "reaslab-agent",
      version: "0.1.0",
    })
    expect(result.authenticateResult.authenticated).toBe(true)
  })

  test("session/new returns sessionId workspace and plan entries", async () => {
    const harness = createACPHarness()

    const result = await harness.start({
      cwd: "C:/tmp/reaslab-agent/acp-contract-harness",
    })

    expect(typeof result.sessionResult.sessionId).toBe("string")
    expect(result.sessionResult.workspace).toBe("C:/tmp/reaslab-agent/acp-contract-harness")
    expect(result.sessionResult.plan).toEqual({
      entries: [],
    })
  })

  test("session/load exposes bootstrap todos only under result.plan.entries", async () => {
    const harness = createACPHarness()
    const cwd = "C:/tmp/reaslab-agent/acp-contract-load"

    const started = await harness.start({ cwd })

    await Boot.init(cwd)
    await Instance.provide({
      directory: cwd,
      fn: async () => {
        Todo.update({
          sessionID: started.sessionResult.sessionId,
          todos: [
            {
              content: "Bootstrap contract entry",
              status: "pending",
              priority: "medium",
            },
          ],
        })
      },
    })

    const loaded = await harness.loadSession({
      sessionId: started.sessionResult.sessionId,
      cwd,
    })

    expect(Object.keys(loaded.sessionResult).sort()).toEqual([
      "plan",
      "sessionId",
      "workspace",
    ])
    expect(Object.keys(loaded.sessionResult.plan).sort()).toEqual(["entries"])
    expect(loaded.sessionResult.plan.entries).toEqual([
      {
        content: "Bootstrap contract entry",
        status: "pending",
        priority: "medium",
      },
    ])
    expect((loaded.sessionResult as any).entries).toBeUndefined()
  })

  test("runPrompt records prompt completion lifecycle for errored prompt execution", async () => {
    const harness = createACPHarness()

    const started = await harness.start({
      cwd: "C:/tmp/reaslab-agent/acp-prompt-lifecycle",
    })

    const result = await harness.runPrompt({
      sessionId: started.sessionResult.sessionId,
      prompt: "Say hello and stop.",
      _meta: {
        model: "test-model",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "test-api-key",
      },
      timeoutMs: 5000,
    })

    expect(result).toHaveProperty("promptImmediateResult")
    expect(result).toHaveProperty("notifications")
    expect(result).toHaveProperty("errors")
    expect(result).toHaveProperty("aggregatedText")
    expect(result).toHaveProperty("aggregatedThoughts")
    expect(result).toHaveProperty("toolCalls")
    expect(result).toHaveProperty("toolCallUpdates")
    expect(result).toHaveProperty("planUpdates")
    expect(result).toHaveProperty("finalResponse")
    expect(result).toHaveProperty("model")
    expect(result).toHaveProperty("scenario")
    expect(result).toHaveProperty("timeline")
    expect(result).toHaveProperty("completion")

    expect(result.promptImmediateResult).toBeNull()
    expect(Array.isArray(result.notifications)).toBe(true)
    expect(Array.isArray(result.errors)).toBe(true)
    expect(Array.isArray(result.toolCalls)).toBe(true)
    expect(Array.isArray(result.toolCallUpdates)).toBe(true)
    expect(Array.isArray(result.planUpdates)).toBe(true)
    expect(typeof result.aggregatedText).toBe("string")
    expect(typeof result.aggregatedThoughts).toBe("string")
    expect(result.model).toBe("test-model")
    expect(result.scenario).toBe("prompt-lifecycle")
    expect(result.timeline.startedAt).toBeGreaterThan(0)
    expect(result.completion.state).toBe("errored")
    expect(result.completion.classification).toBe("runtime_failure")
    expect(result.finalResponse).toBeDefined()
    expect(result.finalResponse?.result).toMatchObject({
      stopReason: "error",
    })
  })

  test("runPrompt times out even if session/cancel never resolves", async () => {
    const originalDispatch = ACPServer.prototype.dispatch

    ACPServer.prototype.dispatch = function(request) {
      switch (request.method) {
        case "initialize":
          return Promise.resolve({ result: { protocolVersion: "0.1.0" } })
        case "authenticate":
          return Promise.resolve({ result: { authenticated: true } })
        case "session/new":
          return Promise.resolve({ result: { sessionId: "ses-timeout" } })
        case "session/prompt":
          return Promise.resolve({ result: null })
        case "session/cancel":
          return new Promise(() => {})
        default:
          return Promise.reject(new Error(`Unexpected method: ${request.method}`))
      }
    }

    try {
      const harness = createACPHarness()
      const started = await harness.start({
        cwd: "C:/tmp/reaslab-agent/acp-prompt-lifecycle",
      })

      const result = await Promise.race([
        harness.runPrompt({
          sessionId: started.sessionResult.sessionId,
          prompt: "wait forever",
          _meta: {
            model: "test-model",
            baseUrl: "http://127.0.0.1:1",
            apiKey: "test-api-key",
          },
          timeoutMs: 20,
        }),
        new Promise<"hung">((resolve) => {
          setTimeout(() => resolve("hung"), 250)
        }),
      ])

      expect(result).not.toBe("hung")
      expect(result).toMatchObject({
        finalResponse: null,
        completion: {
          state: "timed_out",
          classification: "runtime_failure",
        },
      })
    } finally {
      ACPServer.prototype.dispatch = originalDispatch
    }
  })

  test("runPrompt leaves completion classification empty for successful completions", async () => {
    const originalDispatch = ACPServer.prototype.dispatch

    ACPServer.prototype.dispatch = function(request) {
      switch (request.method) {
        case "initialize":
          return Promise.resolve({ result: { protocolVersion: "0.1.0" } })
        case "authenticate":
          return Promise.resolve({ result: { authenticated: true } })
        case "session/new":
          return Promise.resolve({ result: { sessionId: "ses-success" } })
        case "session/prompt":
          setTimeout(() => {
            this.onNotification?.({
              jsonrpc: "2.0",
              id: request.id,
              result: { stopReason: "end_turn" },
            })
          }, 0)
          return Promise.resolve({ result: null })
        default:
          return Promise.reject(new Error(`Unexpected method: ${request.method}`))
      }
    }

    try {
      const harness = createACPHarness()
      const started = await harness.start({
        cwd: "C:/tmp/reaslab-agent/acp-prompt-lifecycle",
      })

      const result = await harness.runPrompt({
        sessionId: started.sessionResult.sessionId,
        prompt: "say hello",
        _meta: {
          model: "test-model",
          baseUrl: "http://127.0.0.1:1",
          apiKey: "test-api-key",
        },
        timeoutMs: 100,
      })

      expect(result.completion.state).toBe("completed")
      expect(result.completion.classification).toBeNull()
      expect(result.finalResponse?.result).toMatchObject({
        stopReason: "end_turn",
      })
    } finally {
      ACPServer.prototype.dispatch = originalDispatch
    }
  })
})
