// Stub: provider error parsing utilities
export namespace ProviderError {
  interface ParsedError {
    type: "api_error" | "context_overflow"
    message: string
    statusCode?: number
    isRetryable: boolean
    responseHeaders?: Record<string, string>
    responseBody?: string
    metadata?: Record<string, string>
  }

  export function parseAPICallError(_input: {
    providerID: string
    error: unknown
  }): ParsedError {
    const err = _input.error as any
    return {
      type: "api_error",
      message: err?.message ?? String(err),
      statusCode: err?.statusCode,
      isRetryable: err?.isRetryable ?? false,
      responseHeaders: err?.responseHeaders,
      responseBody: err?.responseBody,
    }
  }

  export function parseStreamError(_e: unknown): ParsedError | undefined {
    return undefined
  }
}
