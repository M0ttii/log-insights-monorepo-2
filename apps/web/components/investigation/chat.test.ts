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
      screen.getByRole("button", { name: "search logs · Interrupted" })
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
      screen.getByRole("button", { name: "search logs · Running" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "count events · Failed" })
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
      screen.getByRole("button", { name: "Investigation order · Complete" })
    )
    expect(screen.getByText("Truncated")).toBeTruthy()
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
