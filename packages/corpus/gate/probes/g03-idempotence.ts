import { LOG_TEXT_ANALYZER } from "../../src/analyzer.ts"
import { failureOf } from "../db.ts"
import { check, equals, type Probe } from "../probe.ts"

export const g03Idempotence: Probe = {
  id: "G3",
  title: "CREATE OR REPLACE TABLE … AS SELECT and dependent objects",
  async run({ db }) {
    await db.rows(
      "CREATE OR REPLACE TABLE gate.g3 AS SELECT * FROM (VALUES (1::BIGINT, 'alpha beta'), (2, 'gamma')) v(id, msg)"
    )
    await db.rows(
      `CREATE TEXT SEARCH DICTIONARY gate.g3_dict AS ${LOG_TEXT_ANALYZER} WITH (frequency)`
    )
    await db.rows(
      "CREATE INDEX g3_idx ON gate.g3 USING inverted (id, msg gate.g3_dict)"
    )
    await db.rows("VACUUM (REFRESH_TABLE) gate.g3")
    await db.rows(
      "CREATE OR REPLACE VIEW gate.g3_view AS SELECT id FROM gate.g3 WHERE id > 0"
    )
    const before = await db.value(
      "SELECT count(*) FROM gate.g3_idx WHERE msg @@ 'alpha'"
    )

    const replace =
      "CREATE OR REPLACE TABLE gate.g3 AS SELECT * FROM (VALUES (1::BIGINT, 'alpha beta'), (2, 'gamma'), (3, 'alpha again')) v(id, msg)"
    // 26.10.1: a dependent view blocks the replace (26.09.1.3 dropped it
    // silently). The loader therefore drops its views first (01_schema.sql).
    const blockedByView = await failureOf(() => db.rows(replace))
    const rowsWhileBlocked = await db.value("SELECT count(*) FROM gate.g3")
    const viewKept = await failureOf(() =>
      db.rows("SELECT count(*) FROM gate.g3_view")
    )
    await db.rows("DROP VIEW gate.g3_view")

    await db.rows(replace)
    const rowsAfter = await db.value("SELECT count(*) FROM gate.g3")
    const indexesAfter = await db.value(
      "SELECT count(*) FROM pg_indexes WHERE schemaname = 'gate' AND tablename = 'g3'"
    )
    const indexGone = await failureOf(() =>
      db.rows("SELECT count(*) FROM gate.g3_idx WHERE msg @@ 'alpha'")
    )
    const dictionaryKept = await db.value(
      "SELECT ts_lexize('gate.g3_dict', 'Alpha')::text"
    )

    // The loader therefore recreates views and indexes after every replace.
    await db.rows(
      "CREATE INDEX g3_idx ON gate.g3 USING inverted (id, msg gate.g3_dict)"
    )
    await db.rows("VACUUM (REFRESH_TABLE) gate.g3")
    const rebuilt = await db.value(
      "SELECT count(*) FROM gate.g3_idx WHERE msg @@ 'alpha'"
    )

    // Without VACUUM a new row becomes searchable after the background refresh.
    await db.rows("INSERT INTO gate.g3 VALUES (4, 'alpha four')")
    const beforeRefresh = await db.value(
      "SELECT count(*) FROM gate.g3_idx WHERE msg @@ 'alpha'"
    )
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const afterRefresh = await db.value(
      "SELECT count(*) FROM gate.g3_idx WHERE msg @@ 'alpha'"
    )

    return [
      equals("index before replace", "1", before),
      check(
        "replace fails while a view depends on the table (26.10.1; 26.09.1.3 dropped the view silently)",
        "error 2BP01 'Cannot drop entry … entries that depend on it'",
        `${blockedByView?.code ?? "no error"}: ${blockedByView?.message ?? "replaced"}`,
        blockedByView?.code === "2BP01"
      ),
      equals("failed replace keeps the old contents", "2", rowsWhileBlocked),
      equals("failed replace keeps the view", null, viewKept),
      equals(
        "replace after DROP VIEW swaps the table contents",
        "3",
        rowsAfter
      ),
      equals(
        "replace drops the dependent inverted index silently",
        "0",
        indexesAfter
      ),
      check(
        "index relation is gone after replace",
        "query error",
        indexGone?.message ?? "still queryable",
        indexGone !== null
      ),
      equals(
        "text search dictionary survives the replace",
        "[alpha]",
        dictionaryKept
      ),
      equals("recreated index sees the new rows", "2", rebuilt),
      equals("insert is not yet visible before refresh", "2", beforeRefresh),
      equals(
        "insert visible after background refresh (~1 s)",
        "3",
        afterRefresh
      ),
    ]
  },
}
