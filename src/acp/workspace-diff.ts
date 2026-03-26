import fs from "fs/promises"
import path from "path"

export interface FileDiff {
  absolutePath: string
  oldText: string
  newText: string
}

const SKIP_DIRS = new Set([
  ".git", ".reaslab", ".reaslingo",
  "node_modules", "__pycache__", ".venv", "venv",
  "target", ".next", "dist", "build", "out",
  "bower_components", "vendor", ".cache", "coverage", ".pytest_cache",
])

const MAX_FILE_SIZE = 512 * 1024
const MAX_TOTAL_SIZE = 100 * 1024 * 1024
const BINARY_CHECK_BYTES = 8192

async function isBinary(filePath: string): Promise<boolean> {
  try {
    const fd = await fs.open(filePath, "r")
    const buf = Buffer.alloc(BINARY_CHECK_BYTES)
    const { bytesRead } = await fd.read(buf, 0, BINARY_CHECK_BYTES, 0)
    await fd.close()
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true
    }
    return false
  } catch {
    return true
  }
}

async function* walkDir(dir: string): AsyncGenerator<string> {
  let entries: import("fs").Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true }) as import("fs").Dirent[]
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* walkDir(fullPath)
    } else if (entry.isFile()) {
      yield fullPath
    }
  }
}

export class WorkspaceDiffer {
  private entries = new Map<string, { mtime: number; oldText: string }>()
  private snapshotDone = false
  private snapshotFailed = false

  async snapshot(workspace: string): Promise<void> {
    this.entries.clear()
    this.snapshotFailed = false
    let totalSize = 0
    try {
      for await (const filePath of walkDir(workspace)) {
        let stat: Awaited<ReturnType<typeof fs.stat>>
        try { stat = await fs.stat(filePath) } catch { continue }
        if (stat.size > MAX_FILE_SIZE) continue
        if (await isBinary(filePath)) continue
        let content: string
        try { content = await fs.readFile(filePath, "utf-8") } catch { continue }
        totalSize += content.length
        if (totalSize > MAX_TOTAL_SIZE) {
          console.error("[workspace-diff] snapshot budget exceeded (>100MB)")
          this.snapshotFailed = true
          this.snapshotDone = true
          return
        }
        this.entries.set(filePath, { mtime: stat.mtimeMs, oldText: content })
      }
    } catch (err) {
      console.error("[workspace-diff] snapshot failed:", err)
      this.snapshotFailed = true
    }
    this.snapshotDone = true
  }

  async computeDiffs(workspace: string): Promise<FileDiff[]> {
    if (!this.snapshotDone || this.snapshotFailed) return []
    const diffs: FileDiff[] = []
    const deadline = Date.now() + 5000
    const CONCURRENCY = 10
    const candidates: Array<{ filePath: string; entry: { mtime: number; oldText: string } | undefined }> = []

    for await (const filePath of walkDir(workspace)) {
      if (Date.now() > deadline) break
      let stat: Awaited<ReturnType<typeof fs.stat>>
      try { stat = await fs.stat(filePath) } catch { continue }
      const existing = this.entries.get(filePath)
      if (existing && stat.mtimeMs === existing.mtime) continue
      if (stat.size > MAX_FILE_SIZE) continue
      if (await isBinary(filePath)) continue
      candidates.push({ filePath, entry: existing })
      if (Date.now() > deadline) break
    }

    const chunks: typeof candidates[] = []
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      chunks.push(candidates.slice(i, i + CONCURRENCY))
    }

    for (const chunk of chunks) {
      if (Date.now() > deadline) break
      const results = await Promise.allSettled(
        chunk.map(async ({ filePath, entry }) => {
          const newText = await fs.readFile(filePath, "utf-8")
          const oldText = entry?.oldText ?? ""
          if (newText === oldText) return null
          return { absolutePath: filePath, oldText, newText } satisfies FileDiff
        }),
      )
      for (const r of results) {
        if (r.status === "fulfilled" && r.value !== null) diffs.push(r.value)
      }
    }

    return diffs.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath))
  }
}
