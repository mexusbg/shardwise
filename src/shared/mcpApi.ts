/**
 * Local MCP server contract. Shardwise can expose selected saved connections to MCP clients (Claude Code,
 * Claude Desktop, IDE agents…) over Streamable HTTP on 127.0.0.1. Implemented by `mcpHandlers()` in
 * src/main/mcp/service.ts.
 */

export interface McpSettings {
  enabled: boolean
  port: number
  /** Registers the write tools; every write call still needs approval in the app. */
  allowWrites: boolean
  /** Max documents returned by find / aggregate. */
  maxDocs: number
  /** Connect exposed connections on demand instead of requiring them to be open in the app. */
  autoConnect: boolean
}

export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  port: 27999,
  allowWrites: false,
  maxDocs: 50,
  autoConnect: false
}

export const MCP_MAX_DOCS_LIMIT = 1000

export interface McpStatus {
  settings: McpSettings
  /** Bearer token clients must send (`Authorization: Bearer <token>`). */
  token: string
  running: boolean
  /** e.g. `http://127.0.0.1:27999/mcp` while running. */
  url?: string
  port?: number
  /** Last start failure (port in use…). */
  error?: string
  /** Open MCP sessions and the client names they reported. */
  sessions: number
  clients: string[]
}

export interface McpLogEntry {
  id: number
  time: Date
  /** `name version` from the client's initialize request. */
  client?: string
  tool: string
  /** Short, size-capped summary of the arguments. */
  args: string
  ms: number
  /** Characters of tool output. */
  size?: number
  error?: string
  /** Write tools: whether the user approved. */
  approved?: boolean
}

export interface ApprovalRequest {
  id: string
  client?: string
  tool: string
  connection: string
  database: string
  collection: string
  /** The exact operation in mongo shell syntax. */
  operation: string
  /** One-line description, e.g. "Insert 3 documents". */
  summary: string
  /** Epoch ms after which the request is denied automatically. */
  expiresAt: number
}

/** Main → renderer events (sent on the same `event` channel as ApiEvents). */
export interface McpEvents {
  'mcp:approval': ApprovalRequest
  'mcp:log': McpLogEntry
}

/** Renderer-callable methods. */
export interface McpApi {
  mcpStatus(): McpStatus
  /** Saves the settings and starts / stops / reconfigures the server. */
  mcpConfigure(settings: Partial<McpSettings>): McpStatus
  mcpRegenerateToken(): McpStatus
  /** Most recent calls first (last 200). */
  mcpLog(): McpLogEntry[]
  mcpClearLog(): void
  mcpRespondApproval(id: string, approved: boolean): void
}
