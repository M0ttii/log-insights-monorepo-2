import { LOG_TEXT_ANALYZER } from "../../src/analyzer.ts"
import { failureOf } from "../db.ts"
import { check, equals, type Check, type Probe } from "../probe.ts"

const SCHEMA = "gate_u25"
const TABLE = `${SCHEMA}.events`
const INDEX = `${SCHEMA}.events_idx`
const planText = (rows: Array<Record<string, unknown>>) =>
  rows.map((row) => Object.values(row).join(" ")).join("\n")

const facet = (relation: string, where = "") =>
  `SELECT category, count(*) AS n FROM ${relation} ${where}
   GROUP BY category ORDER BY category NULLS FIRST`

const combined = (relation: string) => `SELECT dataset, category, count(*) AS n
  FROM ${relation} GROUP BY dataset, category ORDER BY dataset, category NULLS FIRST`

const range = (relation: string) => `SELECT event_id FROM ${relation}
  WHERE ts >= $1::TIMESTAMPTZ AND ts < $2::TIMESTAMPTZ
    AND event_id >= $3::BIGINT AND event_id < $4::BIGINT ORDER BY event_id`

const scores = (index: string, name: string) => `SELECT event_id,
  BM25(${name}.tableoid) AS score FROM ${index}
  WHERE message @@ 'parity' AND ts >= $1::TIMESTAMPTZ
    AND ts < $2::TIMESTAMPTZ ORDER BY event_id`
