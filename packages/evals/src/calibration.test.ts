import { describe, expect, it } from "vitest"
import { auditCalibration, calibrationPacket } from "./calibration.ts"

describe("independent reviewer calibration", () => {
  const packet = calibrationPacket("complete synthetic LOG-52 controls")
  const reviewer = {
    id: "independent",
    kind: "agent",
    version: "v1",
    independent_of_playbooks: true,
  }
  const calibration = {
    reviewer,
    source_sha256: packet.source_sha256,
    assessed_at: "2026-10-18T00:00:00Z",
    results: Object.entries(packet.controls).map(([control, judgment]) => ({
      control,
      judgment,
      reason:
        "Inspected the complete synthetic control and saved claims result.",
    })),
  }
  it("requires calibration for every reviewer identity and preserves originals", () => {
    expect(auditCalibration([], packet.source_sha256, [reviewer]).status).toBe(
      "unknown"
    )
    const report = auditCalibration([calibration], packet.source_sha256, [
      reviewer,
    ])
    expect(report.status).toBe("pass")
    expect(report.original_calibrations).toEqual([calibration])
    expect(
      auditCalibration([calibration], packet.source_sha256, [
        { ...reviewer, version: "v2" },
      ]).status
    ).toBe("unknown")
  })
  it("rejects wrong-group/status false passes, absent controls and changed provenance", () => {
    for (const name of ["wrong_group", "unsupported_hypothesis_status"])
      expect(
        auditCalibration(
          [
            {
              ...calibration,
              results: calibration.results.map((item) =>
                item.control === name ? { ...item, judgment: "pass" } : item
              ),
            },
          ],
          packet.source_sha256,
          [reviewer]
        ).status
      ).toBe("fail")
    expect(
      auditCalibration(
        [{ ...calibration, results: calibration.results.slice(1) }],
        packet.source_sha256,
        [reviewer]
      ).status
    ).toBe("fail")
    expect(
      auditCalibration([calibration], "0".repeat(64), [reviewer]).status
    ).toBe("fail")
  })
})
