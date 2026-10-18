import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRegistry } from "@workspace/analytics/registry"
import type { QueryRunner, ReceiptStore } from "@workspace/domain/tool"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createMcpServer } from "./server.ts"

const connections: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  await Promise.all(connections.splice(0).map((item) => item.close()))
})
async function connect() {
  const receipts: ReceiptStore = {
    put: vi.fn<ReceiptStore["put"]>(),
    get: vi.fn<ReceiptStore["get"]>().mockResolvedValue(null),
    list: vi.fn<ReceiptStore["list"]>().mockResolvedValue([]),
  }
  const query = vi.fn<QueryRunner["query"]>()
  const registry = createRegistry({
    db: { query, timeoutMs: 10000 },
    receipts,
    log: () => undefined,
  })
  const server = createMcpServer({ registry, receipts })
  const client = new Client({ name: "log41-contract-test", version: "1" })
  const [left, right] = InMemoryTransport.createLinkedPair()
  connections.push(client, server)
  await server.connect(right)
  await client.connect(left)
  return { client, query }
}

describe("LOG-41 MCP contract exposure", () => {
  it("advertises retrieval, entities, temporal analysis and outliers through the shared eight tools", async () => {
    const { client, query } = await connect()
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(8)
    const serialized = (name: string) =>
      JSON.stringify(tools.find((tool) => tool.name === name)?.inputSchema)
    expect(serialized("search_logs")).toContain('"semantic"')
    expect(serialized("search_logs")).toContain('"hybrid"')
    expect(serialized("search_logs")).toContain('"retrieval_snapshot"')
    expect(serialized("count_events")).toContain('"entity"')
    expect(serialized("recurring_patterns")).toContain('"periodicity"')
    expect(serialized("recurring_patterns")).toContain('"cooccurrence"')
    expect(serialized("latency_stats")).toContain('"outliers"')
    expect(query).not.toHaveBeenCalled()
  })
  it.each([
    {
      name: "search_logs",
      arguments: { query: "memory integrity fault", match: "semantic" },
    },
    {
      name: "search_logs",
      arguments: { query: "cache parity", match: "hybrid" },
    },
    {
      name: "count_events",
      arguments: { group_by: ["component"], entity: { type: "invented" } },
    },
    {
      name: "recurring_patterns",
      arguments: { dataset: "bgl", analysis: { mode: "cooccurrence" } },
    },
    { name: "latency_stats", arguments: { outliers: { threshold: "p50" } } },
  ])(
    "returns explicit invalid_input with a correction hint for $name",
    async (args) => {
      const { client, query } = await connect()
      const result = await client.callTool(args)
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain("invalid_input")
      expect(JSON.stringify(result.content)).toContain("hint")
      expect(query).not.toHaveBeenCalled()
    }
  )
})
