import { createReadStream } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { failureOf } from "../db.ts"
import { check, equals, type Probe } from "../probe.ts"

/** Options that make read_csv return each raw line as one VARCHAR column. */
const LINE_READER =
  "columns = {'line': 'VARCHAR'}, delim = E'\\x1f', quote = '', escape = '', header = false, auto_detect = false"

/** Lines of the fixture, in file order; written as UTF-8 except the Latin-1 line. */
const FIXTURE_LINES = [
  "plain line one",
  'quoted "GET /v2/servers HTTP/1.1" status: 200 len: 1893',
  "tab\there\tand,comma,separated",
  '"starts with a quote',
  "backslash \\ and pipe | char",
  "unicode Grüße ✓ 🌊",
  "",
  "after an empty line",
] as const
const LATIN1_LINE = Buffer.from("latin1 \xe9t\xe9 bytes", "latin1")

/** Numbered lines make every line number checkable against its content. */
const numbered = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix} ${i + 1} a, "b"\n`).join(
    ""
  )

/** Counts newline bytes, like `wc -l`. */
async function countLines(path: string): Promise<number> {
  let lines = 0
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer
    for (let i = buffer.indexOf(10); i !== -1; i = buffer.indexOf(10, i + 1)) {
      lines++
    }
  }
  return lines
}

export const g02ReadLines: Probe = {
  id: "G2",
  title:
    "Raw lines via read_csv, line numbers, filename and globs, regex fields",
  async run({ config, db, bglLog, loadBgl }) {
    const hostDir = join(config.hostRawDir, "gate-probe")
    const dir = `${config.containerRawDir}/gate-probe`
    await mkdir(join(hostDir, "multi"), { recursive: true })

    const utf8 = Buffer.from(FIXTURE_LINES.map((line) => `${line}\n`).join(""))
    await writeFile(join(hostDir, "fixture.log"), utf8)
    await writeFile(
      join(hostDir, "fixture-latin1.log"),
      Buffer.concat([utf8, LATIN1_LINE, Buffer.from("\n")])
    )
    await writeFile(join(hostDir, "numbered.log"), numbered("line", 1_000_000))
    await writeFile(join(hostDir, "multi", "f1.log"), numbered("f1", 300_000))
    await writeFile(join(hostDir, "multi", "f2.log"), numbered("f2", 120_000))
    await writeFile(join(hostDir, "multi", "f3.log"), numbered("f3", 450_000))

    const read = await db.rows(
      `SELECT line FROM read_csv('${dir}/fixture.log', ${LINE_READER})`
    )
    const invalidUtf8 = await failureOf(() =>
      db.rows(
        `SELECT count(*) FROM read_csv('${dir}/fixture-latin1.log', ${LINE_READER})`
      )
    )
    await db.rows(
      `CREATE OR REPLACE TEMP TABLE g2_rejected AS SELECT line FROM read_csv('${dir}/fixture-latin1.log', ${LINE_READER}, ignore_errors = true, store_rejects = true)`
    )
    const rejected = await db.rows(
      "SELECT line, error_type FROM reject_errors ORDER BY scan_id DESC, line LIMIT 1"
    )
    const acceptedWithRejects = await db.value(
      "SELECT count(*) FROM g2_rejected"
    )

    const numberedMismatch = await db.value(
      `SELECT count(*) FILTER (WHERE line <> 'line ' || line_no || ' a, "b"') || '/' || count(*)
       FROM (SELECT row_number() OVER () AS line_no, line FROM read_csv('${dir}/numbered.log', ${LINE_READER}))`
    )
    const perFile = await db.rows(
      `WITH g AS (
         SELECT row_number() OVER () AS global_no, filename, line
         FROM read_csv('${dir}/multi/*.log', ${LINE_READER})),
       n AS (SELECT filename, line, global_no - min(global_no) OVER (PARTITION BY filename) + 1 AS line_no FROM g)
       SELECT regexp_extract(filename, '[^/]+$') AS file, count(*) AS lines,
              count(*) FILTER (WHERE split_part(line, ' ', 2)::BIGINT <> line_no) AS mismatched
       FROM n GROUP BY filename ORDER BY filename`
    )
    // A partitioned row_number() without ORDER BY is not in file order.
    const partitionedMismatch = await db.value(
      `SELECT count(*) FILTER (WHERE split_part(line, ' ', 2)::BIGINT <> line_no)
       FROM (SELECT line, row_number() OVER (PARTITION BY filename) AS line_no
             FROM read_csv('${dir}/multi/*.log', ${LINE_READER}))`
    )

    const [regex] = await db.rows(
      `SELECT regexp_extract('abc', '(\\d+)', 1) AS miss,
              NULLIF(regexp_extract('abc', '(\\d+)', 1), '') AS miss_nullif,
              regexp_extract('k=v rest', '(\\w)=(\\w)(?: (.*))?', ['key', 'value', 'tail']) AS named,
              (regexp_extract('k=v rest', '(\\w)=(\\w)(?: (.*))?', ['key', 'value', 'tail'])).value AS named_field,
              (regexp_extract('k=v', '(\\w)=(\\w)(?: (.*))?', ['key', 'value', 'tail'])).tail AS optional_group`
    )

    const checks = [
      equals(
        "fixture lines read verbatim (quotes, tabs, commas, backslash, Unicode)",
        FIXTURE_LINES.map((line) => (line === "" ? null : line)),
        read.map((row) => row["line"])
      ),
      equals("empty line is a row with NULL, not skipped", 8, read.length),
      check(
        "invalid UTF-8 aborts read_csv by default",
        "error: CSV Error on Line: 9 (Invalid unicode)",
        invalidUtf8?.message ?? "no error",
        invalidUtf8?.message.startsWith("CSV Error on Line: 9") ?? false
      ),
      equals(
        "ignore_errors + store_rejects records the line and reason",
        [{ line: "9", error_type: "INVALID ENCODING" }],
        rejected.map((row) => ({
          line: String(row["line"]),
          error_type: row["error_type"],
        }))
      ),
      equals("accepted lines with store_rejects", "8", acceptedWithRejects),
      equals(
        "row_number() OVER () equals the file line number (1M lines)",
        "0/1000000",
        numberedMismatch
      ),
      equals(
        "glob over three files: virtual filename and per-file line_no",
        [
          { file: "f1.log", lines: "300000", mismatched: "0" },
          { file: "f2.log", lines: "120000", mismatched: "0" },
          { file: "f3.log", lines: "450000", mismatched: "0" },
        ],
        perFile
      ),
      check(
        "row_number() OVER (PARTITION BY filename) is not file order",
        "mismatches > 0 (do not use)",
        partitionedMismatch,
        Number(partitionedMismatch) > 0
      ),
      equals("regexp_extract without match returns ''", "", regex?.["miss"]),
      equals(
        "NULLIF(regexp_extract(…), '') keeps a missing field NULL",
        null,
        regex?.["miss_nullif"]
      ),
      equals(
        "regexp_extract with a name list: a STRUCT, sent to pg as composite text",
        "(k,v,rest)",
        regex?.["named"]
      ),
      equals(
        "struct fields are addressable in SQL (.value)",
        "v",
        regex?.["named_field"]
      ),
      equals(
        "unmatched optional group is '' in the struct",
        "",
        regex?.["optional_group"]
      ),
    ]

    if (bglLog === null) {
      return [
        ...checks,
        { skipped: "BGL.log not downloaded: full load time and line count" },
      ]
    }
    const wcLines = await countLines(bglLog)
    const load = await loadBgl()
    const [bgl] = await db.rows(
      `SELECT count(*) AS lines, count(*) FILTER (WHERE ts IS NULL) AS unparsed,
              max(line_no) AS max_line_no, min(ts) AS first_ts, max(ts) AS last_ts
       FROM gate.bgl`
    )
    return [
      ...checks,
      equals(
        "full BGL: lines read equal wc -l",
        String(wcLines),
        bgl?.["lines"]
      ),
      equals("full BGL: brief line count", "4747963", bgl?.["lines"]),
      equals("full BGL: line_no is 1…n", String(wcLines), bgl?.["max_line_no"]),
      equals(
        "full BGL: lines without timestamp after regex parse",
        "0",
        bgl?.["unparsed"]
      ),
      equals(
        "full BGL: time span in UTC from Unix seconds + microseconds",
        ["2005-06-03 22:42:50.363779+00", "2006-01-04 16:00:05.233639+00"],
        [bgl?.["first_ts"], bgl?.["last_ts"]]
      ),
      check(
        "full BGL: read + parse time (target: total load < 10 min)",
        "< 600000 ms",
        `${load?.loadMs ?? "?"} ms`,
        (load?.loadMs ?? Infinity) < 600_000
      ),
    ]
  },
}
