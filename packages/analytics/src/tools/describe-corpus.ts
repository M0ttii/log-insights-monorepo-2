import { toSafeInteger } from "@workspace/domain/bigint"
import { datasetSchema, type Dataset } from "@workspace/domain/filters"
import {
  formatInstant,
  instantSchema,
  parseInstant,
} from "@workspace/domain/time"
import {
  defineTool,
  emptyInputSchema,
  READ_ONLY_ANNOTATIONS,
  renderDescription,
  roleGuidanceSchema,
} from "@workspace/domain/tool"
import { CONTRACT_VERSION } from "@workspace/domain/version"
import { z } from "zod"

import { corpusNotLoaded } from "../corpus.ts"
import { isoTime } from "../sql.ts"

/**
 * describe_corpus (A-04, A-37): scope and limits of the loaded corpus. Every
 * figure comes from SereneDB (`corpus_stats`, `ownership`, `load_manifest`);
 * only the field meanings and the corpus limits of concept § 5.2 are text.
 */

const count = z.number().int().nonnegative()

const fieldSchema = z.strictObject({
  name: z.string(),
  meaning: z.string(),
})

const datasetSummarySchema = z.strictObject({
  dataset: datasetSchema,
  events: count.describe("Parsed log events (lines) loaded."),
  lines_read: count.describe("Lines read from the raw files."),
  rejected: count.describe(
    "Lines rejected by the loader, with reasons in load_rejects."
  ),
  first_event: instantSchema.describe("Time of the first event, UTC."),
  last_event: instantSchema.describe(
    "Time of the last event, UTC; the span includes it."
  ),
  error_events: count.describe("Events with an error level (R-02)."),
  patterns: count.describe("Distinct normalised message patterns (R-04)."),
  single_event_patterns: count.describe("Patterns seen exactly once."),
  time_basis: z.string().describe("How event times were derived."),
  label_source: z.string().describe("Where the dataset labels come from."),
  fields: z
    .array(fieldSchema)
    .describe("Columns that carry values for this dataset."),
  levels: z
    .array(z.strictObject({ level: z.string().nullable(), events: count }))
    .describe("Observed levels, most events first."),
  components: z
    .array(
      z.strictObject({
        component: z.string().nullable(),
        team: z.string().describe("Fictional owning team or 'unowned'."),
        events: count,
      })
    )
    .describe(
      "Observed components, most events first; use these names in filters."
    ),
  labels: z
    .array(
      z.strictObject({
        label: z
          .string()
          .nullable()
          .describe("Dataset label (not our finding); null = no label."),
        events: count,
      })
    )
    .describe("Dataset labels, most events first."),
  api_accesses: count
    .nullable()
    .describe("OpenStack lines with an HTTP status (R-01); null for BGL."),
  api_accesses_without_request_id: count
    .nullable()
    .describe("API accesses without a request ID; null for BGL."),
  requests: count
    .nullable()
    .describe("Distinct request IDs among API accesses; null for BGL."),
})

const outputSchema = z.strictObject({
  datasets: z.array(datasetSummarySchema),
  limits: z
    .array(z.string())
    .describe("Known limits of the corpus; carry them into answers."),
  ownership: z
    .strictObject({
      fictional: z.literal(true),
      note: z.string(),
      teams: z.array(
        z.strictObject({
          team: z.string(),
          components: z.array(
            z.strictObject({ dataset: datasetSchema, component: z.string() })
          ),
        })
      ),
      unowned: z
        .array(
          z.strictObject({
            dataset: datasetSchema,
            component: z.string().nullable(),
            events: count,
          })
        )
        .describe("Observed components without a team."),
    })
    .describe(
      "Fictional ownership table (Serene Platform), invented for this project."
    ),
  versions: z.strictObject({
    data_version: z.string(),
    source: z
      .string()
      .describe("corpus (full BGL and OpenStack) or samples (Loghub 2k)."),
    loader_version: z.string(),
    parser_version: z.string(),
    pattern_rules_version: z.string(),
    ownership_version: z.string(),
    rules_version: z.string(),
    contract_version: z.string(),
  }),
  answer_guidance: roleGuidanceSchema
    .omit({ version: true })
    .nullable()
    .describe(
      "How to answer per role; null when the client injected no playbooks."
    ),
  guidance_version: z
    .string()
    .nullable()
    .describe(
      "Playbook version of answer_guidance; part of the result digest."
    ),
})

type DescribeCorpusOutput = z.infer<typeof outputSchema>

/** Concept § 5.2. */
const LIMITS = [
  "No shared time axis: BGL (2005–2006) and OpenStack (2017) do not overlap. Trends and period comparisons are per dataset; numbers across both are totals over each full span and are labelled as such.",
  "Logs only: there is no business, customer, cost or downtime data. Such impact is unknown and must be named as unknown.",
  "Labels belong to the dataset: BGL alert categories and OpenStack anomaly labels are not findings of this system; cite them as dataset labels.",
  "Matches are log entries: counted events, patterns and episodes are neither incidents nor outages.",
]

