import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { loadPlaybooks } from "@workspace/agent/playbooks"
import { createRegistry } from "@workspace/analytics/registry"
import type { ReceiptStore, QueryRunner } from "@workspace/domain/tool"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createMcpServer } from "./server.ts"
import type { PlaybookSource, PromptArguments } from "./prompts.ts"

const connections: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close())
  )
})

async function connect(playbooks?: PlaybookSource) {
  const receipts: ReceiptStore = {
    put: vi.fn<ReceiptStore["put"]>(),
    get: vi.fn<ReceiptStore["get"]>().mockResolvedValue(null),
    list: vi.fn<ReceiptStore["list"]>().mockResolvedValue([]),
  }
  const db = { query: vi.fn<QueryRunner["query"]>(), timeoutMs: 10_000 }
  const registry = createRegistry({
    db,
    receipts,
    roleGuidance: playbooks?.guidance,
    log: () => undefined,
  })
  const server = createMcpServer({ registry, receipts, playbooks })
  const client = new Client({ name: "unit-test", version: "1" })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  connections.push(client, server)
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, registry, db }
}

describe("MCP registry adapter", () => {
  it("serves the production playbooks through initialize and prompts/get", async () => {
    const source = loadPlaybooks()
    const { client, db } = await connect(source)
    expect(client.getInstructions()).toBe(source.instructions)
    const listed = await client.listPrompts()
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(
      Object.keys(source.prompts)
    )
    for (const [name, prompt] of Object.entries(source.prompts)) {
      const result = await client.getPrompt({
        name,
        arguments: { question: "Investigate this scope", dataset: "bgl" },
      })
      expect(result.messages).toEqual([
        {
          role: "user",
          content: {
            type: "text",
            text: prompt.render({
              question: "Investigate this scope",
              dataset: "bgl",
            }),
          },
        },
      ])
    }
    expect(db.query).not.toHaveBeenCalled()
  })

  it("advertises all canonical tools and no playbooks without a source", async () => {
    const { client, registry } = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(
      registry.tools.map((tool) => tool.name)
    )
    expect(tools).toHaveLength(8)
    for (const tool of tools) {
      const { _meta: metadata } = tool
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      })
      expect(tool.outputSchema).toBeDefined()
      expect(metadata).toEqual(
        tool.name === "describe_corpus"
          ? { "anthropic/maxResultSizeChars": 200_000 }
          : undefined
      )
    }
    expect(client.getInstructions()).toBeUndefined()
    expect(client.getServerCapabilities()?.prompts).toBeUndefined()
  })

  it("keeps registry invalid_input and hint for malformed schema input", async () => {
    const { client, db } = await connect()
    const result = await client.callTool({
      name: "search_logs",
      arguments: { query: "test", limit: 0 },
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("invalid_input")
    expect(JSON.stringify(result.content)).toContain(
      "Correct the listed fields"
    )
    expect(db.query).not.toHaveBeenCalled()
  })

  it("sanitizes unexpected failures without database text", async () => {
    const { client, db } = await connect()
    db.query.mockRejectedValue(
      new Error("private database text password=secret")
    )
    const result = await client.callTool({
      name: "describe_corpus",
      arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/private|password|secret|stack/)
    expect(JSON.stringify(result)).toContain("hint")
  })

  it("registers instructions and optional role prompts from a marked test fixture", async () => {
    const render = vi.fn<(args: PromptArguments) => string>(
      (args: PromptArguments) => `TEST FIXTURE ONLY: ${JSON.stringify(args)}`
    )
    const prompt = {
      title: "Test fixture",
      description: "Test fixture only, never shipped.",
      render,
    }
    const source: PlaybookSource = {
      instructions: "TEST FIXTURE ONLY: injected instructions.",
      guidance: {
        version: "test",
        routing: "TEST FIXTURE",
        roles: {
          engineer: "TEST FIXTURE",
          team_lead: "TEST FIXTURE",
          manager: "TEST FIXTURE",
        },
      },
      prompts: {
        engineer_investigation: prompt,
        team_lead_review: prompt,
        manager_priorities: prompt,
      },
    }
    const { client } = await connect(source)
    expect(client.getInstructions()).toBe(source.instructions)
    const { prompts } = await client.listPrompts()
    expect(prompts.map((entry) => entry.name)).toEqual([
      "engineer_investigation",
      "team_lead_review",
      "manager_priorities",
    ])
    expect(prompts[0]?.arguments?.every((arg) => !arg.required)).toBe(true)
    const args = {
      question: "test question",
      dataset: "bgl",
      from: "2005-06-03T00:00:00Z",
    }
    const result = await client.getPrompt({
      name: "engineer_investigation",
      arguments: args,
    })
    expect(render).toHaveBeenCalledWith(args)
    expect(JSON.stringify(result)).toContain("TEST FIXTURE ONLY")
  })

  it("forwards the client cancellation signal to the registry", async () => {
    const { client, registry } = await connect()
    let callSignal: AbortSignal | undefined
    vi.spyOn(registry, "runTool").mockImplementation(
      async (_name, _input, call) => {
        callSignal = call.signal
        await new Promise<void>((_resolve, reject) => {
          call.signal.addEventListener(
            "abort",
            () => reject(call.signal.reason),
            { once: true }
          )
        })
        throw new Error("Unreachable after cancellation")
      }
    )
    const controller = new AbortController()
    const pending = client.callTool(
      { name: "describe_corpus", arguments: {} },
      undefined,
      { signal: controller.signal }
    )
    const rejected = pending.catch((error: unknown) => error)
    await vi.waitFor(() => expect(callSignal).toBeDefined())
    controller.abort()
    expect(await rejected).toBeInstanceOf(Error)
    await vi.waitFor(() => expect(callSignal?.aborted).toBe(true))
  })
})
