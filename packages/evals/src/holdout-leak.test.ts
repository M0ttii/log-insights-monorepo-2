import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInvestigation, type ModelConfig } from "@workspace/agent/ai-sdk"
import type { Registry, ToolEntry } from "@workspace/analytics/registry"
import { notFound } from "@workspace/domain/errors"
import type { ToolResult } from "@workspace/domain/tool"
import { z } from "zod"
import { afterEach, describe, expect, it, vi } from "vitest"

// Only synthetic files are used here. Record file access so a closed release
// gate is proved to reject before even opening the question payload.
const fileAccess = vi.hoisted(() => ({ reads: [] as string[] }))
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>()
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) => {
      fileAccess.reads.push(String(args[0]))
      return actual.readFile(...args)
    },
    open: (...args: Parameters<typeof actual.open>) => {
      fileAccess.reads.push(String(args[0]))
      return actual.open(...args)
    },
  }
})

import {
  freezeHoldout,
  holdoutInvestigationInput,
  holdoutQuestionBankSchema,
  registerHoldout,
  releaseHoldout,
} from "./holdout.ts"
import { digest, readArtifact, writeArtifact } from "./artifacts.ts"
import { manifestSchema } from "./contracts.ts"
import { prepareReview } from "./development.ts"
import { prepareRound, runFixtureRound } from "./runner.ts"

const QUESTION = {
  id: "synthetic-boundary-engineer",
  role: "engineer",
  question: "Inspect this clearly synthetic boundary control.",
  scope: {
    dataset: "bgl",
    from: "2005-06-03T00:00:00Z",
    to: "2005-06-04T00:00:00Z",
    filters: { components: ["KERNEL"], only_errors: true },
  },
}
const PRIVATE_MARKER = "SYNTHETIC_PRIVATE_EXPECTATION_MUST_STAY_OUT"
const PUBLIC_BANK = {
  schema_version: 1,
  set_id: "synthetic-boundary",
  questions: ["engineer", "team_lead", "manager"].flatMap((role) =>
    [1, 2].map((number) => ({
      ...QUESTION,
      id: `synthetic-${role}-${number}`,
      role,
      question: `Clearly synthetic ${role} boundary control ${number}.`,
    }))
  ),
}
const PRIVATE_FIELDS = [
  "expected_answer",
  "required_evidence",
  "distinguishing_check",
  "allowed_tool_sequences",
  "reference",
  "reference_provenance",
  "expectations",
  "rubric",
  "evidence",
]

function syntheticMetadata() {
  return {
    schema_version: 1,
    set_id: PUBLIC_BANK.set_id,
    created_at: "2026-01-01T00:00:00Z",
    author_id: "synthetic-author",
    author_not_playbook_author: true,
    sealed: true,
    contaminated: false,
    role_counts: { engineer: 2, team_lead: 2, manager: 2 },
    datasets: ["bgl", "openstack"],
    data_version: "dv_syntheticBoundary",
    files: {
      questions_sha256: "1".repeat(64),
      expectations_sha256: "2".repeat(64),
      evidence_sha256: "3".repeat(64),
    },
  }
}

function syntheticRuntime(observedAt: string) {
  return {
    observed_at: observedAt,
    configured_image: "synthetic/not-a-real-runtime",
    running_image_id: `sha256:${"5".repeat(64)}`,
    published_port: 1,
    corpus_receipt_id: "r_00000000",
    corpus_receipt_sha256: "6".repeat(64),
    data_version: "dv_syntheticBoundary",
    source: "corpus",
    datasets: ["bgl", "openstack"],
    lockfile_sha256: "4".repeat(64),
  }
}

type CapturingModel = Extract<
  ModelConfig["model"],
  { specificationVersion: "v4" }
>
type ModelOptions = Parameters<CapturingModel["doStream"]>[0]
type ModelPart =
  Awaited<
    ReturnType<CapturingModel["doStream"]>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never

const ANSWER = [
  "## Scope",
  "Synthetic boundary control.",
  "## Answer",
  "The fixture establishes prompt isolation only.",
  "## Evidence",
  "No corpus finding is asserted.",
  "## Timeline",
  "Unknown.",
  "## Narrowing",
  "Unknown.",
  "## Hypotheses",
  "Unknown.",
  "## Next check",
  "Collect actual evidence.",
  "## Unknown",
  "The cause remains unknown.",
  "## Verification",
  "No numerical claim was made.",
].join("\n")

