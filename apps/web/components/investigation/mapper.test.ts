import { describe, expect, it } from "vitest"
import type { UIMessage } from "ai"
import { publicParts } from "./ExportRun"
import { projectMessage, publicDataPart, requestMessages } from "./mapper"
import { scopeSummary } from "./scope"

const run = {
  run_id: "run_deadbeef",
  status: "completed",
  duration_ms: 12,
  usage: { input: null, output: null, cache_read: null, cache_write: null },
}
const message: UIMessage = {
  id: "public-run",
  role: "assistant",
  parts: [
    {
      type: "data-phase",
      data: {
        kind: "investigate",
        draft: "draft",
        instruction_texts: ["must-not-export"],
      },
    },
    { type: "reasoning", text: "private model thoughts" },
    { type: "text", text: "Transient progress must not be saved" },
    { type: "data-phase", data: { kind: "answer", draft: "draft" } },
    { type: "text", text: "A public answer" },
    {
      type: "data-gate",
      data: {
        version: "draft",
        findings: [],
        private_provider_data: "must-not-export",
      },
    },
    {
      type: "data-run",
      data: { ...run, instruction_texts: ["must-not-export"] },
    },
  ],
}

describe("public investigation projection", () => {
  it("exports a bounded follow-up requirement while stripping instruction fields", () => {
    const followUp: UIMessage = {
      ...message,
      parts: [
        { type: "data-phase", data: { kind: "investigate", draft: "draft" } },
        {
          type: "data-phase",
          data: {
            kind: "investigate",
            draft: "draft",
            requirement: "event_trend",
            system_hint: "private instructions",
          },
        },
      ],
    }
    const part = {
      type: "data-phase",
      data: {
        kind: "investigate",
        draft: "draft",
        requirement: "event_trend",
      },
    }
    expect(publicParts(followUp)).toContainEqual(part)
    expect(projectMessage(followUp).tools).toEqual([part])
    expect(JSON.stringify(publicParts(followUp))).not.toContain(
      "private instructions"
    )
    expect(
      publicDataPart({
        type: "data-phase",
        data: {
          kind: "investigate",
          draft: "draft",
          requirement: "x".repeat(1001),
        },
      })
    ).toBeNull()
  })
  it("exports only allowlisted public data and answer text", () => {
    const parts = publicParts(message)
    const json = JSON.stringify(parts)
    expect(json).toContain("A public answer")
    expect(json).not.toContain("private model thoughts")
    expect(json).not.toContain("Transient progress")
    expect(json).not.toContain("must-not-export")
  })
  it("sends prior run references without tools, reasoning, drafts or system messages", () => {
    const history: UIMessage[] = [
      {
        id: "private-system",
        role: "system",
        parts: [{ type: "text", text: "private system" }],
      },
      {
        id: "question",
        role: "user",
        parts: [{ type: "text", text: "My question" }],
      },
      message,
    ]
    expect(requestMessages(history)).toEqual([
      {
        id: "question",
        role: "user",
        parts: [{ type: "text", text: "My question" }],
      },
      {
        id: "public-run",
        role: "assistant",
        parts: [{ type: "data-run", data: run }],
      },
    ])
    expect(projectMessage(message).final).toEqual([
      { type: "text", text: "A public answer" },
    ])
  })
  it("keeps human labels and explicit scope bounds in request history", () => {
    const label = scopeSummary({
      dataset: "bgl",
      from: "2005-06-03T00:00:00Z",
      teams: ["Compute Platform"],
      only_errors: true,
    })
    expect(label).toContain("BGL")
    expect(label).toContain("[2005-06-03T00:00:00Z, span end) UTC")
    expect(label).toContain("Teams: Compute Platform (fictional ownership)")
    expect(label).toContain("Errors only")
    expect(label).not.toContain("only_errors")
  })
})
