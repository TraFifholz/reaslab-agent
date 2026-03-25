// Stub: Patch module for apply_patch tool
// This is a placeholder — the actual implementation should be ported from opencode

export namespace Patch {
  export interface Chunk {
    type: "context" | "add" | "remove"
    content: string
    lineNumber?: number
  }

  export interface Hunk {
    path: string
    type: "add" | "update" | "delete"
    contents: string
    chunks: Chunk[]
    move_path?: string
  }

  export interface ParseResult {
    hunks: Hunk[]
  }

  export function parsePatch(patchText: string): ParseResult {
    // Minimal parser for apply_patch tool
    const hunks: Hunk[] = []
    const lines = patchText.split("\n")
    let i = 0

    while (i < lines.length) {
      const line = lines[i]

      if (line.startsWith("*** ") && !line.startsWith("*** Begin Patch") && !line.startsWith("*** End Patch")) {
        const pathMatch = line.match(/^\*\*\* (\S+)/)
        if (pathMatch) {
          const filePath = pathMatch[1]
          i++
          const nextLine = lines[i] ?? ""

          if (nextLine.startsWith("--- new file")) {
            i++
            let contents = ""
            while (i < lines.length && !lines[i].startsWith("***")) {
              contents += (contents ? "\n" : "") + (lines[i].startsWith("+") ? lines[i].slice(1) : lines[i])
              i++
            }
            hunks.push({ path: filePath, type: "add", contents, chunks: [] })
          } else if (nextLine.startsWith("--- delete")) {
            i++
            hunks.push({ path: filePath, type: "delete", contents: "", chunks: [] })
          } else {
            // Update hunk
            const chunks: Chunk[] = []
            let moveTarget: string | undefined
            if (nextLine.startsWith("--- move to ")) {
              moveTarget = nextLine.replace("--- move to ", "").trim()
              i++
            }
            while (i < lines.length && !lines[i].startsWith("***")) {
              const l = lines[i]
              if (l.startsWith("+")) {
                chunks.push({ type: "add", content: l.slice(1) })
              } else if (l.startsWith("-")) {
                chunks.push({ type: "remove", content: l.slice(1) })
              } else {
                chunks.push({ type: "context", content: l.startsWith(" ") ? l.slice(1) : l })
              }
              i++
            }
            hunks.push({
              path: filePath,
              type: "update",
              contents: "",
              chunks,
              move_path: moveTarget,
            })
          }
        } else {
          i++
        }
      } else {
        i++
      }
    }

    return { hunks }
  }

  export function deriveNewContentsFromChunks(
    _filePath: string,
    chunks: Chunk[],
  ): { content: string } {
    // This is a simplified implementation
    const result: string[] = []
    for (const chunk of chunks) {
      if (chunk.type === "context" || chunk.type === "add") {
        result.push(chunk.content)
      }
      // "remove" chunks are skipped (they represent old content being removed)
    }
    return { content: result.join("\n") + "\n" }
  }
}
