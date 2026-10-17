import { randomBytes } from "node:crypto"

import { connect, failureOf } from "../db.ts"
import { check, equals, type Probe } from "../probe.ts"

const ROLE = "gate_reader"

export const g08ReadOnlyRole: Probe = {
  id: "G8",
  title: "Read-only role (optional)",
  async run({ config, db }) {
    await db.rows(
      "CREATE OR REPLACE TABLE gate.g8 AS SELECT * FROM (VALUES (1::BIGINT, 'kernel panic')) v(id, msg)"
    )
    await db.rows(
      "CREATE TEXT SEARCH DICTIONARY gate.g8_dict (template = 'text', locale = 'en_US.UTF-8', case = 'lower', stemming = false, frequency)"
    )
    await db.rows(
      "CREATE INDEX g8_idx ON gate.g8 USING inverted (id, msg gate.g8_dict)"
    )
    await db.rows("VACUUM (REFRESH_TABLE) gate.g8")
    await db.rows("CREATE OR REPLACE TABLE gate.g8_private AS SELECT 1 AS x")

    // A throwaway password for this run only; the role is dropped afterwards.
    const password = randomBytes(16).toString("hex")
    await db.rows(`DROP ROLE IF EXISTS ${ROLE}`)
    await db.rows(`CREATE ROLE ${ROLE} LOGIN PASSWORD '${password}'`)
    await db.rows(`GRANT USAGE ON SCHEMA gate TO ${ROLE}`)
    await db.rows(`GRANT SELECT ON gate.g8 TO ${ROLE}`)

    const reader = await connect(config, { user: ROLE, password })
    try {
      const select = await failureOf(() =>
        reader.rows("SELECT count(*) FROM gate.g8")
      )
      const search = await failureOf(() =>
        reader.rows("SELECT count(*) FROM gate.g8_idx WHERE msg @@ 'panic'")
      )
      const privateTable = await failureOf(() =>
        reader.rows("SELECT count(*) FROM gate.g8_private")
      )
      const create = await failureOf(() =>
        reader.rows("CREATE TABLE gate.g8_new AS SELECT 1 AS x")
      )
      const insert = await failureOf(() =>
        reader.rows("INSERT INTO gate.g8 VALUES (2, 'x')")
      )
      const drop = await failureOf(() => reader.rows("DROP TABLE gate.g8"))
      const fileRead = await failureOf(() =>
        reader.rows(
          `SELECT count(*) FROM read_json('${config.containerReceiptsDir}/gate-probe/*.json')`
        )
      )

      return [
        equals("granted SELECT works", null, select),
        equals("granted table is searchable through its index", null, search),
        check(
          "ungranted table is denied",
          "permission denied",
          privateTable?.message ?? "allowed",
          privateTable !== null
        ),
        check(
          "CREATE is denied",
          "permission denied",
          create?.message ?? "allowed",
          create !== null
        ),
        check(
          "INSERT is denied",
          "permission denied",
          insert?.message ?? "allowed",
          insert !== null
        ),
        check(
          "DROP is denied",
          "must be owner",
          drop?.message ?? "allowed",
          drop !== null
        ),
        check(
          "file table functions stay available to the reader (read_json)",
          "allowed (files are not covered by grants)",
          fileRead?.message ?? "allowed",
          fileRead === null
        ),
      ]
    } finally {
      await reader.close()
      await db.rows(`DROP OWNED BY ${ROLE}`).catch(() => undefined)
      await db
        .rows(`REVOKE ALL ON SCHEMA gate FROM ${ROLE}`)
        .catch(() => undefined)
      await db.rows(`REVOKE ALL ON gate.g8 FROM ${ROLE}`).catch(() => undefined)
      await db.rows(`DROP ROLE IF EXISTS ${ROLE}`)
    }
  },
}
