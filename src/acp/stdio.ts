// Stdio capture for ACP protocol
// Must be imported before anything else to redirect stdout → stderr
// so that console.log doesn't corrupt the ACP JSON stream

const realStdout = process.stdout
const realWrite = realStdout.write.bind(realStdout)

// Redirect stdout to stderr so console.log goes to stderr
process.stdout.write = process.stderr.write.bind(process.stderr)

/** Write an ACP JSON-RPC message to real stdout (the ACP channel) */
export function writeACP(message: object): void {
  const json = JSON.stringify(message)
  realWrite(json + "\n")
}

/** Read line-delimited JSON from stdin as an async iterable */
export async function* readStdin(): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buffer = ""

  // Use Node.js readable stream instead of Bun.stdin.stream() for compatibility
  for await (const chunk of process.stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })

    let newlineIndex: number
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line.length > 0) {
        yield line
      }
    }
  }

  // Handle any remaining data
  const remaining = buffer.trim()
  if (remaining.length > 0) {
    yield remaining
  }
}
