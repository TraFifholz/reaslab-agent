// Shim: workspace table not used in reaslab-agent
import { sqliteTable, text } from "drizzle-orm/sqlite-core"

export const WorkspaceTable = sqliteTable("workspace", {
  id: text("id").primaryKey(),
})
