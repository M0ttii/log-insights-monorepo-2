// @vitest-environment jsdom
// Synthetic messages are confined to this component test; the app has no demo agent.
import { createElement } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai"
import type { ToolResult } from "@workspace/domain/tool"
import { InvestigationView } from "./InvestigationView"
import { Conversation } from "./Conversation"

vi.mock("next/navigation", () => ({
  usePathname: () => "/investigations/new",
  useSearchParams: () => new URLSearchParams(),
}))
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollTo = vi.fn<() => void>()
})
afterEach(cleanup)

const brief = {
  version: "test-only",
  roles: [
    {
      id: "engineer",
      title: "Engineer",
      description: "Diagnose a failure.",
      summary: "Evidence and checks.",
    },
  ],
  examples: [],
}
function streamTransport() {
  let sink: ReadableStreamDefaultController<UIMessageChunk> | undefined
  const sendMessages = vi.fn<ChatTransport<UIMessage>["sendMessages"]>(
    async ({ abortSignal }) =>
      new ReadableStream({
        start(controller) {
          sink = controller
          abortSignal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Stopped", "AbortError")),
            { once: true }
          )
        },
      })
  )
  const transport: ChatTransport<UIMessage> = {
    sendMessages,
    reconnectToStream: async () => null,
  }
  return {
    transport,
    sendMessages,
    push: (chunk: UIMessageChunk) => {
      if (!sink) throw new Error("No stream")
      sink.enqueue(chunk)
    },
    close: () => sink?.close(),
  }
}

