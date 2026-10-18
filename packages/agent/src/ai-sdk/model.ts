import { createAnthropic } from "@ai-sdk/anthropic"
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic"
import type { LanguageModel } from "ai"

/**
 * One place for the model and the Claude provider options (technical.md § 11.1,
 * "Modell und Claude-Optionen"). The phase machine (a later stage) reads
 * `model` and `providerOptions` from here and never assembles them itself, so
 * the cache prefix (instructions + tools) stays byte-stable across a run.
 *
 * The exact Anthropic option names were read from the installed packages, not
 * from the spec:
 * - `thinking: { type: "adaptive", display }` and `effort`
 *   (node_modules/@ai-sdk/anthropic/dist/index.d.ts, `anthropicLanguageModelOptions`).
 * - `cacheControl: { type: "ephemeral", ttl: "1h" }` (same file).
 * - `fallbacks: "default"` (same file).
 * - `display: "updates" | "summarized" | "omitted"` inside the adaptive
 *   thinking union (same file); 4.0.82 passes `"updates"` through, so we use it.
 */

/** Effort levels the installed @ai-sdk/anthropic 4.0.82 accepts. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const

export type Effort = (typeof EFFORT_LEVELS)[number]

/** Default model: the jury model (concept O-01, technical.md § 11). */
export const DEFAULT_MODEL_ID = "claude-opus-5-5"

/**
 * Default effort is `high`: Opus 5.5's own default is `medium`, and the eval
 * measures `medium` against `high` (technical.md § 11.1).
 */
export const DEFAULT_EFFORT: Effort = "high"

/** Message raised when the key is missing; the chat is disabled, not crashed. */
export const CHAT_DISABLED_MESSAGE =
  "Chat disabled: ANTHROPIC_API_KEY is not set"

/** Thrown when a model is requested without an API key present. */
export class ChatDisabledError extends Error {
  constructor() {
    super(CHAT_DISABLED_MESSAGE)
    this.name = "ChatDisabledError"
  }
}

export type ModelOptions = {
  /** Overrides the env; an empty string means "use the default model id". */
  modelId?: string
  effort?: Effort
  /**
   * Inject a ready `LanguageModel` (the AI SDK mock in tests). When given, no
   * API key is required and no provider is created.
   */
  model?: LanguageModel
  /** Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>
}

export type ModelConfig = {
  model: LanguageModel
  providerOptions: { anthropic: AnthropicProviderOptions }
  modelId: string
  effort: Effort
}

/** `LOG_INSIGHTS_MODEL` with an empty string treated as "unset". */
function resolveModelId(
  override: string | undefined,
  env: Record<string, string | undefined>
): string {
  const candidate = override ?? env.LOG_INSIGHTS_MODEL
  return candidate === undefined || candidate === ""
    ? DEFAULT_MODEL_ID
    : candidate
}

/**
 * Builds the Claude provider options: adaptive thinking (always on for Opus
 * 5.5), the configured effort, prompt caching with a 1 h TTL as the breakpoint
 * after tools + instructions, and `fallbacks: "default"` so a refusal surfaces
 * as its own state rather than a hard error. No forced tool choice is set here
 * (Opus 5.5 rejects `tool_choice: any`/`tool`, technical.md § 11.1); callers
 * leave `toolChoice` at the SDK default.
 */
function buildProviderOptions(effort: Effort): {
  anthropic: AnthropicProviderOptions
} {
  return {
    anthropic: {
      thinking: { type: "adaptive", display: "updates" },
      effort,
      cacheControl: { type: "ephemeral", ttl: "1h" },
      fallbacks: "default",
    },
  }
}

/**
 * Resolves the model and provider options.
 *
 * The missing-key check runs here, when the model is created, never at import
 * time: importing this module must not throw, so the web overview, logs and
 * receipts keep working without a key (technical.md § 11, O-01). A model
 * injected through `options.model` (tests) skips the key check and the
 * provider entirely.
 *
 * We set no `maxRetries` here and leave the SDK default in force: the spec
 * requires no retries beyond the SDK default, and invalid input or timeouts
 * must not be retried without narrowing (AGENTS.md "Model calls",
 * technical.md § 11.1). The phase machine owns `maxRetries` if it ever needs a
 * bounded value; this module does not widen it.
 */
export function resolveModel(options: ModelOptions = {}): ModelConfig {
  const env = options.env ?? process.env
  const effort = options.effort ?? DEFAULT_EFFORT
  const modelId = resolveModelId(options.modelId, env)
  const providerOptions = buildProviderOptions(effort)

  if (options.model !== undefined) {
    return { model: options.model, providerOptions, modelId, effort }
  }

  const apiKey = env.ANTHROPIC_API_KEY
  if (apiKey === undefined || apiKey === "") throw new ChatDisabledError()

  const anthropic = createAnthropic({ apiKey })
  return { model: anthropic(modelId), providerOptions, modelId, effort }
}
