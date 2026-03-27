import fs from "fs/promises"
import path from "path"
import { Config } from "@/config/config"

export namespace DebugTrace {
  const filename = "debug-tool-call-trace.ndjson"

  function enabled() {
    return process.env.REASLAB_AGENT_DEBUG_TRACE !== "0"
  }

  export async function write(event: string, payload: Record<string, unknown>) {
    if (!enabled()) return

    const file = filePath()
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
    await fs.appendFile(
      file,
      JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...payload,
      }) + "\n",
      "utf-8",
    ).catch(() => {})
  }

  export function filePath() {
    return path.join(process.env.DATA_DIR || Config.get().dataDir, filename)
  }
}