function capturingModel(requests: ModelOptions[]): ModelConfig {
  const model: CapturingModel = {
    specificationVersion: "v4",
    provider: "offline-boundary-control",
    modelId: "synthetic",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("Only the shared streaming investigation may run")
    },
    doStream: async (options) => {
      requests.push(options)
      const parts: ModelPart[] = [{ type: "stream-start", warnings: [] }]
      if (requests.length === 1)
        parts.push({
          type: "tool-call",
          toolCallId: "synthetic_check",
          toolName: "check_claims",
          input: '{"claims":[]}',
        })
      else
        parts.push(
          { type: "text-start", id: "answer" },
          { type: "text-delta", id: "answer", delta: ANSWER },
          { type: "text-end", id: "answer" }
        )
      parts.push({
        type: "finish",
        finishReason: {
          unified: requests.length === 1 ? "tool-calls" : "stop",
          raw: requests.length === 1 ? "tool-calls" : "stop",
        },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      })
      return {
        stream: new ReadableStream<ModelPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  }
  return {
    model,
    modelId: "claude-opus-5-5",
    effort: "high",
    providerOptions: { anthropic: {} },
  }
}

function toolEntry(name: string): ToolEntry {
  return {
    name,
    title: name,
    version: "1.0.0",
    description: "Synthetic boundary control only.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema:
      name === "check_claims"
        ? z.strictObject({ claims: z.array(z.never()) })
        : z.strictObject({}),
    outputSchema: z.unknown(),
    execute: () => {
      throw new Error("Only the registry boundary may execute this tool")
    },
    summarize: () => null,
  }
}

function toolResult(name: string): ToolResult<unknown> {
  return {
    data:
      name === "check_claims"
        ? {
            claims: [],
            summary: {
              checked: 0,
              verified: 0,
              mismatch: 0,
              unresolved: 0,
              text: "No claims submitted.",
            },
          }
        : { datasets: [{ dataset: "bgl" }] },
    facts: [],
    notes: [],
    receipt: {
      receipt_id: name === "check_claims" ? "r_00000002" : "r_00000001",
      input: name === "check_claims" ? { claims: [] } : {},
      signature: "a".repeat(64),
      data_version: "dv_syntheticBoundary",
      sql: [],
      params: [],
      scope: { windows: [], filters: {} },
      population: null,
      rows_returned: 0,
      truncated: false,
      duration_ms: 0,
      result_digest: "b".repeat(64),
    },
  }
}

afterEach(() => {
  fileAccess.reads.length = 0
})

describe("independent holdout leak boundary", () => {
  it.each(PRIVATE_FIELDS)(
    "rejects private %s before model projection",
    (key) => {
      expect(() =>
        holdoutInvestigationInput({ ...QUESTION, [key]: PRIVATE_MARKER })
      ).toThrow("Invalid holdout artifact")
    }
  )

  it.each(["scope", "filters"])(
    "rejects private fields nested inside %s",
    (location) => {
      const scope =
        location === "scope"
          ? { ...QUESTION.scope, expectations: PRIVATE_MARKER }
          : {
              ...QUESTION.scope,
              filters: {
                ...QUESTION.scope.filters,
                expectations: PRIVATE_MARKER,
              },
            }
      expect(() => holdoutInvestigationInput({ ...QUESTION, scope })).toThrow(
        "Invalid holdout artifact"
      )
    }
  )

  it("rejects a private rubric at the public bank root", () => {
    expect(holdoutQuestionBankSchema.safeParse(PUBLIC_BANK).success).toBe(true)
    expect(
      holdoutQuestionBankSchema.safeParse({
        ...PUBLIC_BANK,
        rubric: PRIVATE_MARKER,
      }).success
    ).toBe(false)
  })

  it("rejects expectation data attached to a question in the public bank", () => {
    expect(
      holdoutQuestionBankSchema.safeParse({
        ...PUBLIC_BANK,
        questions: PUBLIC_BANK.questions.map((question, index) =>
          index === 0
            ? { ...question, required_evidence: [PRIVATE_MARKER] }
            : question
        ),
      }).success
    ).toBe(false)
  })

  it("passes only the strict public projection through the actual SDK prompt assembly", async () => {
    const projected = holdoutInvestigationInput(QUESTION)
    expect(projected).toEqual({
      question: QUESTION.question,
      role: "engineer",
      scope: QUESTION.scope,
    })
    const requests: ModelOptions[] = []
    const toolCalls: unknown[] = []
    const registry: Registry = {
      tools: [toolEntry("describe_corpus"), toolEntry("check_claims")],
      catalog: () => [],
      runTool: async (name, input, context) => {
        toolCalls.push({ name, input, context })
        return { ok: true, result: toolResult(name) }
      },
      rerun: async () => ({
        ok: false,
        error: notFound("receipt", "r_00000000"),
      }),
    }
    const { stream, done } = runInvestigation(
      { ...projected, variant: "playbook", history: [] },
      {
        registry,
        playbooks: {
          version: "synthetic",
          instructions: "Synthetic common instructions.",
          sharedRules: "Synthetic shared rules.",
          systemPrompt: (role) => `Synthetic ${role} instructions.`,
        },
        runs: { put: async () => {}, get: async () => null },
        model: capturingModel(requests),
        callContext: (signal) => ({ client: "eval", signal }),
        expectedDataVersion: "dv_syntheticBoundary",
        limits: { maxFollowUps: 0, maxRevisions: 0 },
      },
      new AbortController().signal
    )
    const reader = stream.getReader()
    try {
      while (!(await reader.read()).done) {
        // Exercise the real streaming pipeline without a provider or database.
      }
    } finally {
      reader.releaseLock()
    }
    const record = await done
    expect(record.status).toBe("completed")
    expect(requests).toHaveLength(2)
    expect(record.question).toBe(QUESTION.question)
    expect(record.scope).toEqual(QUESTION.scope)
    const prompt = JSON.stringify(requests)
    expect(prompt).toContain(QUESTION.question)
    expect(prompt).toContain("Synthetic engineer instructions.")
    expect(prompt).toContain("KERNEL")
    expect(prompt).not.toContain(QUESTION.id)
    for (const key of PRIVATE_FIELDS) expect(prompt).not.toContain(key)
    expect(prompt).not.toContain(PRIVATE_MARKER)
    expect(toolCalls).toEqual([
      {
        name: "describe_corpus",
        input: {},
        context: { client: "eval", signal: expect.any(AbortSignal) },
      },
      {
        name: "check_claims",
        input: { claims: [] },
        context: { client: "eval", signal: expect.any(AbortSignal) },
      },
    ])
    expect(JSON.stringify(record)).not.toContain(PRIVATE_MARKER)
  })

  it("does not open even a synthetic private question file without a valid freeze", async () => {
    const root = await mkdtemp(join(tmpdir(), "log54-leak-control-"))
    const vault = join(root, "synthetic-vault")
    // This deliberately invalid synthetic payload must not even be opened.
    const questions = join(vault, "questions.yaml")
    await mkdir(vault)
    await writeFile(questions, `[${PRIVATE_MARKER}`)
    fileAccess.reads.length = 0
    try {
      await expect(
        releaseHoldout(
          join(root, "missing-preparation"),
          join(root, "missing-freeze"),
          vault,
          join(root, "output")
        )
      ).rejects.toThrow(/ENOENT/)
      expect(fileAccess.reads).not.toContain(questions)
      expect(fileAccess.reads.some((file) => file.startsWith(vault))).toBe(
        false
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects an invalid freeze after valid public registration without reading the vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "log54-invalid-freeze-"))
    const preparation = join(root, "preparation")
    const freeze = join(root, "freeze")
    const vault = join(root, "synthetic-vault")
    try {
      const metadataFile = join(root, "metadata.json")
      await writeFile(metadataFile, JSON.stringify(syntheticMetadata()))
      await registerHoldout(metadataFile, preparation)
      await writeArtifact(freeze, "freeze.json", {})
      await mkdir(vault)
      await writeFile(join(vault, "questions.yaml"), `[${PRIVATE_MARKER}`)
      fileAccess.reads.length = 0
      await expect(
        releaseHoldout(preparation, freeze, vault, join(root, "output"))
      ).rejects.toThrow(/Invalid holdout artifact/)
      expect(fileAccess.reads).toContain(join(preparation, "registration.json"))
      expect(fileAccess.reads).toContain(join(freeze, "freeze.json"))
      expect(fileAccess.reads.some((file) => file.startsWith(vault))).toBe(
        false
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses a forged passed fixture freeze before any private payload access", async () => {
    const root = await mkdtemp(join(tmpdir(), "log54-forged-freeze-"))
    const preparation = join(root, "preparation")
    const development = join(root, "fixture-development")
    const freeze = join(root, "forged-freeze")
    const vault = join(root, "synthetic-vault")
    try {
      const metadataFile = join(root, "metadata.json")
      await writeFile(metadataFile, JSON.stringify(syntheticMetadata()))
      const prepared = await registerHoldout(metadataFile, preparation)
      await runFixtureRound(development)
      const manifest = manifestSchema.parse(
        await readArtifact(development, "manifest.json")
      )
      const fakePass = { acceptance: "passed", synthetic: true }
      await writeArtifact(
        development,
        "development-reports/synthetic-review.json",
        fakePass
      )
      await writeArtifact(development, "review-input/synthetic-review.json", {})
      // This is deliberately forged metadata, never acceptance evidence. Its
      // valid shape must still be rejected by the real development replay gate.
      const plan = ["engineer", "team_lead", "manager"].flatMap((role, index) =>
        [1, 2].flatMap((ordinal) =>
          (ordinal === 1
            ? ["baseline", "playbook"]
            : ["playbook", "baseline"]
          ).map((variant, position) => ({
            slot: `${role}-${ordinal}`,
            role,
            ordinal,
            variant,
            repetition: 1,
            order: index * 4 + (ordinal - 1) * 2 + position,
          }))
        )
      )
      const now = new Date().toISOString()
      await writeArtifact(freeze, "freeze.json", {
        schema_version: 1,
        state: "frozen_before_release",
        frozen_at: now,
        metadata_sha256: prepared.metadata_sha256,
        preparation_sha256: digest(prepared),
        development: {
          directory: development,
          reviewer_version: "synthetic-review",
          manifest_sha256: digest(manifest),
          report_sha256: digest(fakePass),
          review_input_sha256: digest({}),
        },
        configuration: manifest,
        lockfile_sha256: "4".repeat(64),
        runtime: syntheticRuntime(now),
        plan,
        repeat_anchors: {
          split: "development",
          question_ids: manifest.repeated_questions,
          trials_per_variant: 3,
          holdout_trials_per_variant: 1,
        },
        policy: {
          version: "log54-v1",
          comparison: "blind_both_orders",
          human_sample: "one_pair_per_role_and_all_critical_findings",
          error_policy: "retain_all_no_replacement_or_resume",
          acceptance: "unchanged_technical_13_1_per_split",
          inspection: "questions_become_regression_after_inspection",
        },
        limitations: ["Synthetic forged-freeze regression control only."],
      })
      await mkdir(vault)
      await writeFile(join(vault, "questions.yaml"), `[${PRIVATE_MARKER}`)
      fileAccess.reads.length = 0
      await expect(
        releaseHoldout(preparation, freeze, vault, join(root, "output"))
      ).rejects.toThrow(/real LOG-53 development round/)
      expect(fileAccess.reads).toContain(join(development, "manifest.json"))
      expect(fileAccess.reads.some((file) => file.startsWith(vault))).toBe(
        false
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("recomputes failed development prerequisites instead of trusting a saved passed label", async () => {
    const root = await mkdtemp(join(tmpdir(), "log54-unpassed-development-"))
    const preparation = join(root, "preparation")
    const development = join(root, "unexecuted-development")
    const vault = join(root, "synthetic-vault")
    try {
      const metadataFile = join(root, "metadata.json")
      await writeFile(metadataFile, JSON.stringify(syntheticMetadata()))
      await registerHoldout(metadataFile, preparation)
      const manifest = await prepareRound(development, "dv_syntheticBoundary")
      // Deliberately forge execution/runtime metadata and a passed label. The
      // replay must retain every missing planned attempt and close the gate.
      const runtime = syntheticRuntime(new Date().toISOString())
      await writeArtifact(development, "runtime.json", runtime)
      await writeArtifact(development, "execution.json", {
        started_at: new Date().toISOString(),
        manifest_sha256: digest(manifest),
        runtime_sha256: digest(runtime),
      })
      await prepareReview(development, "synthetic-review")
      await writeArtifact(development, "review-input/synthetic-review.json", {
        judge_submissions: [],
        pair_judgments: [],
        human_reviews: [],
        s13_content: [],
        calibrations: [],
      })
      await writeArtifact(
        development,
        "development-reports/synthetic-review.json",
        { acceptance: "passed", synthetic: true }
      )
      await mkdir(vault)
      await writeFile(join(vault, "questions.yaml"), `[${PRIVATE_MARKER}`)
      fileAccess.reads.length = 0
      await expect(
        freezeHoldout(
          preparation,
          development,
          "synthetic-review",
          join(root, "freeze")
        )
      ).rejects.toThrow(/Development acceptance has not passed/)
      expect(fileAccess.reads).toContain(
        join(development, "review-input/synthetic-review.json")
      )
      expect(fileAccess.reads.some((file) => file.startsWith(vault))).toBe(
        false
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
