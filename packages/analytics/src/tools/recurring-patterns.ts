import { toSafeInteger } from "@workspace/domain/bigint"
import { DATASETS, type BreadthUnit } from "@workspace/domain/datasets"
import {
  invalidInput,
  type InputIssue,
  type ToolError,
} from "@workspace/domain/errors"
import {
  patternsUnsupported,
  validateFilter,
  type Dataset,
  type Filter,
} from "@workspace/domain/filters"
import type { Scope } from "@workspace/domain/receipt"
import type { ComparisonCoverage } from "@workspace/domain/rules/compare"
import type { RankCriterion } from "@workspace/domain/rules/ranking"
import { patternStatusSchema } from "@workspace/domain/rules/status"
import {
  EPISODE_GAP_MINUTES,
  RECURRING_MIN_EPISODES,
  SIGNIFICANT_INCREASE_FACTOR,
  SIGNIFICANT_INCREASE_MIN_EVENTS,
} from "@workspace/domain/rules/thresholds"
import {
  instantSchema,
  parseInstant,
  previousPeriod,
  type DataSpan,
  type TimeRange,
} from "@workspace/domain/time"
import {
  defineTool,
  READ_ONLY_ANNOTATIONS,
  renderDescription,
  type ToolContext,
} from "@workspace/domain/tool"
import {
  INVESTIGATION_DEFAULT_LIMIT,
  INVESTIGATION_EXCLUDED_FILTERS,
  INVESTIGATION_LIMITS,
  INVESTIGATION_MAX_LIMIT,
  RECURRING_DEFAULT_LIMIT,
  RECURRING_FILTER,
  RECURRING_MAX_LIMIT,
  recurringPatternsFactSpecs,
  recurringPatternsInputSchema,
  recurringPatternsOutputSchema,
  resolvedLimit,
  summarizeRecurringPatterns,
  type Rank,
  type RecurringPattern,
  type RecurringPatternsInput,
  type RecurringPatternsOutput,
} from "@workspace/domain/tools/recurring-patterns"
import { z } from "zod"

import { comparisonCoverageSql } from "../comparison.ts"
import { compileFilter, dimensionExpression } from "../filters.ts"
import { describeFilters, resolveWindows, scopeFilters } from "../scope.ts"
import { isoTime, SqlParams } from "../sql.ts"
import { patternAnalysis } from "../pattern-analysis.ts"
import {
  conflictRow,
  dimensions,
  investigationCtes,
  leaderRow,
  rankBasis,
  ruleRecords,
  ruleSummaryRow,
  type RecordColumn,
} from "./recurring-pattern-rules.ts"

/**
 * recurring_patterns (A-10, A-11): patterns of one dataset with episodes,
 * active days, breadth, change and status, ranked by events, episodes,
 * increase or the investigation order (R-08, R-09).
 *
 * Every call runs, in this order, each query through the tool's runner so
 * all of them are in the receipt:
 * 1. the data span of the dataset (window defaults);
 * 2. the SQL coverage of current and baseline periods;
 * 3. the rule versions of the load (`load_manifest`);
 * 4. the main aggregate: the fully filtered window first, then gaps per
 *    pattern with MATCH_RECOGNIZE, ordered by ts, event_id. The pattern
 *    (s n*) continues only below the R-05 gap, bound as `$n::INTERVAL`;
 *    CLASSIFIER marks starts, MATCH_NUMBER identifies the first episode
 *    for the example event. ALL ROWS preserves activity and breadth
 *    dimensions (R-05: never precomputed gaps). In the same statement, when
 *    the previous period B overlaps the data span, the counts of B with the identical
 *    filter, joined per pattern, so C − B comes from SereneDB and a pattern
 *    seen only in B has C = 0 (quiet);
 *    The same SQL computes history before the window, R-05 recurring and
 *    R-10 status. For investigation_order it also computes R-08 availability,
 *    order and capped leaders, and R-09 dominance and bounded conflicts;
 * 5. with investigation_order, the levels and alert labels of the listed
 *    candidates.
 *
 * investigation_order reads only candidate events (R-08: error events or
 * alerts; for OpenStack also failed API accesses, 5xx) and compares every
 * candidate of the scope in SQL. TypeScript assembles the bounded result
 * records without sorting, aggregating or deciding a rule outcome.
 */

const GAP_INTERVAL = `${EPISODE_GAP_MINUTES} minutes`

const BREADTH_ARTICLE: Record<BreadthUnit, string> = {
  nodes: "a node",
  instances: "an instance",
  blocks: "a block",
  client_ips: "a client IP",
}

/**
 * Breadth columns per dataset (R-08, catalog): the unit first, the extra one
 * second; a dataset without a unit reads NULL, so breadth is null for every
 * pattern and drops out of investigation_order with its reason.
 */
function breadthColumns(dataset: Dataset): readonly [string, string] {
  const breadth = DATASETS[dataset].breadth
  return [
    breadth === null ? "NULL::VARCHAR" : `e.${breadth.column}`,
    breadth?.extra == null ? "NULL::VARCHAR" : `e.${breadth.extra.column}`,
  ]
}

