// Boot sequence for reaslab-agent
// Initializes the minimum subsystems needed for the agent loop

import { Config } from "@/config/config"
import { Log } from "@/util/log"
import path from "path"
import fs from "fs/promises"

const log = Log.create({ service: "boot" })

export namespace Boot {
  let initialized = false

  /** Initialize the agent runtime */
  export async function init(workspace?: string): Promise<void> {
    if (initialized) return
    initialized = true

    const cfg = Config.get()
    const ws = workspace || cfg.workspace

    // Ensure data directory exists
    const dataDir = cfg.dataDir
    await fs.mkdir(dataDir, { recursive: true }).catch(() => {})

    // Set up project workspace
    process.env.PROJECT_WORKSPACE = ws

    log.info("boot", {
      workspace: ws,
      dataDir,
      userId: cfg.userId,
    })
  }

  /** Reset for testing */
  export function reset() {
    initialized = false
  }
}
