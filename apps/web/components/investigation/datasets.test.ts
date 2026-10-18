// @vitest-environment jsdom
import { createElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { LoadedDatasetsProvider } from "@/components/providers/LoadedDatasets"
import { ScopeControls } from "./ScopeControls"
import type { Filter } from "@workspace/domain/filters"

afterEach(cleanup)

it("offers only loaded datasets and preserves an explicit OTel selection", async () => {
  const onChange = vi.fn<(scope: Filter) => void>()
  render(
    createElement(
      LoadedDatasetsProvider,
      {
        datasets: ["otel", "otel_replay"],
      },
      createElement(ScopeControls, {
        scope: {},
        onChange,
        disabled: false,
      })
    )
  )
  fireEvent.click(screen.getByRole("button", { name: /^Choose dataset/ }))
  expect(screen.queryByRole("menuitemradio", { name: "BGL" })).toBeNull()
  fireEvent.click(
    await screen.findByRole("menuitemradio", {
      name: "OpenTelemetry logs (text_bench)",
    })
  )
  expect(onChange).toHaveBeenCalledWith({ dataset: "otel" })
})

it("does not pretend datasets are loaded when the catalog is unavailable", async () => {
  render(
    createElement(ScopeControls, {
      scope: {},
      onChange: vi.fn<(scope: Filter) => void>(),
      disabled: false,
    })
  )
  fireEvent.click(screen.getByRole("button", { name: /^Choose dataset/ }))
  expect(await screen.findByText(/Loaded datasets unavailable/)).toBeTruthy()
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(1)
})
