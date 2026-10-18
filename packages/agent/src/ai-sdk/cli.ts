import { parseArgs } from "node:util"
import { pathToFileURL } from "node:url"

import { EFFORT_LEVELS, type Effort } from "./model.ts"

/**
 * CLI skeleton (technical.md § 11.1 "CLI"): `agent:ask`. A later stage wires
 * `runInvestigation`; this stage parses the arguments, validates the
 * environment and the inputs, and exits with a clear message and a non-zero
 * code when `ANTHROPIC_API_KEY` is missing.
 *
 * stdout carries only the final answer and the run record path; every
 * diagnostic goes to stderr, so stdout stays machine-consumable for probes and
 * the eval runner.
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
 * The CLI entry. Returns the process exit code; it does not call
 * `process.exit`, so it stays testable. Diagnostics go to `stderr`, results to
 * `stdout`.
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

  // `runInvestigation` is wired in a later stage (after domain/answer exists).
  // Until then the CLI validates everything and reports that the agent loop is
  // not yet wired, rather than pretending to answer.
  stderr(
    `agent:ask ready: role=${args.role} variant=${args.variant} effort=${args.effort}.`
  )
  stderr(
    "runInvestigation is not wired yet in this build; this is the LOG-48 first-half skeleton."
  )
  return 0
}

const entrypoint = process.argv[1]
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = runCli(process.argv.slice(2))
}
