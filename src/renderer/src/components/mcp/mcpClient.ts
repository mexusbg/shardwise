import { decodeIpc, encodeIpc } from '@shared/ipcCodec'
import type { McpApi, McpEvents } from '@shared/mcpApi'

type Promisified = { [K in keyof McpApi]: (...args: Parameters<McpApi[K]>) => Promise<Awaited<ReturnType<McpApi[K]>>> }

async function call(method: string, args: unknown[]): Promise<unknown> {
  const res = await window.bridge.invoke(method, encodeIpc(args))
  if (!res.ok) throw new Error(res.error)
  return decodeIpc(res.value)
}

/** MCP server methods, invoked over the same IPC channel and codec as `api`. */
export const mcpApi = new Proxy({} as Promisified, {
  get: (_t, method: string) => (...args: unknown[]) => call(method, args)
}) as Promisified

export function onMcpEvent<K extends keyof McpEvents>(channel: K, cb: (payload: McpEvents[K]) => void): () => void {
  return window.bridge.on((ch, payload) => {
    if (ch === channel) cb(decodeIpc(payload) as McpEvents[K])
  })
}

export const claudeCommand = (url: string, token: string): string => `claude mcp add --transport http shardwise ${url} --header "Authorization: Bearer ${token}"`

export const jsonConfig = (url: string, token: string): string =>
  JSON.stringify({ mcpServers: { shardwise: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)
