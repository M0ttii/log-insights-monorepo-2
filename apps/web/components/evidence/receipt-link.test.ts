// @vitest-environment jsdom
import { createElement } from "react"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Receipt } from "@workspace/domain/receipt"
import { ReceiptLink } from "./ReceiptLink"

vi.mock("next/navigation", () => ({
  usePathname: () => "/investigations/new",
  useSearchParams: () => new URLSearchParams("role=engineer"),
}))

const receipt: Receipt = {
  receipt_id: "r_7f3a9c21",
  created_at: "2026-10-17T12:00:00.000000Z",
  client: "test",
  tool: "count_events",
  tool_version: "1.0.0",
  input: { dataset: "bgl" },
  signature: "a".repeat(64),
  data_version: "test-only",
  sql: [],
  params: [],
  scope: {
    windows: [
      {
        dataset: "bgl",
        from: "2005-06-03T22:42:50.363779Z",
        to: "2006-01-04T16:00:05.233640Z",
      },
    ],
    filters: { only_errors: true },
  },
  population: { count: 1204, unit: "log_events" },
  rows_returned: 1,
  truncated: false,
  row_limit: 20,
  duration_ms: 12.5,
  result: { total: 1204 },
  result_digest: "b".repeat(64),
  facts: [
    {
      id: "r_7f3a9c21.f1",
      path: "/result/total",
      value: 1204,
      metric: "events",
      unit: "log_events",
      group: { rack: "R00" },
    },
  ],
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function focusChip() {
  const link = screen.getByRole("link")
  fireEvent.keyDown(document, { key: "Tab" })
  await act(async () => link.focus())
  return link
}

describe("receipt-backed citation previews", () => {
  it("loads only on focus and preserves native link navigation and every fact field", async () => {
    const fetchReceipt = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(receipt))
    vi.stubGlobal("fetch", fetchReceipt)
    render(
      createElement(ReceiptLink, {
        id: receipt.receipt_id,
        fact: "r_7f3a9c21.f1",
        status: "verified",
      })
    )
    expect(fetchReceipt).not.toHaveBeenCalled()
    const link = await focusChip()
    expect(link.tagName).toBe("A")
    expect(link.getAttribute("role")).toBeNull()
    expect(link.getAttribute("href")).toBe(
      "/investigations/new?role=engineer&receipt=r_7f3a9c21&fact=r_7f3a9c21.f1"
    )
    await waitFor(() => expect(fetchReceipt).toHaveBeenCalledOnce())
    const preview = await screen.findByRole("tooltip")
    await waitFor(() => expect(preview.textContent).toContain("1,204"))
    for (const text of [
      "Value",
      "Metric",
      "events",
      "Unit",
      "log_events",
      "Group",
      "rack: R00",
      "Scope",
      "bgl",
      receipt.scope.windows[0]?.from,
      receipt.scope.windows[0]?.to,
      '"only_errors":true',
    ]) {
      expect(preview.textContent).toContain(text)
    }
  })

  it("shows the claim mismatch fields beside the unchanged receipt value", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt))
    )
    render(
      createElement(ReceiptLink, {
        id: receipt.receipt_id,
        fact: "r_7f3a9c21.f1",
        status: "mismatch",
        mismatchOn: ["value", "group"],
      })
    )
    await focusChip()
    const preview = await screen.findByRole("tooltip")
    await waitFor(() => expect(preview.textContent).toContain("1,204"))
    expect(preview.textContent).toContain("Mismatch on: value, group")
  })

  it("reports a missing fact without substituting another fact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(receipt))
    )
    render(
      createElement(ReceiptLink, {
        id: receipt.receipt_id,
        fact: "r_7f3a9c21.f9",
      })
    )
    await focusChip()
    const preview = await screen.findByRole("tooltip")
    await waitFor(() =>
      expect(preview.textContent).toContain("Fact unavailable")
    )
    expect(preview.textContent).not.toContain("1,204")
  })

  it.each([
    { response: { raw_database_error: "private" }, status: 503 },
    { response: { ...receipt, receipt_id: "r_11111111" }, status: 200 },
    { response: { ...receipt, scope: null }, status: 200 },
  ])(
    "rejects unavailable or invalid receipts without showing raw data ($status)",
    async ({ response, status }) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(Response.json(response, { status }))
      )
      render(
        createElement(ReceiptLink, {
          id: receipt.receipt_id,
          fact: "r_7f3a9c21.f1",
        })
      )
      await focusChip()
      const preview = await screen.findByRole("tooltip")
      await waitFor(() =>
        expect(preview.textContent).toContain("Receipt unavailable")
      )
      expect(preview.textContent).not.toContain("private")
      expect(preview.textContent).not.toContain("1,204")
    }
  )

  it("aborts the receipt request when the preview unmounts", async () => {
    let signal: AbortSignal | null | undefined
    const fetchReceipt = vi
      .fn<typeof fetch>()
      .mockImplementation((_input, init) => {
        signal = init?.signal
        return new Promise(() => undefined)
      })
    vi.stubGlobal("fetch", fetchReceipt)
    const view = render(createElement(ReceiptLink, { id: receipt.receipt_id }))
    await focusChip()
    await waitFor(() => expect(fetchReceipt).toHaveBeenCalledOnce())
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it("aborts on close and never retries a timed-out request in the same preview", async () => {
    const signals: AbortSignal[] = []
    const fetchReceipt = vi
      .fn<typeof fetch>()
      .mockImplementation((_input, init) => {
        const signal = init?.signal
        if (!signal) throw new Error("The request must have an abort signal")
        signals.push(signal)
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true }
          )
        })
      })
    vi.stubGlobal("fetch", fetchReceipt)
    render(createElement(ReceiptLink, { id: receipt.receipt_id }))
    const link = await focusChip()
    await waitFor(() => expect(fetchReceipt).toHaveBeenCalledOnce())
    fireEvent.keyDown(link, { key: "Escape" })
    await waitFor(() => expect(signals[0]?.aborted).toBe(true))
    await act(async () => link.blur())
    vi.useFakeTimers()
    await focusChip()
    expect(fetchReceipt).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(10_000))
    expect(signals[1]?.aborted).toBe(true)
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Receipt unavailable"
    )
    await act(async () => vi.advanceTimersByTimeAsync(30_000))
    expect(fetchReceipt).toHaveBeenCalledTimes(2)
  })
})