/** R-08 candidates: error events or alerts (R-02); OpenStack also 5xx accesses. */
function candidate(dataset: Dataset, q: string): string {
  switch (dataset) {
    case "bgl":
      return `(${q}.is_error OR ${q}.is_alert)`
    case "openstack":
      return `(${q}.is_error OR (${q}.http_status >= 500 AND ${q}.http_status <= 599))`
    default:
      return `${q}.is_error`
  }
}

function candidateText(dataset: Dataset): string {
  switch (dataset) {
    case "bgl":
      return "error events (FATAL, ERROR, SEVERE, FAILURE) or alerts (R-02)"
    case "openstack":
      return "error events (ERROR, CRITICAL) or failed API accesses (HTTP 500–599, R-02)"
    default:
      return `error events (${DATASETS[dataset].errorDefinition ?? "none defined"}, R-02)`
  }
}

const BASE_NOTE =
  "Counts are log events (parsed lines), not incidents; patterns and episodes are not incidents or outages."
const EPISODE_NOTE = `Episodes are computed over the fully filtered scope: a new episode starts after at least ${EPISODE_GAP_MINUTES} minutes without an event of the same pattern (R-05); recurring means at least ${RECURRING_MIN_EPISODES} episodes. A single episode over several active days is not a one-off spike; describe it with its duration and active days.`
const INVESTIGATION_NOTE =
  "Episodes are not outages; ranking is a technical investigation order, not severity or business risk; business impact unknown."
const STATUS_NOTE = `Status follows R-10 against the previous period (escalating: B > 0, C ≥ ${SIGNIFICANT_INCREASE_FACTOR} · B and C − B ≥ ${SIGNIFICANT_INCREASE_MIN_EVENTS}); a status is not a severity.`
const TEAM_NOTE =
  "Teams come from a fictional ownership table (Serene Platform); unmapped components are 'unowned'."
const LABEL_NOTE =
  "Alert labels are BGL dataset labels, not findings of this system."
const INVESTIGATION_HINT = `rank investigation_order ranks the error and alert patterns of one dataset and scope (A-11): remove ${INVESTIGATION_EXCLUDED_FILTERS.join(", ")}, use limit 1–${INVESTIGATION_MAX_LIMIT} (default ${INVESTIGATION_DEFAULT_LIMIT}) and leave only_errors out (it is implied). For one pattern, use another rank with pattern_id.`

/** BIGINT columns arrive as exact strings and become numbers only after a range check. */
const exactInteger = z
  .union([z.string(), z.number()])
  .transform((value) => toSafeInteger(value))
const exactCount = exactInteger.pipe(z.number().int().nonnegative())

const rulesRow = z.object({
  rules_version: z.string(),
  pattern_rules_version: z.string(),
})

const patternRow = z.object({
  record_kind: z.literal("pattern"),
  pattern_id: z.string(),
  pattern: z.string(),
  dataset: z.string(),
  component: z.string().nullable(),
  team: z.string(),
  events: exactCount,
  episodes: exactCount,
  recurring: z.boolean(),
  status: patternStatusSchema,
  first_seen_before_window: instantSchema.nullable(),
  active_days: exactCount,
  active_weeks: exactCount,
  b1: exactCount.nullable(),
  b2: exactCount.nullable(),
  components: exactCount,
  first_seen: instantSchema.nullable(),
  last_seen: instantSchema.nullable(),
  example_event_id: exactCount.nullable(),
  baseline: exactCount.nullable(),
  delta: exactInteger.nullable(),
  share: z.number().nullable(),
  total: exactCount,
  active: exactCount,
  quiet: exactCount,
})

type PatternRow = z.infer<typeof patternRow>

const detailRow = z.object({
  pattern_id: z.string(),
  kind: z.enum(["level", "label"]),
  value: z.string().nullable(),
  events: exactCount,
})

/** C, B and what the data span says about them. */
type Periods = {
  current: TimeRange
  baseline: TimeRange
  coverage: ComparisonCoverage
  span: DataSpan
}