/** Small, deterministic counterparts of the full-corpus U25 measurements. */
export const g12IndexFunctions: Probe = {
  id: "G12",
  title: "Dictionary facets, token regex and indexed range boundaries (U25)",
  async run({ db }) {
    const checks: Check[] = []
    await db.rows(`CREATE SCHEMA ${SCHEMA}`)
    try {
      await db.rows(`CREATE TEXT SEARCH DICTIONARY ${SCHEMA}.text AS
        ${LOG_TEXT_ANALYZER} WITH (frequency, position, norm)`)
      await db.rows(`CREATE TABLE ${TABLE} (
        event_id BIGINT, dataset VARCHAR NOT NULL, category VARCHAR,
        ts TIMESTAMPTZ, message VARCHAR)`)
      await db.rows(`CREATE INDEX events_idx ON ${TABLE} USING inverted (
        event_id, dataset, category, ts, message ${SCHEMA}.text)
        WITH (refresh_interval = 0, compaction_interval = 0)`)
      // Separate refreshes create multiple segments. IDs exceed JS's safe
      // integer range; times differ by one microsecond and include a tie.
      await db.rows(`INSERT INTO ${TABLE} VALUES
        (9007199254740993, 'a', 'x', '2005-06-03 00:00:00.000001Z', 'R02-M1-N0 0x00544eb8 parity'),
        (9007199254740994, 'a', NULL, '2005-06-03 00:00:00.000002Z', 'cache parity')`)
      await db.rows(`VACUUM (REFRESH_TABLE) ${TABLE}`)
      await db.rows(`INSERT INTO ${TABLE} VALUES
        (9007199254740995, 'b', 'y', '2005-06-03 00:00:00.000002Z', '0x0054abcd'),
        (9007199254740996, 'b', 'x', '2005-06-03 00:00:00.000003Z', 'quiet')`)
      await db.rows(`VACUUM (REFRESH_TABLE) ${TABLE}`)

      const implicit = await db.rows(facet(INDEX))
      const implicitPlan = planText(await db.rows(`EXPLAIN ${facet(INDEX)}`))
      checks.push(
        equals(
          "nullable implicit facet preserves the NULL group",
          [
            { category: null, n: "1" },
            { category: "x", n: "2" },
            { category: "y", n: "1" },
          ],
          implicit
        ),
        check(
          "nullable bare facet uses TsDict",
          "TsDict: category",
          implicitPlan,
          implicitPlan.includes("TsDict: category")
        )
      )
      checks.push(
        equals(
          "explicit filtered facet omits NULL (not a drop-in replacement)",
          [{ category: "x", n: "1" }],
          await db.rows(
            `SELECT category, n::BIGINT AS n FROM (
        SELECT unnest(ts_dict_agg(category)) AS category,
          unnest(ts_dict_count(category)) AS n FROM ${INDEX} WHERE dataset = $1)
        ORDER BY category NULLS FIRST`,
            ["a"]
          )
        )
      )
      const filteredPlan = planText(
        await db.rows(`EXPLAIN ${facet(INDEX, "WHERE dataset = 'a'")}`)
      )
      checks.push(
        equals(
          "filtered nullable facet preserves NULL",
          await db.rows(facet(TABLE, "WHERE dataset = 'a'")),
          await db.rows(facet(INDEX, "WHERE dataset = 'a'"))
        )
      )
      checks.push(
        equals(
          "filtered nullable facet also uses the dictionary (broader than docs)",
          true,
          filteredPlan.includes("TsDict:")
        )
      )
      checks.push(
        equals(
          "nullable distinct/min/max match the base table",
          await db.rows(
            `SELECT count(DISTINCT category), min(category), max(category) FROM ${TABLE}`
          ),
          await db.rows(
            `SELECT count(DISTINCT category), min(category), max(category) FROM ${INDEX}`
          )
        )
      )
      checks.push(
        equals(
          "two dimensions retain their joint distribution",
          await db.rows(combined(TABLE)),
          await db.rows(combined(INDEX))
        )
      )

      for (const [pattern, expected] of [
        ["0x0054.*", "2"],
        [".*parity.*", "2"],
        ["r02-m1-n0.*", "0"],
        ["r02", "1"],
        ["PARITY", "0"],
        ["(?i)PARITY", "2"],
        ["no_such_term", "0"],
      ]) {
        const where = "message @@ ts_regexp($1::VARCHAR)"
        const count = await db.value(
          `SELECT count(*) FROM ${INDEX} WHERE ${where}`,
          [pattern]
        )
        const listed = await db.value(
          `SELECT count(*) FROM (
          SELECT event_id FROM ${INDEX} WHERE ${where} ORDER BY event_id)`,
          [pattern]
        )
        checks.push(
          equals(`token regex ${pattern}: expected count`, expected, count)
        )
        checks.push(
          equals(`token regex ${pattern}: count = complete list`, count, listed)
        )
      }
      checks.push(
        equals(
          "raw split identifier exists even though token regex misses it",
          "1",
          await db.value(
            `SELECT count(*) FROM ${TABLE} WHERE regexp_matches(message, $1)`,
            ["R02-M1-N0"]
          )
        )
      )
      // On this image malformed token regexes match nothing; a future
      // tool mode must not advertise engine-side syntax validation.
      checks.push(
        equals(
          "invalid token regex currently returns an empty list",
          [],
          await db.rows(
            `SELECT event_id FROM ${INDEX}
          WHERE message @@ ts_regexp($1::VARCHAR) ORDER BY event_id`,
            ["["]
          )
        )
      )

      const ranges = [
        [
          "2005-06-03T00:00:00.000001Z",
          "2005-06-03T00:00:00.000002Z",
          ["9007199254740993"],
        ],
        [
          "2005-06-03T00:00:00.000002Z",
          "2005-06-03T00:00:00.000003Z",
          ["9007199254740994", "9007199254740995"],
        ],
        ["2005-06-03T00:00:00.000003Z", "2005-06-03T00:00:00.000004Z", []],
        ["2005-06-03T00:00:00.000000Z", "2005-06-03T00:00:00.000001Z", []],
      ] as const
      for (const phase of ["off", "background", "compacted"]) {
        if (phase === "background")
          await db.rows(`ALTER INDEX ${INDEX} SET (compaction_interval = 1)`)
        if (phase === "compacted")
          await db.rows(`VACUUM (COMPACT_INDEX) ${INDEX}`)
        for (const [from, to, expectedIds] of ranges) {
          const params = [from, to, "9007199254740993", "9007199254740996"]
          const baseRows = await db.rows(range(TABLE), params)
          checks.push(
            equals(
              `literal boundary IDs (${phase}, ${from})`,
              expectedIds,
              baseRows.map((row) => row["event_id"])
            ),
            equals(
              `indexed half-open microsecond/ID range (${phase}, ${from})`,
              baseRows,
              await db.rows(range(INDEX), params)
            )
          )
        }
      }
      const rangePlan = planText(
        await db.rows(`EXPLAIN ${range(INDEX)}`, [
          ranges[1][0],
          ranges[1][1],
          "9007199254740993",
          "9007199254740996",
        ])
      )
      checks.push(
        check(
          "ts and event_id ranges run inside the index",
          "Index Filter on ts and event_id, no Column Filter",
          rangePlan,
          rangePlan.includes("Field: ts") &&
            rangePlan.includes("Field: event_id") &&
            !rangePlan.includes("Column Filter")
        )
      )
      await db.rows(`CREATE INDEX text_idx ON ${TABLE} USING inverted (
        dataset, category, message ${SCHEMA}.text)
        WITH (refresh_interval = 0, compaction_interval = 0)`)
      await db.rows(`VACUUM (REFRESH_TABLE) ${TABLE}`)
      const outsideTime = await failureOf(() =>
        db.rows(
          `SELECT unnest(ts_dict_agg(category)) AS category
         FROM ${SCHEMA}.text_idx WHERE ts >= $1::TIMESTAMPTZ`,
          [ranges[0][0]]
        )
      )
      checks.push(
        check(
          "explicit facet rejects a non-indexed time predicate",
          "WHERE accepts indexed document predicates error",
          outsideTime,
          outsideTime?.message.includes(
            "WHERE accepts indexed document predicates"
          ) === true
        )
      )
      const scoreParams = [ranges[0][0], ranges[2][1]]
      const columnScores = await db.rows(
        scores(`${SCHEMA}.text_idx`, "text_idx"),
        scoreParams
      )
      const indexScores = await db.rows(
        scores(INDEX, "events_idx"),
        scoreParams
      )
      checks.push(
        check(
          "indexed range filters change BM25 scores (migration rejected)",
          "same IDs, different scores",
          { columnScores, indexScores },
          columnScores.length > 0 &&
            JSON.stringify(columnScores.map((row) => row["event_id"])) ===
              JSON.stringify(indexScores.map((row) => row["event_id"])) &&
            JSON.stringify(columnScores) !== JSON.stringify(indexScores)
        )
      )
      return checks
    } finally {
      await db.rows(`DROP SCHEMA ${SCHEMA} CASCADE`)
    }
  },
}