describe("prepared chat", () => {
  it("makes no request before the agent is connected, even on Enter", () => {
    const wire = streamTransport()
    render(
      createElement(InvestigationView, { brief, chatTransport: wire.transport })
    )
    const textbox = screen.getByRole("textbox", { name: "Your question" })
    fireEvent.change(textbox, { target: { value: "Investigate this failure" } })
    fireEvent.keyDown(textbox, { key: "Enter" })
    expect(
      screen
        .getByRole("button", { name: "Send unavailable" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(wire.sendMessages).not.toHaveBeenCalled()
    expect(textbox.getAttribute("readonly")).toBeNull()
  })
  it("consumes a real SDK stream, sends the role and scope, and clears a successful draft", async () => {
    const wire = streamTransport()
    render(
      createElement(InvestigationView, {
        brief,
        available: true,
        chatTransport: wire.transport,
      })
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Choose perspective, Engineer" })
    )
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: /Manager/ })
    )
    fireEvent.click(screen.getByRole("button", { name: /^Choose dataset/ }))
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "BGL · 2005–2006" })
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Test question" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(wire.sendMessages).toHaveBeenCalledOnce())
    expect(wire.sendMessages.mock.calls[0]?.[0].body).toEqual({
      role: "manager",
      scope: { dataset: "bgl" },
    })
    expect(screen.getByRole("button", { name: "Stop response" })).toBeTruthy()
    await act(async () => {
      wire.push({ type: "start", messageId: "test-reply" })
      wire.push({ type: "text-start", id: "text" })
      wire.push({
        type: "text-delta",
        id: "text",
        delta: "## Answer\nA test response, without invented data.",
      })
      wire.push({ type: "text-end", id: "text" })
      wire.push({ type: "finish", finishReason: "stop" })
      wire.close()
    })
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy()
    )
    await waitFor(() =>
      expect(screen.getByRole("textbox").getAttribute("readonly")).toBeNull()
    )
    expect(screen.getByRole("textbox")).toHaveProperty("value", "")
    expect(screen.getByRole("button", { name: "Copy answer" })).toBeTruthy()
  })
  it("keeps partial text and the draft after Stop", async () => {
    const wire = streamTransport()
    render(
      createElement(InvestigationView, {
        brief,
        available: true,
        chatTransport: wire.transport,
      })
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this question" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(wire.sendMessages).toHaveBeenCalledOnce())
    await act(async () => {
      wire.push({ type: "start", messageId: "partial" })
      wire.push({ type: "text-start", id: "text" })
      wire.push({ type: "text-delta", id: "text", delta: "Partial evidence" })
    })
    await waitFor(() =>
      expect(screen.getByText("Partial evidence")).toBeTruthy()
    )
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }))
    await waitFor(() =>
      expect(screen.getByText(/Stopped · partial response/)).toBeTruthy()
    )
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "Keep this question"
    )
    expect(screen.getByText("Not verified")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "A follow-up question" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(wire.sendMessages).toHaveBeenCalledTimes(2))
    await act(async () => {
      wire.push({ type: "start", messageId: "follow-up" })
      wire.push({ type: "text-start", id: "text" })
      wire.push({ type: "text-delta", id: "text", delta: "Follow-up answer" })
      wire.push({ type: "text-end", id: "text" })
      wire.push({ type: "finish", finishReason: "stop" })
      wire.close()
    })
    await waitFor(() =>
      expect(screen.getByText("Follow-up answer")).toBeTruthy()
    )
    expect(screen.getByText(/Stopped · partial response/)).toBeTruthy()
  })
  it("preserves the draft and hides provider errors", async () => {
    const transport: ChatTransport<UIMessage> = {
      sendMessages: async () => {
        throw new Error("secret provider payload")
      },
      reconnectToStream: async () => null,
    }
    render(
      createElement(InvestigationView, {
        brief,
        available: true,
        chatTransport: transport,
      })
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Retain my input" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() =>
      expect(screen.getByText("Response interrupted")).toBeTruthy()
    )
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "Retain my input"
    )
    expect(screen.queryByText("secret provider payload")).toBeNull()
  })
  it("marks partial text and pending tools as interrupted after an SDK error", async () => {
    const wire = streamTransport()
    render(
      createElement(InvestigationView, {
        brief,
        available: true,
        chatTransport: wire.transport,
      })
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep the failed draft" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(wire.sendMessages).toHaveBeenCalledOnce())
    await act(async () => {
      wire.push({ type: "start", messageId: "error-reply" })
      wire.push({
        type: "tool-input-available",
        toolCallId: "pending-call",
        toolName: "search_logs",
        input: { query: "test" },
        dynamic: true,
      })
      wire.push({ type: "text-start", id: "text" })
      wire.push({
        type: "text-delta",
        id: "text",
        delta: "Partial before failure",
      })
      wire.push({ type: "error", errorText: "private provider error" })
      wire.close()
    })
    await waitFor(() =>
      expect(screen.getByText(/Interrupted · partial response/)).toBeTruthy()
    )
    expect(
      screen.getByRole("button", { name: /search_logs.*Interrupted/ })
    ).toBeTruthy()
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "Keep the failed draft"
    )
    expect(screen.queryByText("private provider error")).toBeNull()
  })
  it("renders safe markdown and tool states without exposing model thoughts", () => {
    const messages: UIMessage[] = [
      {
        id: "safe",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private model thoughts" },
          {
            type: "text",
            text: "## Answer\n[unsafe](javascript:alert(1))\n<script>window.bad=true</script>\n![remote](https://example.com/tracker.png)",
          },
          {
            type: "dynamic-tool",
            toolName: "search_logs",
            toolCallId: "running",
            state: "input-available",
            input: { query: "test" },
          },
          {
            type: "dynamic-tool",
            toolName: "count_events",
            toolCallId: "failed",
            state: "output-error",
            input: {},
            errorText: "raw database stack",
          },
        ],
      },
    ]
    const { container } = render(
      createElement(Conversation, { messages, status: "streaming" })
    )
    expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy()
    expect(
      container.querySelector("script, img, a[href^='javascript:']")
    ).toBeNull()
    expect(container.textContent).not.toContain("private model thoughts")
    expect(container.textContent).not.toContain("raw database stack")
    expect(
      screen.getByRole("button", { name: /search_logs.*Running/ })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: /count_events.*Failed/ })
    ).toBeTruthy()
  })
  it("renders a completed receipt, truncation, input and independent claim checks", () => {
    const result: ToolResult<unknown> = {
      data: { note: "Synthetic component-test evidence", events: 7 },
      facts: [
        {
          id: "r_deadbeef.f1",
          path: "/result/events",
          value: 7,
          metric: "events",
          unit: "log_events",
          group: {},
        },
      ],
      notes: ["Synthetic test caveat"],
      receipt: {
        receipt_id: "r_deadbeef",
        input: { dataset: "bgl", rank: "investigation_order" },
        signature: "a".repeat(64),
        data_version: "test-only",
        sql: [],
        params: [],
        scope: { windows: [], filters: {} },
        population: null,
        rows_returned: 1,
        truncated: true,
        duration_ms: 12,
        result_digest: "b".repeat(64),
      },
    }
    const check = {
      claims: [],
      summary: {
        checked: 0,
        verified: 0,
        mismatch: 0,
        unresolved: 0,
        text: "0 claims checked · 0 mismatch · 0 unresolved",
      },
    }
    const messages: UIMessage[] = [
      {
        id: "test-results",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "recurring_patterns",
            toolCallId: "complete",
            state: "output-available",
            input: { dataset: "bgl", rank: "investigation_order" },
            output: { ok: true, result },
          },
          {
            type: "dynamic-tool",
            toolName: "check_claims",
            toolCallId: "check-a",
            state: "output-available",
            input: {},
            output: { ok: true, result: { ...result, data: check } },
          },
          {
            type: "dynamic-tool",
            toolName: "check_claims",
            toolCallId: "check-b",
            state: "output-available",
            input: {},
            output: { ok: true, result: { ...result, data: check } },
          },
        ],
      },
    ]
    render(createElement(Conversation, { messages, status: "ready" }))
    expect(
      screen.getAllByRole("link", { name: "Open receipt r_deadbeef" })
    ).toHaveLength(3)
    expect(screen.getAllByText(check.summary.text)).toHaveLength(2)
    expect(screen.getByText("bgl")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", {
        name: /recurring_patterns.*Investigation order.*Complete/,
      })
    )
    expect(screen.getAllByText("Truncated")).toHaveLength(3)
    expect(screen.getByText("Synthetic test caveat")).toBeTruthy()
    expect(screen.getByText("Synthetic component-test evidence")).toBeTruthy()
    expect(screen.getByText("7", { exact: true })).toBeTruthy()
    expect(
      screen
        .getByRole("link", {
          name: "Fact r_deadbeef.f1, unchecked, open evidence",
        })
        .getAttribute("href")
    ).toBe("/investigations/new?receipt=r_deadbeef&fact=r_deadbeef.f1")
    expect(screen.getByText(/"rank": "investigation_order"/)).toBeTruthy()
  })
})

