import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DebugTrace } from "../../src/util/debug-trace"

describe("DebugTrace", () => {
  const original = process.env.REASLAB_AGENT_DEBUG_TRACE
  const originalDataDir = process.env.DATA_DIR

  afterEach(async () => {
    process.env.REASLAB_AGENT_DEBUG_TRACE = original
    process.env.DATA_DIR = originalDataDir
  })

  test("writes ndjson trace file into DATA_DIR when enabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reaslab-debug-trace-"))
    process.env.REASLAB_AGENT_DEBUG_TRACE = "1"
    process.env.DATA_DIR = dir

    await DebugTrace.write("test.event", { ok: true, count: 1 })

    const text = await fs.readFile(path.join(dir, "debug-tool-call-trace.ndjson"), "utf-8")
    expect(text).toContain('"event":"test.event"')
    expect(text).toContain('"ok":true')
    expect(text).toContain('"count":1')
  })

  test("writes ndjson trace file into DATA_DIR without debug env override", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reaslab-debug-trace-default-"))
    delete process.env.REASLAB_AGENT_DEBUG_TRACE
    process.env.DATA_DIR = dir

    await DebugTrace.write("test.default", { ok: true })

    const text = await fs.readFile(path.join(dir, "debug-tool-call-trace.ndjson"), "utf-8")
    expect(text).toContain('"event":"test.default"')
    expect(text).toContain('"ok":true')
  })
})