export const recurringPatterns = defineTool({
  name: "recurring_patterns",
  title: "Recurring patterns",
  version: "1.2.0",
  description: renderDescription({
    purpose: `Patterns (normalised messages, R-04) of one dataset with their episodes (R-05: a new episode after at least ${EPISODE_GAP_MINUTES} min without the pattern, computed over the fully filtered scope), active days and weeks, breadth, change against the previous period of the same length and status (new, escalating, reappeared, ongoing, quiet; R-10). With rank investigation_order it ranks the error and alert patterns into a reproducible technical investigation order by episodes and breadth instead of log lines, with the leader per criterion and dominance (R-08, R-09). Optional analysis selects periodicity (pattern_id,min_occurrences at least four) or cooccurrence/order (pattern_a,pattern_b,window_seconds,direction either|after,optional control_pattern_id). SQL computes consecutive gaps or distinct matched-anchor rates over the same filtered dataset/window; temporal order is never a causal conclusion.`,
    useWhen:
      "the question is whether a problem recurs or was a one-off spike, which patterns a team or component has, what is new, escalating or reappearing, or which problems to investigate first (priorities for a manager: rank investigation_order).",
    doNotUseWhen: [
      {
        situation: "you look for single events or example lines",
        use: "search_logs or get_log_context",
      },
      {
        situation:
          "you need a pure distribution or total by team, component, level or node",
        use: "count_events",
      },
      {
        situation: "you need the development over time in buckets",
        use: "event_trend",
      },
    ],
    inputs: `dataset (required, exactly one loaded dataset; not otel, whose messages stay in remote files without patterns: invalid_input), from/to as ISO-8601 with Z or offset, [from, to), default the whole data span; the previous period of the same length is the reference for delta and status, so without a window it lies before the data and is not determinable. rank: episodes (default; episodes, then events), events (log events, then episodes; inflated by bursts), increase (C − B, then events; fails when the previous period lies outside the data span), investigation_order (error events after R-02 and BGL alerts only, for OpenStack also 5xx accesses; not for linux, which has no error definition; order episodes ↓, breadth ↓, increase ↓, events ↓, pattern_id; a criterion not determinable for every candidate is dropped for all). limit 1–${RECURRING_MAX_LIMIT}, default ${RECURRING_DEFAULT_LIMIT}; with investigation_order 1–${INVESTIGATION_MAX_LIMIT}, default ${INVESTIGATION_DEFAULT_LIMIT}, and no ${INVESTIGATION_EXCLUDED_FILTERS.join(", ")}. Episodes depend on the filters: filtering by node can split one episode into two.`,
    filters: RECURRING_FILTER.summary,
    outputs: `per pattern pattern_id, pattern, component, team (fictional), events (C), first_seen, last_seen, episodes, recurring (≥ ${RECURRING_MIN_EPISODES} episodes), active_days, active_weeks, breadth (BGL nodes and racks, OpenStack instances and requests, HDFS blocks, OpenSSH and Apache client_ips, none for Linux and ZooKeeper; null when not every event carries the unit), components, baseline (B), delta (C − B, null when B is not determinable), status, first_seen_before_window (same filters except time), example_event_id; totals events, pattern_count, quiet_count; comparison (B window, coverage, determinable); rules (versions, ${EPISODE_GAP_MINUTES}-minute gap, breadth unit). investigation_order adds per candidate share_of_error_events, levels and labels, and investigation with candidates_checked (all candidates, not only the listed), rank_basis (criteria used and dropped with reason), leaders (highest value and holder per criterion), dominance (clear_priority = clear priority 1, or trade_off with the conflicts to name) and limits (the R-09 limit; quote it). Levels, labels and status are no ranking criteria. Cite every number by its fact ID (group pattern_id).`,
    truncation:
      "at most limit patterns in rank order with pattern_id as final tiebreaker; truncated is true when more qualify. investigation_order still checks every candidate in scope.",
    countingUnit:
      "log events (parsed lines) per pattern; episodes are bursts of a pattern, not incidents or outages. No severity, no business impact, no composite risk score.",
  }),
  input: recurringPatternsInputSchema,
  output: recurringPatternsOutputSchema,
  factSpecs: recurringPatternsFactSpecs,
  annotations: READ_ONLY_ANNOTATIONS,
  validate: validatePatterns,
  summary: summarizeRecurringPatterns,
  async run(ctx, input) {
    const limit = resolvedLimit(input)
    const investigating = input.rank === "investigation_order"
    const { dataset } = input

    const resolved = await resolveWindows(ctx.db, [dataset], input, ctx.signal)
    if (!resolved.ok) return resolved
    const [first] = resolved.windows
    if (first === undefined) throw new Error("no window for the dataset")
    const { span } = first
    const current: TimeRange = { from: first.window.from, to: first.window.to }
    if (!isBefore(current.from, current.to))
      return { ok: false, error: emptyWindow(current, span, dataset) }
    const baseline = previousPeriod(current)
    const periods: Periods = {
      current,
      baseline,
      coverage: await comparisonCoverageSql(ctx, current, baseline, span),
      span,
    }
    if (input.rank === "increase" && !periods.coverage.determinable)
      return { ok: false, error: increaseNotDeterminable(periods, dataset) }

    const rulesQuery = await ctx.db.query(
      "SELECT rules_version, pattern_rules_version FROM load_manifest",
      [],
      ctx.signal
    )
    const rules = rulesRow.parse(rulesQuery.rows[0])

    const {
      listed,
      investigation,
      dropped,
      total,
      active,
      quiet,
      truncated,
      qualifying,
    } = await mainAggregate(ctx, input, periods, limit)
    const ids = listed.map((row) => row.pattern_id)
    const startsAfterData = isBefore(span.first, current.from)
    const details = investigating
      ? await levelsAndLabels(ctx, input, current, ids)
      : null

    const patterns = listed.map((row) =>
      toPattern(row, {
        dataset,
        details,
      })
    )
    const data: RecurringPatternsOutput = {
      ...(input.analysis === undefined
        ? {}
        : { analysis: await patternAnalysis(ctx, input, current) }),
      dataset,
      rank: input.rank,
      limit,
      rules: {
        ...rules,
        episode_gap_minutes: EPISODE_GAP_MINUTES,
        recurring_min_episodes: RECURRING_MIN_EPISODES,
        breadth_unit: DATASETS[dataset].breadth?.unit ?? null,
      },
      comparison: {
        baseline,
        coverage: {
          current: periods.coverage.current,
          baseline: periods.coverage.baseline,
        },
        determinable: periods.coverage.determinable,
      },
      events: total,
      pattern_count: active,
      quiet_count: quiet,
      patterns,
      truncated,
      investigation,
    }
    const scope: Scope = {
      windows: [
        { dataset, ...current, period: "current" },
        { dataset, ...baseline, period: "baseline" },
      ],
      filters: scopeFilters(input, RECURRING_FILTER.fields),
    }

    return {
      ok: true,
      run: {
        data,
        scope,
        population: { count: total, unit: "log_events" },
        rows_returned: patterns.length,
        truncated: data.truncated,
        row_limit: limit,
        notes: notesFor(
          input,
          data,
          periods,
          startsAfterData,
          dropped,
          qualifying
        ),
      },
    }
  },
})