const FIELDS: readonly {
  name: string
  meaning: string
  datasets: readonly Dataset[]
}[] = [
  {
    name: "event_id",
    meaning:
      "Stable event ID; BGL line number, OpenStack 10,000,000 + running line number.",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "ts",
    meaning: "Event time, UTC with microseconds.",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "level",
    meaning: "Severity as logged.",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "component",
    meaning:
      "BGL component (KERNEL, APP, …) or OpenStack service (nova-api, …).",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "source_type",
    meaning: "BGL message type (RAS, …) or OpenStack logger name.",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "message",
    meaning: "Original log message, untrusted text.",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "pattern_id",
    meaning: "Hash of dataset, component and normalised message (R-04).",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "is_error",
    meaning: "Error level after R-02.",
    datasets: ["bgl", "openstack"],
  },
  {
    name: "node",
    meaning: "Node ID, e.g. R02-M1-N0-C:J12-U11.",
    datasets: ["bgl"],
  },
  {
    name: "midplane",
    meaning: "Midplane derived from the node, e.g. R02-M1.",
    datasets: ["bgl"],
  },
  {
    name: "rack",
    meaning: "Rack derived from the node, e.g. R02.",
    datasets: ["bgl"],
  },
  {
    name: "alert_label",
    meaning: "Dataset alert category; null for non-alert lines.",
    datasets: ["bgl"],
  },
  {
    name: "request_id",
    meaning: "Request ID (req-…) of the request block.",
    datasets: ["openstack"],
  },
  {
    name: "instance_id",
    meaning: "Instance UUID named in the line.",
    datasets: ["openstack"],
  },
  {
    name: "http_method",
    meaning: "HTTP method of an API access line.",
    datasets: ["openstack"],
  },
  {
    name: "endpoint",
    meaning: "API path with IDs masked (R-04).",
    datasets: ["openstack"],
  },
  {
    name: "http_status",
    meaning: "HTTP status of an API access line.",
    datasets: ["openstack"],
  },
  {
    name: "latency_ms",
    meaning: "Response time of an API access in milliseconds.",
    datasets: ["openstack"],
  },
  {
    name: "is_anomalous",
    meaning: "Dataset anomaly label of the instance, where assignable.",
    datasets: ["openstack"],
  },
]

/** BIGINT columns arrive as exact strings and become numbers only after a range check. */
const exactCount = z
  .union([z.string(), z.number()])
  .transform((value) => toSafeInteger(value))
  .pipe(count)

const statsRow = z.object({
  dataset: datasetSchema,
  lines_read: exactCount,
  events: exactCount,
  rejected: exactCount,
  first_event: instantSchema,
  last_event: instantSchema,
  error_events: exactCount,
  patterns: exactCount,
  single_event_patterns: exactCount,
  time_basis: z.string(),
  label_source: z.string(),
  levels: z.array(z.object({ level: z.string().nullable(), events: count })),
  components: z.array(
    z.object({
      component: z.string().nullable(),
      team: z.string(),
      events: count,
    })
  ),
  labels: z.array(z.object({ label: z.string().nullable(), events: count })),
  api_accesses: exactCount.nullable(),
  api_accesses_without_request_id: exactCount.nullable(),
  requests: exactCount.nullable(),
})

const ownershipRow = z.object({
  dataset: datasetSchema,
  component: z.string(),
  team: z.string(),
  note: z.string(),
})

const manifestRow = z.object({
  data_version: z.string(),
  source: z.string(),
  loader_version: z.string(),
  parser_version: z.string(),
  pattern_rules_version: z.string(),
  ownership_version: z.string(),
  rules_version: z.string(),
})

const STATS_SQL = `SELECT dataset, lines_read, events, rejected, ${isoTime("first_ts")} AS first_event, ${isoTime("last_ts")} AS last_event, error_events, patterns, single_event_patterns, time_basis, label_source, levels, components, labels, api_accesses, api_accesses_without_request_id, requests FROM corpus_stats ORDER BY dataset`

const OWNERSHIP_SQL =
  "SELECT dataset, component, team, note FROM ownership ORDER BY team, dataset, component"

const MANIFEST_SQL =
  "SELECT data_version, source, loader_version, parser_version, pattern_rules_version, ownership_version, rules_version FROM load_manifest"

const NO_GUIDANCE_NOTE =
  "answer_guidance is null: this client injected no role playbooks. Follow the server instructions, or ask which role (engineer, team lead, manager) the user has."

