import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { ACPServer } from "../../src/acp/server"
import { createACPHarness } from "../helpers/acp-harness"
import { loadModelMatrixConfig } from "../helpers/acp-model-config"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDir() {
  const dir = await mkdtemp(join(tmpdir(), "acp-model-config-"))
  tempDirs.push(dir)
  return dir
}

describe("ACP model matrix config loader", () => {
  test("missing config is skipped in optional mode", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "acp-model-test.config.json")

    const result = await loadModelMatrixConfig({
      mode: "optional",
      filePath,
    })

    expect(result).toBeNull()
  })

  test("malformed config throws a clear validation error in required mode", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "acp-model-test.config.json")

    await writeFile(filePath, JSON.stringify({
      baseUrl: "",
      apiKey: "",
      models: [],
      timeoutMs: 1000,
    }))

    await expect(loadModelMatrixConfig({
      mode: "required",
      filePath,
    })).rejects.toThrow(/ACP model matrix config.*baseUrl.*apiKey.*models/i)
  })

  test("missing config throws a clear error in required mode", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "acp-model-test.config.json")

    await expect(loadModelMatrixConfig({
      mode: "required",
      filePath,
    })).rejects.toThrow(/ACP model matrix config is required but was not found/i)
  })

  test("valid config yields baseUrl apiKey models and timeoutMs", async () => {
    const dir = await createTempDir()
    const filePath = join(dir, "acp-model-test.config.json")

    await writeFile(filePath, JSON.stringify({
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-api-key",
      models: ["model-a", "model-b"],
      timeoutMs: 25000,
    }))

    const result = await loadModelMatrixConfig({
      mode: "required",
      filePath,
    })

    expect(result).toEqual({
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-api-key",
      models: ["model-a", "model-b"],
      timeoutMs: 25000,
    })
  })

  test("default config path is resolved independently of process cwd", async () => {
    const originalCwd = process.cwd()
    const dir = await createTempDir()
    const filePath = join(originalCwd, "tests", "local", "acp-model-test.config.json")

    await mkdir(join(originalCwd, "tests", "local"), { recursive: true })
    await writeFile(filePath, JSON.stringify({
      baseUrl: "https://api.example.test/from-stable-default",
      apiKey: "stable-default-key",
      models: ["stable-default-model"],
      timeoutMs: 6789,
    }))

    process.chdir(dir)

    try {
      const result = await loadModelMatrixConfig({
        mode: "required",
      })

      expect(result).toEqual({
        baseUrl: "https://api.example.test/from-stable-default",
        apiKey: "stable-default-key",
        models: ["stable-default-model"],
        timeoutMs: 6789,
      })
    } finally {
      process.chdir(originalCwd)
      await rm(filePath, { force: true })
    }
  })
})

describe("ACP model matrix scenario A", () => {
  test("runPrompt records scenario A metadata for basic prompt completion", async () => {
    const requests: unknown[] = []
    let promptRequestId: string | number | null = null
    const server = new ACPServer()
    const harness = createACPHarness({
      server,
      dispatch: async (request) => {
        requests.push(request)

        if (request.method === "initialize") {
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "1.0",
              capabilities: {
                streaming: true,
                tools: true,
                skills: true,
              },
              serverInfo: {
                name: "test-server",
                version: "0.0.0",
              },
            },
          }
        }

        if (request.method === "authenticate") {
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              authenticated: true,
            },
          }
        }

        if (request.method === "session/new") {
          return {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              sessionId: "session-a",
              workspace: "/tmp/workspace-a",
              plan: { entries: [] },
            },
          }
        }

        if (request.method === "session/prompt") {
          promptRequestId = request.id

          queueMicrotask(() => {
            server.onNotification?.({
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: request.params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    text: "hello",
                  },
                },
              },
            })

            server.onNotification?.({
              jsonrpc: "2.0",
              id: promptRequestId,
              result: {
                stopReason: "end_turn",
              },
            })
          })

          return {
            jsonrpc: "2.0",
            id: request.id,
            result: null,
          }
        }

        throw new Error(`Unexpected method: ${String(request.method)}`)
      },
    })

    const started = await harness.start({ cwd: "D:/tmp/acp-matrix" })
    const result = await harness.runPrompt({
      sessionId: started.sessionResult.sessionId,
      prompt: "Say hello in one word",
      _meta: {
        model: "model-a",
        baseUrl: "https://api.example.test/v1",
        apiKey: "test-api-key",
      },
      scenario: "basic-prompt-completion",
      timeoutMs: 100,
    })

    const promptRequest = requests.find(
      (request) => !!request && typeof request === "object" && "method" in request && request.method === "session/prompt",
    ) as {
      params: {
        _meta: Record<string, unknown>
      }
    }

    expect(promptRequest.params._meta).toEqual({
      model: "model-a",
      baseUrl: "https://api.example.test/v1",
      apiKey: "test-api-key",
    })
    expect(result.scenario).toBe("basic-prompt-completion")
    expect(result.model).toBe("model-a")
    expect(result.completion.state).toBe("completed")
    expect(result.aggregatedText).toBe("hello")
  })

  test("runs basic prompt completion against each configured model", async () => {
    const config = await loadModelMatrixConfig({
      mode: process.env.ACP_MODEL_MATRIX_MODE === "required" ? "required" : "optional",
    })

    if (!config) {
      return
    }

    for (const model of config.models) {
      const harness = createACPHarness()
      const workspace = await mkdtemp(join(tmpdir(), `acp-model-matrix-${model.replace(/[^a-zA-Z0-9_-]/g, "-")}-`))
      tempDirs.push(workspace)

      const started = await harness.start({ cwd: workspace })
      const result = await harness.runPrompt({
        sessionId: started.sessionResult.sessionId,
        prompt: "Say hello in one word",
        _meta: {
          model,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
        },
        scenario: "basic-prompt-completion",
        timeoutMs: config.timeoutMs,
      })

      expect(result.scenario).toBe("basic-prompt-completion")
      expect(result.model).toBe(model)
      expect(result.completion.state).toBe("completed")

      const textChunks = result.notifications.filter(
        (message) =>
          !!message &&
          typeof message === "object" &&
          "params" in message &&
          message.params &&
          typeof message.params === "object" &&
          "update" in message.params &&
          message.params.update &&
          typeof message.params.update === "object" &&
          "sessionUpdate" in message.params.update &&
          message.params.update.sessionUpdate === "agent_message_chunk",
      )

      expect(textChunks.length > 0 || result.aggregatedText.length > 0).toBe(true)
    }
  }, 120000)
})
