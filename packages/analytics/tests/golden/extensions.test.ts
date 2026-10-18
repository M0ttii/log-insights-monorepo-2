/** Author: golden-extensions, independent LOG-40 verifier (not a tool implementer). */
import {
  countEventsOutputSchema,
  type CountEventsOutput,
} from "@workspace/domain/tools/count-events"
import {
  eventContextOutputSchema,
  type EventContextOutput,
} from "@workspace/domain/tools/get-log-context"
import {
  eventTrendOutputSchema,
  type EventTrendOutput,
} from "@workspace/domain/tools/event-trend"
import {
  recurringPatternsOutputSchema,
  type RecurringPatternsOutput,
} from "@workspace/domain/tools/recurring-patterns"
import {
  searchLogsOutputSchema,
  type SearchLogsOutput,
} from "@workspace/domain/tools/search-logs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createGoldenHarness, integer, type GoldenHarness } from "./helpers.ts"

/**
 * Independent verification of the five Loghub extensions (U26, LOG-40) against
 * the loaded full corpus. The oracle SQL here is written from the spec
 * (technical.md § 7.1, concept 5.5/A-39), the dataset catalog
 * (packages/domain/src/datasets.ts, read as the contract) and the RAW files;
 * it never imports a tool implementation or packages/analytics/src/filters.ts.
 *
 * Raw files are read with the loader's read_csv settings (unit-separator
 * delimiter, quoting off) but parsed with regexes derived here, independent of
 * packages/corpus/sql. Full-corpus raw paths and line counts (task / catalog):
 *   hdfs/HDFS.log            11,175,629   rejected 0
 *   openssh/SSH.log             655,147   rejected 0
 *   apache/Apache.log            56,482   rejected 4,478 (header-less continuations)
 *   linux/Linux.log              25,567   rejected 20   (invalid UTF-8, read level)
 *   zookeeper/Zookeeper.log      74,380   rejected 0
 */

type Extension = {
  dataset: "hdfs" | "openssh" | "apache" | "linux" | "zookeeper"
  /** Raw log path inside the SereneDB container (.data/raw is mounted at /data/raw). */
  rawPath: string
  /** Physical lines of the raw file (catalog expectedLines). */
  expectedLines: number
  /** Expected rejects on the full corpus, by reason. */
  rejects: { reason: string; readLevel: boolean; count: number }[]
  /** Plain alphabetic probe term (ICU-tokenizable, lower-cased). */
  term: string
  /** Default event-context scope and the anchor column it filters on. */
  defaultScope: "same_block" | "same_process" | "same_client" | "same_component"
  scopeColumn: "block_id" | "process_id" | "client_ip" | "component"
  /** A dataset-specific grouping dimension and its column. */
  specificDimension: "block_id" | "client_ip" | "host" | "thread"
  /**
   * Independent raw-timestamp expression over a read_csv row aliased `line`,
   * producing a TIMESTAMPTZ (UTC). Datasets with a year wrap re-derive the
   * rule here; see technical.md § 7.1.
   */
  rawTimestamp: RawTimestamp
}

type RawTimestamp =
  | { kind: "inline"; cte: (file: string) => string }
  | {
      kind: "wrap"
      baseYear: number
      monthRegex: string
      cte: (file: string) => string
    }

