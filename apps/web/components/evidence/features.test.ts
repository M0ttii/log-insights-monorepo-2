import { describe, expect, it } from "vitest"
import { receiptFeatures } from "./features"
describe("receipt feature provenance", () => {
  it("does not advertise row pattern matching for a legacy lag query", () => {
    expect(
      receiptFeatures(["SELECT lag(ts) OVER (ORDER BY ts, event_id) FROM logs"])
    ).toEqual([])
  })
  it("recognizes only functions in this receipt's SQL", () => {
    expect(
      receiptFeatures([
        "SELECT BM25(message), ts_offsets(message, ts_phrase($1::VARCHAR)) FROM logs",
      ]).map((feature) => feature.label)
    ).toEqual(["BM25 ranking", "Phrase search", "Match ranges"])
    expect(
      receiptFeatures([
        "SELECT quantile_cont(latency_ms, [0.5, 0.95]) FROM api_access",
      ]).map((feature) => feature.label)
    ).toEqual(["Percentiles"])
  })
})
