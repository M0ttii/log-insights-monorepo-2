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
    // field, as receipt files of different tool versions would differ. The
    // second time carries an offset: it is 15:00:01 UTC.
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
        created_at: "2026-10-17T17:00:01.000000+02:00",
        facts: [{ id: "r_9a7e0002.f1", value: 3 }],
      })
    )

    const glob = `${config.containerReceiptsDir}/gate-probe/*.json`
    // The session runs under UTC (db.ts). epoch_us and strftime pin the
    // instant and the microseconds independently of the text rendering.
    const rows = await db.rows(
      `SELECT receipt_id, tool, duration_ms, typeof(created_at) AS created_at_type,
              created_at::TEXT AS created_at, epoch_us(created_at) AS created_at_us,
              strftime(created_at, '%Y-%m-%dT%H:%M:%S.%fZ') AS created_at_iso
       FROM read_json('${glob}', union_by_name = true) ORDER BY receipt_id`
    )
    const [stats] = await db.rows(
      `SELECT count(*) AS receipts, median(duration_ms) AS median_ms,
              count(*) FILTER (WHERE facts IS NOT NULL) AS with_facts
       FROM read_json('${glob}', union_by_name = true)`
    )

    return [
      // 26.09.1.3 inferred TIMESTAMP (text without offset, e.g.
      // '2026-10-17 15:00:00.000001') for the same UTC instants.
      equals(
        "read_json reads every file of the glob; ISO strings become TIMESTAMPTZ with the same UTC instant and microseconds",
        [
          {
            receipt_id: "r_9a7e0001",
            tool: "count_events",
            duration_ms: 12.5,
            created_at_type: "TIMESTAMP WITH TIME ZONE",
            created_at: "2026-10-17 15:00:00.000001+00",
            created_at_us: "1792249200000001",
            created_at_iso: "2026-10-17T15:00:00.000001Z",
          },
          {
            receipt_id: "r_9a7e0002",
            tool: "search_logs",
            duration_ms: 7.25,
            created_at_type: "TIMESTAMP WITH TIME ZONE",
            created_at: "2026-10-17 15:00:01+00",
            created_at_us: "1792249201000000",
            created_at_iso: "2026-10-17T15:00:01.000000Z",
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