/** The shared filter of every query without the window; investigation_order implies only_errors. */
function filterOf(input: RecurringPatternsInput): Partial<Filter> {
  return {
    ...input,
    from: undefined,
    to: undefined,
    only_errors:
      input.rank === "investigation_order" ? undefined : input.only_errors,
  }
}

/**
 * WHERE condition of the scope without the window, on alias `e`, plus the
 * R-08 candidate condition for investigation_order.
 */
function scopeCondition(
  input: RecurringPatternsInput,
  params: SqlParams
): { relation: string; where: string } {
  const compiled = compileFilter(filterOf(input), {
    accepted: ["dataset", ...RECURRING_FILTER.fields],
    params,
    alias: "e",
  })
  // The schema and validatePatterns admit only accepted fields.
  if (!compiled.ok) throw new Error(compiled.error.message)
  const conditions = [compiled.filter.where]
  if (input.rank === "investigation_order")
    conditions.push(candidate(input.dataset, "e"))
  return { relation: compiled.filter.relation, where: conditions.join(" AND ") }
}

function inRange(range: TimeRange, params: SqlParams): string {
  return `e.ts >= ${params.add(range.from)}::TIMESTAMPTZ AND e.ts < ${params.add(range.to)}::TIMESTAMPTZ`
}

/** Non-investigation orders; R-08 builds its availability-aware order in SQL. */
const ORDER: Record<Rank, string> = {
  episodes: "episodes DESC, events DESC, pattern_id ASC",
  events: "events DESC, episodes DESC, pattern_id ASC",
  increase: "delta DESC, events DESC, pattern_id ASC",
  investigation_order: "pattern_id ASC",
}

/**
 * The main aggregate (3): C per pattern with episodes, activity and breadth
 * over the filtered window, B per pattern when determinable, and the totals
 * of the scope as window columns of every row.
 */
