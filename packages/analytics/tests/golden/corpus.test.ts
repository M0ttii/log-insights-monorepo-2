/** Author: Codex root, independent LOG-13 verifier; A-02/A-04 and technical §6–7. */
import { createReadStream } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { afterAll, beforeAll, expect, it } from "vitest"
import { z } from "zod"

import { findWorkspaceRoot } from "../../src/config.ts"
import { createGoldenHarness, integer, type GoldenHarness } from "./helpers.ts"

let golden: GoldenHarness
beforeAll(async () => {
  golden = await createGoldenHarness()
})
afterAll(async () => {
  await golden?.close()
})

const level = z.object({ level: z.string().nullable(), events: integer })
const component = z.object({
  component: z.string().nullable(),
  team: z.string(),
  events: integer,
})
const label = z.object({ label: z.string().nullable(), events: integer })
const summary = z.object({
  dataset: z.string(),
  events: integer,
  first_event: z.string(),
  last_event: z.string(),
  error_events: integer,
  patterns: integer,
  single_event_patterns: integer,
  api_accesses: integer.nullable(),
  api_accesses_without_request_id: integer.nullable(),
  requests: integer.nullable(),
})
// describe_corpus has no exported domain output schema yet. This projection validates
// only fields compared below; the registry validates the complete canonical output.
// U26: the full corpus now also carries the five extension datasets. The whole-corpus
// output must validate for all of them, so error_events is nullable here (linux has no
// error definition, so its canonical value is null, not zero). The exact BGL/OpenStack
// aggregates below still go through the strict `summary` schema, which keeps
// error_events a non-null integer for those two datasets.
const description = z.object({
  datasets: z.array(
    summary.extend({
      error_events: integer.nullable(),
      lines_read: integer,
      rejected: integer,
      levels: z.array(level),
      components: z.array(component),
      labels: z.array(label),
    })
  ),
  ownership: z.object({
    fictional: z.boolean(),
    note: z.string(),
    teams: z.array(
      z.object({
        team: z.string(),
        components: z.array(
          z.object({ dataset: z.string(), component: z.string() })
        ),
      })
    ),
    unowned: z.array(
      z.object({
        dataset: z.string(),
        component: z.string().nullable(),
        events: integer,
      })
    ),
  }),
})

