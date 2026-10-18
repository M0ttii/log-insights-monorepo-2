// @vitest-environment jsdom
import { createElement } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Receipt, ReceiptSource } from "@workspace/domain/receipt"
import { EvidenceDrawer } from "./EvidenceDrawer"

vi.mock("next/navigation", () => ({
  usePathname: () => "/datasets",
  useSearchParams: () => new URLSearchParams("receipt=r_7f3a9c21"),
  useRouter: () => ({ replace: vi.fn<(url: string) => void>() }),
}))

const remoteSource: ReceiptSource = {
  dataset: "otel",
  kind: "remote_parquet",
  path: "indexed_window",
  window: {
    from: "2025-09-23T10:00:00.000000Z",
    to: "2025-09-23T10:01:00.000000Z",
  },
  files: [
    {
      file_index: 0,
      url: "https://example.test/text_bench/part_000.parquet",
      bytes: 4096,
      etag: "synthetic-version-stamp",
      last_modified: "Tue, 23 Sep 2025 10:02:00 GMT",
      assigned_from: "2025-09-23T10:00:00.000000000Z",
      assigned_to: "2025-09-23T10:02:00.000000000Z",
      read_from: "2025-09-23T10:00:00.000000000Z",
      read_to: "2025-09-23T10:01:00.000000000Z",
    },
  ],
  mapping_version: "synthetic-mapping",
  index: {
    name: "synthetic_reference_index",
    glob: "https://example.test/text_bench/part_*.parquet",
    from: "2025-09-23T10:00:00.000000Z",
    to: "2025-09-23T10:01:00.000000Z",
    built_at: "2026-10-18T08:00:00.000000Z",
    build_ms: 12,
  },
  source_check: {
    method: "read_blob size and last_modified",
    files_checked: 1,
  },
  bytes_read: {
    kind: "not_measured",
    reason: "Normal queries do not instrument remote bytes.",
  },
  bytes_estimated_from_footer: null,
}
const replaySource: ReceiptSource = {
  dataset: "otel_replay",
  kind: "otlp_replay",
  replay_id: "synthetic-replay",
  replayed_at: "2026-10-18T07:00:00.000000Z",
  records: 32,
  fixture: {
    path: "fixtures/synthetic-otel.json",
    sha256: "c".repeat(64),
    source_url: "https://example.test/text_bench/part_000.parquet",
  },
  listener_table: "otel_listener",
  index: {
    name: "synthetic_replay_index",
    built_at: "2026-10-18T08:00:00.000000Z",
  },
}
function receipt(source?: ReceiptSource): Receipt {
  return {
    receipt_id: "r_7f3a9c21",
    created_at: "2026-10-18T09:00:00.000000Z",
    client: "test",
    tool: "count_events",
    tool_version: "1.0.0",
    input: { dataset: source?.dataset ?? "bgl" },
    signature: "a".repeat(64),
    data_version: "synthetic-ui-fixture",
    sql: [],
    params: [],
    scope: { windows: [], filters: { only_errors: false } },
    population: { count: 14, unit: "log_events" },
    rows_returned: 1,
    truncated: false,
    row_limit: 20,
    duration_ms: 1,
    result: { total: 14 },
    result_digest: "b".repeat(64),
    facts: [],
    ...(source ? { source } : {}),
  }
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
})

describe("receipt source provenance", () => {
  it("shows the queried remote files, window, path, mapping and index snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(receipt(remoteSource)))
    )
    render(createElement(EvidenceDrawer))
    fireEvent.click(await screen.findByRole("tab", { name: "Source" }))
    const source = await screen.findByRole("region", { name: "Receipt source" })
    for (const text of [
      "indexed_window",
      "https://example.test/text_bench/part_000.parquet",
      "synthetic-version-stamp",
      "synthetic-mapping",
      "synthetic_reference_index",
      "2026-10-18T08:00:00.000000Z",
      "not_measured",
    ])
      expect(within(source).getByText(text)).toBeTruthy()
    expect(source.textContent).toContain("2025-09-23T10:00:00.000000Z")
    expect(source.textContent).toContain("2025-09-23T10:01:00.000000Z")
  })

  it("keeps direct-scan estimates separate from measured bytes and retains an absent index", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          receipt({
            ...remoteSource,
            path: "direct_scan",
            index: null,
            bytes_estimated_from_footer: {
              kind: "estimate",
              bytes: 2048,
              row_groups: 1,
              basis: "Synthetic footer upper bound",
            },
          })
        )
      )
    )
    render(createElement(EvidenceDrawer))
    fireEvent.click(await screen.findByRole("tab", { name: "Source" }))
    const source = await screen.findByRole("region", { name: "Receipt source" })
    expect(within(source).getByText("direct_scan")).toBeTruthy()
    expect(within(source).getByText("not_measured")).toBeTruthy()
    expect(within(source).getByText("estimate")).toBeTruthy()
    expect(
      within(source).getByText("Synthetic footer upper bound")
    ).toBeTruthy()
    const index = within(source).getByText("index").parentElement
    expect(index?.textContent).toContain("Unknown")
  })

  it("shows the bounded replay fixture, listener and frozen index snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(receipt(replaySource)))
    )
    render(createElement(EvidenceDrawer))
    fireEvent.click(await screen.findByRole("tab", { name: "Source" }))
    const source = await screen.findByRole("region", { name: "Receipt source" })
    for (const text of [
      "synthetic-replay",
      "fixtures/synthetic-otel.json",
      "otel_listener",
      "synthetic_replay_index",
    ]) {
      expect(within(source).getByText(text)).toBeTruthy()
    }
    expect(source.textContent).toContain("2026-10-18T08:00:00.000000Z")
  })

  it("preserves source_changed and its correction hint on re-run without creating a new receipt", async () => {
    const fetchReceipt = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(receipt(remoteSource)))
      .mockResolvedValueOnce(
        Response.json(
          {
            ok: false,
            error: {
              code: "source_changed",
              message:
                "The remote source no longer matches its loaded version stamp.",
              hint: "Reload the pinned metadata and rebuild the reference index before retrying.",
              files: ["https://example.test/text_bench/part_000.parquet"],
            },
          },
          { status: 409 }
        )
      )
    vi.stubGlobal("fetch", fetchReceipt)
    render(createElement(EvidenceDrawer))
    fireEvent.click(await screen.findByRole("button", { name: "Re-run" }))
    expect(
      await screen.findByText(
        "The remote source no longer matches its loaded version stamp."
      )
    ).toBeTruthy()
    expect(
      screen.getByText(
        "Reload the pinned metadata and rebuild the reference index before retrying."
      )
    ).toBeTruthy()
    expect(screen.queryByText("Same result")).toBeNull()
    expect(screen.queryByRole("link", { name: /Open receipt/ })).toBeNull()
    expect(fetchReceipt).toHaveBeenCalledTimes(2)
  })

  it("keeps unvalidated response bodies behind a generic failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json(receipt()))
        .mockResolvedValueOnce(
          Response.json(
            { raw_database_error: "private database detail" },
            { status: 503 }
          )
        )
    )
    render(createElement(EvidenceDrawer))
    fireEvent.click(await screen.findByRole("button", { name: "Re-run" }))
    expect(
      await screen.findByText("Re-run failed. Check SereneDB and try again.")
    ).toBeTruthy()
    expect(screen.queryByText(/private database detail/)).toBeNull()
    expect(screen.queryByRole("region", { name: "Receipt source" })).toBeNull()
  })
})