// Recorded wire fixture using the installed SDK's public chunk protocol.
// Values are synthetic and exercise rendering; they are not corpus evidence.
const fixtureResult: ToolResult<unknown> = {
  data: { note: "Synthetic recorded evidence" },
  facts: [
    {
      id: "r_deadbeef.f1",
      path: "/result/events",
      value: 7,
      metric: "events",
      unit: "log_events",
      group: {},
    },
  ],
  notes: [],
  receipt: {
    receipt_id: "r_deadbeef",
    input: { dataset: "bgl" },
    signature: "a".repeat(64),
    data_version: "test-only",
    sql: [],
    params: [],
    scope: { windows: [], filters: {} },
    population: null,
    rows_returned: 1,
    truncated: false,
    duration_ms: 12,
    result_digest: "b".repeat(64),
  },
}
function recordedCheck(id: string, verified: boolean): ToolResult<unknown> {
  return {
    ...fixtureResult,
    receipt: { ...fixtureResult.receipt, receipt_id: id },
    facts: ["checked", "verified", "mismatch", "unresolved"].map(
      (field, index) => ({
        id: `${id}.f${index + 1}`,
        path: `/result/summary/${field}`,
        value:
          field === "checked" ||
          (field === "verified" && verified) ||
          (field === "mismatch" && !verified)
            ? 1
            : 0,
        metric: `claims_${field}`,
        unit: "claims",
        group: {},
      })
    ),
    data: {
      claims: [
        {
          claim: {
            fact: "r_deadbeef.f1",
            value: verified ? 7 : 9,
            metric: "events",
            group: {},
          },
          status: verified ? "verified" : "mismatch",
          mismatch_on: verified ? [] : ["value"],
          reason: verified ? null : "The submitted value differs",
          fact: null,
          receipt: null,
        },
      ],
      summary: {
        checked: 1,
        verified: verified ? 1 : 0,
        mismatch: verified ? 0 : 1,
        unresolved: 0,
        text: `1 claims checked · ${verified ? 0 : 1} mismatch · 0 unresolved`,
      },
    },
  }
}
function recordedTool(
  id: string,
  name: string,
  result: ToolResult<unknown>
): UIMessageChunk[] {
  return [
    {
      type: "tool-input-available",
      toolCallId: id,
      toolName: name,
      input: {},
      dynamic: true,
    },
    {
      type: "tool-output-available",
      toolCallId: id,
      output: { ok: true, result },
    },
  ]
}
const recordedDraft =
  "## Answer\n9 events [r_deadbeef.f1]. Another 44 without evidence."
