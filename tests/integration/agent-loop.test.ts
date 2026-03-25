import { describe, test, expect } from "bun:test"
import { ACPServer } from "../../src/acp/server"

describe("Agent Loop Integration", () => {
  test("initialize → session/new → session/prompt produces output", async () => {
    const server = new ACPServer()
    const collected: any[] = []
    server.onNotification = (msg: any) => collected.push(msg)

    // Initialize
    const init = await server.dispatch({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {},
    })
    expect(init.result.protocolVersion).toBeDefined()

    // Create session
    const session = await server.dispatch({
      jsonrpc: "2.0",
      id: "2",
      method: "session/new",
      params: { cwd: "/tmp/test-workspace", mcpServers: [] },
    })
    expect(session.result.sessionId).toBeDefined()

    // Send prompt (requires real API key — skip in CI)
    if (process.env.TEST_API_KEY && process.env.TEST_BASE_URL) {
      const result = await server.dispatch({
        jsonrpc: "2.0",
        id: "3",
        method: "session/prompt",
        params: {
          sessionId: session.result.sessionId,
          prompt: "Say hello in one word",
          _meta: {
            model: process.env.TEST_MODEL || "gpt-4o-mini",
            baseUrl: process.env.TEST_BASE_URL,
            apiKey: process.env.TEST_API_KEY,
          },
        },
      })

      // Immediate response is null
      expect(result.result).toBeNull()

      // Wait for async completion
      await new Promise((resolve) => setTimeout(resolve, 10000))

      // Should have received at least one notification (text chunk or completion)
      const textChunks = collected.filter(
        (m) => m.params?.update?.sessionUpdate === "agent_message_chunk",
      )
      expect(textChunks.length).toBeGreaterThan(0)
    }
  })

  test("full ACP lifecycle without API key still works for init/session", async () => {
    const server = new ACPServer()

    // Initialize
    const init = await server.dispatch({
      jsonrpc: "2.0",
      id: "1",
      method: "initialize",
      params: {},
    })
    expect(init.result.capabilities.streaming).toBe(true)

    // Authenticate
    const auth = await server.dispatch({
      jsonrpc: "2.0",
      id: "2",
      method: "authenticate",
      params: {},
    })
    expect(auth.result.authenticated).toBe(true)

    // Create session
    const session = await server.dispatch({
      jsonrpc: "2.0",
      id: "3",
      method: "session/new",
      params: {
        cwd: "/workspace",
        mcpServers: [
          { type: "http", name: "tooling", url: "http://localhost:10004/mcp/test" },
        ],
      },
    })
    expect(session.result.sessionId).toBeDefined()

    // Cancel (should not error even if nothing running)
    const cancel = await server.dispatch({
      jsonrpc: "2.0",
      id: "4",
      method: "session/cancel",
      params: { sessionId: session.result.sessionId },
    })
    expect(cancel.result.cancelled).toBe(true)
  })
})
