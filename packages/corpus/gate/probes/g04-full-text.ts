import { check, equals, type Info, type Probe } from "../probe.ts"

/** Word-boundary regex equivalent of one lower-case index token, for independent counts. */
const tokenRegex = (token: string) => `(^|[^a-z0-9])${token}([^a-z0-9]|$)`

const FILTERS =
  "dataset = $2 AND level = $3 AND component = $4 AND ts >= $5::TIMESTAMPTZ AND ts < $6::TIMESTAMPTZ"
const FILTER_VALUES = [
  "bgl",
  "INFO",
  "KERNEL",
  "2005-06-01T00:00:00Z",
  "2005-07-01T00:00:00Z",
]

const planText = (rows: Array<Record<string, unknown>>) =>
  rows.map((row) => Object.values(row).join(" ")).join("\n")

export const g04FullText: Probe = {
  id: "G4",
  title:
    "Full text: dictionary, inverted index, filters, BM25, counts vs hit list",
  async run({ db, loadBgl }) {
    const load = await loadBgl()
    if (load === null) return [{ skipped: "BGL.log not downloaded" }]

    const tokens = await db.value(
      "SELECT array_to_string(ts_lexize('gate.msg_dict', 'Instruction cache PARITY errors, rts: 0x00544eb8 R02-M1-N0-C:J12-U11 nova.compute.manager req-3a7f'), ' ')"
    )

    const indexCount = await db.value(
      "SELECT count(*) FROM gate.bgl_idx WHERE message @@ $1",
      ["parity"]
    )
    const regexCount = await db.value(
      "SELECT count(*) FROM gate.bgl WHERE regexp_matches(lower(message), $1)",
      [tokenRegex("parity")]
    )

    const filteredCount = await db.value(
      `SELECT count(*) FROM gate.bgl_idx WHERE message @@ $1 AND ${FILTERS}`,
      ["parity", ...FILTER_VALUES]
    )
    const filteredList = await db.value(
      `SELECT count(*) FROM (
         SELECT event_id FROM gate.bgl_idx WHERE message @@ $1 AND ${FILTERS}
         ORDER BY BM25(bgl_idx.tableoid) DESC, event_id)`,
      ["parity", ...FILTER_VALUES]
    )
    const filteredBase = await db.value(
      `SELECT count(*) FROM gate.bgl WHERE regexp_matches(lower(message), $1) AND ${FILTERS}`,
      [tokenRegex("parity"), ...FILTER_VALUES]
    )

    const plan = planText(
      await db.rows(
        `EXPLAIN SELECT count(*) FROM gate.bgl_idx
         WHERE message @@ 'parity' AND dataset = 'bgl' AND level = 'INFO'
           AND component IN ('KERNEL', 'APP') AND node = 'R02-M1-N0-C:J12-U11'
           AND ts >= '2005-06-01T00:00:00Z' AND ts < '2005-07-01T00:00:00Z'`
      )
    )
    const [indexPart, columnPart = ""] = plan.split("Column Filter")
    const expressionPlan = planText(
      await db.rows(
        "EXPLAIN SELECT event_id FROM gate.bgl_idx WHERE message @@ 'parity' AND lower(level) = 'info'"
      )
    )

    const top = async () =>
      (
        await db.rows(
          `SELECT event_id, BM25(bgl_idx.tableoid) AS score FROM gate.bgl_idx
           WHERE message @@ $1 AND ts >= $2::TIMESTAMPTZ AND ts < $3::TIMESTAMPTZ
           ORDER BY BM25(bgl_idx.tableoid) DESC, event_id LIMIT 5`,
          ["torus", "2005-06-01T00:00:00Z", "2005-07-01T00:00:00Z"]
        )
      ).map((row) => `${String(row["event_id"])}:${String(row["score"])}`)
    const firstTop = await top()
    const secondTop = await top()
    const scoresDescending = firstTop
      .map((entry) => Number(entry.split(":")[1]))
      .every((score, i, all) => i === 0 || score <= (all[i - 1] ?? Infinity))

    const orCount = await db.value(
      "SELECT count(*) FROM gate.bgl_idx WHERE message @@ $1",
      ["cache parity"]
    )
    const andCount = await db.value(
      "SELECT count(*) FROM gate.bgl_idx WHERE message @@ plainto_tsquery($1)",
      ["cache parity"]
    )
    const andBase = await db.value(
      "SELECT count(*) FROM gate.bgl WHERE regexp_matches(lower(message), $1) AND regexp_matches(lower(message), $2)",
      [tokenRegex("cache"), tokenRegex("parity")]
    )
    const operatorsIgnored = await db.value(
      "SELECT count(*) FROM gate.bgl_idx WHERE message @@ $1",
      ["parity -cache"]
    )
    const wildcardLiteral = await db.value(
      "SELECT count(*) FROM gate.bgl_idx WHERE message @@ $1",
      ["pari*"]
    )

    // ts and event_id as range columns inside the index. On 26.09.1.3 range
    // filters there over-counted, non-deterministically (65,045–65,069
    // instead of 65,028 for June 2005); with background compaction the count
    // sometimes became right after a few seconds, so one correct-looking
    // result is no proof. The probe therefore compares several ranges with
    // compaction off, twice each. The production index keeps ts and event_id
    // out regardless (sql/50_index.sql); this measures, it does not decide.
    await db.rows(
      `CREATE INDEX bgl_range_idx ON gate.bgl USING inverted (event_id, ts, message gate.msg_dict)
       WITH (compaction_interval = 0)`
    )
    await db.rows("VACUUM (REFRESH_TABLE) gate.bgl")
    const RANGES = [
      ["2005-06-01T00:00:00Z", "2005-07-01T00:00:00Z"],
      ["2005-06-03T22:42:50.363779Z", "2005-06-04T00:00:00Z"],
      ["2005-08-01T00:00:00Z", "2005-12-01T00:00:00.000001Z"],
      ["2005-11-03T16:30:10.649636Z", "2006-01-04T16:00:05.233639Z"],
    ] as const
    const rangeRuns: Array<{ index: string; base: string }> = []
    for (let round = 0; round < 2; round++) {
      for (const [from, to] of RANGES) {
        rangeRuns.push({
          index: String(
            await db.value(
              "SELECT count(*) FROM gate.bgl_range_idx WHERE message @@ $1 AND ts >= $2::TIMESTAMPTZ AND ts < $3::TIMESTAMPTZ",
              ["parity", from, to]
            )
          ),
          base: String(
            await db.value(
              "SELECT count(*) FROM gate.bgl WHERE regexp_matches(lower(message), $1) AND ts >= $2::TIMESTAMPTZ AND ts < $3::TIMESTAMPTZ",
              [tokenRegex("parity"), from, to]
            )
          ),
        })
      }
    }
    const idRange = await db.value(
      "SELECT count(*) FROM gate.bgl_range_idx WHERE message @@ $1 AND event_id >= 1 AND event_id < 2400000",
      ["parity"]
    )
    const idRangeBase = await db.value(
      "SELECT count(*) FROM gate.bgl WHERE regexp_matches(lower(message), $1) AND event_id >= 1 AND event_id < 2400000",
      [tokenRegex("parity")]
    )
    await db.rows("DROP INDEX gate.bgl_range_idx")
    const rangeSummary = rangeRuns
      .map((run) => `${run.index}/${run.base}`)
      .join(", ")
    const measurement: Info = {
      info: `range columns inside the index (compaction off), index/base per range and round: ${rangeSummary}; event_id range ${String(idRange)}/${String(idRangeBase)}`,
    }

    return [
      equals(
        "tokenizer: lower case, ICU word boundaries, no stemming",
        "instruction cache parity errors rts 0x00544eb8 r02 m1 n0 c:j12 u11 nova.compute.manager req 3a7f",
        tokens
      ),
      check(
        "index build + VACUUM (REFRESH_TABLE) on full BGL",
        "built",
        `${load.indexMs} ms`,
        true
      ),
      equals(
        "@@ term count equals an independent regex count",
        regexCount,
        indexCount
      ),
      equals(
        "filtered count(*) equals the full ordered hit list",
        filteredCount,
        filteredList
      ),
      equals(
        "filtered index count equals base-table count",
        filteredBase,
        filteredCount
      ),
      check(
        "EXPLAIN: equality, IN and node run in the index; ts as column filter on the scan",
        "Index Filter: message, dataset, level, component (Or), node; Column Filter: ts",
        columnPart.includes("ts >=") ? "as expected" : plan,
        [
          "Field: message",
          "Field: dataset",
          "Field: level",
          "Field: component",
          "Field: node",
        ].every((needle) => (indexPart ?? "").includes(needle)) &&
          columnPart.includes("ts >=") &&
          !plan.includes("FILTER")
      ),
      check(
        "EXPLAIN: a non-indexed expression becomes a FILTER above the scan",
        "FILTER lower(level) = 'info'",
        expressionPlan.includes("FILTER")
          ? "FILTER above IRESEARCH_SCAN"
          : expressionPlan,
        expressionPlan.includes("FILTER")
      ),
      check(
        "BM25 order with event_id tiebreaker is descending and reproducible",
        "same top 5 twice, scores descending",
        firstTop.join(", "),
        firstTop.length === 5 &&
          firstTop.join() === secondTop.join() &&
          scoresDescending
      ),
      check(
        "bare string query ORs its terms",
        "count('cache parity') > count(plainto_tsquery)",
        `${String(orCount)} vs ${String(andCount)}`,
        Number(orCount) > Number(andCount)
      ),
      equals(
        "plainto_tsquery ANDs terms; equals independent count",
        andBase,
        andCount
      ),
      equals(
        "operators in a bare string are tokenised, not parsed (-cache)",
        orCount,
        operatorsIgnored
      ),
      equals("'*' in a bare string is no wildcard", "0", wildcardLiteral),
      measurement,
      check(
        "ts and event_id range filters inside the index equal the base table (26.10.1; over-counted on 26.09.1.3; production index unchanged)",
        "index = base for every range and round",
        `${rangeSummary}; event_id ${String(idRange)}/${String(idRangeBase)}`,
        rangeRuns.every((run) => run.index === run.base) &&
          String(idRange) === String(idRangeBase)
      ),
    ]
  },
}
