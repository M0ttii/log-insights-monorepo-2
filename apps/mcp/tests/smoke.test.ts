/**
 * Public stdio boundary against the already loaded Loghub 2k samples. The
 * SDK owns framing and validates advertised output schemas after tools/list;
 * parser errors therefore also detect pnpm banners or operational logs on
 * stdout. No Claude client or model credentials are needed.
 */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import {
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry } from "@workspace/analytics/registry"
import { toolErrorSchema } from "@workspace/domain/errors"
import { receiptSchema } from "@workspace/domain/receipt"
import { toolResultSchema } from "@workspace/domain/tool"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

const run = promisify(execFile)
const root = findWorkspaceRoot()
const envFile = join(root, ".env")
if (existsSync(envFile)) process.loadEnvFile(envFile)

const defaultToolNames = [
  "describe_corpus",
  "search_logs",
  "get_log_context",
  "count_events",
  "event_trend",
  "recurring_patterns",
  "latency_stats",
  "check_claims",
]

const resultSchema = toolResultSchema(z.unknown())
const desktopConfigSchema = z.strictObject({
  mcpServers: z.strictObject({
    "log-insights": z.strictObject({
      command: z.string(),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()).optional(),
    }),
  }),
})

type Session = Awaited<ReturnType<typeof startSession>>

let receiptDir: string
let foreignDir: string
let session: Session

beforeAll(async () => {
  receiptDir = await mkdtemp(join(tmpdir(), "mcp-receipts-"))
  foreignDir = await mkdtemp(join(tmpdir(), "mcp-foreign-cwd-"))
  session = await startSession({
    env: samplesEnv({ LOG_INSIGHTS_RECEIPTS_DIR: receiptDir }),
  })
})

afterAll(async () => {
  if (session !== undefined) await session.client.close()
  if (receiptDir !== undefined)
    await rm(receiptDir, { recursive: true, force: true })
  if (foreignDir !== undefined)
    await rm(foreignDir, { recursive: true, force: true })
})

function samplesEnv(overrides: Record<string, string> = {}) {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value
  }
  // Each process is pointed at the samples explicitly; never reload or alter
  // the full corpus as part of a transport test.
  delete env.LOG_INSIGHTS_RECEIPTS_DIR
  return {
    ...env,
    SERENEDB_DATABASE: "log_insights_samples",
    LOG_INSIGHTS_WORKSPACE_TOOLS: "0",
    ...overrides,
  }
}

async function startSession(options: Partial<StdioServerParameters> = {}) {
  const protocolErrors: Error[] = []
  const client = new Client({ name: "log-insights-smoke", version: "1.0.0" })
  const transport = new StdioClientTransport({
    command: "pnpm",
    args: ["--dir", root, "--silent", "mcp"],
    cwd: root,
    env: samplesEnv(),
    stderr: "pipe",
    ...options,
  })
  // The SDK exposes protocol callbacks rather than an EventTarget API.
  Object.assign(client, {
    onerror: (error: Error) => protocolErrors.push(error),
  })
  try {
    await client.connect(transport)
  } catch (error) {
    await client.close()
    throw error
  }
  return { client, protocolErrors }
}

function canonicalTools() {
  return createRegistry({
    db: {
      timeoutMs: 10_000,
      query() {
        throw new Error("Catalog inspection must not query the database.")
      },
    },
    receipts: new FileReceiptStore(receiptDir),
    log: () => undefined,
  }).tools
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
) {
  return CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args })
  )
}

function textContent(result: z.infer<typeof CallToolResultSchema>) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

async function readJsonResource(client: Client, uri: string) {
  const resource = await client.readResource({ uri })
  expect(resource.contents).toHaveLength(1)
  const content = resource.contents[0]
  if (content === undefined || !("text" in content))
    throw new Error(`Expected a text resource at ${uri}.`)
  expect(content.uri).toBe(uri)
  expect(content.mimeType).toBe("application/json")
  return JSON.parse(content.text) as unknown
}

