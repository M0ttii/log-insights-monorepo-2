import type {
  CallContext,
  Registry,
  ToolEntry,
} from "@workspace/analytics/registry"
import { ROLE_SECTIONS, detectSections } from "@workspace/domain/answer"
import { invalidInput, notFound } from "@workspace/domain/errors"
import type { ToolResult } from "@workspace/domain/tool"
import { simulateReadableStream, type LanguageModel } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { z } from "zod"
import { describe, expect, it } from "vitest"

import { baselineRegistryGuidance } from "./baseline.ts"
import {
  DEFAULT_LIMITS,
  runInvestigation,
  type InvestigationDeps,
  type InvestigationInput,
  type InvestigationPlaybooks,
} from "./investigation.ts"
import type { ModelConfig } from "./model.ts"
import type { RunRecord, RunStore } from "./run-record.ts"

/* ----------------------------------------------------------------------- *
 * Mock model harness: one scripted stream per model phase, capturing the
 * prompt (the normalized messages) the model received on each call.
 * ----------------------------------------------------------------------- */

/** A scripted model turn: optional tool calls, then final text. */
type Turn = {
  tools?: { name: string; input: unknown }[]
  text?: string
  finishReason?: "stop" | "tool-calls" | "content-filter"
}

/** The options object the mock's `doStream` receives (prompt + tools). */
type DoStreamOptions = Parameters<MockLanguageModelV4["doStream"]>[0]
/** The provider stream-part element the mock's stream yields. */
type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4["doStream"]>
  >["stream"] extends ReadableStream<infer P>
    ? P
    : never
type Prompt = DoStreamOptions["prompt"]

const USAGE = {
  inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: 0 },
  outputTokens: { total: 40, text: 40, reasoning: 0 },
}

function turnToParts(turn: Turn): StreamPart[] {
  const parts: StreamPart[] = [
    { type: "stream-start", warnings: [] } as StreamPart,
  ]
  for (const [index, call] of (turn.tools ?? []).entries()) {
    parts.push({
      type: "tool-call",
      toolCallId: `call_${index}`,
      toolName: call.name,
      input: JSON.stringify(call.input),
    } as StreamPart)
  }
  if (turn.text !== undefined) {
    parts.push({ type: "text-start", id: "t0" } as StreamPart)
    parts.push({ type: "text-delta", id: "t0", delta: turn.text } as StreamPart)
    parts.push({ type: "text-end", id: "t0" } as StreamPart)
  }
  const reason =
    turn.finishReason ??
    (turn.tools !== undefined && turn.tools.length > 0 ? "tool-calls" : "stop")
  parts.push({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: USAGE,
  } as StreamPart)
  return parts
}