async function mainAggregate(
  ctx: ToolContext,
  input: RecurringPatternsInput,
  periods: Periods,
  limit: number
): Promise<Aggregate> {
  const params = new SqlParams()
  const { relation, where } = scopeCondition(input, params)
  const [u1, u2] = breadthColumns(input.dataset)
  const gap = params.add(GAP_INTERVAL)
  const inCurrent = inRange(periods.current, params)
  const compared = periods.coverage.determinable
  const inBaseline = compared ? inRange(periods.baseline, params) : null
  const investigating = input.rank === "investigation_order"

  const ctes = [
    `WITH cur AS (SELECT e.event_id, e.pattern_id, e.pattern, e.dataset, e.component, e.ts, ${u1} AS u1, ${u2} AS u2 FROM ${relation} e WHERE ${where} AND ${inCurrent})`,
    `, episodic AS (SELECT * FROM cur MATCH_RECOGNIZE (PARTITION BY pattern_id ORDER BY ts, event_id MEASURES pattern AS pattern, dataset AS dataset, component AS component, u1 AS u1, u2 AS u2, CLASSIFIER() AS phase, MATCH_NUMBER() AS episode ALL ROWS PER MATCH AFTER MATCH SKIP PAST LAST ROW PATTERN (s n*) DEFINE n AS ts - PREV(ts) < ${gap}::INTERVAL))`,
    `, c AS (SELECT pattern_id, min(pattern) AS pattern, min(dataset) AS dataset, min(component) AS component, count(*) AS events, count(*) FILTER (WHERE phase = 's') AS episodes, count(DISTINCT date_trunc('day', ts)) AS active_days, count(DISTINCT date_trunc('week', ts)) AS active_weeks, CASE WHEN count(u1) = count(*) THEN count(DISTINCT u1) END AS b1, CASE WHEN count(u2) = count(*) THEN count(DISTINCT u2) END AS b2, count(DISTINCT component) AS components, min(ts) AS first_ts, max(ts) AS last_ts, min(event_id) FILTER (WHERE phase = 's' AND episode = 1) AS example_event_id FROM episodic GROUP BY pattern_id)`,
  ]
  if (inBaseline === null) {
    ctes.push(
      ", joined AS (SELECT *, NULL::BIGINT AS baseline, NULL::BIGINT AS delta FROM c)"
    )
  } else {
    ctes.push(
      `, b AS (SELECT e.pattern_id, min(e.pattern) AS pattern, min(e.dataset) AS dataset, min(e.component) AS component, count(*) AS baseline FROM ${relation} e WHERE ${where} AND ${inBaseline} GROUP BY e.pattern_id)`,
      // A pattern seen only in B has no event in the window: C = 0, its
      // breadth over no events is 0, and times and example are NULL.
      ", joined AS (SELECT coalesce(c.pattern_id, b.pattern_id) AS pattern_id, coalesce(c.pattern, b.pattern) AS pattern, coalesce(c.dataset, b.dataset) AS dataset, coalesce(c.component, b.component) AS component, coalesce(c.events, 0) AS events, coalesce(c.episodes, 0) AS episodes, coalesce(c.active_days, 0) AS active_days, coalesce(c.active_weeks, 0) AS active_weeks, CASE WHEN c.pattern_id IS NULL THEN 0 ELSE c.b1 END AS b1, CASE WHEN c.pattern_id IS NULL THEN 0 ELSE c.b2 END AS b2, coalesce(c.components, 0) AS components, c.first_ts, c.last_ts, c.example_event_id, coalesce(b.baseline, 0) AS baseline, coalesce(c.events, 0) - coalesce(b.baseline, 0) AS delta FROM c FULL OUTER JOIN b ON c.pattern_id = b.pattern_id)"
    )
  }
  const recurringMinimum = `${params.add(RECURRING_MIN_EPISODES)}::BIGINT`
  const increaseFactor = `${params.add(SIGNIFICANT_INCREASE_FACTOR)}::BIGINT`
  const increaseMinimum = `${params.add(SIGNIFICANT_INCREASE_MIN_EVENTS)}::BIGINT`
  const historyFrom = `${params.add(periods.current.from)}::TIMESTAMPTZ`
  const firstInData = `${params.add(periods.span.first)}::TIMESTAMPTZ`
  ctes.push(
    `, history AS (SELECT e.pattern_id, min(e.ts) AS first_before FROM ${relation} e WHERE ${where} AND e.ts < ${historyFrom} AND ${firstInData} < ${historyFrom} AND e.pattern_id IN (SELECT pattern_id FROM joined) GROUP BY e.pattern_id)`,
    `, ruled AS (SELECT joined.*, history.first_before, episodes >= ${recurringMinimum} AS recurring, CASE WHEN events > 0 AND history.first_before IS NULL AND ${firstInData} < ${historyFrom} THEN 'new' WHEN baseline > 0 AND events >= ${increaseFactor} * baseline AND events - baseline >= ${increaseMinimum} THEN 'escalating' WHEN baseline = 0 AND events > 0 AND history.first_before IS NOT NULL THEN 'reappeared' WHEN events > 0 THEN 'ongoing' WHEN baseline > 0 THEN 'quiet' ELSE NULL::VARCHAR END AS status FROM joined LEFT JOIN history ON joined.pattern_id = history.pattern_id)`,
    ", totals AS (SELECT coalesce(sum(events), 0)::BIGINT AS total, coalesce(count_if(events > 0), 0) AS active, coalesce(count_if(events = 0), 0) AS quiet FROM joined)",
    ...(investigating
      ? investigationCtes(params, limit)
      : [
          ` , ranked AS (SELECT *, row_number() OVER (ORDER BY ${ORDER[input.rank]}) AS rank FROM ruled)`,
        ])
  )
  const columns: readonly RecordColumn[] = [
    ...["pattern_id", "pattern", "dataset", "component"].map(
      (name): RecordColumn => [name, "VARCHAR", name]
    ),
    ["team", "VARCHAR", dimensionExpression("team", "ranked")],
    ...[
      "events",
      "episodes",
      "active_days",
      "active_weeks",
      "b1",
      "b2",
      "components",
      "example_event_id",
      "baseline",
      "delta",
    ].map((name): RecordColumn => [name, "BIGINT", name]),
    ["recurring", "BOOLEAN", "recurring"],
    ["status", "VARCHAR", "status"],
    ["first_seen_before_window", "VARCHAR", isoTime("first_before")],
    ["first_seen", "VARCHAR", isoTime("first_ts")],
    ["last_seen", "VARCHAR", isoTime("last_ts")],
    [
      "share",
      "DOUBLE",
      "events::DOUBLE / NULLIF((SELECT total FROM totals), 0)",
    ],
    ...["total", "active", "quiet"].map((name): RecordColumn => [
      name,
      "BIGINT",
      `(SELECT ${name} FROM totals)`,
    ]),
  ]
  const selection = ruleRecords(columns, params, investigating, limit)
  const { rows } = await ctx.db.query(
    `${ctes.join("")}${selection}`,
    params.values,
    ctx.signal
  )
  return assembleAggregate(rows, periods, input.dataset, investigating)
}