it("reconciles every raw file, load_report, rejects and brief totals", async () => {
  // U26: the full corpus now also carries the five extension datasets (hdfs, openssh,
  // apache, linux, zookeeper), each with its own load_report rows and some rejects.
  // This test reconciles the base corpus, so every oracle below is restricted to
  // dataset IN ('bgl', 'openstack'); the BGL/OpenStack line counts, rejects and reasons
  // stay exactly as before. The extension datasets are reconciled in extensions.test.ts.
  const report = await golden.sql(
    "SELECT dataset, source_file, lines_read, events_loaded, rejected, reason_counts FROM load_report WHERE dataset IN ('bgl', 'openstack') ORDER BY dataset, source_file",
    [],
    z.object({
      dataset: z.enum(["bgl", "openstack"]),
      source_file: z.string(),
      lines_read: integer,
      events_loaded: integer,
      rejected: integer,
      reason_counts: z.record(z.string(), integer),
    })
  )
  expect(report).toHaveLength(4)
  for (const entry of report) {
    const expectedFiles = new Set([
      "BGL.log",
      "openstack_abnormal.log",
      "openstack_normal1.log",
      "openstack_normal2.log",
    ])
    expect(expectedFiles.has(entry.source_file)).toBe(true)
    const rejects = await golden.sql(
      "SELECT line_no, reason, raw_line FROM load_rejects WHERE dataset = $1 AND source_file = $2 ORDER BY line_no",
      [entry.dataset, entry.source_file],
      z.object({
        line_no: integer,
        reason: z.string().min(1),
        raw_line: z.string(),
      })
    )
    const rejectedLines = new Map(
      rejects.map((row) => [row.line_no, row.raw_line])
    )
    const file = join(
      findWorkspaceRoot(),
      ".data",
      "raw",
      ...(entry.dataset === "bgl" ? [] : ["openstack"]),
      entry.source_file
    )
    const observedRejects = new Map<number, string>()
    let physicalLines = 0
    const stream = createReadStream(file)
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const text of lines) {
        physicalLines++
        if (rejectedLines.has(physicalLines))
          observedRejects.set(physicalLines, text)
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    expect(observedRejects).toEqual(rejectedLines)
    expect(physicalLines).toBe(entry.lines_read)
    expect(entry.events_loaded + entry.rejected).toBe(entry.lines_read)
    expect(rejects).toHaveLength(entry.rejected)
    const reasons = await golden.sql(
      "SELECT reason, count(*) AS events FROM load_rejects WHERE dataset = $1 AND source_file = $2 GROUP BY reason ORDER BY reason",
      [entry.dataset, entry.source_file],
      z.object({ reason: z.string(), events: integer })
    )
    expect(
      Object.fromEntries(reasons.map((row) => [row.reason, row.events]))
    ).toEqual(entry.reason_counts)
    const [loaded] = await golden.sql(
      "SELECT count(*) AS events FROM log_events WHERE dataset = $1 AND source_file = $2",
      [entry.dataset, entry.source_file],
      z.object({ events: integer })
    )
    expect(loaded?.events).toBe(entry.events_loaded)
  }
  const totals = await golden.sql(
    "SELECT dataset, sum(lines_read) AS lines_read, sum(events_loaded) AS events, sum(rejected) AS rejected FROM load_report WHERE dataset IN ('bgl', 'openstack') GROUP BY dataset ORDER BY dataset",
    [],
    z.object({
      dataset: z.string(),
      lines_read: integer,
      events: integer,
      rejected: integer,
    })
  )
  expect(totals).toEqual([
    { dataset: "bgl", lines_read: 4_747_963, events: 4_747_945, rejected: 18 },
    { dataset: "openstack", lines_read: 207_820, events: 207_820, rejected: 0 },
  ])
  const reasons = await golden.sql(
    "SELECT dataset, reason, count(*) AS events FROM load_rejects WHERE dataset IN ('bgl', 'openstack') GROUP BY dataset, reason ORDER BY dataset, reason",
    [],
    z.object({ dataset: z.string(), reason: z.string(), events: integer })
  )
  expect(reasons).toEqual([
    { dataset: "bgl", reason: "bgl_corrupted_fields", events: 18 },
  ])
})