/** Builds a mock model from one scripted turn per model call; captures prompts. */
function scriptModel(turns: Turn[]): {
  model: LanguageModel
  prompts: Prompt[]
} {
  const prompts: Prompt[] = []
  let call = 0
  const model = new MockLanguageModelV4({
    modelId: "mock",
    doStream: async (options: DoStreamOptions) => {
      prompts.push(options.prompt)
      const turn = turns[call] ?? { text: "" }
      call += 1
      return {
        stream: simulateReadableStream({
          chunks: turnToParts(turn),
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
      }
    },
  })
  return { model: model as unknown as LanguageModel, prompts }
}

/* ----------------------------------------------------------------------- *
 * Fake registry: no DB, scripted describe_corpus + tool outcomes.
 * ----------------------------------------------------------------------- */

const TOOL_NAMES = [
  "describe_corpus",
  "search_logs",
  "count_events",
  "check_claims",
] as const

function toolEntry(name: string): ToolEntry {
  return {
    name,
    title: name,
    version: "1.0.0",
    description: `desc ${name}`,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: z.looseObject({}),
    outputSchema: z.unknown(),
    execute: () => {
      throw new Error("unused by the adapter")
    },
    summarize: () => null,
  }
}

function okResult(receiptId: string, data: unknown): ToolResult<unknown> {
  return {
    data,
    facts: [
      {
        id: `${receiptId}.f1`,
        path: "/result/x",
        value: 1204,
        metric: "events",
        unit: "log_events",
        group: { dataset: "bgl" },
      },
    ],
    notes: [],
    receipt: {
      receipt_id: receiptId,
      input: {},
      signature: "a".repeat(64),
      data_version: "dv_test",
      sql: [],
      params: [],
      scope: { windows: [], filters: {} },
      population: null,
      rows_returned: 1,
      truncated: false,
      duration_ms: 3,
      result_digest: "b".repeat(64),
    },
  }
}

const describeData = {
  datasets: [{ dataset: "bgl", events: 4747963 }],
}

/** A check_claims output with the given mismatch/unresolved counts. */
function checkOutput(mismatch: number, unresolved: number) {
  return {
    claims: [],
    summary: {
      checked: mismatch + unresolved,
      verified: 0,
      mismatch,
      unresolved,
      text: `${mismatch + unresolved} checked · ${mismatch} mismatch · ${unresolved} unresolved`,
    },
  }
}

type RunToolFake = Registry["runTool"]

function fakeRegistry(runTool: RunToolFake): Registry {
  return {
    tools: TOOL_NAMES.map(toolEntry),
    catalog: () => [],
    runTool,
    rerun: async () => ({
      ok: false,
      error: notFound("receipt", "r_00000000"),
    }),
  }
}

/** A registry whose describe_corpus and tools always succeed; check_claims clean. */
function cleanRegistry(onCall?: (name: string) => void): Registry {
  return fakeRegistry(async (name) => {
    onCall?.(name)
    if (name === "describe_corpus")
      return { ok: true, result: okResult("r_00000001", describeData) }
    if (name === "check_claims")
      return { ok: true, result: okResult("r_0000000c", checkOutput(0, 0)) }
    return { ok: true, result: okResult("r_0000000a", { count: 1204 }) }
  })
}

/* ----------------------------------------------------------------------- *
 * Fake run store + deps.
 * ----------------------------------------------------------------------- */

function fakeRuns(): RunStore & { records: RunRecord[] } {
  const records: RunRecord[] = []
  return {
    records,
    put: async (record) => {
      records.push(record)
    },
    get: async () => null,
  }
}

const playbooks: InvestigationPlaybooks = {
  version: "1.0.0",
  instructions: "COMMON RULES\nROUTING\nSUMMARIES",
  systemPrompt: (role) => `COMMON RULES\nENGINEER PLAYBOOK for ${role}`,
}

function modelConfig(model: LanguageModel): ModelConfig {
  return {
    model,
    providerOptions: {
      anthropic: {
        thinking: { type: "adaptive", display: "updates" },
        effort: "high",
        cacheControl: { type: "ephemeral", ttl: "1h" },
        fallbacks: "default",
      },
    },
    modelId: "claude-opus-5-5",
    effort: "high",
  }
}

const ctx = (signal: AbortSignal): CallContext => ({ client: "test", signal })

function deps(
  model: LanguageModel,
  overrides: Partial<InvestigationDeps> = {}
): InvestigationDeps & { runs: ReturnType<typeof fakeRuns> } {
  const runs = (overrides.runs as ReturnType<typeof fakeRuns>) ?? fakeRuns()
  return {
    registry: cleanRegistry(),
    playbooks,
    model: modelConfig(model),
    callContext: ctx,
    now: () => new Date("2026-10-18T10:00:00Z"),
    ...overrides,
    runs,
  }
}

/** Drains the stream and returns the collected UI message chunks. */
async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

/** The `type`s of the data-phase chunks, in order. */
function phaseKinds(chunks: unknown[]): string[] {
  return chunks
    .filter(
      (chunk): chunk is { type: string; data: { kind: string } } =>
        typeof chunk === "object" &&
        chunk !== null &&
        (chunk as { type?: string }).type === "data-phase"
    )
    .map((chunk) => chunk.data.kind)
}

function chunkTypes(chunks: unknown[]): string[] {
  return chunks.map((chunk) =>
    typeof chunk === "object" && chunk !== null
      ? ((chunk as { type?: string }).type ?? "?")
      : "?"
  )
}

/* ----------------------------------------------------------------------- *
 * Tests.
 * ----------------------------------------------------------------------- */

const baseInput: InvestigationInput = {
  question: "Why did KERNEL errors spike on June 3?",
  role: "engineer",
}

/** A complete engineer answer with every required section, no citation and no number. */
const CLEAN_ENGINEER_ANSWER = [
  "## Scope",
  "bgl kernel errors",
  "## Answer",
  "the symptoms were job-wide, not one node",
  "## Evidence",
  "e",
  "## Timeline",
  "t",
  "## Narrowing",
  "n",
  "## Hypotheses",
  "h",
  "## Next check",
  "c",
  "## Unknown",
  "u",
  "## Verification",
  "checked",
].join("\n")

describe("runInvestigation phase order", () => {
  it("runs preflight → investigate → answer and writes the record", async () => {
    // Investigate ends after check_claims; answer writes the final text.
    const { model } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      {
        text: "## Scope\nbgl\n## Answer\nok [r_0000000a.f1]\n## Evidence\ne\n## Timeline\nt\n## Narrowing\nn\n## Hypotheses\nh\n## Next check\nc\n## Unknown\nu\n## Verification\nchecked",
      },
    ])
    const d = deps(model)
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    const chunks = await drain(stream)
    const record = await done

    expect(phaseKinds(chunks).slice(0, 3)).toEqual([
      "preflight",
      "investigate",
      "answer",
    ])
    expect(record.status).toBe("completed")
    expect(d.runs.records).toHaveLength(1)
    expect(record.phases[0]?.kind).toBe("preflight")
    expect(record.phases[0]?.steps[0]?.tool).toBe("describe_corpus")
  })
})