type DroppedCriterion = { criterion: RankCriterion; reason: string }
type Aggregate = {
  listed: PatternRow[]
  investigation: RecurringPatternsOutput["investigation"]
  dropped: DroppedCriterion[]
  total: number
  active: number
  quiet: number | null
  truncated: boolean
  qualifying: number
}

const totalsRow = z.object({
  total: exactCount,
  active: exactCount,
  quiet: exactCount,
  truncated: z.boolean(),
  qualifying: exactCount,
})
const recordKindRow = z.object({
  record_kind: z.enum(["pattern", "summary", "leader", "conflict"]),
})

/** Assemble already ordered, counted and capped SQL records into the public DTO. */
function assembleAggregate(
  rows: readonly unknown[],
  periods: Periods,
  dataset: Dataset,
  investigating: boolean
): Aggregate {
  const listed: PatternRow[] = []
  const leaders: NonNullable<
    RecurringPatternsOutput["investigation"]
  >["leaders"] = {
    episodes: null,
    breadth: null,
    increase: null,
    events: null,
  }
  const conflicts: z.infer<typeof conflictRow>[] = []
  let summary: z.infer<typeof ruleSummaryRow> | undefined
  let totals: z.infer<typeof totalsRow> | undefined
  for (const row of rows) {
    const { record_kind } = recordKindRow.parse(row)
    if (record_kind === "pattern") listed.push(patternRow.parse(row))
    else if (record_kind === "summary") {
      totals = totalsRow.parse(row)
      if (investigating) summary = ruleSummaryRow.parse(row)
    } else if (record_kind === "leader") {
      const parsed = leaderRow.parse(row)
      const entry = leaders[parsed.criterion] ?? {
        value: parsed.value,
        tied: parsed.tied,
        pattern_ids: [],
      }
      entry.pattern_ids.push(parsed.pattern_id)
      leaders[parsed.criterion] = entry
    } else conflicts.push(conflictRow.parse(row))
  }
  if (totals === undefined) throw new Error("aggregate summary missing")
  const dropped: DroppedCriterion[] = []
  let investigation: RecurringPatternsOutput["investigation"] = null
  if (investigating) {
    if (summary === undefined) throw new Error("investigation summary missing")
    if (summary.drop_breadth) {
      const breadth = DATASETS[dataset].breadth
      dropped.push({
        criterion: "breadth",
        reason:
          breadth === null
            ? `Dataset ${dataset} has no breadth unit (no node, instance, block or client field, R-08), so breadth is no criterion.`
            : `${summary.missing_breadth} of ${summary.candidates_checked} candidates have events without ${BREADTH_ARTICLE[breadth.unit]} in scope, so breadth (${breadth.unit}) is not determinable for every candidate (R-08).`,
      })
    }
    if (summary.drop_increase)
      dropped.push({
        criterion: "increase",
        reason: `The previous period [${periods.baseline.from}, ${periods.baseline.to}) lies outside the ${dataset} data span (${periods.span.first} to ${periods.span.last}), so the increase C − B is not determinable (R-06).`,
      })
    const compared = dimensions(!summary.drop_breadth, !summary.drop_increase)
    const firstId = summary.first_pattern_id
    investigation = {
      candidates_checked: summary.candidates_checked,
      rank_basis: { criteria: rankBasis(summary), dropped },
      leaders,
      dominance:
        firstId === null
          ? null
          : summary.not_dominated_by_first === 0
            ? {
                kind: "clear_priority",
                pattern_id: firstId,
                dimensions: compared,
                compared_with: summary.compared_with,
              }
            : {
                kind: "trade_off",
                pattern_id: firstId,
                dimensions: compared,
                not_dominated_by_first: summary.not_dominated_by_first,
                conflicts: conflicts.map((row) => ({
                  a: row.a,
                  b: row.b,
                  a_ahead_in: aheadDimensions(
                    row.a_episodes,
                    row.a_breadth,
                    row.a_change
                  ),
                  b_ahead_in: aheadDimensions(
                    row.b_episodes,
                    row.b_breadth,
                    row.b_change
                  ),
                  b_listed: row.b_listed,
                })),
              },
      limits: INVESTIGATION_LIMITS,
    }
  }
  return {
    listed,
    investigation,
    dropped,
    total: totals.total,
    active: totals.active,
    quiet: periods.coverage.determinable ? totals.quiet : null,
    truncated: totals.truncated,
    qualifying: totals.qualifying,
  }
}

function aheadDimensions(episodes: boolean, breadth: boolean, change: boolean) {
  return [
    ...(episodes ? ["episodes" as const] : []),
    ...(breadth ? ["breadth" as const] : []),
    ...(change ? ["change" as const] : []),
  ]
}

