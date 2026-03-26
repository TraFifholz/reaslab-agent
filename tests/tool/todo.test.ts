import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "crypto"
import { rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Boot } from "../../src/boot"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Database } from "../../src/storage/db"
import { TodoWriteTool } from "../../src/tool/todo"

describe("TodoWriteTool", () => {
  const dataDir = path.join(tmpdir(), `reaslab-agent-tool-todo-${randomUUID()}`)
  const workspace = path.resolve(import.meta.dir, "../..")

  beforeEach(() => {
    process.env.DATA_DIR = dataDir
    process.env.PROJECT_WORKSPACE = workspace
    Config.reset()
    Boot.reset()
  })

  afterEach(async () => {
    await Instance.disposeAll()
    Database.close()
    Config.reset()
    Boot.reset()
    delete process.env.DATA_DIR
    delete process.env.PROJECT_WORKSPACE
    rmSync(dataDir, { recursive: true, force: true })
  })

  test("returns JSON output text and full todos metadata", async () => {
    await Boot.init(workspace)

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const session = await Session.createNext({ directory: workspace })
        const todos = [
          {
            content: "Keep todowrite output stable",
            status: "in_progress",
            priority: "high",
          },
          {
            content: "Preserve metadata todos shape",
            status: "pending",
            priority: "medium",
          },
        ]

        const tool = await TodoWriteTool.init()
        const result = await tool.execute(
          { todos },
          {
            sessionID: session.id,
            messageID: "message-test" as any,
            agent: "default",
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            ask: async () => {},
          },
        )

        expect(result.output).toBe(JSON.stringify(todos, null, 2))
        expect(result.metadata.todos).toEqual(todos)
      },
    })
  })
})
