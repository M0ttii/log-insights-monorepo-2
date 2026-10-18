// @vitest-environment jsdom
import { createElement } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ToolResult } from "@workspace/domain/tool"
import { DatasetCards } from "./DatasetCards"

vi.mock("next/navigation", () => ({
  usePathname: () => "/datasets",
  useSearchParams: () => new URLSearchParams(),
}))
afterEach(cleanup)

const result: ToolResult<unknown> = {
  data: {},
  facts: [
    {
      id: "r_7f3a9c21.f1",
      path: "/result/datasets/0/remote/footer_rows",
      value: 3200,
      metric: "footer_rows",
      unit: "rows",
      group: { dataset: "otel" },
    },
    {
      id: "r_7f3a9c21.f2",
      path: "/result/datasets/0/replay/records",
      value: 32,
      metric: "records",
      unit: "log_events",
      group: { dataset: "otel_replay" },
    },
  ],
  receipt: {
    receipt_id: "r_7f3a9c21",
    input: {},
    signature: "a".repeat(64),
    data_version: "synthetic-ui-fixture",
    sql: [],
    params: [],
    scope: { windows: [], filters: { only_errors: false } },
    population: null,
    rows_returned: 1,
    truncated: false,
    duration_ms: 1,
    result_digest: "b".repeat(64),
  },
  notes: [],
}

describe("dataset source metadata", () => {
  it("shows the returned title, indexed coverage, footer caveat and canonical remote facts", () => {
    render(
      createElement(DatasetCards, {
        datasets: [
          {
            dataset: "otel",
            title: "OpenTelemetry · remote Parquet",
            storage: "remote_parquet",
            counts_cover: "reference_window",
            events: null,
            error_events: 14,
            patterns: null,
            capabilities: { full_text: "reference_window", patterns: false },
            remote: {
              pin_kind: "version stamp",
              footer_rows: 3200,
              reference_window: {
                from: "2025-09-23T10:00:00.000000Z",
                to: "2025-09-23T10:01:00.000000Z",
                events: 3180,
              },
              scan_limits: { max_seconds: 60, max_files: 2 },
            },
            replay: null,
          },
        ],
        result,
      })
    )
    expect(screen.getByText("OpenTelemetry · remote Parquet")).toBeTruthy()
    expect(
      screen.getByText(/error counts.*indexed reference window only/i)
    ).toBeTruthy()
    expect(
      screen.getByText(/footer counts.*boundary duplicates.*distinct events/i)
    ).toBeTruthy()
    expect(screen.getByText("remote_parquet")).toBeTruthy()
    expect(screen.getByText("reference_window")).toBeTruthy()
    const errorRow = screen.getByText("error events").parentElement
    expect(errorRow?.textContent).toContain("14")
    const eventsRow = screen.getByText("events").parentElement
    expect(eventsRow?.textContent).toContain("Unknown")

    fireEvent.click(
      screen.getByRole("button", { name: "Schema, labels & details" })
    )
    expect(screen.getByRole("heading", { name: "capabilities" })).toBeTruthy()
    const remote = screen.getByRole("heading", { name: "remote" }).parentElement
    if (!remote) throw new Error("Remote source section missing")
    expect(within(remote).getByText("3,200")).toBeTruthy()
    expect(within(remote).getByText("version stamp")).toBeTruthy()
    expect(within(remote).getByText("2025-09-23T10:01:00.000000Z")).toBeTruthy()
    expect(
      within(remote)
        .getByRole("link", {
          name: "Fact r_7f3a9c21.f1, unchecked, open evidence",
        })
        .getAttribute("href")
    ).toContain("fact=r_7f3a9c21.f1")
    expect(screen.queryByRole("heading", { name: "replay" })).toBeNull()
  })

  it("labels a replay separately from production and keeps its canonical fact link", () => {
    render(
      createElement(DatasetCards, {
        datasets: [
          {
            dataset: "otel_replay",
            title: "OpenTelemetry · bounded OTLP replay",
            storage: "otlp_replay",
            counts_cover: "dataset",
            replay: {
              replay_id: "synthetic-replay",
              records: 32,
              fixture: {
                path: "fixtures/replay.json",
                selection: "Synthetic fixture selection",
              },
              index: {
                name: "replay_snapshot",
                built_at: "2026-10-18T08:00:00.000000Z",
              },
            },
            remote: null,
          },
        ],
        result,
      })
    )
    expect(screen.getByText("OpenTelemetry · bounded OTLP replay")).toBeTruthy()
    expect(screen.getByText(/replay.*production stream/i)).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "Schema, labels & details" })
    )
    expect(screen.getByText("synthetic-replay")).toBeTruthy()
    expect(screen.getByText("fixtures/replay.json")).toBeTruthy()
    expect(
      screen.getByRole("link", {
        name: "Fact r_7f3a9c21.f2, unchecked, open evidence",
      })
    ).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "remote" })).toBeNull()
  })
})
