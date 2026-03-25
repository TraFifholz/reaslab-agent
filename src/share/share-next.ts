// Shim: share functionality not used in reaslab-agent
export namespace ShareNext {
  export async function create(_opts: any): Promise<any> {
    throw new Error("Share not supported in reaslab-agent")
  }
  export function init(): void {}
  export async function remove(_id: string): Promise<void> {}
}
