import { execFileSync } from "node:child_process"
import { readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import {
  baselineRegistryGuidance,
  baselineRoleInstruction,
  DEFAULT_LIMITS,
  FileRunStore,
  resolveModel,
  runInvestigation,
  type RunRecord,
} from "@workspace/agent/ai-sdk"
import { loadPlaybooks } from "@workspace/agent/playbooks"
import { findWorkspaceRoot, loadConfig } from "@workspace/analytics/config"
import { createDatabase } from "@workspace/analytics/db"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry } from "@workspace/analytics/registry"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import {
  digest,
  exportAttempt,
  readArtifact,
  writeArtifact,
} from "./artifacts.ts"
import {
  EVAL_VERSION,
  loadQuestions,
  makePlan,
  manifestSchema,
  questionBankSchema,
  normalizeQuestionScope,
  type EvalManifest,
  type QuestionBank,
} from "./contracts.ts"
import { saveReport } from "./report.ts"
import {
  EXPERIMENT_LIMITS,
  experimentPlan,
  experimentProjection,
  OPUS_PRICING,
  REPEATED_QUESTIONS,
} from "./experiment.ts"
import { observeEvalRuntime } from "./holdout-runtime.ts"

// Released YAML is separately hash-bound input, never executable source. All
// other tracked/untracked source and dirty state remain part of the freeze.
function releasedQuestions(path: string): boolean {
  return /^packages\/evals\/questions\/holdout-[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}\.yaml$/.test(
    path
  )
}
function configurationSource(path: string): boolean {
  return (
    path !== "" &&
    !path.startsWith("packages/evals/results/") &&
    !path.startsWith("vendor/") &&
    !releasedQuestions(path)
  )
}

async function sourceVersion(
  root: string
): Promise<
  Pick<EvalManifest["versions"], "code_commit" | "code_dirty" | "code_sha256">
> {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" }
  )
    .split("\0")
    .filter(configurationSource)
    .toSorted()
  const files: Record<string, string> = {}
  for (const path of paths)
    files[path] = digest(await readFile(join(root, path), "utf8"))
  return {
    code_commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    code_dirty: execFileSync(
      "git",
      ["status", "--porcelain", "-z", "--untracked-files=all"],
      {
        cwd: root,
        encoding: "utf8",
      }
    )
      .split("\0")
      .filter(Boolean)
      .some((entry) => configurationSource(entry.slice(3))),
    code_sha256: digest(files),
  }
}
export async function createManifest(input: {
  round_id: string
  bank: QuestionBank
  data_version: string
  repeated: string[]
  root: string
  fixture?: boolean
  experiment?: boolean
}): Promise<EvalManifest> {
  const playbooks = loadPlaybooks()
  const instructions = {
    shared_rules: playbooks.sharedRules,
    playbook: {
      auto: playbooks.instructions,
      engineer: playbooks.systemPrompt("engineer"),
      team_lead: playbooks.systemPrompt("team_lead"),
      manager: playbooks.systemPrompt("manager"),
      registry_guidance: playbooks.guidance,
    },
    baseline: {
      auto: baselineRoleInstruction("auto"),
      engineer: baselineRoleInstruction("engineer"),
      team_lead: baselineRoleInstruction("team_lead"),
      manager: baselineRoleInstruction("manager"),
      registry_guidance: baselineRegistryGuidance(playbooks.version),
    },
    phase_source: await readFile(
      join(input.root, "packages/agent/src/ai-sdk/investigation.ts"),
      "utf8"
    ),
  }
  // No pool or connection: catalog construction never runs a query.
  const registry = createRegistry({
    db: {
      timeoutMs: 10_000,
      query: () => {
        throw new Error("Catalog only")
      },
    },
    receipts: {
      put: () => {
        throw new Error("Catalog only")
      },
      get: () => Promise.resolve(null),
      list: () => Promise.resolve([]),
    },
    log: () => undefined,
  })
  const tools = registry.catalog()
  return manifestSchema.parse({
    schema_version: EVAL_VERSION,
    round_id: input.round_id,
    created_at: new Date().toISOString(),
    split: input.fixture === true ? "fixture" : "development",
    fixture_only: input.fixture === true,
    versions: {
      ...(await sourceVersion(input.root)),
      questions_sha256: digest(input.bank),
      tools_sha256: digest(tools),
      prompts_sha256: digest(instructions),
      rubric_version: EVAL_VERSION,
      rubric_sha256: digest(
        await readFile(new URL("./evaluate.ts", import.meta.url), "utf8")
      ),
      data_version: input.data_version,
    },
    model: {
      id: "claude-opus-5-5",
      effort: "high",
      provider_options: {
        thinking: { type: "adaptive", display: "updates" },
        effort: "high",
        cacheControl: { type: "ephemeral", ttl: "1h" },
        fallbacks: "default",
      },
    },
    limits: {
      max_steps: DEFAULT_LIMITS.maxSteps,
      max_follow_ups: DEFAULT_LIMITS.maxFollowUps,
      max_revisions: 1,
      timeout_ms: DEFAULT_LIMITS.timeoutMs,
      max_retries: 0,
      output_limit: null,
      context_limit: null,
      ...(input.experiment === true
        ? {
            max_model_calls: EXPERIMENT_LIMITS.maxModelCalls,
            max_output_tokens: EXPERIMENT_LIMITS.maxOutputTokens,
            max_input_bytes: EXPERIMENT_LIMITS.maxInputBytes,
            output_limit: EXPERIMENT_LIMITS.maxOutputTokens,
          }
        : {}),
    },
    initial_history: "empty",
    pricing: input.experiment === true ? OPUS_PRICING : null,
    instructions,
    tool_catalog: tools,
    repeated_questions: input.repeated,
    attempts:
      input.experiment === true
        ? experimentPlan(input.bank)
        : makePlan(input.bank, input.repeated),
    ...(input.experiment === true
      ? {
          experiment: experimentProjection(
            experimentPlan(input.bank),
            input.bank
          ),
        }
      : {}),
  })
}
export async function runLiveRound(
  dir: string,
  dataVersion: string,
  signal: AbortSignal
): Promise<void> {
  await prepareRound(dir, dataVersion)
  await executeRound(dir, signal)
}