describe("MCP stdio smoke against Loghub 2k samples", () => {
  it("advertises exactly the canonical eight tools and draft-7 contracts", async () => {
    const listed = await session.client.listTools()
    expect(listed.nextCursor).toBeUndefined()
    expect(listed.tools.map((tool) => tool.name)).toEqual(defaultToolNames)
    for (const canonical of canonicalTools()) {
      const advertised = listed.tools.find(
        (tool) => tool.name === canonical.name
      )
      expect(advertised).toMatchObject({
        name: canonical.name,
        title: canonical.title,
        description: canonical.description,
        annotations: canonical.annotations,
      })
      expect(advertised?.inputSchema).toEqual(
        z.toJSONSchema(canonical.inputSchema, {
          target: "draft-7",
          io: "input",
        })
      )
      expect(advertised?.outputSchema).toEqual(
        z.toJSONSchema(canonical.outputSchema, {
          target: "draft-7",
          io: "output",
        })
      )
      expect(advertised?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      })
    }
    expect(session.protocolErrors).toEqual([])
  })

  it("lists the corpus resources and receipt URI template", async () => {
    const listed = await session.client.listResources()
    expect(listed.resources.map((resource) => resource.uri).toSorted()).toEqual(
      ["corpus://overview", "corpus://ownership", "corpus://schema"]
    )
    const templates = await session.client.listResourceTemplates()
    expect(
      templates.resourceTemplates.map((template) => template.uriTemplate)
    ).toEqual(["receipt://{id}"])
    expect(session.protocolErrors).toEqual([])
  })

  it.each([
    {
      name: "describe_corpus",
      args: {},
      expected: {
        datasets: [
          { dataset: "bgl", events: 2000 },
          { dataset: "openstack", events: 2000 },
        ],
      },
      truncated: false,
    },
    {
      name: "search_logs",
      args: { query: "parity", dataset: "bgl", limit: 1 },
      // Independently counted from BGL_2k.log: 48 parity messages.
      expected: { total_matches: 48, truncated: true, row_limit: 1 },
      truncated: true,
    },
  ])(
    "$name returns validated structured results, cited text and readable stored receipts",
    async ({ name, args, expected, truncated }) => {
      const wire = await callTool(session.client, name, args)
      expect(wire.isError).not.toBe(true)
      const canonical = canonicalTools().find((tool) => tool.name === name)
      if (canonical === undefined)
        throw new Error(`Missing canonical tool ${name}.`)
      expect(
        canonical.outputSchema.safeParse(wire.structuredContent).success
      ).toBe(true)
      const result = resultSchema.parse(wire.structuredContent)
      const text = textContent(wire)
      expect(text).toContain(result.receipt.receipt_id)
      expect(text).toMatch(/truncated/i)
      expect(result.facts.length).toBeGreaterThan(0)
      expect(result.facts.some((fact) => text.includes(fact.id))).toBe(true)
      const stored = receiptSchema.parse(
        JSON.parse(
          await readFile(
            join(receiptDir, `${result.receipt.receipt_id}.json`),
            "utf8"
          )
        )
      )
      expect(stored.client).toBe("mcp")
      expect(stored.tool).toBe(name)
      expect(stored.result).toEqual(result.data)
      expect(stored.facts).toEqual(result.facts)
      expect(
        await readJsonResource(session.client, `receipt://${stored.receipt_id}`)
      ).toEqual(stored)
      expect(result.data).toMatchObject(expected)
      expect(result.receipt.truncated).toBe(truncated)
      expect(session.protocolErrors).toEqual([])
    }
  )

  it("returns invalid input as an actionable tool error and stays connected", async () => {
    const result = await callTool(session.client, "search_logs", {
      query: "parity",
      limit: 0,
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(
      toolErrorSchema.parse(JSON.parse(textContent(result)))
    ).toMatchObject({
      code: "invalid_input",
      hint: "Correct the listed fields and call the tool again.",
      issues: [{ path: "limit", message: expect.any(String) }],
    })
    expect((await session.client.listTools()).tools).toHaveLength(8)
    expect(session.protocolErrors).toEqual([])
  })

  it("keeps the optional workspace tools absent until their implementation", async () => {
    const workspace = await startSession({
      env: samplesEnv({
        LOG_INSIGHTS_RECEIPTS_DIR: receiptDir,
        LOG_INSIGHTS_WORKSPACE_TOOLS: "1",
      }),
    })
    try {
      expect(
        (await workspace.client.listTools()).tools.map((tool) => tool.name)
      ).toEqual(defaultToolNames)
      expect(workspace.protocolErrors).toEqual([])
    } finally {
      await workspace.client.close()
    }
  })

  it("launches the root command from a foreign directory and stores receipts at the repository", async () => {
    const foreign = await startSession({ cwd: foreignDir })
    let receiptId: string | undefined
    try {
      const result = resultSchema.parse(
        (await callTool(foreign.client, "describe_corpus", {}))
          .structuredContent
      )
      receiptId = result.receipt.receipt_id
      expect(
        receiptSchema.parse(
          JSON.parse(
            await readFile(
              join(root, ".data", "receipts", `${receiptId}.json`),
              "utf8"
            )
          )
        ).result
      ).toEqual(result.data)
      expect(
        existsSync(join(foreignDir, ".data", "receipts", `${receiptId}.json`))
      ).toBe(false)
      expect(foreign.protocolErrors).toEqual([])
    } finally {
      await foreign.client.close()
      if (receiptId !== undefined)
        await rm(join(root, ".data", "receipts", `${receiptId}.json`), {
          force: true,
        })
    }
  })

  it("prints a desktop configuration that starts with absolute paths from a foreign directory", async () => {
    const { stdout } = await run(
      "pnpm",
      ["--dir", root, "--silent", "mcp:desktop-config"],
      {
        cwd: foreignDir,
        env: samplesEnv(),
      }
    )
    const config = desktopConfigSchema.parse(JSON.parse(stdout)).mcpServers[
      "log-insights"
    ]
    expect(isAbsolute(config.command)).toBe(true)
    expect(config.args).toContain(`--env-file-if-exists=${envFile}`)
    expect(
      config.args.some(
        (arg) => isAbsolute(arg) && arg.endsWith("/tsx/dist/cli.mjs")
      )
    ).toBe(true)
    expect(config.args).toContain(join(root, "apps", "mcp", "src", "server.ts"))
    const desktop = await startSession({
      command: config.command,
      args: config.args,
      cwd: foreignDir,
      env: {
        ...samplesEnv({ LOG_INSIGHTS_RECEIPTS_DIR: receiptDir }),
        ...config.env,
      },
    })
    try {
      expect((await desktop.client.listTools()).tools).toHaveLength(8)
      expect(
        resultSchema.safeParse(
          (await callTool(desktop.client, "describe_corpus", {}))
            .structuredContent
        ).success
      ).toBe(true)
      expect(desktop.protocolErrors).toEqual([])
    } finally {
      await desktop.client.close()
    }
  })
})
