import "server-only"

import {
  CHAT_DISABLED_MESSAGE,
  ChatDisabledError,
  gateFindingsSchema,
  investigationInputSchema,
  investigationRoleSchema,
  resolveModel,
  runIdSchema,
  runInvestigation,
  runStatusSchema,
  runUsageSchema,
  type InvestigationDeps,
  type InvestigationInput,
  type RunRecord,
} from "@workspace/agent/ai-sdk"
import {
  filterSchema,
  validateFilter,
  type Filter,
} from "@workspace/domain/filters"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import {
  createUIMessageStreamResponse,
  safeValidateUIMessages,
  type ModelMessage,
  type UIMessage,
} from "ai"
import { z } from "zod"

import { runtime } from "./runtime"
import { sameOrigin } from "./http"

const MAX_BODY_BYTES = 1_048_576
const MAX_HISTORY_TEXT_BYTES = 128_000
const questionSchema = investigationInputSchema.shape.question

// The transport adds its chat id and trigger; model options and instruction
// channels are deliberately absent. Scope uses the composer's shared Filter.
const requestSchema = z.strictObject({
  id: z.string().min(1).max(128).optional(),
  trigger: z.literal("submit-message").optional(),
  messageId: z.string().min(1).max(128).optional(),
  role: investigationRoleSchema,
  scope: filterSchema.optional(),
  messages: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(128),
        role: z.enum(["user", "assistant"]),
        metadata: z.unknown().optional(),
        parts: z.array(z.unknown()).max(128),
      })
    )
    .min(1)
    .max(40),
})

const dataSchemas = {
  phase: z.strictObject({
    kind: z.enum(["preflight", "investigate", "answer", "revise"]),
    draft: z.enum(["draft", "final"]),
    requirement: z.string().min(1).max(1000).optional(),
  }),
  gate: z.strictObject({
    version: z.enum(["draft", "final"]),
    findings: gateFindingsSchema,
  }),
  run: z.strictObject({
    run_id: runIdSchema,
    status: runStatusSchema,
    duration_ms: z.number().nonnegative(),
    usage: runUsageSchema,
  }),
}

type ChatDependencies = {
  getRuntime: () => Pick<InvestigationDeps, "registry" | "playbooks" | "runs">
  getModel: typeof resolveModel
  investigate: typeof runInvestigation
}

const defaults: ChatDependencies = {
  getRuntime: runtime,
  getModel: resolveModel,
  investigate: runInvestigation,
}

export function chatAvailability(
  env: Record<string, string | undefined> = process.env
) {
  const available = Boolean(env.ANTHROPIC_API_KEY?.trim())
  return {
    available,
    disabledMessage: available ? undefined : CHAT_DISABLED_MESSAGE,
  }
}

class ChatInputError extends Error {}
class BodyLimitError extends Error {}

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new ChatInputError()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      throw new BodyLimitError()
    }
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new ChatInputError()
  }
}

function textMessage(message: UIMessage): UIMessage {
  // User files, tool calls, provider metadata and data parts have no authority.
  if (message.parts.some((part) => part.type !== "text"))
    throw new ChatInputError()
  const text = messageText(message).trim()
  const parsed = questionSchema.safeParse(text)
  if (!parsed.success) throw new ChatInputError()
  return {
    id: message.id,
    role: "user",
    parts: [{ type: "text", text: parsed.data }],
  }
}

function messageText(message: UIMessage): string {
  return message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
}

