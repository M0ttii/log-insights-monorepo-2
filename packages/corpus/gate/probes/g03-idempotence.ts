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
      "CREATE TEXT SEARCH DICTIONARY gate.g3_dict (template = 'text', locale = 'en_US.UTF-8', case = 'lower', stemming = false, frequency)"
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

    await db.rows(
      "CREATE OR REPLACE TABLE gate.g3 AS SELECT * FROM (VALUES (1::BIGINT, 'alpha beta'), (2, 'gamma'), (3, 'alpha again')) v(id, msg)"
    )
    const rowsAfter = await db.value("SELECT count(*) FROM gate.g3")
    const indexesAfter = await db.value(
      "SELECT count(*) FROM pg_indexes WHERE schemaname = 'gate' AND tablename = 'g3'"
    )
    const indexGone = await failureOf(() =>
      db.rows("SELECT count(*) FROM gate.g3_idx WHERE msg @@ 'alpha'")
    )
    const viewGone = await failureOf(() =>
      db.rows("SELECT count(*) FROM gate.g3_view")
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
      equals("replace swaps the table contents", "3", rowsAfter),
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
      check(
        "dependent view is dropped silently",
        "query error",
        viewGone?.message ?? "still queryable",
        viewGone !== null
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