type Details = Map<
  string,
  {
    levels: { level: string | null; events: number }[]
    labels: { alert_label: string; events: number }[]
  }
>

/** Levels and alert labels of the listed candidates (5); shown separately, never ranked (R-09). */
async function levelsAndLabels(
  ctx: ToolContext,
  input: RecurringPatternsInput,
  current: TimeRange,
  ids: readonly string[]
): Promise<Details> {
  const details: Details = new Map(
    ids.map((id) => [id, { levels: [], labels: [] }])
  )
  if (ids.length === 0) return details
  const params = new SqlParams()
  const { relation, where } = scopeCondition(input, params)
  const condition = `${where} AND ${inRange(current, params)} AND e.pattern_id IN (${params.list(ids)})`
  const levels = `SELECT e.pattern_id, 'level' AS kind, e.level AS value, count(*) AS events FROM ${relation} e WHERE ${condition} GROUP BY e.pattern_id, e.level`
  const labels = `SELECT e.pattern_id, 'label' AS kind, e.alert_label AS value, count(*) AS events FROM ${relation} e WHERE ${condition} AND e.alert_label IS NOT NULL GROUP BY e.pattern_id, e.alert_label`
  const { rows } = await ctx.db.query(
    `${input.dataset === "bgl" ? `${levels} UNION ALL ${labels}` : levels} ORDER BY pattern_id, kind, events DESC, value NULLS LAST`,
    params.values,
    ctx.signal
  )
  for (const row of rows) {
    const parsed = detailRow.parse(row)
    const entry = details.get(parsed.pattern_id)
    if (entry === undefined)
      throw new Error("detail row of an unlisted pattern")
    if (parsed.kind === "level")
      entry.levels.push({ level: parsed.value, events: parsed.events })
    else if (parsed.value !== null)
      entry.labels.push({ alert_label: parsed.value, events: parsed.events })
  }
  return details
}

function toPattern(
  row: PatternRow,
  context: {
    dataset: Dataset
    details: Details | null
  }
): RecurringPattern {
  const unit = DATASETS[context.dataset].breadth
  const breadth =
    unit === null
      ? {}
      : {
          [unit.unit]: row.b1,
          ...(unit.extra === null ? {} : { [unit.extra.unit]: row.b2 }),
        }
  const pattern: RecurringPattern = {
    pattern_id: row.pattern_id,
    pattern: row.pattern,
    component: row.component,
    team: row.team,
    events: row.events,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
    episodes: row.episodes,
    recurring: row.recurring,
    active_days: row.active_days,
    active_weeks: row.active_weeks,
    ...breadth,
    components: row.components,
    baseline: row.baseline,
    delta: row.delta,
    status: row.status,
    first_seen_before_window: row.first_seen_before_window,
    example_event_id: row.example_event_id,
  }
  if (context.details === null) return pattern
  const detail = context.details.get(row.pattern_id)
  if (detail === undefined || row.share === null)
    throw new Error("candidate without details or share")
  return {
    ...pattern,
    share_of_error_events: row.share,
    levels: detail.levels,
    labels: context.dataset === "bgl" ? detail.labels : null,
  }
}

/**
 * Cross-field rules: the restrictions of investigation_order (A-11, § 8.2)
 * and the shared filter rules.
 */
function validatePatterns(input: RecurringPatternsInput): ToolError | null {
  // Remote datasets have no message patterns (LOG-35): never a zero.
  if (!DATASETS[input.dataset].patterns)
    return invalidInput([patternsUnsupported(input.dataset, "dataset")])
  const issues: InputIssue[] = []
  if (input.analysis !== undefined && input.rank === "investigation_order")
    issues.push({
      path: "analysis",
      message:
        "Temporal analysis uses the same ordinary filtered event scope; choose rank events or episodes, not investigation_order.",
    })
  if (input.rank === "investigation_order") {
    for (const field of INVESTIGATION_EXCLUDED_FILTERS)
      if (input[field] !== undefined)
        issues.push({
          path: field,
          message:
            "Not with rank investigation_order: it ranks the error and alert patterns of the whole scope.",
        })
    if (input.limit !== undefined && input.limit > INVESTIGATION_MAX_LIMIT)
      issues.push({
        path: "limit",
        message: `With rank investigation_order limit is 1–${INVESTIGATION_MAX_LIMIT} (default ${INVESTIGATION_DEFAULT_LIMIT}); ${input.limit} given.`,
      })
    if (input.only_errors === false)
      issues.push({
        path: "only_errors",
        message:
          "investigation_order always ranks error events and alerts (R-08); leave only_errors out.",
      })
    if (DATASETS[input.dataset].errorDefinition === null)
      issues.push({
        path: "rank",
        message: `Dataset ${input.dataset} has no error definition (no level or error marker in the log, R-02), so there are no determinable candidates; use rank episodes or events instead.`,
      })
  }
  if (
    input.analysis?.mode === "cooccurrence" &&
    input.analysis.pattern_a === input.analysis.pattern_b
  )
    issues.push({
      path: "analysis.pattern_b",
      message: "Choose two distinct patterns for cooccurrence/order.",
    })
  if (
    input.analysis?.mode === "cooccurrence" &&
    input.analysis.control_pattern_id === input.analysis.pattern_a
  )
    issues.push({
      path: "analysis.control_pattern_id",
      message: "The control pattern must differ from the anchor pattern.",
    })
  const investigationIssues = issues.length
  const filterError = validateFilter(input)
  if (filterError?.code === "invalid_input") issues.push(...filterError.issues)
  else if (filterError !== null) return filterError
  if (issues.length === 0) return null
  return investigationIssues > 0
    ? invalidInput(issues, INVESTIGATION_HINT)
    : invalidInput(issues)
}