const recordedFinal =
  "## Scope\nBGL.\n## Answer\n7 events [r_deadbeef.f1].\n## Evidence\nSee the receipt.\n## Timeline\nUnknown.\n## Narrowing\nUnknown.\n## Hypotheses\nOpen.\n## Next check\nInspect the original message.\n## Unknown\nCause unknown.\n## Verification\nSee the claim check."
const recordedRun = {
  run_id: "run_deadbeef",
  status: "completed",
  duration_ms: 30,
  usage: { input: 12, output: 15, cache_read: null, cache_write: null },
}
const revisionChunks: UIMessageChunk[] = [
  { type: "start", messageId: "recorded-revision" },
  { type: "data-phase", data: { kind: "preflight", draft: "draft" } },
  ...recordedTool("corpus", "describe_corpus", fixtureResult),
  { type: "data-phase", data: { kind: "investigate", draft: "draft" } },
  ...recordedTool(
    "draft-check",
    "check_claims",
    recordedCheck("r_aaaaaaaa", false)
  ),
  { type: "data-phase", data: { kind: "answer", draft: "draft" } },
  { type: "text-start", id: "draft-text" },
  { type: "text-delta", id: "draft-text", delta: recordedDraft },
  { type: "text-end", id: "draft-text" },
  {
    type: "data-gate",
    data: {
      version: "draft",
      findings: [
        {
          kind: "mismatch",
          fact: "r_deadbeef.f1",
          mismatch_on: ["value"],
          check_receipt_id: "r_aaaaaaaa",
          excerpt: "9 events",
        },
        {
          kind: "uncited",
          value: "44",
          start: 0,
          end: 2,
          excerpt: "Another 44 without evidence",
        },
      ],
    },
  },
  { type: "data-phase", data: { kind: "revise", draft: "final" } },
  ...recordedTool(
    "final-check",
    "check_claims",
    recordedCheck("r_bbbbbbbb", true)
  ),
  { type: "text-start", id: "final-text" },
  { type: "text-delta", id: "final-text", delta: recordedFinal },
  { type: "text-end", id: "final-text" },
  { type: "data-gate", data: { version: "final", findings: [] } },
  { type: "data-run", data: recordedRun },
  { type: "finish", finishReason: "stop" },
]