describe("investigate stops after check_claims", () => {
  it("does not loop once check_claims has run (no coverage follow-up pending)", async () => {
    const { model, prompts } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { text: "## Scope\n## Answer\nok\n## Unknown\n## Verification\n" },
    ])
    const { stream, done } = runInvestigation(
      { ...baseInput, role: "auto" },
      deps(model),
      new AbortController().signal
    )
    await drain(stream)
    await done
    // Two model calls only: investigate, answer. No re-investigate.
    expect(prompts).toHaveLength(2)
  })
})

describe("coverage follow-up", () => {
  const coverage = {
    engineer: [
      {
        label: "a trend",
        anyOf: [{ tool: "event_trend" }],
      },
    ],
  }

  it("asks a follow-up when a requirement is missing (playbook)", async () => {
    const { model, prompts } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { text: "## Scope\n## Answer\nok\n## Unknown\n## Verification\n" },
    ])
    const d = deps(model, {
      playbooks: { ...playbooks, coverage },
    })
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    await drain(stream)
    const record = await done
    expect(record.coverage_requests.length).toBeGreaterThanOrEqual(1)
    expect(record.coverage_requests[0]).toContain(
      "Required evidence still missing"
    )
    // 3 model calls: investigate, re-investigate (after follow-up), answer.
    expect(prompts.length).toBeGreaterThanOrEqual(3)
  })

  it("asks no coverage follow-up in the baseline variant", async () => {
    const { model, prompts } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { text: CLEAN_ENGINEER_ANSWER },
    ])
    const d = deps(model, { playbooks: { ...playbooks, coverage } })
    const { stream, done } = runInvestigation(
      { ...baseInput, variant: "baseline" },
      d,
      new AbortController().signal
    )
    await drain(stream)
    const record = await done
    expect(record.coverage_requests).toEqual([])
    expect(prompts).toHaveLength(2)
  })

  it("asks at most 2 follow-ups", async () => {
    // check_claims always reports a mismatch → a follow-up is always due.
    const registry = fakeRegistry(async (name) => {
      if (name === "describe_corpus")
        return { ok: true, result: okResult("r_00000001", describeData) }
      if (name === "check_claims")
        return { ok: true, result: okResult("r_0000000c", checkOutput(1, 0)) }
      return { ok: true, result: okResult("r_0000000a", { count: 1 }) }
    })
    const { model, prompts } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { text: CLEAN_ENGINEER_ANSWER },
    ])
    const d = deps(model, { registry })
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    await drain(stream)
    const record = await done
    expect(record.coverage_requests).toHaveLength(2) // investigate + 2 follow-up investigates + answer = 4 calls (cap stops a 3rd).
    expect(prompts).toHaveLength(4)
  })
})

