import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import type { Registry } from "@workspace/analytics/registry"
import { dbUnavailable } from "@workspace/domain/errors"
import { receiptSchema } from "@workspace/domain/receipt"
import type { ReceiptStore, ToolResult } from "@workspace/domain/tool"
import { afterEach, describe, expect, it, vi } from "vitest"

import { registerResources } from "./resources.ts"

const RESULT: ToolResult<unknown> = {
  data: {
    datasets: [],
    limits: ["Events are not incidents."],
    ownership: {
      fictional: true,
      note: "Fictional ownership.",
      teams: [],
      unowned: [],
    },
    versions: {
      data_version: "dv_test",
      source: "samples",
      loader_version: "1.0.0",
      parser_version: "1.0.0",
      pattern_rules_version: "1.0.0",
      ownership_version: "1.0.0",
      rules_version: "1.0.0",
      contract_version: "1.0.0",
    },
    answer_guidance: null,
    guidance_version: null,
  },
  facts: [],
  receipt: {
    receipt_id: "r_01234567",
    input: {},
    signature: "0".repeat(64),
    data_version: "dv_test",
    sql: [],
    params: [],
    scope: { windows: [], filters: {} },
    population: null,
    rows_returned: 1,
    truncated: false,
    duration_ms: 1,
    result_digest: "1".repeat(64),
  },
  notes: ["Teams are fictional."],
}

const RECEIPT = receiptSchema.parse({
  ...RESULT.receipt,
  created_at: "2026-10-17T12:00:00Z",
  client: "mcp",
  tool: "describe_corpus",
  tool_version: "1.0.0",
  row_limit: null,
  result: RESULT.data,
  facts: RESULT.facts,
})

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

async function setup() {
  const runTool = vi.fn<Registry["runTool"]>().mockResolvedValue({
    ok: true,
    result: RESULT,
  })
  const registry: Registry = {
    tools: [],
    catalog: () => [],
    runTool,
    rerun: vi.fn<Registry["rerun"]>(),
  }
  const get = vi.fn<ReceiptStore["get"]>().mockResolvedValue(null)
  const receipts: ReceiptStore = {
    put: vi.fn<ReceiptStore["put"]>(),
    get,
    list: vi.fn<ReceiptStore["list"]>(),
  }
  const server = new McpServer({ name: "resource-test", version: "1.0.0" })
  registerResources(server, registry, receipts)
  const client = new Client({ name: "resource-test-client", version: "1.0.0" })
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  closers.push(async () => {
    await client.close()
    await server.close()
  })
  return { client, registry, runTool, get, receipts }
}

describe("MCP resources", () => {
  it("lists three fixed corpus resources and the receipt template without store access", async () => {
    const { client, receipts } = await setup()
    expect((await client.listResources()).resources).toEqual([
      expect.objectContaining({
        uri: "corpus://overview",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "corpus://schema",
        mimeType: "application/json",
      }),
      expect.objectContaining({
        uri: "corpus://ownership",
        mimeType: "application/json",
      }),
    ])
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: "receipt://{id}",
        mimeType: "application/json",
      }),
    ])
    expect(receipts.list).not.toHaveBeenCalled()
    expect(receipts.get).not.toHaveBeenCalled()
    expect(receipts.put).not.toHaveBeenCalled()
  })

  it.each(["overview", "schema", "ownership"])(
    "routes corpus://%s through describe_corpus with the MCP signal and receipt",
    async (name) => {
      const { client, runTool, get } = await setup()
      const uri = `corpus://${name}`
      const response = await client.readResource({ uri })
      expect(runTool).toHaveBeenCalledExactlyOnceWith(
        "describe_corpus",
        {},
        {
          client: "mcp",
          signal: expect.any(AbortSignal),
        }
      )
      expect(response.contents).toEqual([
        {
          uri,
          mimeType: "application/json",
          text: expect.any(String),
        },
      ])
      const content = response.contents[0]
      if (content === undefined || !("text" in content))
        throw new Error("expected JSON text")
      const body: unknown = JSON.parse(content.text)
      expect(body).toMatchObject({
        receipt: RESULT.receipt,
        facts: RESULT.facts,
        notes: RESULT.notes,
      })
      expect(body).toHaveProperty(
        `data.${name === "ownership" ? "ownership" : "datasets"}`
      )
      expect(get).not.toHaveBeenCalled()
    }
  )

  it("reads the full stored receipt through the shared store", async () => {
    const { client, get, runTool } = await setup()
    get.mockResolvedValue(RECEIPT)
    const response = await client.readResource({ uri: "receipt://r_01234567" })
    expect(get).toHaveBeenCalledExactlyOnceWith("r_01234567")
    const content = response.contents[0]
    if (content === undefined || !("text" in content))
      throw new Error("expected JSON text")
    expect(JSON.parse(content.text)).toEqual(RECEIPT)
    expect(runTool).not.toHaveBeenCalled()
  })

  it.each(["r_ABCDEF12", "r_1234567", "%2e%2e%2fsecret"])(
    "rejects malformed receipt ID %s before accessing the store",
    async (id) => {
      const { client, get } = await setup()
      await expect(
        client.readResource({ uri: `receipt://${id}` })
      ).rejects.toBeInstanceOf(McpError)
      expect(get).not.toHaveBeenCalled()
    }
  )

  it("reports unknown receipt IDs as not_found", async () => {
    const { client, get } = await setup()
    await expect(
      client.readResource({ uri: "receipt://r_01234567" })
    ).rejects.toMatchObject({
      data: { code: "not_found", resource: "receipt", id: "r_01234567" },
    })
    expect(get).toHaveBeenCalledExactlyOnceWith("r_01234567")
  })

  it("sanitizes corrupt receipt and unexpected database failures", async () => {
    const { client, get, runTool } = await setup()
    const secret = "private database credentials and /tmp/private/receipt.json"
    get.mockRejectedValue(new Error(secret))
    runTool.mockRejectedValue(new Error(secret))
    for (const uri of ["receipt://r_01234567", "corpus://overview"]) {
      const request = client.readResource({ uri })
      await expect(request).rejects.toBeInstanceOf(McpError)
      await expect(request).rejects.not.toThrow(secret)
    }
  })

  it("maps expected tool errors with their correction hint", async () => {
    const { client, runTool } = await setup()
    runTool.mockResolvedValue({ ok: false, error: dbUnavailable() })
    await expect(
      client.readResource({ uri: "corpus://overview" })
    ).rejects.toMatchObject({ data: dbUnavailable() })
  })

  it("forwards client cancellation to the active registry read", async () => {
    const { client, runTool } = await setup()
    const started = new Promise<AbortSignal>((resolve) => {
      runTool.mockImplementation(async (_name, _input, call) => {
        resolve(call.signal)
        return new Promise((_resolve, reject) => {
          call.signal.addEventListener(
            "abort",
            () => reject(call.signal.reason),
            { once: true }
          )
        })
      })
    })
    const controller = new AbortController()
    const request = client.readResource(
      { uri: "corpus://overview" },
      { signal: controller.signal }
    )
    const signal = await started
    controller.abort(new Error("Resource read cancelled"))
    await expect(request).rejects.toThrow("Resource read cancelled")
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
  })
})
