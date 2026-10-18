import { LOG_TEXT_ANALYZER } from "../../src/analyzer.ts"
import {
  check,
  equals,
  type Check,
  type Info,
  type Probe,
  type Skip,
} from "../probe.ts"

const SCHEMA = "gate_otel_counts"
const TABLE = `${SCHEMA}.events`
const INDEX = `${SCHEMA}.events_idx`
const planText = (rows: Array<Record<string, unknown>>) =>
  rows.map((row) => Object.values(row).join(" ")).join("\n")
const grouped = (relation: string, count: string) =>
  `SELECT component, ${count} AS n FROM ${relation}
   WHERE message @@ plainto_tsquery('visa cache full')
   GROUP BY component ORDER BY component`

/** G13 distinguishes a reproducible plan hazard from an observed full-data defect. */
export const g13OtelCounts: Probe = {
  id: "G13",
  title: "Full-text dictionary facets and nanosecond timestamp coercion (OTel)",
  async run({ db }) {
    const checks: Array<Check | Info | Skip> = []
    await db.rows(`CREATE SCHEMA ${SCHEMA}`)
    try {
      await db.rows(`CREATE TEXT SEARCH DICTIONARY ${SCHEMA}.text AS
        ${LOG_TEXT_ANALYZER} WITH (frequency, position, norm)`)
      await db.rows(`CREATE TABLE ${TABLE} (
        event_id BIGINT, component VARCHAR, ts TIMESTAMPTZ_NS, message VARCHAR)`)
      await db.rows(`INSERT INTO ${TABLE} VALUES
        (1, 'frontend', '2025-09-23T00:00:00.500007604Z', 'Visa cache full'),
        (2, 'frontend', '2025-09-23T00:00:00.500008001Z', 'Visa cache full'),
        (3, 'cart', '2025-09-23T00:00:00.500009001Z', 'Visa unrelated'),
        (4, 'email', '2025-09-23T00:00:00.500009002Z', 'cache full unrelated'),
        (5, 'payment', '2025-09-23T00:00:00.500009003Z', 'Visa cache full')`)
      await db.rows(`CREATE INDEX events_idx ON ${TABLE} USING inverted (
        component, message ${SCHEMA}.text) INCLUDE (ts, event_id)`)
      const starPlan = planText(
        await db.rows(`EXPLAIN ${grouped(INDEX, "count(*)")}`)
      )
      const tsPlan = planText(
        await db.rows(`EXPLAIN ${grouped(INDEX, "count(ts)")}`)
      )
      const expected = [
        { component: "frontend", n: "2" },
        { component: "payment", n: "1" },
      ]
      checks.push(
        check(
          "count(*) with full text uses dictionary facets",
          "TsDict: component",
          starPlan,
          starPlan.includes("TsDict: component")
        ),
        check(
          "count(ts) avoids the dictionary facet plan",
          "no TsDict",
          tsPlan,
          !tsPlan.includes("TsDict:")
        ),
        equals(
          "count(ts) counts matching rows",
          expected,
          await db.rows(grouped(INDEX, "count(ts)"))
        ),
        equals(
          "small count(*) counterpart currently agrees (not a defect reproduction)",
          expected,
          await db.rows(grouped(INDEX, "count(*)"))
        ),
        {
          info: "This five-row fixture proves the unsafe plan shape only. It does not reproduce the full OTel count(*) defect; no BGL parity miscount is claimed.",
        }
      )
      const bounds = [
        "2025-09-23T00:00:00.500008Z",
        "2025-09-23T00:00:00.500010Z",
      ]
      checks.push(
        equals(
          "TIMESTAMPTZ_NS bounds preserve the half-open lower edge",
          "4",
          await db.value(
            `SELECT count(*) FROM ${TABLE} WHERE ts >= $1::TIMESTAMPTZ_NS AND ts < $2::TIMESTAMPTZ_NS`,
            bounds
          )
        ),
        equals(
          "TIMESTAMPTZ bounds round a nanosecond column and include the earlier row",
          "5",
          await db.value(
            `SELECT count(*) FROM ${TABLE} WHERE ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ`,
            bounds
          )
        ),
        equals(
          "output formatting truncates while a microsecond cast rounds",
          [{ truncated: "500007", rounded: "500008" }],
          await db.rows(
            `SELECT strftime(ts, '%f') AS truncated, strftime(ts::TIMESTAMPTZ, '%f') AS rounded FROM ${TABLE} WHERE event_id = 1 ORDER BY event_id`
          )
        )
      )
      const exists = await db.value(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'otel_ref'"
      )
      if (String(exists) === "0") {
        checks.push({
          skipped:
            "Full remote OTel reference is not loaded; the small fixture proves the plan shape, not a miscount.",
        })
      } else {
        // Optional local observation. Do not lock the faulty values in as a correct result:
        // fixed engine versions may change them. The row count must still match raw evidence.
        const star = await db.rows(grouped("otel_ref_idx", "count(*)"))
        const ts = await db.rows(grouped("otel_ref_idx", "count(ts)"))
        const raw = await db.rows(`SELECT component, count(*) AS n FROM otel_ref
          WHERE regexp_matches(message, '(?i)visa cache full')
          GROUP BY component ORDER BY component`)
        checks.push(
          equals(
            "loaded OTel count(ts) agrees with raw phrase evidence",
            raw,
            ts
          ),
          {
            info: `Loaded reference: count(*)=${JSON.stringify(star)}; count(ts)=${JSON.stringify(ts)}; raw phrase=${JSON.stringify(raw)}. This observation covers only the loaded reference window.`,
          }
        )
      }
      return checks
    } finally {
      await db.rows(`DROP SCHEMA ${SCHEMA} CASCADE`)
    }
  },
}
