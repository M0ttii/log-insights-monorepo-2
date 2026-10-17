import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js"
import type { Registry } from "@workspace/analytics/registry"
import {
  readCorpusResource,
  type CorpusResourceName,
} from "@workspace/analytics/resources"
import { notFound } from "@workspace/domain/errors"
import { RECEIPT_ID_PATTERN } from "@workspace/domain/ids"
import type { ReceiptStore } from "@workspace/domain/tool"

import { toResourceError } from "./errors.ts"

const CORPUS_RESOURCES: readonly {
  name: CorpusResourceName
  title: string
  description: string
}[] = [
  {
    name: "overview",
    title: "Corpus overview",
    description:
      "Loaded datasets, event counts, UTC spans, valid filters, versions, limits and role guidance. Read first. Numbers retain their describe_corpus fact IDs and receipt.",
  },
  {
    name: "schema",
    title: "Corpus schema",
    description:
      "Available columns and their meanings per dataset, with corpus versions and the source describe_corpus receipt.",
  },
  {
    name: "ownership",
    title: "Fictional corpus ownership",
    description:
      "The fictional ownership table and observed unowned components. Numbers retain their describe_corpus fact IDs and receipt; teams do not represent real ownership.",
  },
]

export function registerResources(
  server: McpServer,
  registry: Registry,
  receipts: ReceiptStore
): void {
  for (const resource of CORPUS_RESOURCES) {
    server.registerResource(
      `corpus_${resource.name}`,
      `corpus://${resource.name}`,
      {
        title: resource.title,
        description: resource.description,
        mimeType: "application/json",
      },
      async (uri, { signal }) => {
        const outcome = await safelyRead(signal, () =>
          readCorpusResource(registry, resource.name, { client: "mcp", signal })
        )
        if (!outcome.ok) throw toResourceError(outcome.error)
        return jsonResource(uri, outcome.result)
      }
    )
  }

  server.registerResource(
    "receipt",
    new ResourceTemplate("receipt://{id}", { list: undefined }),
    {
      title: "Query receipt",
      description:
        "Full stored query receipt: validated input, exact SQL and parameters, scope, versions, result and original facts. Use an r_ + 8 lowercase hexadecimal digit ID returned by a tool.",
      mimeType: "application/json",
    },
    async (uri, variables, { signal }) => {
      signal.throwIfAborted()
      const id = variables.id
      // Validate before calling the store; malformed IDs never form a path.
      if (typeof id !== "string" || !RECEIPT_ID_PATTERN.test(id)) {
        throw toResourceError(
          notFound("receipt", typeof id === "string" ? id : "invalid")
        )
      }
      const receipt = await safelyRead(signal, () => receipts.get(id))
      if (receipt === null) throw toResourceError(notFound("receipt", id))
      return jsonResource(uri, receipt)
    }
  )
}

/** Resource reads have protocol errors, not tool-result isError envelopes. */
async function safelyRead<T>(
  signal: AbortSignal,
  read: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted()
  try {
    const result = await read()
    signal.throwIfAborted()
    return result
  } catch {
    signal.throwIfAborted()
    // Store, schema and database exceptions may contain paths or raw payloads.
    throw toResourceError()
  }
}

function jsonResource(uri: URL, value: unknown): ReadResourceResult {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  }
}