describe("revision", () => {
  it("revises exactly once when the gate finds something", async () => {
    // The draft cites a number with no fact ID → uncited finding → one revise.
    const { model, prompts } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      {
        text: "## Scope\n## Answer\n42 events happened\n## Unknown\n## Verification\n",
      },
      {
        text: "## Scope\n## Answer\nfixed\n## Unknown\n## Verification\n",
      },
    ])
    const d = deps(model)
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    const chunks = await drain(stream)
    const record = await done
    expect(phaseKinds(chunks)).toContain("revise")
    // gate_findings has two entries: draft (with findings) and final.
    expect(record.gate_findings).toHaveLength(2)
    expect(record.gate_findings[0]?.length).toBeGreaterThan(0)
    // investigate, answer, revise = 3 model calls.
    expect(prompts).toHaveLength(3)
  })

  it("does not revise when the gate finds nothing", async () => {
    const { model, prompts } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      {
        text: "## Scope\nbgl\n## Answer\nclean answer, no numbers\n## Evidence\ne\n## Timeline\nt\n## Narrowing\nn\n## Hypotheses\nh\n## Next check\nc\n## Unknown\nu\n## Verification\nchecked",
      },
    ])
    const d = deps(model)
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    const chunks = await drain(stream)
    const record = await done
    expect(phaseKinds(chunks)).not.toContain("revise")
    expect(record.gate_findings).toHaveLength(1)
    expect(record.gate_findings[0]).toEqual([])
    expect(prompts).toHaveLength(2)
  })

  it("does not revise when Verification cites the check's own summary facts (LOG-46 rule)", async () => {
    // The Verification line cites the submitted check_claims receipt's OWN
    // summary facts (N checked / M mismatch / K unresolved). cleanRegistry's
    // check_claims returns receipt r_0000000c, so r_0000000c.fN are the check's
    // summary facts — they come from the check itself and are deliberately not
    // re-submitted (common.md), so the corrected rule exempts them from
    // `unchecked`. The answer is otherwise clean (every section present, every
    // number followed by its summary fact ID), so the gate finds nothing and
    // the run never enters a revise phase. Before the rule change these three
    // Verification facts were each flagged `unchecked` → one revise.
    const { model, prompts } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      {
        text: [
          "## Scope",
          "bgl kernel errors",
          "## Answer",
          "the symptoms were job-wide, not one node",
          "## Evidence",
          "e",
          "## Timeline",
          "t",
          "## Narrowing",
          "n",
          "## Hypotheses",
          "h",
          "## Next check",
          "c",
          "## Unknown",
          "u",
          "## Verification",
          "1 checked [r_0000000c.f1] · 0 mismatch [r_0000000c.f1] · 0 unresolved [r_0000000c.f1]",
        ].join("\n"),
      },
    ])
    const d = deps(model)
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    const chunks = await drain(stream)
    const record = await done
    expect(phaseKinds(chunks)).not.toContain("revise")
    expect(record.gate_findings).toHaveLength(1)
    expect(record.gate_findings[0]).toEqual([])
    // No unchecked finding for the check's own summary fact.
    expect(record.gate_findings[0]?.some((f) => f.kind === "unchecked")).toBe(
      false
    )
    // investigate + answer only; no revise call.
    expect(prompts).toHaveLength(2)
  })
})

