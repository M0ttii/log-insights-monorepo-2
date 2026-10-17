import { check, timed, type Probe } from "../probe.ts"

/** Episode gap and look-back window for the probe; R-05 fixes the real threshold in U03. */
const EPISODE_GAP = "30 minutes"
const WINDOW = "10 minutes"
const WINDOW_US = 10 * 60 * 1_000_000
const STATEMENT_TIMEOUT_MS = 10_000

// Sketch of get_log_context mode=aggregate (technical.md § 8.2): anchors are
// episode starts of the anchor pattern within the scope; for each other
// pattern count anchors with at least one occurrence in the window before;
// base rate is the share of fixed grid windows from the span start that
// contain the pattern. Ratios are computed in SereneDB.
const PRECURSORS = `
WITH scope AS (SELECT event_id, ts, pattern_id FROM gate.bgl WHERE dataset = 'bgl'),
span AS (SELECT min(ts) AS t0, max(ts) AS t1 FROM scope),
grid AS (SELECT (epoch_us(t1) - epoch_us(t0)) // $4 + 1 AS windows FROM span),
anchors AS (
  SELECT event_id, ts FROM (
    SELECT event_id, ts, lag(ts) OVER (ORDER BY ts, event_id) AS prev_ts
    FROM scope WHERE pattern_id = $1::UBIGINT) s
  WHERE prev_ts IS NULL OR ts - prev_ts >= $2::INTERVAL),
anchor_count AS (SELECT count(*) AS anchors FROM anchors),
hits AS (
  SELECT e.pattern_id, count(DISTINCT a.event_id) AS anchors_with_pattern
  FROM anchors a
  JOIN scope e ON e.ts >= a.ts - $3::INTERVAL AND e.ts < a.ts AND e.pattern_id <> $1::UBIGINT
  GROUP BY e.pattern_id
  ORDER BY anchors_with_pattern DESC, e.pattern_id
  LIMIT 10),
base AS (
  SELECT s.pattern_id, count(DISTINCT (epoch_us(s.ts) - epoch_us(span.t0)) // $4) AS windows_with_pattern
  FROM scope s, span
  WHERE s.pattern_id IN (SELECT pattern_id FROM hits)
  GROUP BY s.pattern_id)
SELECT h.pattern_id, h.anchors_with_pattern, c.anchors,
       h.anchors_with_pattern::DOUBLE / c.anchors AS anchor_share,
       b.windows_with_pattern::DOUBLE / g.windows AS base_rate,
       (h.anchors_with_pattern::DOUBLE / c.anchors) / (b.windows_with_pattern::DOUBLE / g.windows) AS ratio
FROM hits h JOIN base b USING (pattern_id), anchor_count c, grid g
ORDER BY h.anchors_with_pattern DESC, h.pattern_id`

export const g09Precursors: Probe = {
  id: "G9",
  title: "Precursor analysis (R-11) on the full BGL corpus",
  async run({ db, loadBgl }) {
    const load = await loadBgl()
    if (load === null) return [{ skipped: "BGL.log not downloaded" }]

    // Frequent: most episodes. Rare: fewest events among patterns with at
    // least five episodes (base rates start at five anchors, § 8.2).
    const candidates = await db.rows(
      `WITH s AS (
         SELECT pattern_id, ts, lag(ts) OVER (PARTITION BY pattern_id ORDER BY ts, event_id) AS prev_ts
         FROM gate.bgl),
       p AS (
         SELECT pattern_id, count(*) AS events,
                count(*) FILTER (WHERE prev_ts IS NULL OR ts - prev_ts >= $1::INTERVAL) AS episodes
         FROM s GROUP BY pattern_id)
       (SELECT 'frequent' AS kind, pattern_id::TEXT AS pattern_id, events, episodes FROM p ORDER BY episodes DESC, pattern_id LIMIT 1)
       UNION ALL
       (SELECT 'rare', pattern_id::TEXT, events, episodes FROM p WHERE episodes >= 5 ORDER BY events, pattern_id LIMIT 1)
       UNION ALL
       (SELECT 'most_events', pattern_id::TEXT, events, episodes FROM p ORDER BY events DESC, pattern_id LIMIT 1)`,
      [EPISODE_GAP]
    )

    const checks = []
    for (const candidate of candidates) {
      const kind = String(candidate["kind"])
      const run = await timed(() =>
        db.rows(PRECURSORS, [
          String(candidate["pattern_id"]),
          EPISODE_GAP,
          WINDOW,
          WINDOW_US,
        ])
      )
      const [top] = run.result
      checks.push(
        check(
          `${kind} pattern (${String(candidate["events"])} events, ${String(candidate["episodes"])} anchors): runtime`,
          `< ${STATEMENT_TIMEOUT_MS} ms`,
          `${run.ms} ms; top precursor share ${Number(top?.["anchor_share"]).toFixed(3)}, base rate ${Number(top?.["base_rate"]).toFixed(4)}, ratio ${Number(top?.["ratio"]).toFixed(2)}`,
          run.ms < STATEMENT_TIMEOUT_MS && run.result.length > 0
        )
      )
    }
    return checks
  },
}