const extensions: Extension[] = [
  {
    dataset: "hdfs",
    rawPath: "/data/raw/hdfs/HDFS.log",
    expectedLines: 11_175_629,
    rejects: [],
    term: "block",
    defaultScope: "same_block",
    scopeColumn: "block_id",
    specificDimension: "block_id",
    rawTimestamp: {
      kind: "inline",
      cte: (file) => `
        SELECT strptime(h.d || ' ' || h.t || ' +0000', '%y%m%d %H%M%S %z') AS ts
        FROM read_csv('${file}', columns = {'line': 'VARCHAR'}, delim = E'\\x1f',
          quote = '', escape = '', header = false, auto_detect = false, ignore_errors = true)
        CROSS JOIN LATERAL (SELECT regexp_extract(line, '^(\\d{6}) (\\d{6}) ', ['d', 't']) AS h) x
        WHERE h.d <> ''`,
    },
  },
  {
    dataset: "openssh",
    rawPath: "/data/raw/openssh/SSH.log",
    expectedLines: 655_147,
    rejects: [],
    term: "password",
    defaultScope: "same_process",
    scopeColumn: "process_id",
    specificDimension: "client_ip",
    rawTimestamp: {
      kind: "wrap",
      baseYear: 2017,
      monthRegex: "^([A-Z][a-z]{2}) +(\\d{1,2}) (\\d{2}:\\d{2}:\\d{2}) ",
      cte: (file) => wrapTimestampCte(file, 2017),
    },
  },
  {
    dataset: "apache",
    rawPath: "/data/raw/apache/Apache.log",
    expectedLines: 56_482,
    rejects: [
      { reason: "apache_missing_header", readLevel: false, count: 4_478 },
    ],
    term: "directory",
    defaultScope: "same_client",
    scopeColumn: "client_ip",
    specificDimension: "client_ip",
    rawTimestamp: {
      kind: "inline",
      cte: (file) => `
        SELECT strptime(h.mon || ' ' || h.day || ' ' || h.time || ' ' || h.year || ' +0000',
          '%b %d %H:%M:%S %Y %z') AS ts
        FROM read_csv('${file}', columns = {'line': 'VARCHAR'}, delim = E'\\x1f',
          quote = '', escape = '', header = false, auto_detect = false, ignore_errors = true)
        CROSS JOIN LATERAL (SELECT regexp_extract(line,
          '^\\[[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\\d{2}) (\\d{2}:\\d{2}:\\d{2}) (\\d{4})\\] ',
          ['mon', 'day', 'time', 'year']) AS h) x
        WHERE h.mon <> ''`,
    },
  },
  {
    dataset: "linux",
    rawPath: "/data/raw/linux/Linux.log",
    expectedLines: 25_567,
    // read_csv rejects the 20 invalid-UTF-8 lines at the read level; the reason
    // string is produced by SereneDB, so only its read_ prefix is asserted.
    rejects: [{ reason: "read_", readLevel: true, count: 20 }],
    term: "authentication",
    defaultScope: "same_component",
    scopeColumn: "component",
    specificDimension: "host",
    rawTimestamp: {
      kind: "wrap",
      baseYear: 2005,
      monthRegex: "^([A-Z][a-z]{2}) +(\\d{1,2}) (\\d{2}:\\d{2}:\\d{2}) ",
      cte: (file) => wrapTimestampCte(file, 2005),
    },
  },
  {
    dataset: "zookeeper",
    rawPath: "/data/raw/zookeeper/Zookeeper.log",
    expectedLines: 74_380,
    rejects: [],
    term: "connection",
    defaultScope: "same_component",
    scopeColumn: "component",
    specificDimension: "thread",
    rawTimestamp: {
      kind: "inline",
      cte: (file) => `
        SELECT strptime(h.d || '.' || h.ms || ' +0000', '%Y-%m-%d %H:%M:%S.%g %z') AS ts
        FROM read_csv('${file}', columns = {'line': 'VARCHAR'}, delim = E'\\x1f',
          quote = '', escape = '', header = false, auto_detect = false, ignore_errors = true)
        CROSS JOIN LATERAL (SELECT regexp_extract(line,
          '^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}),(\\d{3}) ', ['d', 'ms']) AS h) x
        WHERE h.d <> ''`,
    },
  },
]

/**
 * Independent syslog "Mon dd HH:MM:SS" parse with the single documented month
 * wrap (technical.md § 7.1): December→January for OpenSSH (base 2017),
 * June…February for Linux (base 2005). Derives the wrap from the month going
 * backwards along file order, not from the loader. read_csv skips the read
 * level rejects, so the row order is the loaded order.
 */
function wrapTimestampCte(file: string, baseYear: number): string {
  return `
    WITH raw AS (
      SELECT row_number() OVER () AS seq,
        regexp_extract(line, '^([A-Z][a-z]{2}) +(\\d{1,2}) (\\d{2}:\\d{2}:\\d{2}) ',
          ['mon', 'day', 'time']) AS h
      FROM read_csv('${file}', columns = {'line': 'VARCHAR'}, delim = E'\\x1f',
        quote = '', escape = '', header = false, auto_detect = false, ignore_errors = true)
    ), months AS (
      SELECT seq, h, list_position(
        ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], h.mon) AS mn
      FROM raw WHERE h.mon <> ''
    ), prev AS (
      SELECT *, lag(mn) OVER (ORDER BY seq) AS prev_mn FROM months
    ), wrapped AS (
      SELECT *, coalesce(sum(CASE WHEN mn < prev_mn THEN 1 ELSE 0 END)
        OVER (ORDER BY seq ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS wraps
      FROM prev
    )
    SELECT strptime((${baseYear} + wraps)::VARCHAR || ' ' || h.mon || ' ' || h.day
      || ' ' || h.time || ' +0000', '%Y %b %d %H:%M:%S %z') AS ts
    FROM wrapped`
}

