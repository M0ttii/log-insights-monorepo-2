// @vitest-environment jsdom
import { createElement } from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Answer } from "./Answer"

vi.mock("next/navigation", () => ({
  usePathname: () => "/investigations/new",
  useSearchParams: () => new URLSearchParams(),
}))
afterEach(cleanup)

function answer(text: string) {
  return createElement(Answer, {
    text,
    role: "engineer",
    checks: [],
    outline: true,
  })
}

function linkedTarget(outline: HTMLElement, section: string) {
  const link = within(outline).getByRole("link", { name: section })
  const href = link.getAttribute("href")
  expect(href?.startsWith("#")).toBe(true)
  expect(link.getAttribute("target")).toBeNull()
  const target = document.getElementById(href?.slice(1) ?? "")
  expect(target).not.toBeNull()
  expect(target?.getAttribute("tabindex")).toBe("-1")
  return target
}

describe("answer outline", () => {
  it("jumps to canonical headings and paragraph-leading bold labels in original order", () => {
    const { container } = render(
      answer(
        "## Evidence\nRecorded evidence.\n\n**Scope:** BGL only.\n\n__Answer__ Observed symptoms."
      )
    )
    const outline = screen.getByRole("navigation", { name: "Answer outline" })
    expect(linkedTarget(outline, "Evidence")).toBe(
      screen.getByRole("heading", { name: "Evidence" })
    )
    expect(linkedTarget(outline, "Scope")?.tagName).toBe("STRONG")
    expect(linkedTarget(outline, "Answer")?.tagName).toBe("STRONG")
    expect(
      within(outline).getByText("Missing section: Next check")
    ).toBeTruthy()
    expect(
      Array.from(container.querySelectorAll("h2, strong")).map(
        (node) => node.textContent
      )
    ).toEqual(["Evidence", "Scope:", "Answer"])
  })

  it("uses distinct stable targets across answers and repeated section headings", () => {
    const text = "## Answer\nFirst result.\n\n## Answer\nRepeated label."
    const { container, rerender } = render(
      createElement("div", null, answer(text), answer(text))
    )
    const outlines = screen.getAllByRole("navigation", {
      name: "Answer outline",
    })
    const targets = outlines.map((outline) => linkedTarget(outline, "Answer"))
    expect(targets[0]).not.toBe(targets[1])
    const ids = Array.from(container.querySelectorAll("[id]")).map(
      (node) => node.id
    )
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(ids.length)
    expect(screen.getAllByRole("heading", { name: "Answer" })).toHaveLength(4)
    rerender(
      createElement("div", null, answer(`${text}\nMore text.`), answer(text))
    )
    expect(
      Array.from(container.querySelectorAll("[id]")).map((node) => node.id)
    ).toEqual(ids)
  })

  it("does not turn section-looking code or inline bold prose into outline targets", () => {
    const { container } = render(
      answer(
        "```text\n## Scope\n```\n\nObserved **Evidence** here.\n\n## Answer\nA conclusion."
      )
    )
    const outline = screen.getByRole("navigation", { name: "Answer outline" })
    expect(within(outline).queryByRole("link", { name: "Scope" })).toBeNull()
    expect(within(outline).queryByRole("link", { name: "Evidence" })).toBeNull()
    expect(container.querySelector("pre [id]")).toBeNull()
    expect(linkedTarget(outline, "Answer")).toBeTruthy()
  })
})
