/**
 * Provider-specific quirks and compatibility rules
 */

export namespace ProviderQuirks {
  /**
   * Providers that don't support 'developer' role (which AI SDK may convert 'system' to)
   * For these providers, system prompts should be sent as user messages instead
   */
  export function requiresSystemAsUser(providerID: string): boolean {
    const id = providerID.toLowerCase()
    return id.includes("deepseek")
  }
}