function isBefore(a: string, b: string): boolean {
  const left = parseInstant(a)
  const right = parseInstant(b)
  if (left === null || right === null) throw new RangeError("not an instant")
  return left < right
}

function emptyWindow(
  window: TimeRange,
  span: DataSpan,
  dataset: Dataset
): ToolError {
  return invalidInput(
    [
      {
        path: "",
        message: `The window [${window.from}, ${window.to}) is empty: a missing bound defaults to the ${dataset} data span (${span.first} to ${span.last}).`,
      },
    ],
    "Pass both from and to, with from earlier than to."
  )
}

function increaseNotDeterminable(
  periods: Periods,
  dataset: Dataset
): ToolError {
  return invalidInput(
    [
      {
        path: "rank",
        message: `rank increase needs the previous period [${periods.baseline.from}, ${periods.baseline.to}), which lies outside the ${dataset} data span (${periods.span.first} to ${periods.span.last}); no increase can be determined (R-06).`,
      },
    ],
    "Rank by episodes or events, or choose from and to so that the previous period of the same length lies inside the data span."
  )
}

function notesFor(
  input: RecurringPatternsInput,
  data: RecurringPatternsOutput,
  periods: Periods,
  startsAfterData: boolean,
  dropped: readonly { criterion: RankCriterion; reason: string }[],
  qualifying: number
): string[] {
  const { current, baseline, coverage, span } = periods
  const investigating = data.investigation !== null
  const notes = [BASE_NOTE, EPISODE_NOTE]
  if (investigating) {
    notes.push(
      INVESTIGATION_NOTE,
      `Candidates are patterns with ${candidateText(input.dataset)} in scope; only those events are counted, and share_of_error_events is their share of the ${data.events} candidate events.`
    )
    for (const { criterion, reason } of dropped)
      notes.push(
        `Rank criterion ${criterion} dropped for all candidates: ${reason}`
      )
    if (data.investigation?.candidates_checked === 1)
      notes.push(
        "Only one candidate in scope: it is first by default, and dominance compares it with nothing."
      )
  }
  const spanText = `${span.first} to ${span.last}`
  if (coverage.current === "none")
    notes.push(
      `The window lies outside the ${input.dataset} data span (${spanText}): its count of 0 is not an observed zero (R-03).`
    )
  else if (coverage.current === "partial")
    notes.push(
      `The window reaches beyond the ${input.dataset} data span (${spanText}); only the observed part is counted.`
    )
  if (!coverage.determinable)
    notes.push(
      `The previous period [${baseline.from}, ${baseline.to}) lies outside the ${input.dataset} data span (${spanText}): baseline and delta are null, not 0, and status skips escalating, reappeared and quiet (R-10).`
    )
  else {
    notes.push(
      `delta and status compare C = [${current.from}, ${current.to}) with the previous period B = [${baseline.from}, ${baseline.to}) of the same length, same filters.`
    )
    if (coverage.baseline === "partial")
      notes.push(
        `The previous period is only partly covered by data (${input.dataset} data span ${spanText}): B counts only the observed part, so an increase may be overstated.`
      )
  }
  notes.push(STATUS_NOTE)
  if (startsAfterData)
    notes.push(
      `new and reappeared look for events of the pattern before ${current.from} with the same filters except time${investigating ? " (candidate events only)" : ""}.`
    )
  else
    notes.push(
      "The window starts with the data, so no pattern is new: its first event may be the start of the data."
    )
  if (data.events === 0) {
    const filters = describeFilters(
      scopeFilters(input, RECURRING_FILTER.fields)
    )
    notes.push(
      `Nothing in scope: 0 ${investigating ? "candidate events" : "log events"} in ${input.dataset} [${current.from}, ${current.to})${filters === "" ? "" : ` with ${filters}`}.`
    )
  }
  if (data.truncated) {
    notes.push(
      `Truncated: ${data.patterns.length} of ${qualifying} patterns listed; raise limit (max ${investigating ? INVESTIGATION_MAX_LIMIT : RECURRING_MAX_LIMIT}) or narrow the filters.`
    )
  }
  if (data.patterns.length > 0 || input.teams !== undefined)
    notes.push(TEAM_NOTE)
  if (
    input.alert_label !== undefined ||
    data.patterns.some((pattern) => (pattern.labels ?? []).length > 0)
  )
    notes.push(LABEL_NOTE)
  return notes
}
