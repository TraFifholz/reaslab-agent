import { describe, test, expect, beforeEach } from "bun:test"
import { Config } from "../../src/config/config"

describe("Config", () => {
  beforeEach(() => {
    Config.reset()
  })

  test("reads PROJECT_WORKSPACE from env", () => {
    process.env.PROJECT_WORKSPACE = "/test/workspace"
    const cfg = Config.get()
    expect(cfg.workspace).toBe("/test/workspace")
    delete process.env.PROJECT_WORKSPACE
  })

  test("reads REASLAB_USER_ID from env", () => {
    process.env.REASLAB_USER_ID = "user-123"
    const cfg = Config.get()
    expect(cfg.userId).toBe("user-123")
    delete process.env.REASLAB_USER_ID
  })

  test("provides default agent definitions", () => {
    const cfg = Config.get()
    expect(cfg.agents.length).toBeGreaterThan(0)
    const ids = cfg.agents.map((a) => a.id)
    expect(ids).toContain("build")
    expect(ids).toContain("plan")
    expect(ids).toContain("general")
    expect(ids).toContain("explore")
  })

  test("provides default workspace when env not set", () => {
    delete process.env.PROJECT_WORKSPACE
    const cfg = Config.get()
    expect(cfg.workspace).toBe("/workspace")
  })

  test("dbPath returns path inside dataDir", () => {
    process.env.DATA_DIR = "/tmp/test-data"
    const dbPath = Config.dbPath()
    expect(dbPath).toContain("test-data")
    expect(dbPath).toEndWith(".db")
    delete process.env.DATA_DIR
  })
})