describe("recorded investigation protocol", () => {
  it("names the missing evidence in a follow-up phase and accepts legacy phases", () => {
    render(
      createElement(Conversation, {
        status: "ready",
        messages: [
          {
            id: "coverage-follow-up",
            role: "assistant",
            parts: [
              {
                type: "data-phase",
                data: { kind: "investigate", draft: "draft" },
              },
              {
                type: "data-phase",
                data: {
                  kind: "investigate",
                  draft: "draft",
                  requirement:
                    "event_trend; 1 claim(s) mismatch their cited fact",
                },
              },
              {
                type: "data-phase",
                data: { kind: "investigate", draft: "draft" },
              },
            ],
          },
        ],
      })
    )
    expect(
      screen.getByText(
        "Required evidence requested: event_trend; 1 claim(s) mismatch their cited fact"
      )
    ).toBeTruthy()
    expect(screen.getByText("Required evidence requested")).toBeTruthy()
  })

  it("splits the revision from its draft, marks citations and keeps each check independent", async () => {
    const wire = streamTransport()
    render(
      createElement(InvestigationView, {
        brief,
        available: true,
        chatTransport: wire.transport,
      })
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Investigate the recorded fixture" },
    })
    expect(screen.getByRole("textbox").getAttribute("maxlength")).toBe("4000")
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(wire.sendMessages).toHaveBeenCalledOnce())
    await act(async () => {
      for (const chunk of revisionChunks) wire.push(chunk)
      wire.close()
    })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Export run" })).toBeTruthy()
    )
    expect(screen.queryByText(/Another 44/)).toBeNull()
    expect(
      screen
        .getByRole("link", {
          name: "Fact r_deadbeef.f1, verified, open evidence",
        })
        .getAttribute("href")
    ).toContain("receipt=r_deadbeef&fact=r_deadbeef.f1")
    expect(
      screen.getByText(/Markings: 0 unchecked fact IDs · 0 uncited numbers/)
    ).toBeTruthy()
    expect(
      screen.getAllByText("1 claims checked · 1 mismatch · 0 unresolved")
    ).toHaveLength(2)
    expect(
      screen.getAllByText("1 claims checked · 0 mismatch · 0 unresolved")
    ).toHaveLength(2)
    expect(
      screen.getByText(
        /Revised after check: Mismatch on r_deadbeef.f1 \(value\)/
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: /Draft · 2 findings/ }))
    expect(
      await screen.findByRole("button", {
        name: "Uncited number 44: No fact ID next to this number",
      })
    ).toBeTruthy()
    expect(
      screen.getByRole("link", {
        name: "Fact r_deadbeef.f1, mismatch, open evidence",
      })
    ).toBeTruthy()
    expect(screen.getByRole("textbox")).toHaveProperty("value", "")
  })

  it("preserves a declined question and suppresses verification for a refusal", async () => {
    const wire = streamTransport()
    render(
      createElement(InvestigationView, {
        brief,
        available: true,
        chatTransport: wire.transport,
      })
    )
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Keep this declined question" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Send question" }))
    await waitFor(() => expect(wire.sendMessages).toHaveBeenCalledOnce())
    await act(async () => {
      wire.push({ type: "start", messageId: "refused" })
      wire.push({
        type: "data-run",
        data: { ...recordedRun, status: "refusal" },
      })
      wire.push({ type: "finish", finishReason: "stop" })
      wire.close()
    })
    await waitFor(() =>
      expect(screen.getByText(/The model declined this request/)).toBeTruthy()
    )
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "Keep this declined question"
    )
    expect(
      screen.queryByRole("region", { name: "Claim verification" })
    ).toBeNull()
  })

  it("renders the canonical adapter error and its correction hint", () => {
    render(
      createElement(Conversation, {
        status: "ready",
        messages: [
          {
            id: "adapter-failed",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "count_events",
                toolCallId: "timeout",
                state: "output-available",
                input: {},
                output: {
                  ok: false,
                  error: {
                    error: {
                      kind: "query_timeout",
                      message: "The query timed out.",
                      hint: "Choose a shorter time window.",
                    },
                  },
                },
              },
            ],
          },
        ],
      })
    )
    fireEvent.click(
      screen.getByRole("button", { name: /count_events.*Failed/ })
    )
    expect(
      screen.getByText("query_timeout · The query timed out.")
    ).toBeTruthy()
    expect(screen.getByText("Choose a shorter time window.")).toBeTruthy()
  })

  it.each(["timeout", "error", "stopped"])(
    "shows %s as an unverified partial answer",
    (status) => {
      render(
        createElement(Conversation, {
          status: "ready",
          messages: [
            {
              id: "partial-run",
              role: "assistant",
              parts: [
                { type: "text", text: "Partial response" },
                { type: "data-run", data: { ...recordedRun, status } },
              ],
            },
          ],
        })
      )
      expect(screen.getByText(/Partial answer – not verified/)).toBeTruthy()
      expect(
        screen.queryByRole("region", { name: "Claim verification" })
      ).toBeNull()
    }
  )
})

describe("Markdown boundaries", () => {
  it("preserves external URL targets and code while marking visible answer numbers", () => {
    render(
      createElement(Conversation, {
        status: "ready",
        messages: [
          {
            id: "markdown-edges",
            role: "assistant",
            parts: [
              {
                type: "text",
                text: "Read [reference](https://example.com/42). Keep `42` verbatim. Another 17 without evidence.",
              },
            ],
          },
        ],
      })
    )
    expect(
      screen.getByRole("link", { name: "reference" }).getAttribute("href")
    ).toBe("https://example.com/42")
    expect(
      screen.getByRole("button", {
        name: "Uncited number 17: No fact ID next to this number",
      })
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", {
        name: "Uncited number 42: No fact ID next to this number",
      })
    ).toBeNull()
  })
})