let golden: GoldenHarness
beforeAll(async () => {
  golden = await createGoldenHarness()
})
afterAll(async () => {
  await golden?.close()
})

const countRow = z.object({ n: integer })
const loadRow = z.object({
  lines_read: integer,
  events_loaded: integer,
  rejected: integer,
  events: integer,
  raw_lines: integer,
  read_rejects: integer,
})
const hitRow = z.object({
  event_id: integer,
  ts: z.string(),
})
const windowRow = z.object({ before: integer, after: integer })
const groupRow = z.object({ key: z.string().nullable(), n: integer })
const bucketRow = z.object({ start: z.string(), n: integer })
const episodeRow = z.object({ episodes: integer, events: integer })

for (const ext of extensions) {
  describe(`${ext.dataset} · independent extension verification (LOG-40)`, () => {
    // (a) Load balance versus the raw file and the catalog line count.
    it("(a) load balance reconciles raw lines, report and log_events", async () => {
      const [balance] = await golden.sql(
        `
        WITH raw AS (
          SELECT count(*) AS raw_lines FROM read_csv('${ext.rawPath}',
            columns = {'line': 'VARCHAR'}, delim = E'\\x1f', quote = '', escape = '',
            header = false, auto_detect = false, ignore_errors = true)
        ), report AS (
          SELECT sum(lines_read) AS lines_read, sum(events_loaded) AS events_loaded,
            sum(rejected) AS rejected
          FROM load_report WHERE dataset = $1
        ), reads AS (
          SELECT count(*) AS read_rejects FROM load_rejects
          WHERE dataset = $1 AND starts_with(reason, 'read_')
        ), events AS (
          SELECT count(*) AS events FROM log_events WHERE dataset = $1
        )
        SELECT report.lines_read, report.events_loaded, report.rejected,
          events.events, raw.raw_lines, reads.read_rejects
        FROM report, events, raw, reads`,
        // The path is a constant of this file, inlined: a bound read_csv
        // argument leaves the result undescribed in the extended protocol
        // (gate G1).
        [ext.dataset],
        loadRow
      )
      expect(balance).toBeDefined()
      if (balance === undefined) throw new Error("missing load balance")
      // Catalog expectedLines, and the A-02 identity read = loaded + rejected.
      expect(balance.lines_read).toBe(ext.expectedLines)
      expect(balance.lines_read).toBe(balance.events_loaded + balance.rejected)
      // The tool's table holds exactly the accepted lines.
      expect(balance.events).toBe(balance.events_loaded)
      // Independent raw read: readable lines plus read-level rejects = physical lines.
      expect(balance.raw_lines + balance.read_rejects).toBe(ext.expectedLines)
      const expectedRejected = ext.rejects.reduce((sum, r) => sum + r.count, 0)
      expect(balance.rejected).toBe(expectedRejected)

      for (const reject of ext.rejects) {
        const [row] = await golden.sql(
          reject.readLevel
            ? `SELECT count(*) AS n FROM load_rejects WHERE dataset = $1 AND starts_with(reason, $2)`
            : `SELECT count(*) AS n FROM load_rejects WHERE dataset = $1 AND reason = $2`,
          [ext.dataset, reject.reason],
          countRow
        )
        // load_rejects keeps at most the first 1,000 per reason; compare capped.
        expect(row?.n).toBe(Math.min(reject.count, 1_000))
      }
    })

    // (b) search_logs total_matches and in-window hit timestamps.
    it("(b) search_logs total_matches matches an independent word-boundary scan", async () => {
      const [expected] = await golden.sql(
        `SELECT count(*) AS n FROM log_events
         WHERE dataset = $1 AND regexp_matches(lower(message), '\\b' || $2 || '\\b')`,
        [ext.dataset, ext.term],
        countRow
      )
      expect(expected?.n).toBeGreaterThan(0)
      const hits = await golden.sql(
        `SELECT event_id, strftime(ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS ts FROM log_events
         WHERE dataset = $1 AND regexp_matches(lower(message), '\\b' || $2 || '\\b')
         ORDER BY ts, event_id LIMIT 50`,
        [ext.dataset, ext.term],
        hitRow
      )
      const result = await golden.run<SearchLogsOutput>(
        "search_logs",
        {
          dataset: ext.dataset,
          query: ext.term,
          match: "terms",
          sort: "time_asc",
          limit: 50,
        },
        searchLogsOutputSchema
      )
      expect(result.data.total_matches).toBe(expected?.n)
      expect(result.data.truncated).toBe((expected?.n ?? 0) > 50)
      // Each returned hit sits in the time-ordered prefix of the matching set.
      expect(
        result.data.hits.map((hit) => ({ event_id: hit.event_id, ts: hit.ts }))
      ).toEqual(hits.map((hit) => ({ event_id: hit.event_id, ts: hit.ts })))
    })

    // (c) get_log_context mode event, deterministic anchor, default scope.
    it("(c) get_log_context event window counts match an independent scan", async () => {
      const [anchor] = await golden.sql(
        `SELECT event_id FROM log_events
         WHERE dataset = $1 AND regexp_matches(lower(message), '\\b' || $2 || '\\b')
           AND ${ext.scopeColumn} IS NOT NULL
         ORDER BY event_id LIMIT 1`,
        [ext.dataset, ext.term],
        z.object({ event_id: integer })
      )
      expect(anchor).toBeDefined()
      if (anchor === undefined) throw new Error("no anchor event")
      const window = 10
      const [expected] = await golden.sql(
        `WITH a AS (SELECT * FROM log_events WHERE event_id = $1::BIGINT)
         SELECT
           count(*) FILTER (WHERE e.ts < a.ts OR (e.ts = a.ts AND e.event_id < a.event_id)) AS before,
           count(*) FILTER (WHERE e.ts > a.ts OR (e.ts = a.ts AND e.event_id > a.event_id)) AS after
         FROM log_events e JOIN a ON e.dataset = a.dataset
         WHERE e.event_id <> a.event_id
           AND e.ts >= a.ts - $2::INTEGER * INTERVAL '1 minute'
           AND e.ts <= a.ts + $2::INTEGER * INTERVAL '1 minute'
           AND e.${ext.scopeColumn} IS NOT DISTINCT FROM a.${ext.scopeColumn}`,
        [anchor.event_id, window],
        windowRow
      )
      if (expected === undefined) throw new Error("no window counts")
      const result = await golden.run<EventContextOutput>(
        "get_log_context",
        {
          mode: "event",
          event_id: anchor.event_id,
          window_minutes: window,
          before: 25,
          after: 25,
        },
        eventContextOutputSchema
      )
      expect(result.data.anchor.event_id).toBe(anchor.event_id)
      expect(result.data.scope).toBe(ext.defaultScope)
      const before = result.data.sides.find(
        (side) => side.direction === "before"
      )
      const after = result.data.sides.find((side) => side.direction === "after")
      expect(before?.in_window).toBe(expected.before)
      expect(after?.in_window).toBe(expected.after)
    })

    // (d) count_events total, group by component, and a dataset-specific dimension.
    it("(d) count_events total, component and a dataset-specific dimension", async () => {
      const [total] = await golden.sql(
        `SELECT count(*) AS n FROM log_events WHERE dataset = $1`,
        [ext.dataset],
        countRow
      )
      const components = await golden.sql(
        `SELECT component AS key, count(*) AS n FROM log_events WHERE dataset = $1
         GROUP BY component ORDER BY count(*) DESC, component ASC NULLS LAST LIMIT 50`,
        [ext.dataset],
        groupRow
      )
      const counted = await golden.run<CountEventsOutput>(
        "count_events",
        { dataset: ext.dataset, group_by: ["component"], top_n: 50 },
        countEventsOutputSchema
      )
      expect(counted.data.total).toBe(total?.n)
      expect(counted.data.unit).toBe("log_events")
      expect(
        counted.data.groups.map((group) => ({
          key: group.component ?? null,
          n: group.events,
        }))
      ).toEqual(components.map((row) => ({ key: row.key, n: row.n })))

      const dim = ext.specificDimension
      const specific = await golden.sql(
        `SELECT ${dim} AS key, count(*) AS n FROM log_events WHERE dataset = $1
         GROUP BY ${dim} ORDER BY count(*) DESC, ${dim} ASC NULLS LAST LIMIT 5`,
        [ext.dataset],
        groupRow
      )
      const byDimension = await golden.run<CountEventsOutput>(
        "count_events",
        { dataset: ext.dataset, group_by: [dim], top_n: 5 },
        countEventsOutputSchema
      )
      expect(
        byDimension.data.groups.map((group) => ({
          key: (group as Record<string, unknown>)[dim] as string | null,
          n: group.events,
        }))
      ).toEqual(specific.map((row) => ({ key: row.key, n: row.n })))
    })

    // (e) event_trend weekly buckets equal date_trunc counts over raw timestamps.
    it("(e) event_trend weekly buckets equal independent raw-timestamp counts", async () => {
      const source = ext.rawTimestamp.cte(ext.rawPath)
      const buckets = await golden.sql(
        `WITH parsed AS (${source})
         SELECT strftime(date_trunc('week', ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS start, count(*) AS n
         FROM parsed WHERE ts IS NOT NULL GROUP BY date_trunc('week', ts)
         ORDER BY date_trunc('week', ts)`,
        [],
        bucketRow
      )
      const [parsedTotal] = await golden.sql(
        `WITH parsed AS (${source}) SELECT count(*) AS n FROM parsed WHERE ts IS NOT NULL`,
        [],
        countRow
      )
      const [loaded] = await golden.sql(
        `SELECT count(*) AS n FROM log_events WHERE dataset = $1`,
        [ext.dataset],
        countRow
      )
      // Independent raw parse recovers exactly the loaded events (rejects carry no
      // valid timestamp and are excluded from both sides).
      expect(parsedTotal?.n).toBe(loaded?.n)
      const result = await golden.run<EventTrendOutput>(
        "event_trend",
        { dataset: ext.dataset, bucket: "week" },
        eventTrendOutputSchema
      )
      expect(result.data.bucket_count).toBeLessThanOrEqual(120)
      expect(result.data.total).toBe(loaded?.n)
      const byStart = new Map(buckets.map((row) => [row.start, row.n]))
      for (const bucket of result.data.buckets) {
        expect(bucket.events).toBe(byStart.get(bucket.bucket_start) ?? 0)
      }
      // Every observed week is represented in the tool's grid.
      const toolStarts = new Set(
        result.data.buckets.map((row) => row.bucket_start)
      )
      const missingObservedWeeks = buckets
        .filter((row) => row.n > 0)
        .map((row) => row.start)
        .filter((start) => !toolStarts.has(start))
      expect(missingObservedWeeks).toEqual([])
    })

    // (f) recurring_patterns episodes via an independent gap formulation (no LAG,
    // no MATCH_RECOGNIZE): a new episode starts when the gap to the preceding
    // event of the same pattern is at least 30 minutes (R-05).
    it("(f) recurring_patterns episodes match an independent gap count", async () => {
      const [pattern] = await golden.sql(
        `SELECT pattern_id FROM log_events WHERE dataset = $1
         GROUP BY pattern_id ORDER BY count(*) DESC, pattern_id ASC LIMIT 1`,
        [ext.dataset],
        z.object({ pattern_id: z.string() })
      )
      expect(pattern).toBeDefined()
      if (pattern === undefined) throw new Error("no pattern")
      const [expected] = await golden.sql(
        `WITH ordered AS (
           SELECT ts, event_id, max(ts) OVER (
             ORDER BY ts, event_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS preceding_ts
           FROM log_events WHERE dataset = $1 AND pattern_id = $2
         )
         SELECT count(*) FILTER (
             WHERE preceding_ts IS NULL OR ts - preceding_ts >= INTERVAL '30 minutes'
           ) AS episodes,
           count(*) AS events
         FROM ordered`,
        [ext.dataset, pattern.pattern_id],
        episodeRow
      )
      if (expected === undefined) throw new Error("no episode count")
      const result = await golden.run<RecurringPatternsOutput>(
        "recurring_patterns",
        {
          dataset: ext.dataset,
          pattern_id: pattern.pattern_id,
          rank: "episodes",
        },
        recurringPatternsOutputSchema
      )
      const first = result.data.patterns[0]
      expect(first?.pattern_id).toBe(pattern.pattern_id)
      expect(first?.episodes).toBe(expected.episodes)
      expect(first?.events).toBe(expected.events)
      expect(first?.recurring).toBe(expected.episodes >= 2)
    })
  })
}