describe("append-only history and identical prompt prefix", () => {
  it("each phase's prompt is a prefix-extension of the previous", async () => {
    const { model, prompts } = scriptModel([
      { tools: [{ name: "count_events", input: { dataset: "bgl" } }] },
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      {
        text: "## Scope\n## Answer\n5 events [r_0000000a.f1]\n## Unknown\n## Verification\n",
      },
      { text: "## Scope\n## Answer\nfixed\n## Unknown\n## Verification\n" },
    ])
    const { stream, done } = runInvestigation(
      baseInput,
      deps(model),
      new AbortController().signal
    )
    await drain(stream)
    await done
    expect(prompts.length).toBeGreaterThanOrEqual(2)
    for (let i = 1; i < prompts.length; i += 1) {
      const prev = prompts[i - 1] ?? []
      const next = prompts[i] ?? []
      expect(next.length).toBeGreaterThanOrEqual(prev.length)
      for (let j = 0; j < prev.length; j += 1) {
        expect(JSON.stringify(next[j])).toBe(JSON.stringify(prev[j]))
      }
    }
  })

  it("the system prompt and tool list are identical across calls", async () => {
    const { model } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      {
        text: "## Scope\n## Answer\n9 things\n## Unknown\n## Verification\n",
      },
      { text: "## Scope\n## Answer\nfixed\n## Unknown\n## Verification\n" },
    ])
    const systems: string[] = []
    const toolSets: string[] = []
    const capturing = new MockLanguageModelV4({
      modelId: "mock",
      doStream: async (options) => {
        const system = options.prompt.find((m) => m.role === "system")
        systems.push(system ? JSON.stringify(system.content) : "")
        toolSets.push(JSON.stringify((options.tools ?? []).map((t) => t.name)))
        const turns: Turn[] = [
          { tools: [{ name: "check_claims", input: { claims: [] } }] },
          {
            text: "## Scope\n## Answer\n9 things\n## Unknown\n## Verification\n",
          },
          { text: "## Scope\n## Answer\nfixed\n## Unknown\n## Verification\n" },
        ]
        const idx = systems.length - 1
        return {
          stream: simulateReadableStream({
            chunks: turnToParts(turns[idx] ?? { text: "" }),
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
          }),
        }
      },
    })
    void model
    const { stream, done } = runInvestigation(
      baseInput,
      deps(capturing as unknown as LanguageModel),
      new AbortController().signal
    )
    await drain(stream)
    await done
    expect(new Set(systems).size).toBe(1)
    expect(new Set(toolSets).size).toBe(1)
    // The system prompt is the engineer playbook (not auto, not baseline).
    expect(systems[0]).toContain("ENGINEER PLAYBOOK")
  })
})

describe("abort", () => {
  it("sets status 'stopped' and still writes the record", async () => {
    const controller = new AbortController()
    // The model hangs; we abort mid-flight.
    const model = new MockLanguageModelV4({
      modelId: "mock",
      doStream: async () => {
        controller.abort(new Error("user stop"))
        return {
          stream: simulateReadableStream({
            chunks: turnToParts({ text: "partial" }),
            initialDelayInMs: 0,
            chunkDelayInMs: 0,
          }),
        }
      },
    })
    const d = deps(model as unknown as LanguageModel)
    const { stream, done } = runInvestigation(baseInput, d, controller.signal)
    await drain(stream)
    const record = await done
    expect(record.status).toBe("stopped")
    expect(record.final_text).toBeNull()
    expect(d.runs.records).toHaveLength(1)
  })

  it("a pre-aborted signal yields status 'stopped'", async () => {
    const controller = new AbortController()
    controller.abort(new Error("already"))
    const { model } = scriptModel([{ text: "x" }])
    const { stream, done } = runInvestigation(
      baseInput,
      deps(model),
      controller.signal
    )
    await drain(stream)
    const record = await done
    expect(record.status).toBe("stopped")
  })
})

describe("tool errors are values", () => {
  it("records a tool error as an error_kind, not a throw, and keeps going", async () => {
    const registry = fakeRegistry(async (name) => {
      if (name === "describe_corpus")
        return { ok: true, result: okResult("r_00000001", describeData) }
      if (name === "check_claims")
        return { ok: true, result: okResult("r_0000000c", checkOutput(0, 0)) }
      if (name === "count_events")
        return {
          ok: false,
          error: invalidInput(
            [{ path: "dataset", message: "bad" }],
            "fix the dataset"
          ),
        }
      return { ok: true, result: okResult("r_0000000a", {}) }
    })
    const { model } = scriptModel([
      {
        tools: [
          { name: "count_events", input: { dataset: "nope" } },
          { name: "check_claims", input: { claims: [] } },
        ],
      },
      { text: "## Scope\n## Answer\nok\n## Unknown\n## Verification\n" },
    ])
    const d = deps(model, { registry })
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    await drain(stream)
    const record = await done
    expect(record.status).toBe("completed")
    const steps = record.phases.flatMap((phase) => phase.steps)
    const failed = steps.find((step) => step.tool === "count_events")
    expect(failed?.error_kind).toBe("invalid_input")
  })
})

describe("step limit", () => {
  it("stops the run at the shared total step budget", async () => {
    // Each investigate turn makes one non-check tool call (never check_claims),
    // so the phase only ends at the step cap. Keep the budget small.
    const { model, prompts } = scriptModel(
      Array.from({ length: 10 }, () => ({
        tools: [{ name: "search_logs", input: { text: "x" } }],
      }))
    )
    const d = deps(model, { limits: { maxSteps: 3, maxFollowUps: 0 } })
    const { stream, done } = runInvestigation(
      baseInput,
      d,
      new AbortController().signal
    )
    await drain(stream)
    const record = await done
    const toolSteps = record.phases
      .flatMap((phase) => phase.steps)
      .filter((step) => step.tool === "search_logs").length
    // Investigate alone consumes the budget; no infinite loop.
    expect(toolSteps).toBeLessThanOrEqual(DEFAULT_LIMITS.maxSteps)
    expect(prompts.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxSteps)
  })
})

