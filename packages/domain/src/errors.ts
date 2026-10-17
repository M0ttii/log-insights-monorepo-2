import { z } from "zod"

/**
 * Expected tool failures (technical.md § 8.4). Every variant carries an English
 * `message` and a `hint` the model can act on; MCP maps them to tool results
 * with `isError: true` (not protocol errors), the web chat to a tool error
 * state. Raw database errors, stacks and SQL never appear in either text.
 */

const issueSchema = z.strictObject({
  path: z
    .string()
    .describe(
      "Dotted path of the offending input field; empty for the whole input."
    ),
  message: z.string(),
})

export type InputIssue = z.infer<typeof issueSchema>

const base = {
  message: z.string().describe("What went wrong, in one sentence."),
  hint: z.string().describe("How to change the call so it succeeds."),
}

export const toolErrorSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("invalid_input"),
    ...base,
    issues: z.array(issueSchema),
  }),
  z.strictObject({
    code: z.literal("not_found"),
    ...base,
    resource: z.enum(["event", "receipt", "pattern"]),
    id: z.string(),
  }),
  z.strictObject({
    code: z.literal("query_timeout"),
    ...base,
    timeout_ms: z.number().int().positive(),
  }),
  z.strictObject({ code: z.literal("db_unavailable"), ...base }),
  z.strictObject({ code: z.literal("receipt_unavailable"), ...base }),
  z.strictObject({
    code: z.literal("limit_exceeded"),
    ...base,
    limit: z.number().int().nonnegative(),
    requested: z.number().int().nonnegative().nullable(),
  }),
])

export type ToolError = z.infer<typeof toolErrorSchema>

export type ToolErrorCode = ToolError["code"]

/** Compile-time exhaustiveness check for switches over unions. */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`)
}

const RETRY_HINT = "Correct the listed fields and call the tool again."

export function invalidInput(
  issues: InputIssue[],
  hint: string = RETRY_HINT
): ToolError {
  const first = issues[0]
  const message =
    first === undefined
      ? "The input is invalid."
      : `Invalid input${first.path === "" ? "" : ` at ${first.path}`}: ${first.message}${
          issues.length > 1 ? ` (+${issues.length - 1} more)` : ""
        }`
  return { code: "invalid_input", message, hint, issues }
}

export function notFound(
  resource: "event" | "receipt" | "pattern",
  id: string
): ToolError {
  const hints = {
    event: "Use an event_id returned by search_logs or another tool.",
    receipt:
      "Use a receipt ID (r_ + 8 hex digits) returned by a tool in this session.",
    pattern:
      "Use a pattern_id returned by recurring_patterns or count_events grouped by pattern.",
  } as const
  return {
    code: "not_found",
    message: `No ${resource} with ID ${id}.`,
    hint: hints[resource],
    resource,
    id,
  }
}

export function queryTimeout(timeoutMs: number): ToolError {
  return {
    code: "query_timeout",
    message: `The query did not finish within ${timeoutMs} ms and was cancelled.`,
    hint: "Narrow the time range, add a dataset or component filter, or use a coarser grouping.",
    timeout_ms: timeoutMs,
  }
}

export function dbUnavailable(): ToolError {
  return {
    code: "db_unavailable",
    message: "The SereneDB database is not reachable.",
    hint: "Do not retry immediately; tell the user the corpus database is unavailable (docker compose up).",
  }
}

export function receiptUnavailable(): ToolError {
  return {
    code: "receipt_unavailable",
    message: "The query receipt could not be stored, so no result is returned.",
    hint: "Results without a stored receipt are not delivered; tell the user and do not cite numbers.",
  }
}

export function limitExceeded(
  what: string,
  limit: number,
  requested: number | null
): ToolError {
  return {
    code: "limit_exceeded",
    message: `${what} exceeds the limit of ${limit}${requested === null ? "" : ` (requested ${requested})`}.`,
    hint: "Narrow the scope or choose a coarser setting so the result stays within the limit.",
    limit,
    requested,
  }
}

/** One line for text channels (MCP text block, logs without payloads). */
export function formatToolError(error: ToolError): string {
  switch (error.code) {
    case "invalid_input":
    case "not_found":
    case "query_timeout":
    case "db_unavailable":
    case "receipt_unavailable":
    case "limit_exceeded":
      return `${error.code}: ${error.message} Hint: ${error.hint}`
    default:
      return assertNever(error)
  }
}

/** Dotted path with array indices in brackets: `claims[2].fact`. */
export function formatIssuePath(path: readonly PropertyKey[]): string {
  let out = ""
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`
    else out += out === "" ? String(key) : `.${String(key)}`
  }
  return out
}

/**
 * Turns a failed schema parse into `invalid_input` with field paths and a
 * correction hint. Unknown fields name the accepted ones, because strict
 * schemas reject rather than ignore them (§ 8.1).
 */
export function fromZodError(
  error: z.ZodError,
  acceptedFields?: readonly string[]
): ToolError {
  const issues: InputIssue[] = []
  const unknown: string[] = []
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const path = formatIssuePath([...issue.path, key])
        unknown.push(path)
        issues.push({ path, message: "Unsupported field." })
      }
    } else {
      issues.push({ path: formatIssuePath(issue.path), message: issue.message })
    }
  }
  if (unknown.length === 0) return invalidInput(issues)
  const accepted =
    acceptedFields === undefined
      ? ""
      : ` Accepted fields: ${acceptedFields.join(", ")}.`
  return invalidInput(
    issues,
    `Remove ${unknown.join(", ")}; this tool does not support it.${accepted}`
  )
}