/** Saves the entire plan without reading credentials or touching a DB/provider. */
export async function prepareRound(
  dir: string,
  dataVersion: string
): Promise<EvalManifest> {
  if (!/^dv_[a-zA-Z0-9]+$/.test(dataVersion))
    throw new Error("An explicit current --data-version is required")
  const root = findWorkspaceRoot(),
    bank = await loadQuestions()
  const manifest = await createManifest({
    round_id: dir.split("/").filter(Boolean).at(-1) ?? "round",
    root,
    bank,
    data_version: dataVersion,
    repeated: REPEATED_QUESTIONS,
    experiment: true,
  })
  await mkdir(dir, { recursive: false })
  await writeArtifact(dir, "manifest.json", manifest)
  await writeArtifact(dir, "questions.json", bank)
  return manifest
}

/** Only this explicit operation can call the paid provider. No round resumes. */
export async function executeRound(
  dir: string,
  signal: AbortSignal
): Promise<void> {
  const root = findWorkspaceRoot()
  const manifest = manifestSchema.parse(
    await readArtifact(dir, "manifest.json")
  )
  const bank = questionBankSchema.parse(
    await readArtifact(dir, "questions.json")
  )
  if (manifest.fixture_only || manifest.experiment === undefined)
    throw new Error("A prepared LOG-53 development round is required")
  const current = await createManifest({
    round_id: manifest.round_id,
    bank,
    root,
    data_version: manifest.versions.data_version,
    repeated: REPEATED_QUESTIONS,
    experiment: true,
  })
  if (
    digest(bank) !== manifest.versions.questions_sha256 ||
    digest(current.versions) !== digest(manifest.versions) ||
    digest(current.attempts) !== digest(manifest.attempts) ||
    digest(current.instructions) !== digest(manifest.instructions) ||
    digest(current.tool_catalog) !== digest(manifest.tool_catalog) ||
    digest(current.model) !== digest(manifest.model) ||
    digest(current.limits) !== digest(manifest.limits) ||
    digest(current.pricing) !== digest(manifest.pricing) ||
    digest(current.experiment) !== digest(manifest.experiment)
  )
    throw new Error(
      "Prepared configuration changed; prepare a new versioned round"
    )
  const config = loadConfig(),
    playbooks = loadPlaybooks()
  const runtime = await observeEvalRuntime(join(dir, "runtime-receipts"))
  if (runtime.data_version !== manifest.versions.data_version)
    throw new Error("Observed corpus differs from the prepared data version")
  await writeArtifact(dir, "runtime.json", runtime)
  // Append-only execution marker prevents rerunning/cherry-picking attempts.
  await writeArtifact(dir, "execution.json", {
    started_at: new Date().toISOString(),
    manifest_sha256: digest(manifest),
    runtime_sha256: digest(runtime),
  })
  const db = createDatabase(config.connection),
    receipts = new FileReceiptStore(join(dir, "receipts"))
  try {
    for (const plan of manifest.attempts) {
      if (signal.aborted) break // Remaining planned attempts stay visibly missing.
      const question = bank.questions.find((q) => q.id === plan.question_id)
      if (question === undefined) throw new Error("Missing planned question")
      const started_at = new Date().toISOString(),
        start = performance.now()
      let record: RunRecord | null = null,
        errorKind: string | undefined
      try {
        const model = resolveModel({
          modelId: manifest.model.id,
          effort: plan.effort ?? "high",
        })
        const registry = createRegistry({
          db,
          receipts,
          workspaceTools: false,
          roleGuidance:
            plan.variant === "baseline"
              ? baselineRegistryGuidance(playbooks.version)
              : playbooks.guidance,
        })
        const { stream, done } = runInvestigation(
          {
            question: question.question,
            role: question.role ?? "auto",
            scope: normalizeQuestionScope(question),
            variant: plan.variant,
            history: [],
          },
          {
            registry,
            playbooks,
            runs: new FileRunStore(join(root, ".data", "runs")),
            model,
            limits: EXPERIMENT_LIMITS,
            expectedDataVersion: manifest.versions.data_version,
            callContext: (toolSignal) => ({
              client: "eval",
              signal: toolSignal,
            }),
          },
          signal
        )
        const reader = stream.getReader()
        try {
          while (!(await reader.read()).done) {
            /* drain the shared stream */
          }
        } finally {
          reader.releaseLock()
        }
        record = await done
      } catch {
        errorKind = "investigation_failed"
      }
      await exportAttempt({
        dir,
        plan,
        record,
        receipts,
        started_at,
        finished_at: new Date().toISOString(),
        elapsed_ms: performance.now() - start,
        ...(errorKind === undefined ? {} : { error_kind: errorKind }),
        aborted: signal.aborted,
      })
    }
  } finally {
    await db.dispose()
  }
  await saveReport(dir, EVAL_VERSION)
}
/** Clearly labeled artifact-only fixture. It establishes no corpus quality. */
export async function runFixtureRound(dir: string): Promise<void> {
  const bank = await loadQuestions(),
    root = findWorkspaceRoot()
  const base = await createManifest({
    round_id: "log52-fixture-v1",
    root,
    bank,
    data_version: "fixture_only",
    repeated: ["dev-eng-01", "dev-tl-01", "dev-mgr-01"],
    fixture: true,
  })
  const instructions = {
    fixture_only: "No model or tools executed; artifact replay control only.",
  }
  const manifest = manifestSchema.parse({
    ...base,
    instructions,
    tool_catalog: [],
    versions: {
      ...base.versions,
      tools_sha256: digest([]),
      prompts_sha256: digest(instructions),
    },
    attempts: base.attempts.slice(0, 2),
  })
  await mkdir(dir, { recursive: false })
  await writeArtifact(dir, "manifest.json", manifest)
  await writeArtifact(dir, "questions.json", bank)
  const question = bank.questions.find((q) => q.id === "dev-clarify-01")
  if (question === undefined) throw new Error("Missing routing fixture")
  for (const plan of manifest.attempts) {
    const record: RunRecord = {
      run_id: plan.variant === "baseline" ? "run_00000001" : "run_00000002",
      started_at: "2026-10-18T00:00:00.000Z",
      finished_at: "2026-10-18T00:00:00.010Z",
      duration_ms: 10,
      status: "completed",
      variant: plan.variant,
      role: { requested: "auto", effective: "auto" },
      question: question.question,
      scope: question.scope,
      model_id: manifest.model.id,
      effort: manifest.model.effort,
      guidance_version: "fixture_only",
      contract_version: CONTRACT_VERSION,
      data_version: "fixture_only",
      instruction_texts: [],
      phases: [],
      coverage_requests: [],
      gate_findings: [],
      usage: { input: null, output: null, cache_read: null, cache_write: null },
      final_text:
        "Which perspective do you need: diagnosing a failure, reviewing recurring problems, or setting priorities?",
      check_claims: [],
      error_kind: null,
      model_calls: 0,
      answer_versions: [],
    }
    await exportAttempt({
      dir,
      plan,
      record,
      receipts: new FileReceiptStore(join(dir, "receipts")),
      started_at: record.started_at,
      finished_at: record.finished_at,
      elapsed_ms: 10,
    })
  }
  await saveReport(dir, EVAL_VERSION)
}
