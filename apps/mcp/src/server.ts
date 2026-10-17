import { pathToFileURL } from "node:url"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"
import { loadConfig } from "@workspace/analytics/config"
import { loadPlaybooks } from "@workspace/agent/playbooks"
import { createDatabase } from "@workspace/analytics/db"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry, type Registry } from "@workspace/analytics/registry"
import type { ReceiptStore, ToolResult } from "@workspace/domain/tool"

import { toToolErrorResult } from "./errors.ts"
import { registerPrompts, type PlaybookSource } from "./prompts.ts"
import { registerResources } from "./resources.ts"

export function createMcpServer(options: {
  registry: Registry
  receipts: ReceiptStore
  playbooks?: PlaybookSource
}): McpServer {
  const { registry, receipts, playbooks } = options
  const server = new McpServer(
    { name: "log-insights", version: "0.0.0" },
    playbooks === undefined ? {} : { instructions: playbooks.instructions }
  )

  const call = async (
    name: string,
    input: unknown,
    signal: AbortSignal
  ): Promise<CallToolResult> => {
    try {
      const outcome = await registry.runTool(name, input, {
        client: "mcp",
        signal,
      })
      if (!outcome.ok) return toToolErrorResult(outcome.error)
      const entry = registry.tools.find((tool) => tool.name === name)
      const text = entry?.summarize(outcome.result) ?? summarize(outcome.result)
      const content: CallToolResult["content"] = [{ type: "text", text }]
      // Desktop may omit Initialize instructions from the model's context.
      // Deliver the same source with results so direct questions still route.
      if (playbooks !== undefined)
        content.push({ type: "text", text: playbooks.instructions })
      content.push({ type: "text", text: JSON.stringify(outcome.result) })
      return {
        // Some clients expose only content to the model. Keep the complete
        // validated result there too, including groups, guidance and fact IDs.
        content,
        structuredContent: { ...outcome.result },
      }
    } catch {
      signal.throwIfAborted()
      return toToolErrorResult()
    }
  }

  for (const tool of registry.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      (input, extra) => call(tool.name, input, extra.signal)
    )
  }

  // SDK 1.32.1 prevalidation bypasses the registry's invalid_input/hint mapper.
  // Replace its call handler through the public API; registration still owns
  // tools/list, while runTool owns input/output validation and receipts.
  server.server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    call(request.params.name, request.params.arguments ?? {}, extra.signal)
  )
  registerResources(server, registry, receipts)
  registerPrompts(server, playbooks)
  return server
}

/** Fallback for catalog entries without summary prose; values are assigned facts. */
function summarize(result: ToolResult<unknown>): string {
  const facts = result.facts
    .slice(0, 6)
    .map((fact) => `${fact.metric}: ${fact.value} [${fact.id}]`)
  return [
    `Receipt ${result.receipt.receipt_id}; truncated=${result.receipt.truncated}.`,
    ...facts,
    ...result.notes,
  ].join("\n")
}

/** Configuration is validated before the transport connects; the pool stays lazy. */
export async function startMcpServer(
  playbooks: PlaybookSource = loadPlaybooks()
): Promise<void> {
  const config = loadConfig()
  const db = createDatabase(config.connection)
  const receipts = new FileReceiptStore(config.receiptsDir)
  const registry = createRegistry({
    db,
    receipts,
    workspaceTools: config.workspaceTools,
    roleGuidance: playbooks.guidance,
  })
  const server = createMcpServer({ registry, receipts, playbooks })
  const transport = new StdioServerTransport()
  let closing: Promise<void> | undefined
  const shutdown = () => {
    closing ??= Promise.resolve()
      .then(async () => {
        process.off("SIGINT", shutdown)
        process.off("SIGTERM", shutdown)
        process.stdin.off("end", shutdown)
        await server.close()
        return db.dispose()
      })
      .catch(() => {
        process.exitCode = 1
      })
    return closing
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  process.stdin.once("end", shutdown)
  // The SDK exposes callback properties rather than EventTarget listeners.
  Object.assign(server.server, { onclose: shutdown })
  try {
    await server.connect(transport)
  } catch (error) {
    await shutdown()
    throw error
  }
}

const entrypoint = process.argv[1]
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  startMcpServer().catch(() => {
    process.stderr.write(
      "Log Insights MCP failed to start. Check the repository .env and installation.\n"
    )
    process.exitCode = 1
  })
}