it("describe_corpus and cached corpus_stats equal direct full-corpus aggregates, including unowned", async () => {
  const result = await golden.run("describe_corpus", {}, description)
  // U26: describe_corpus is a whole-corpus call, so it now lists all seven loaded
  // datasets. Verify the returned set independently against corpus_stats (order is the
  // catalog order, asserted as a set here to avoid importing the catalog), and confirm
  // the base corpus is still present. The exact BGL/OpenStack aggregates are checked below.
  const loadedDatasets = await golden.sql(
    "SELECT dataset FROM corpus_stats ORDER BY dataset",
    [],
    z.object({ dataset: z.string() })
  )
  expect(new Set(result.data.datasets.map((row) => row.dataset))).toEqual(
    new Set(loadedDatasets.map((row) => row.dataset))
  )
  expect(result.data.datasets.map((row) => row.dataset)).toEqual(
    expect.arrayContaining(["bgl", "openstack"])
  )
  for (const dataset of ["bgl", "openstack"]) {
    const [direct] = await golden.sql(
      `SELECT dataset, count(*) AS events,
      strftime(min(ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS first_event,
      strftime(max(ts), '%Y-%m-%dT%H:%M:%S.%fZ') AS last_event,
      sum(CASE WHEN (dataset = 'bgl' AND level IN ('ERROR','SEVERE','FATAL','FAILURE'))
                    OR (dataset = 'openstack' AND level IN ('ERROR','CRITICAL')) THEN 1 ELSE 0 END) AS error_events,
      count(DISTINCT pattern_id) AS patterns,
      (SELECT count(*) FROM (SELECT pattern_id FROM log_events WHERE dataset = $1 GROUP BY pattern_id HAVING count(*) = 1)) AS single_event_patterns,
      CASE WHEN dataset = 'openstack' THEN count(http_status) END AS api_accesses,
      CASE WHEN dataset = 'openstack' THEN sum(CASE WHEN http_status IS NOT NULL AND request_id IS NULL THEN 1 ELSE 0 END) END AS api_accesses_without_request_id,
      CASE WHEN dataset = 'openstack' THEN count(DISTINCT CASE WHEN http_status IS NOT NULL THEN request_id END) END AS requests
      FROM log_events WHERE dataset = $1 GROUP BY dataset ORDER BY dataset`,
      [dataset],
      summary
    )
    const stored = await golden.sql(
      `SELECT dataset, events, strftime(first_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS first_event,
      strftime(last_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS last_event, error_events, patterns, single_event_patterns,
      api_accesses, api_accesses_without_request_id, requests FROM corpus_stats WHERE dataset = $1 ORDER BY dataset`,
      [dataset],
      summary
    )
    const actual = result.data.datasets.find((row) => row.dataset === dataset)
    expect(summary.parse(actual)).toEqual(direct)
    expect(stored).toEqual([direct])
    const counts = await golden.sql(
      "SELECT sum(lines_read) AS lines_read, sum(rejected) AS rejected FROM load_report WHERE dataset = $1",
      [dataset],
      z.object({ lines_read: integer, rejected: integer })
    )
    expect(actual).toMatchObject(counts[0] ?? {})
    const levels = await golden.sql(
      "SELECT level, count(*) AS events FROM log_events WHERE dataset = $1 GROUP BY level ORDER BY events DESC, level NULLS LAST",
      [dataset],
      level
    )
    const components = await golden.sql(
      `SELECT e.component, coalesce(o.team, 'unowned') AS team, count(*) AS events
      FROM log_events e LEFT JOIN ownership o ON e.dataset = o.dataset AND e.component = o.component
      WHERE e.dataset = $1 GROUP BY e.component, o.team ORDER BY events DESC, e.component NULLS LAST`,
      [dataset],
      component
    )
    const labels = await golden.sql(
      `SELECT CASE WHEN dataset = 'bgl' THEN alert_label
      WHEN is_anomalous THEN 'anomalous' WHEN is_anomalous = false THEN 'not_anomalous' END AS label, count(*) AS events
      FROM log_events WHERE dataset = $1 GROUP BY label ORDER BY events DESC, label NULLS LAST`,
      [dataset],
      label
    )
    const [cached] = await golden.sql(
      "SELECT levels, components, labels FROM corpus_stats WHERE dataset = $1",
      [dataset],
      z.object({
        levels: z.array(level),
        components: z.array(component),
        labels: z.array(label),
      })
    )
    expect(actual?.levels).toEqual(levels)
    expect(actual?.components).toEqual(components)
    expect(actual?.labels).toEqual(labels)
    expect(cached).toEqual({ levels, components, labels })
  }
  const owners = await golden.sql(
    "SELECT dataset, component, team FROM ownership ORDER BY team, dataset, component",
    [],
    z.object({ dataset: z.string(), component: z.string(), team: z.string() })
  )
  expect(
    result.data.ownership.teams.flatMap((team) =>
      team.components.map((entry) => ({ ...entry, team: team.team }))
    )
  ).toEqual(owners)
  // U26: with more than one unowned component now present, order matters. describe_corpus
  // reads components from corpus_stats ordered `ORDER BY dataset` (alphabetical) and each
  // dataset's stored components JSON is ordered by events DESC then component name (NULL
  // last). Compute the unowned counts with independent SQL and apply that same ORDER BY in
  // SereneDB, so the comparison uses the engine's own collation rather than a JS reimplementation.
  const unowned = await golden.sql(
    `SELECT e.dataset, e.component, count(*) AS events FROM log_events e
    WHERE NOT EXISTS (SELECT 1 FROM ownership o WHERE o.dataset = e.dataset AND o.component = e.component)
    GROUP BY e.dataset, e.component
    ORDER BY e.dataset, count(*) DESC, e.component NULLS LAST`,
    [],
    z.object({
      dataset: z.string(),
      component: z.string().nullable(),
      events: integer,
    })
  )
  expect(result.data.ownership.unowned).toEqual(unowned)
  // U26: the extension datasets (notably linux) add many unowned components, so the
  // whole-corpus `unowned` list above is no longer only SERV_NET. Preserve the original
  // base-corpus guarantee by checking the BGL/OpenStack slice of the independent oracle:
  // SERV_NET (3 events) remains the single deliberately unowned base component.
  expect(
    unowned.filter(
      (row) => row.dataset === "bgl" || row.dataset === "openstack"
    )
  ).toEqual([{ dataset: "bgl", component: "SERV_NET", events: 3 }])
  expect(result.data.ownership.fictional).toBe(true)
  expect(result.data.ownership.note).toMatch(/fictional/i)
})
