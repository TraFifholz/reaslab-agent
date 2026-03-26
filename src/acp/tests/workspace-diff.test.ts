import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"

describe("WorkspaceDiffer skip rules", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-diff-test-"))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  test("skips node_modules directory", async () => {
    await fs.mkdir(path.join(tmpDir, "node_modules"))
    await fs.writeFile(path.join(tmpDir, "node_modules", "pkg.js"), "module.exports = {}")
    await fs.writeFile(path.join(tmpDir, "index.ts"), "export const x = 1")
    const { WorkspaceDiffer } = await import("../workspace-diff")
    const differ = new WorkspaceDiffer()
    await differ.snapshot(tmpDir)
    expect((differ as any).entries.has(path.join(tmpDir, "index.ts"))).toBe(true)
    expect((differ as any).entries.has(path.join(tmpDir, "node_modules", "pkg.js"))).toBe(false)
  })

  test("skips files larger than 512KB", async () => {
    const large = "x".repeat(513 * 1024)
    await fs.writeFile(path.join(tmpDir, "large.txt"), large)
    await fs.writeFile(path.join(tmpDir, "small.txt"), "hello")
    const { WorkspaceDiffer } = await import("../workspace-diff")
    const differ = new WorkspaceDiffer()
    await differ.snapshot(tmpDir)
    expect((differ as any).entries.has(path.join(tmpDir, "small.txt"))).toBe(true)
    expect((differ as any).entries.has(path.join(tmpDir, "large.txt"))).toBe(false)
  })

  test("skips binary files (null byte detection)", async () => {
    await fs.writeFile(path.join(tmpDir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02]))
    await fs.writeFile(path.join(tmpDir, "text.txt"), "hello world")
    const { WorkspaceDiffer } = await import("../workspace-diff")
    const differ = new WorkspaceDiffer()
    await differ.snapshot(tmpDir)
    expect((differ as any).entries.has(path.join(tmpDir, "text.txt"))).toBe(true)
    expect((differ as any).entries.has(path.join(tmpDir, "binary.bin"))).toBe(false)
  })

  test("skips symlinks", async () => {
    await fs.writeFile(path.join(tmpDir, "real.txt"), "real content")
    try {
      await fs.symlink(path.join(tmpDir, "real.txt"), path.join(tmpDir, "link.txt"))
    } catch { return }
    const { WorkspaceDiffer } = await import("../workspace-diff")
    const differ = new WorkspaceDiffer()
    await differ.snapshot(tmpDir)
    expect((differ as any).entries.has(path.join(tmpDir, "real.txt"))).toBe(true)
    expect((differ as any).entries.has(path.join(tmpDir, "link.txt"))).toBe(false)
  })

  test("skips .git directory", async () => {
    await fs.mkdir(path.join(tmpDir, ".git"))
    await fs.writeFile(path.join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main")
    await fs.writeFile(path.join(tmpDir, "tracked.ts"), "export const x = 1")
    const { WorkspaceDiffer } = await import("../workspace-diff")
    const differ = new WorkspaceDiffer()
    await differ.snapshot(tmpDir)
    expect((differ as any).entries.has(path.join(tmpDir, "tracked.ts"))).toBe(true)
    expect((differ as any).entries.has(path.join(tmpDir, ".git", "HEAD"))).toBe(false)
  })
})
