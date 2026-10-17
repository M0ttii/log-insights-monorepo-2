import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { equals, type Probe } from "../probe.ts"

export const g07ReadReceipts: Probe = {
  id: "G7",
  title: "read_json over a glob on the receipts mount",
  async run({ config, db }) {
    const hostDir = join(config.hostReceiptsDir, "gate-probe")
    await mkdir(hostDir, { recursive: true })
    // One file with a trailing newline, one without and with an extra nested
    // field, as receipt files of different tool versions would differ.
    await writeFile(
      join(hostDir, "r_9a7e0001.json"),
      `${JSON.stringify({ receipt_id: "r_9a7e0001", tool: "count_events", duration_ms: 12.5, created_at: "2026-10-17T15:00:00.000001Z" })}\n`
    )
    await writeFile(
      join(hostDir, "r_9a7e0002.json"),
      JSON.stringify({
        receipt_id: "r_9a7e0002",
        tool: "search_logs",
        duration_ms: 7.25,
        created_at: "2026-10-17T15:00:01.000000Z",
        facts: [{ id: "r_9a7e0002.f1", value: 3 }],
      })
    )

    const glob = `${config.containerReceiptsDir}/gate-probe/*.json`
    const rows = await db.rows(
      `SELECT receipt_id, tool, duration_ms, created_at::TEXT AS created_at
       FROM read_json('${glob}', union_by_name = true) ORDER BY receipt_id`
    )
    const [stats] = await db.rows(
      `SELECT count(*) AS receipts, median(duration_ms) AS median_ms,
              count(*) FILTER (WHERE facts IS NOT NULL) AS with_facts
       FROM read_json('${glob}', union_by_name = true)`
    )

    return [
      equals(
        "read_json reads every file of the glob; ISO strings become timestamps",
        [
          {
            receipt_id: "r_9a7e0001",
            tool: "count_events",
            duration_ms: 12.5,
            created_at: "2026-10-17 15:00:00.000001",
          },
          {
            receipt_id: "r_9a7e0002",
            tool: "search_logs",
            duration_ms: 7.25,
            created_at: "2026-10-17 15:00:01",
          },
        ],
        rows
      ),
      equals(
        "aggregates over receipts in SereneDB; union_by_name tolerates extra fields",
        { receipts: "2", median_ms: 9.875, with_facts: "1" },
        stats
      ),
    ]
  },
}
