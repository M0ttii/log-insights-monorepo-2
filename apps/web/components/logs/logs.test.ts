// @vitest-environment jsdom
import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { LoadedDatasetsProvider } from "@/components/providers/LoadedDatasets"
import { LogsView } from "./LogsView"

const { push } = vi.hoisted(() => ({ push: vi.fn<(url: string) => void>() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
afterEach(() => {
  cleanup()
  push.mockClear()
})

it.each([
  { dataset: "otel", label: /OpenTelemetry.*not loaded/ },
  { dataset: "unknown", label: /unknown.*unknown dataset/ },
])(
  "keeps unavailable URL dataset $dataset explicit when search is submitted again",
  ({ dataset, label }) => {
    render(
      createElement(
        LoadedDatasetsProvider,
        { datasets: ["bgl"] },
        createElement(LogsView, {
          initial: { dataset, q: "called" },
          outcome: null,
        })
      )
    )
    const unavailable = screen.getByRole("option", {
      name: label,
    })
    expect(unavailable).toHaveProperty("disabled", true)
    const form = screen
      .getByRole("button", { name: /^Search$/ })
      .closest("form")
    if (form === null) throw new Error("Search form missing")
    fireEvent.submit(form)
    expect(push).toHaveBeenCalledOnce()
    expect(
      new URLSearchParams(push.mock.calls[0]?.[0].split("?")[1]).get("dataset")
    ).toBe(dataset)
  }
)

it("replaces an unavailable dataset only when the user chooses another scope", () => {
  render(
    createElement(
      LoadedDatasetsProvider,
      { datasets: ["bgl"] },
      createElement(LogsView, {
        initial: { dataset: "otel", q: "called" },
        outcome: null,
      })
    )
  )
  fireEvent.change(screen.getByLabelText("Dataset", { exact: true }), {
    target: { value: "bgl" },
  })
  expect(screen.queryByRole("option", { name: /not loaded/ })).toBeNull()
  const form = screen.getByRole("button", { name: /^Search$/ }).closest("form")
  if (form === null) throw new Error("Search form missing")
  fireEvent.submit(form)
  expect(push).toHaveBeenCalledOnce()
  expect(
    new URLSearchParams(push.mock.calls[0]?.[0].split("?")[1]).get("dataset")
  ).toBe("bgl")
})

it("clears the previous time axis and incompatible fields on dataset changes", () => {
  render(
    createElement(
      LoadedDatasetsProvider,
      { datasets: ["bgl", "otel"] },
      createElement(LogsView, {
        initial: {
          dataset: "bgl",
          q: "called",
          from: "2005-06-01T00:00:00Z",
          to: "2005-06-02T00:00:00Z",
          node: "R02",
          only_errors: "true",
          match: "phrase",
          sort: "time_desc",
        },
        outcome: null,
      })
    )
  )
  expect(screen.getByLabelText("From (UTC)")).toHaveProperty(
    "value",
    "2005-06-01T00:00:00Z"
  )
  fireEvent.change(screen.getByLabelText("Dataset", { exact: true }), {
    target: { value: "otel" },
  })
  expect(screen.getByLabelText("From (UTC)")).toHaveProperty("value", "")
  expect(screen.getByLabelText("To (UTC)")).toHaveProperty("value", "")
  expect(screen.queryByLabelText("Node")).toBeNull()
  expect(screen.getByLabelText("Trace ID · log records only")).toBeTruthy()
  expect(
    screen.getByRole("textbox", { name: "Search message text" })
  ).toHaveProperty("value", "called")
  fireEvent.change(screen.getByLabelText("Dataset", { exact: true }), {
    target: { value: "bgl" },
  })
  expect(screen.getByLabelText("From (UTC)")).toHaveProperty("value", "")
  expect(screen.getByLabelText("To (UTC)")).toHaveProperty("value", "")
  expect(screen.getByLabelText("Node")).toHaveProperty("value", "")
  expect(screen.getByLabelText("Error events only")).toHaveProperty("value", "")
  expect(screen.getByLabelText("Match", { exact: true })).toHaveProperty(
    "value",
    "phrase"
  )
  expect(screen.getByLabelText("Sort", { exact: true })).toHaveProperty(
    "value",
    "time_desc"
  )
})
