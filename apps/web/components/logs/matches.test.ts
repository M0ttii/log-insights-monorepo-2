import { describe, expect, it } from "vitest"
import { messageParts } from "./matches"
describe("SereneDB match ranges", () => {
  it("keeps supplementary Unicode before and inside a match intact", () => {
    expect(messageParts("🙂 disk 💥 failure", [{ start: 2, end: 8 }])).toEqual([
      { text: "🙂 ", matched: false, start: 0 },
      { text: "disk 💥", matched: true, start: 2 },
      { text: " failure", matched: false, start: 8 },
    ])
  })
  it("keeps untrusted markup verbatim instead of interpreting it", () => {
    const message = '<img src=x onerror="alert(1)">'
    expect(
      messageParts(message, [])
        .map((part) => part.text)
        .join("")
    ).toBe(message)
  })
})
