// Stub: ProviderTransform utilities removed in reaslab-agent
// These functions are used by compaction.ts, prompt.ts, and other modules

export namespace ProviderTransform {
  export const OUTPUT_TOKEN_MAX = 32000

  export function maxOutputTokens(model: any): number {
    return model?.limit?.output ?? 16384
  }

  /** Pass-through: returns the schema unchanged */
  export function schema(_model: any, jsonSchema: any): any {
    return jsonSchema
  }

  /** Returns empty options */
  export function options(_input: any): Record<string, any> {
    return {}
  }

  /** Returns empty options for small models */
  export function smallOptions(_model: any): Record<string, any> {
    return {}
  }

  /** Returns empty provider options */
  export function providerOptions(_model: any, _options?: any): Record<string, any> {
    return {}
  }

  /** Returns undefined (no temperature override) */
  export function temperature(_model: any): number | undefined {
    return undefined
  }

  /** Returns undefined (no topP override) */
  export function topP(_model: any): number | undefined {
    return undefined
  }

  /** Returns undefined (no topK override) */
  export function topK(_model: any): number | undefined {
    return undefined
  }

  /** Pass-through: returns messages unchanged */
  export function message(messages: any, _model: any, _options?: any): any {
    return messages
  }
}