describe("data parts", () => {
  it("emits data-phase, data-gate and data-run parts", async () => {
    const { model } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      {
        text: "## Scope\nbgl\n## Answer\nclean\n## Evidence\ne\n## Timeline\nt\n## Narrowing\nn\n## Hypotheses\nh\n## Next check\nc\n## Unknown\nu\n## Verification\nchecked",
      },
    ])
    const { stream, done } = runInvestigation(
      baseInput,
      deps(model),
      new AbortController().signal
    )
    const chunks = await drain(stream)
    await done
    const types = chunkTypes(chunks)
    expect(types).toContain("data-phase")
    expect(types).toContain("data-gate")
    expect(types).toContain("data-run")
  })
})

describe("baseline instructions", () => {
  it("records the baseline shared rules and role instruction, never the playbook", async () => {
    const { model } = scriptModel([
      { tools: [{ name: "check_claims", input: { claims: [] } }] },
      { text: "## Scope\n## Answer\nok\n## Unknown\n## Verification\n" },
    ])
    const { stream, done } = runInvestigation(
      { ...baseInput, variant: "baseline" },
      deps(model),
      new AbortController().signal
    )
    await drain(stream)
    const record = await done
    expect(record.variant).toBe("baseline")
    expect(record.instruction_texts).toHaveLength(2)
    expect(record.instruction_texts.join("\n")).not.toContain(
      "ENGINEER PLAYBOOK"
    )
  })

  it("the baseline registry guidance carries no playbook summaries", () => {
    const guidance = baselineRegistryGuidance("1.0.0")
    expect(guidance.version).toBe("baseline:1.0.0")
    expect(JSON.stringify(guidance)).not.toContain("PLAYBOOK")
  })

  it("baseline instructions expose no role-core section heading nor Coverage", async () => {
    // Direct guard against indirect playbook feed (§ 13.2): the baseline's
    // recorded instruction texts, and the baseline registry guidance, must
    // carry none of the role-core SECTION STRUCTURE a playbook would supply.
    // Detection is by heading / leading-bold form (detectSections), the same
    // way the gate recognises a section — a prose word like "evidence" inside
    // a sentence is fine; a "## Evidence" heading is not.
    const coreNames = [
      ...ROLE_SECTIONS.core.engineer,
      ...ROLE_SECTIONS.core.team_lead,
      ...ROLE_SECTIONS.core.manager,
    ]
    for (const role of ["engineer", "team_lead", "manager", "auto"] as const) {
      const { model } = scriptModel([
        { tools: [{ name: "check_claims", input: { claims: [] } }] },
        { text: "## Scope\n## Answer\nok\n## Unknown\n## Verification\n" },
      ])
      const { stream, done } = runInvestigation(
        { ...baseInput, role, variant: "baseline" },
        deps(model),
        new AbortController().signal
      )
      await drain(stream)
      const record = await done
      const instructions = record.instruction_texts.join("\n")
      // No role-core section is DETECTABLE as a heading / bold in the baseline.
      const present = new Set(
        [
          ...detectSections(instructions, "engineer").present,
          ...detectSections(instructions, "team_lead").present,
          ...detectSections(instructions, "manager").present,
        ].map((name) => name.toLowerCase())
      )
      for (const name of coreNames)
        expect(present.has(name.toLowerCase())).toBe(false)
      // And no "Coverage" section text in any form (LOG-47 is playbook-only).
      expect(instructions).not.toMatch(/coverage/i)
    }
    // The registry guidance strings (answer_guidance) are equally clean.
    const guidanceText = JSON.stringify(baselineRegistryGuidance("1.0.0"))
    for (const name of coreNames)
      expect(guidanceText).not.toMatch(
        new RegExp(`^[ \\t]*#{1,6}[ \\t]+${name}`, "im")
      )
    expect(guidanceText).not.toMatch(/coverage/i)
  })
})
