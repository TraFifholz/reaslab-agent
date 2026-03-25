import { describe, test, expect } from "bun:test"
import { ACPServer } from "../../src/acp/server"

describe("ACPServer", () => {
  test("handles initialize", async () => {
    const server = new ACPServer()
    const result = await server.dispatch({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {},
    })
    expect(result.result.protocolVersion).toBeDefined()
    expect(result.result.capabilities).toBeDefined()
    expect(result.result.capabilities.streaming).toBe(true)
    expect(result.result.serverInfo.name).toBe("reaslab-agent")
  })

  test("handles authenticate", async () => {
    const server = new ACPServer()
    const result = await server.dispatch({
      jsonrpc: "2.0",
      id: "2",
      method: "authenticate",
      params: {},
    })
    expect(result.result.authenticated).toBe(true)
  })

  test("handles session/new", async () => {
    const server = new ACPServer()
    const result = await server.dispatch({
      jsonrpc: "2.0",
      id: "3",
      method: "session/new",
      params: { cwd: "/workspace", mcpServers: [] },
    })
    expect(result.result.sessionId).toBeDefined()
    expect(result.result.workspace).toBe("/workspace")
  })

  test("handles session/load for existing session", async () => {
    const server = new ACPServer()
    const created = await server.dispatch({
      jsonrpc: "2.0",
      id: "1",
      method: "session/new",
      params: { cwd: "/test" },
    })
    const sessionId = created.result.sessionId

    const loaded = await server.dispatch({
      jsonrpc: "2.0",
      id: "2",
      method: "session/load",
      params: { sessionId },
    })
    expect(loaded.result.sessionId).toBe(sessionId)
  })

  test("returns error for unknown method", async () => {
    const server = new ACPServer()
    const result = await server.dispatch({
      jsonrpc: "2.0",
      id: "4",
      method: "unknown/method",
      params: {},
    })
    expect(result.error).toBeDefined()
    expect(result.error.code).toBe(-32601)
  })

  test("handles session/prompt (async, returns null)", async () => {
    const server = new ACPServer()
    const notifications: any[] = []
    server.onNotification = (msg) => notifications.push(msg)

    // Create session first
    const sess = await server.dispatch({
      jsonrpc: "2.0",
      id: "1",
      method: "session/new",
      params: { cwd: "/workspace" },
    })

    const result = await server.dispatch({
      jsonrpc: "2.0",
      id: "2",
      method: "session/prompt",
      params: {
        sessionId: sess.result.sessionId,
        prompt: "Hello!",
        _meta: {
          model: "test-model",
          baseUrl: "http://localhost",
          apiKey: "test-key",
        },
      },
    })

    // Immediate response is null
    expect(result.result).toBeNull()

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 100))

    // Should have received notifications
    expect(notifications.length).toBeGreaterThan(0)
  })

  test("handles session/cancel", async () => {
    const server = new ACPServer()

    const sess = await server.dispatch({
      jsonrpc: "2.0",
      id: "1",
      method: "session/new",
      params: { cwd: "/workspace" },
    })

    const result = await server.dispatch({
      jsonrpc: "2.0",
      id: "3",
      method: "session/cancel",
      params: { sessionId: sess.result.sessionId },
    })

    expect(result.result.cancelled).toBe(true)
  })

  test("parsePromptContent handles string", () => {
    const server = new ACPServer()
    const msg = server.parsePromptContent("hello")
    expect(msg.role).toBe("user")
    expect(msg.parts[0]).toEqual({ type: "text", text: "hello" })
  })

  test("parsePromptContent handles array with mixed types", () => {
    const server = new ACPServer()
    const msg = server.parsePromptContent([
      { type: "text", text: "hello" },
      { type: "resource", resource: { text: "file content" } },
      { type: "resource_link", uri: "file:///test.ts", name: "test.ts" },
    ])
    expect(msg.parts).toHaveLength(3)
    expect(msg.parts[0]).toEqual({ type: "text", text: "hello" })
    expect(msg.parts[1]).toEqual({ type: "text", text: "file content" })
    expect(msg.parts[2]).toEqual({ type: "file", uri: "file:///test.ts", name: "test.ts" })
  })
})