async function trustedHistory(
  messages: UIMessage[],
  runs: InvestigationDeps["runs"],
  configuration: {
    role: InvestigationInput["role"]
    modelId: string
    guidanceVersion: string
  }
) {
  const history: UIMessage[] = []
  let modelHistory: ModelMessage[] | undefined
  let precedingQuestion: string | null = null
  let textSize = 0
  for (const message of messages) {
    let trusted: UIMessage | null = null
    if (message.role === "user") {
      trusted = textMessage(message)
      precedingQuestion = messageText(trusted)
      if (modelHistory) {
        modelHistory = [
          ...modelHistory,
          { role: "user", content: precedingQuestion },
        ]
      }
    } else {
      // A later assistant boundary supersedes an earlier prefix. Until this
      // turn supplies its own compatible record, fall back to the accumulated
      // safe text so a legacy, changed-config or untrusted turn cannot vanish.
      modelHistory = undefined
      // The browser may edit any part, including tool outputs. Only a local
      // completed playbook record can supply assistant text to the model.
      const runParts = message.parts.filter((part) => part.type === "data-run")
      if (runParts.length === 1) {
        const part = runParts[0]
        const reference =
          part && "data" in part ? dataSchemas.run.safeParse(part.data) : null
        if (reference?.success) {
          const record = await runs.get(reference.data.run_id)
          if (
            record?.status === "completed" &&
            record.run_id === reference.data.run_id &&
            record.variant === "playbook" &&
            record.question === precedingQuestion &&
            record.final_text !== null
          ) {
            trusted = {
              id: message.id,
              role: "assistant",
              parts: [{ type: "text", text: record.final_text }],
            }
            if (
              record.model_history?.length &&
              record.role.requested === configuration.role &&
              record.model_id === configuration.modelId &&
              record.guidance_version === configuration.guidanceVersion &&
              record.contract_version === CONTRACT_VERSION
            ) {
              // The record already contains every earlier turn, draft, tool
              // result and signed thinking block. Replace our candidate prefix
              // rather than appending it to an older restored conversation.
              modelHistory = record.model_history
            }
          }
        }
      }
    }
    if (trusted) {
      textSize += Buffer.byteLength(messageText(trusted), "utf8")
      if (textSize > MAX_HISTORY_TEXT_BYTES) throw new ChatInputError()
      history.push(trusted)
    }
  }
  // Older records and changed role/model/playbooks retain the safe text-only
  // fallback; their thinking signatures cannot share the new system prefix.
  return { ui: history, model: modelHistory }
}

function agentScope(scope: Filter | undefined): InvestigationInput["scope"] {
  if (scope === undefined) return undefined
  const { dataset, from, to, ...filters } = scope
  return { dataset, from, to, filters }
}

function failure(status: number, code: string, message: string, hint: string) {
  return Response.json(
    { ok: false, error: { code, message, hint } },
    { status, headers: { "Cache-Control": "no-store" } }
  )
}

export async function chatResponse(
  request: Request,
  deps: ChatDependencies = defaults
): Promise<Response> {
  if (!sameOrigin(request)) return new Response(null, { status: 403 })
  try {
    const parsed = requestSchema.safeParse(await readBody(request))
    if (!parsed.success) throw new ChatInputError()
    const input = parsed.data
    if (input.scope && validateFilter(input.scope)) throw new ChatInputError()
    if (
      new Set(input.messages.map((message) => message.id)).size !==
      input.messages.length
    )
      throw new ChatInputError()
    const validated = await safeValidateUIMessages({
      messages: input.messages,
      dataSchemas,
    })
    if (!validated.success) throw new ChatInputError()
    const current = validated.data.at(-1)
    if (!current || current.role !== "user") throw new ChatInputError()
    const question = messageText(textMessage(current))
    const model = deps.getModel()
    const { registry, playbooks, runs } = deps.getRuntime()
    const history = await trustedHistory(validated.data.slice(0, -1), runs, {
      role: input.role,
      modelId: model.modelId,
      guidanceVersion: playbooks.version,
    })
    const { stream, done } = deps.investigate(
      {
        question,
        role: input.role,
        scope: agentScope(input.scope),
        history: history.model ? undefined : history.ui,
        variant: "playbook",
      },
      {
        registry,
        playbooks,
        runs,
        model,
        history: history.model,
        callContext: (signal) => ({ client: "web", signal }),
      },
      request.signal
    )
    // The shared machine owns failures after streaming begins. Consume any
    // unexpected completion rejection without logging prompts or provider data.
    void done.catch(() => undefined)
    return createUIMessageStreamResponse({
      stream,
      headers: { "Cache-Control": "no-store" },
    })
  } catch (error) {
    if (error instanceof BodyLimitError)
      return failure(
        413,
        "limit_exceeded",
        "The conversation is too large.",
        "Start a new investigation; requests are limited to 1 MiB."
      )
    if (error instanceof ChatInputError)
      return failure(
        400,
        "invalid_input",
        "Invalid chat request.",
        "Send up to 40 valid messages, a question of 1–4000 characters, a role and a valid structured scope."
      )
    if (error instanceof ChatDisabledError)
      return failure(
        503,
        "chat_disabled",
        CHAT_DISABLED_MESSAGE,
        "Set ANTHROPIC_API_KEY in the repository .env to enable chat."
      )
    return failure(
      503,
      "chat_unavailable",
      "The investigation could not be started.",
      "Check the server configuration and try again."
    )
  }
}

/** Explicit export allowlist: local run records also contain server prompts. */
export function publicRunMetadata(record: RunRecord) {
  return {
    run_id: record.run_id,
    started_at: record.started_at,
    model_id: record.model_id,
    guidance_version: record.guidance_version,
    contract_version: record.contract_version,
    data_version: record.data_version,
    role: record.role,
    status: record.status,
    duration_ms: record.duration_ms,
    usage: record.usage,
  }
}
