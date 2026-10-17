import { connect, display, failureOf } from "../db.ts"
import { check, equals, type Probe } from "../probe.ts"

export const g01Driver: Probe = {
  id: "G1",
  title: "Driver and types (pg, parameters, BIGINT, Unicode, NULL, timestamps)",
  async run({ config, db }) {
    const [bound] = await db.rows(
      "SELECT $1::text AS t, $2::bigint AS b, $3::text AS n, typeof($4) AS untyped",
      ['Grüße ✓ 🌊 "q" \\', "9007199254740993", null, "x"]
    )

    // Search operator with a bound parameter; the index lives in a scratch table.
    await db.rows(
      "CREATE TABLE gate.g1 AS SELECT * FROM (VALUES (1::BIGINT, 'kernel panic'), (2, 'disk ok')) v(id, msg)"
    )
    await db.rows(
      "CREATE TEXT SEARCH DICTIONARY gate.g1_dict (template = 'text', locale = 'en_US.UTF-8', case = 'lower', stemming = false, frequency)"
    )
    await db.rows(
      "CREATE INDEX g1_idx ON gate.g1 USING inverted (id, msg gate.g1_dict)"
    )
    await db.rows("VACUUM (REFRESH_TABLE) gate.g1")
    const boundSearch = await db.value(
      "SELECT count(*) FROM gate.g1_idx WHERE msg @@ $1",
      ["PANIC"]
    )

    const [types] = await db.rows(
      `SELECT pg_typeof(TIMESTAMPTZ '2005-06-03 22:42:50.363779+00')::text AS tstz_type,
              TIMESTAMPTZ '2005-06-03 22:42:50.363779+00' AS tstz,
              TIMESTAMP '2005-06-03 22:42:50.363779' AS ts,
              TIMESTAMP '2005-06-03T22:42:50+02:00' AS ts_offset_literal,
              TIMESTAMPTZ '2005-06-03T22:42:50+02:00' AS tstz_offset_literal,
              to_timestamp(1117838570)::text AS from_unix,
              strftime(TIMESTAMPTZ '2005-06-03 22:42:50.363779+00', '%Y-%m-%dT%H:%M:%S.%fZ') AS iso`
    )

    // Range bound with Z and with an offset must select the same instant.
    const instant = "SELECT $1::TIMESTAMPTZ = $2::TIMESTAMPTZ AS same"
    const sameInstant = await db.value(instant, [
      "2005-06-03T22:00:00Z",
      "2005-06-04T00:00:00+02:00",
    ])
    const tsDropsOffset = await db.value(
      "SELECT $1::TIMESTAMP = $2::TIMESTAMP AS same",
      ["2005-06-03T22:00:00Z", "2005-06-04T00:00:00+02:00"]
    )

    // Session time zone: a startup option is ignored, SET is honoured.
    const startup = await connect(config, {
      options: "-c TimeZone=America/Los_Angeles",
    })
    await startup.client.query("RESET TimeZone")
    const startupZone = await startup.value("SHOW TimeZone")
    await startup.client.query("SET TimeZone = 'America/Los_Angeles'")
    const laText = await startup.value(
      "SELECT TIMESTAMPTZ '2005-06-03 22:42:50.363779+00'"
    )
    await startup.close()

    const fields = await db.client.query(
      "SELECT 1::BIGINT AS b, 1::UBIGINT AS u, 1.5::DOUBLE AS d, TIMESTAMPTZ '2005-06-03 22:42:50+00' AS tz"
    )
    const oids = Object.fromEntries(
      fields.fields.map((field) => [field.name, field.dataTypeID])
    )

    const multiStatement = await db.client.query("SELECT 1 AS a; SELECT 2 AS b")
    const multiStatementRows = (
      Array.isArray(multiStatement) ? multiStatement : [multiStatement]
    ).map((result: { rows: unknown[] }) => result.rows)
    const multiStatementError = await failureOf(() =>
      db.client.query("SELECT 1; SELECT no_such_column; SELECT 3")
    )
    const batchedDdl = await failureOf(() =>
      db.client.query(
        "CREATE TEXT SEARCH DICTIONARY gate.g1_batch_dict (template = 'text', locale = 'en_US.UTF-8', case = 'lower', frequency); CREATE INDEX g1_batch_idx ON gate.g1 USING inverted (id, msg gate.g1_batch_dict)"
      )
    )

    return [
      equals(
        "text parameter round trip (Unicode, quotes, backslash)",
        'Grüße ✓ 🌊 "q" \\',
        bound?.["t"]
      ),
      equals(
        "BIGINT above 2^53 arrives as exact string",
        "9007199254740993",
        bound?.["b"]
      ),
      equals("NULL parameter stays NULL", null, bound?.["n"]),
      equals(
        "untyped text parameter binds as VARCHAR",
        "VARCHAR",
        bound?.["untyped"]
      ),
      equals("message @@ $1 with bound parameter", "1", boundSearch),
      equals(
        "TIMESTAMPTZ type name",
        "timestamp with time zone",
        types?.["tstz_type"]
      ),
      equals(
        "TIMESTAMPTZ as raw text under UTC keeps microseconds",
        "2005-06-03 22:42:50.363779+00",
        types?.["tstz"]
      ),
      equals(
        "TIMESTAMP as raw text",
        "2005-06-03 22:42:50.363779",
        types?.["ts"]
      ),
      equals(
        "TIMESTAMP literal silently drops a UTC offset (PostgreSQL behaviour)",
        "2005-06-03 22:42:50",
        types?.["ts_offset_literal"]
      ),
      equals(
        "TIMESTAMPTZ literal applies the offset",
        "2005-06-03 20:42:50+00",
        types?.["tstz_offset_literal"]
      ),
      equals(
        "to_timestamp(unix seconds) returns TIMESTAMPTZ",
        "2005-06-03 22:42:50+00",
        types?.["from_unix"]
      ),
      equals(
        "strftime gives ISO-8601 with microseconds and Z",
        "2005-06-03T22:42:50.363779Z",
        types?.["iso"]
      ),
      equals(
        "bound Z and +02:00 strings compare as one instant (TIMESTAMPTZ)",
        true,
        sameInstant
      ),
      equals(
        "bound offsets are ignored for TIMESTAMP (would shift ranges)",
        false,
        tsDropsOffset
      ),
      check(
        "startup option -c TimeZone is ignored; server default stays",
        "Etc/UTC (option ignored)",
        display(startupZone),
        startupZone === "Etc/UTC"
      ),
      equals(
        "SET TimeZone changes TIMESTAMPTZ text output",
        "2005-06-03 15:42:50.363779-07",
        laText
      ),
      equals(
        "type OIDs: BIGINT 20, UBIGINT as NUMERIC 1700, DOUBLE 701, TIMESTAMPTZ 1184",
        { b: 20, u: 1700, d: 701, tz: 1184 },
        oids
      ),
      equals(
        "multi-statement simple query returns one result per statement",
        [[{ a: 1 }], [{ b: 2 }]],
        multiStatementRows
      ),
      check(
        "multi-statement query stops with the first error",
        "error for no_such_column",
        multiStatementError?.message ?? "succeeded",
        multiStatementError?.message.includes("no_such_column") ?? false
      ),
      check(
        "dictionary created earlier in the same batch is invisible to CREATE INDEX",
        "error 'Dictionary for inverted index does not exists' (send scripts statement by statement)",
        batchedDdl?.message ?? "succeeded",
        batchedDdl?.message.includes("Dictionary for inverted index") ?? false
      ),
    ]
  },
}
