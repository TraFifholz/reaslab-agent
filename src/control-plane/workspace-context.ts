// Shim: workspace-context not used in reaslab-agent
import type { WorkspaceID } from "./schema"

export namespace WorkspaceContext {
  export let workspaceID: WorkspaceID | undefined = undefined

  export function get(): any {
    return {}
  }
}
