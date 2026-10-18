import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"

import { loadConfig } from "@workspace/analytics/config"
import { createDatabase } from "@workspace/analytics/db"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry } from "@workspace/analytics/registry"

import { loadPlaybooks } from "../playbooks.ts"

import { baselineRegistryGuidance } from "./baseline.ts"
import {
  runInvestigation,
  type InvestigationUIMessage,
} from "./investigation.ts"
import { EFFORT_LEVELS, resolveModel, type Effort } from "./model.ts"
import { FileRunStore, resolveRunsDir, type RunRecord } from "./run-record.ts"

import type { CallContext } from "@workspace/analytics/registry"
import { readUIMessageStream } from "ai"

/**
 * CLI `agent:ask` (technical.md § 11.1 "CLI"): for samples and the eval runner.
 * It prints the final answer and the run-record path on stdout, and every
 * diagnostic (phases, tools, the verification line) on stderr, so stdout stays
 * machine-consumable. A missing `ANTHROPIC_API_KEY` disables the chat with a
 * clear message and a non-zero exit (O-01); the pool is closed at the end.
 *
 * `runCli` stays synchronous and side-effect-free beyond its writers: it parses
 * and validates the arguments and the key, and is what the unit tests drive.
 * `main` does the real run (build the registry like apps/mcp, consume the
 * stream, write the record) and is what the entrypoint calls.
 */

const ROLES = ["engineer", "team_lead", "manager", "auto"] as const
type Role = (typeof ROLES)[number]

const VARIANTS = ["playbook", "baseline"] as const
type Variant = (typeof VARIANTS)[number]

export type CliArgs = {
  role: Role
  variant: Variant
  effort: Effort
  question: string
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CliUsageError"
  }
}

const USAGE =
  'Usage: agent:ask --role engineer|team_lead|manager|auto [--variant playbook|baseline] [--effort low|medium|high|xhigh|max] "<question>"'

/** Parses argv into validated CLI args; throws `CliUsageError` on bad input. */
export function parseCliArgs(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        role: { type: "string", default: "auto" },
        variant: { type: "string", default: "playbook" },
        effort: { type: "string", default: "high" },
      },
    })
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error ? error.message : String(error)
    )
  }

  const { values, positionals } = parsed
  const role = values.role as string
  const variant = values.variant as string
  const effort = values.effort as string

  if (!ROLES.includes(role as Role))
    throw new CliUsageError(`--role must be one of ${ROLES.join(", ")}.`)
  if (!VARIANTS.includes(variant as Variant))
    throw new CliUsageError(`--variant must be one of ${VARIANTS.join(", ")}.`)
  if (!EFFORT_LEVELS.includes(effort as Effort))
    throw new CliUsageError(
      `--effort must be one of ${EFFORT_LEVELS.join(", ")}.`
    )

  const question = positionals.join(" ").trim()
  if (question === "")
    throw new CliUsageError("A question is required as a positional argument.")

  return {
    role: role as Role,
    variant: variant as Variant,
    effort: effort as Effort,
    question,
  }
}

/**
 * Validates argv and the environment and returns a process exit code without
 * running the model. Diagnostics go to `stderr`, results to `stdout`. It does
 * not call `process.exit`, so it stays testable. The real run lives in `main`.
 */
export function runCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  stdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  stderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): number {
  let args: CliArgs
  try {
    args = parseCliArgs(argv)
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error))
    stderr(USAGE)
    return 2
  }

  const apiKey = env.ANTHROPIC_API_KEY
  if (apiKey === undefined || apiKey === "") {
    stderr(
      "Chat disabled: ANTHROPIC_API_KEY is not set. Set it in the repository .env to run a query."
    )
    return 1
  }

  stderr(
    `agent:ask ready: role=${args.role} variant=${args.variant} effort=${args.effort}.`
  )
  return 0
}

/**
 * The real run: builds the registry the way `apps/mcp` does, runs
 * `runInvestigation`, consumes the stream to completion, prints the final
 * answer and the run-record path on stdout, the diagnostics on stderr, and
 * closes the pool at the end. Returns the process exit code.
 *
 * Client value: the `CallContext` client enum is `mcp | web | eval | test`
 * (domain/receipt.ts) — there is no `cli`. The CLI is the sample/eval entry per
 * § 11.1 ("für Proben und den Eval-Runner"), so it reuses `eval`, the closest
 * allowed value, rather than widening the contract enum (which would ripple
 * through the receipt schema, its JSON snapshot and CONTRACT_VERSION). Documented
 * here and in the final report.
 */
