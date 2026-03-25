// Shim: plugin system not used in reaslab-agent container
export namespace Plugin {
  export function tools(): any[] {
    return []
  }
  export function hooks(): any[] {
    return []
  }
  export function list(): any[] {
    return []
  }
  /** No-op trigger: returns the defaults object unchanged */
  export async function trigger<T>(_event: string, _ctx: any, defaults: T): Promise<T> {
    return defaults
  }
  /** No-op init */
  export async function init(): Promise<void> {}
}
