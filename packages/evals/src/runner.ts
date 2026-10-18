import { execFileSync } from "node:child_process"
import { readFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import {
  baselineRegistryGuidance,
  baselineRoleInstruction,
  DEFAULT_LIMITS,
  investigationScopeSchema,
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
import { digest, exportAttempt, writeArtifact } from "./artifacts.ts"
import {
  EVAL_VERSION,
  loadQuestions,
  makePlan,
  manifestSchema,
  type EvalManifest,
  type EvalQuestion,
  type QuestionBank,
} from "./contracts.ts"
import { saveReport } from "./report.ts"

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
    .filter(
      (p) =>
        p !== "" &&
        !p.startsWith("packages/evals/results/") &&
        !p.startsWith("vendor/")
    )
    .toSorted()
  const files: Record<string, string> = {}
  for (const path of paths)
    files[path] = digest(await readFile(join(root, path), "utf8"))
  return {
    code_commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    code_dirty:
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim() !== "",
    code_sha256: digest(files),
  }
}
async function createManifest(input: {
  round_id: string
  bank: QuestionBank
  data_version: string
  repeated: string[]
  root: string
  fixture?: boolean
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
    },
    initial_history: "empty",
    pricing: null,
    instructions,
    tool_catalog: tools,
    repeated_questions: input.repeated,
    attempts: makePlan(input.bank, input.repeated),
  })
}
function scopeInput(question: EvalQuestion) {
  const { dataset, from, to, ...other } = question.scope
  const filters = { ...other }
  // The question bank's human-readable singular aliases become canonical
  // domain filters, never inferred equivalence between dataset-specific fields.
  if (typeof filters.component === "string") {
    filters.components = [filters.component]
    delete filters.component
  }
  if (typeof filters.team === "string") {
    filters.teams = [filters.team]
    delete filters.team
  }
  return investigationScopeSchema.parse({ dataset, from, to, filters })
}
export async function runLiveRound(
  dir: string,
  dataVersion: string,
  signal: AbortSignal
): Promise<void> {
  if (!/^dv_[a-zA-Z0-9]+$/.test(dataVersion))
    throw new Error("An explicit current --data-version is required")
  const root = findWorkspaceRoot(),
    bank = await loadQuestions(),
    config = loadConfig()
  const model = resolveModel({ modelId: "claude-opus-5-5", effort: "high" })
  const playbooks = loadPlaybooks()
  const manifest = await createManifest({
    round_id: dir.split("/").filter(Boolean).at(-1) ?? "round",
    root,
    bank,
    data_version: dataVersion,
    repeated: ["dev-eng-01", "dev-tl-01", "dev-mgr-01"],
  })
  await mkdir(dir, { recursive: false })
  await writeArtifact(dir, "manifest.json", manifest)
  await writeArtifact(dir, "questions.json", bank)
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
            scope: scopeInput(question),
            variant: plan.variant,
            history: [],
          },
          {
            registry,
            playbooks,
            runs: new FileRunStore(join(root, ".data", "runs")),
            model,
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