export async function main(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  stdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  stderr: (line: string) => void = (line) => process.stderr.write(`${line}\n`)
): Promise<number> {
  let args: CliArgs
  try {
    args = parseCliArgs(argv)
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error))
    stderr(USAGE)
    return 2
  }

  const apiKey = env.ANTHROPIC_API_KEY
  if (apiKey === undefined || apiKey === "") {
    stderr(
      "Chat disabled: ANTHROPIC_API_KEY is not set. Set it in the repository .env to run a query."
    )
    return 1
  }

  let config: ReturnType<typeof loadConfig>
  try {
    config = loadConfig(env)
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error))
    return 1
  }

  const db = createDatabase(config.connection)
  const playbooks = loadPlaybooks()
  const receipts = new FileReceiptStore(config.receiptsDir)
  // The baseline uses a registry whose describe_corpus guidance is the baseline
  // guidance (no playbook summaries, § 13.2); the playbook variant uses the
  // real playbook guidance.
  const roleGuidance =
    args.variant === "baseline"
      ? baselineRegistryGuidance(playbooks.version)
      : playbooks.guidance
  const registry = createRegistry({
    db,
    receipts,
    workspaceTools: config.workspaceTools,
    roleGuidance,
  })
  const runsStore = new FileRunStore(resolveRunsDir(env))

  const controller = new AbortController()
  const onSignal = () => controller.abort(new Error("interrupted"))
  process.once("SIGINT", onSignal)
  process.once("SIGTERM", onSignal)

  try {
    const model = resolveModel({ effort: args.effort, env })
    const { stream, done } = runInvestigation(
      {
        question: args.question,
        role: args.role,
        variant: args.variant,
      },
      {
        registry,
        playbooks: {
          version: playbooks.version,
          instructions: playbooks.instructions,
          systemPrompt: playbooks.systemPrompt,
        },
        runs: runsStore,
        model,
        callContext: (signal): CallContext => ({ client: "eval", signal }),
      },
      controller.signal
    )

    const finalText = await consumeStream(stream, stderr)
    const record = await done

    if (finalText !== null && finalText !== "") stdout(finalText)
    else stdout("(no answer produced)")
    stdout(`run record: ${resolveRunsDir(env)}/${record.run_id}.json`)
    stderr(verificationDiagnostics(record))
    return record.status === "completed" ? 0 : 1
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error))
    return 1
  } finally {
    process.off("SIGINT", onSignal)
    process.off("SIGTERM", onSignal)
    await db.dispose().catch(() => undefined)
  }
}

/**
 * Consumes the UI message stream to completion, streaming phase and tool
 * diagnostics to stderr, and returns the final assistant text. Uses the SDK's
 * `readUIMessageStream` so partial parts assemble into the final message.
 */
async function consumeStream(
  stream: ReadableStream<unknown>,
  stderr: (line: string) => void
): Promise<string | null> {
  let finalText: string | null = null
  for await (const message of readUIMessageStream<InvestigationUIMessage>({
    stream: stream as ReadableStream<never>,
  })) {
    for (const part of message.parts) {
      if (part.type === "text") finalText = part.text
      else if (part.type === "data-phase")
        stderr(`phase: ${part.data.kind} (${part.data.draft})`)
      else if (part.type.startsWith("tool-")) {
        const tool = part as { type: string; toolName?: string; state?: string }
        if (tool.toolName !== undefined)
          stderr(
            `tool: ${tool.toolName}${tool.state ? ` (${tool.state})` : ""}`
          )
      } else if (part.type === "data-gate") {
        stderr(
          `gate (${part.data.version}): ${part.data.findings.length} finding(s)`
        )
      }
    }
  }
  return finalText
}

/** The verification line and status for stderr (ui-concept 4.3). */
function verificationDiagnostics(record: RunRecord): string {
  const lines = [`status: ${record.status}`]
  if (record.check_claims.length === 0) lines.push("verification: not verified")
  else
    for (const check of record.check_claims) {
      const summary = check.summary as { text?: string } | undefined
      lines.push(
        `verification ${check.receipt_id}: ${summary?.text ?? "checked"}`
      )
    }
  return lines.join("\n")
}

const entrypoint = process.argv[1]
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  void main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
      return code
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      )
      process.exitCode = 1
    })
}
