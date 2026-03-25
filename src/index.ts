// Reaslab Agent — ACP-based agent container
// Entry point: redirect stdout, start ACP server on stdin/stdout

import "./acp/stdio" // Must be first — captures real stdout
import { ACPServer } from "./acp/server"

async function main() {
  console.error("[reaslab-agent] starting ACP server...")

  const server = new ACPServer()
  await server.run() // Blocks on stdin, dispatches JSON-RPC
}

main().catch((err) => {
  console.error("[reaslab-agent] fatal error:", err)
  process.exit(1)
})