export const describeCorpus = defineTool({
  name: "describe_corpus",
  title: "Describe corpus",
  version: "1.0.0",
  description: renderDescription({
    purpose:
      "Describes the loaded log corpus: per dataset the events, time span, fields, levels, components with their fictional owning team, dataset labels and known limits, plus ownership, rule and data versions and the answer guidance per role.",
    useWhen:
      "call first in every investigation, before any other tool, to learn the scope, the time spans, valid component and level names and how to answer for the user's role.",
    doNotUseWhen: [
      {
        situation:
          "you need counts after filters, per time window or per group",
        use: "count_events",
      },
      { situation: "you need example log lines", use: "search_logs" },
    ],
    inputs: "none (empty object).",
    outputs:
      "datasets[] with events, lines_read, rejected, first_event and last_event (UTC, both included), error_events, patterns, fields, levels, components (with team), labels and for OpenStack api_accesses and requests; limits; ownership (fictional) with unowned components; versions; answer_guidance per role (null without playbooks) and guidance_version. Cite numbers by their fact IDs.",
    truncation: "none; every list is complete.",
    countingUnit:
      "log events (parsed lines), not incidents; OpenStack also api_accesses and requests (R-01).",
  }),
  input: emptyInputSchema,
  output: outputSchema,
  factSpecs: [
    {
      path: "/result/datasets/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/lines_read",
      metric: "lines_read",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/rejected",
      metric: "rejected_lines",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/error_events",
      metric: "error_events",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/first_event",
      metric: "first_event_time",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/last_event",
      metric: "last_event_time",
      unit: "log_events",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/levels/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset", "level"],
    },
    {
      path: "/result/datasets/*/components/*/events",
      metric: "events",
      unit: "log_events",
      groupKeys: ["dataset", "team", "component"],
    },
    {
      path: "/result/datasets/*/api_accesses",
      metric: "api_accesses",
      unit: "api_accesses",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/api_accesses_without_request_id",
      metric: "api_accesses_without_request_id",
      unit: "api_accesses",
      groupKeys: ["dataset"],
    },
    {
      path: "/result/datasets/*/requests",
      metric: "requests",
      unit: "requests",
      groupKeys: ["dataset"],
    },
  ],
  annotations: READ_ONLY_ANNOTATIONS,
  async run(ctx) {
    const stats = await ctx.db.query(STATS_SQL, [], ctx.signal)
    const ownership = await ctx.db.query(OWNERSHIP_SQL, [], ctx.signal)
    const manifest = await ctx.db.query(MANIFEST_SQL, [], ctx.signal)

    const datasets = stats.rows.map((row) => statsRow.parse(row))
    const manifestRows = manifest.rows.map((row) => manifestRow.parse(row))
    const versions = manifestRows[0]
    const first = datasets[0]
    if (
      first === undefined ||
      versions === undefined ||
      manifestRows.length !== 1
    )
      return { ok: false, error: corpusNotLoaded }
    const owned = ownership.rows.map((row) => ownershipRow.parse(row))

    const teams = new Map<string, { dataset: Dataset; component: string }[]>()
    for (const { team, dataset, component } of owned) {
      const list = teams.get(team) ?? []
      list.push({ dataset, component })
      teams.set(team, list)
    }
    const guidance = ctx.roleGuidance ?? null

    const data: DescribeCorpusOutput = {
      datasets: datasets.map((row) => ({
        ...row,
        fields: FIELDS.filter((field) =>
          field.datasets.includes(row.dataset)
        ).map(({ name, meaning }) => ({ name, meaning })),
      })),
      limits: [...LIMITS],
      ownership: {
        fictional: true,
        note: [...new Set(owned.map((row) => row.note))].join("; "),
        teams: [...teams].map(([team, components]) => ({ team, components })),
        unowned: datasets.flatMap((row) =>
          row.components
            .filter((component) => component.team === "unowned")
            .map(({ component, events }) => ({
              dataset: row.dataset,
              component,
              events,
            }))
        ),
      },
      versions: { ...versions, contract_version: CONTRACT_VERSION },
      answer_guidance:
        guidance === null
          ? null
          : { routing: guidance.routing, roles: guidance.roles },
      guidance_version: guidance?.version ?? null,
    }

    return {
      ok: true,
      run: {
        data,
        scope: {
          windows: datasets.map((row) => ({
            dataset: row.dataset,
            from: row.first_event,
            to: afterLast(row.last_event),
          })),
          filters: {},
        },
        population: {
          count: datasets.reduce((sum, row) => sum + row.events, 0),
          unit: "log_events",
        },
        rows_returned:
          stats.rows.length + ownership.rows.length + manifest.rows.length,
        truncated: false,
        row_limit: null,
        notes: [
          "Counts are log events (parsed lines), not incidents or outages.",
          "Teams come from a fictional ownership table; unmapped components are 'unowned'.",
          ...(guidance === null ? [NO_GUIDANCE_NOTE] : []),
        ],
      },
    }
  },
})

/** Scope windows exclude their end, so the window over a whole span ends 1 µs after the last event. */
function afterLast(last: string): string {
  const micros = parseInstant(last)
  if (micros === null) throw new RangeError(`not an instant: ${last}`)
  return formatInstant(micros + 1n)
}
