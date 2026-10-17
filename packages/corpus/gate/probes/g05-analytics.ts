import { connect } from "../db.ts"
import { equals, type Probe } from "../probe.ts"

export const g05Analytics: Probe = {
  id: "G5",
  title:
    "Window functions, percentiles, date buckets, DISTINCT, FILTER, intervals",
  async run({ config, db }) {
    // Hand-checkable fixture (technical.md § 8.2 counterexamples): pattern p on
    // node A at 00:00, B at 00:20, A at 00:40; two events share the first
    // timestamp of pattern q. With a 30-minute gap, p has 1 episode unfiltered
    // and 2 with node = 'A'; q has 1 episode.
    await db.rows(
      `CREATE OR REPLACE TABLE gate.g5 AS SELECT * FROM (VALUES
         (1::BIGINT, 'p', 'A', TIMESTAMPTZ '2005-06-03 00:00:00+00', 10.0::DOUBLE),
         (2, 'p', 'B', TIMESTAMPTZ '2005-06-03 00:20:00+00', 20.0),
         (3, 'p', 'A', TIMESTAMPTZ '2005-06-03 00:40:00+00', 30.0),
         (4, 'q', 'A', TIMESTAMPTZ '2005-06-03 23:59:59.999999+00', 40.0),
         (5, 'q', 'B', TIMESTAMPTZ '2005-06-03 23:59:59.999999+00', 50.0))
       v(event_id, pattern, node, ts, latency_ms)`
    )
    const episodes = `
      SELECT pattern, count(*) AS events,
             count(*) FILTER (WHERE prev_ts IS NULL OR ts - prev_ts >= $1::INTERVAL) AS episodes,
             count(DISTINCT node) AS nodes,
             count(DISTINCT date_trunc('day', ts)) AS active_days
      FROM (SELECT pattern, node, ts,
                   lag(ts) OVER (PARTITION BY pattern ORDER BY ts, event_id) AS prev_ts
            FROM gate.g5 WHERE node = ANY($2::VARCHAR[])) s
      GROUP BY pattern ORDER BY pattern`
    const unfiltered = await db.rows(episodes, ["30 minutes", ["A", "B"]])
    const nodeA = await db.rows(episodes, ["30 minutes", ["A"]])

    const [percentiles] = await db.rows(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95,
              quantile_cont(latency_ms, 0.95) AS q95,
              quantile_cont(latency_ms, [0.5, 0.9, 0.95, 0.99]) AS q_list,
              max(latency_ms) AS max
       FROM gate.g5`
    )

    const [buckets] = await db.rows(
      `SELECT date_trunc('hour', ts) AS hour, date_trunc('day', ts) AS day,
              date_trunc('week', ts) AS week, typeof(ts - lag(ts) OVER (ORDER BY event_id)) AS diff_type
       FROM gate.g5 WHERE event_id = 4`
    )
    // date_trunc on TIMESTAMPTZ follows the session time zone.
    const la = await connect(config)
    await la.client.query("SET TimeZone = 'America/Los_Angeles'")
    const laDay = await la.value(
      "SELECT date_trunc('day', TIMESTAMPTZ '2005-06-03 23:59:59.999999+00')"
    )
    await la.close()

    return [
      equals(
        "episodes via lag() + FILTER, unfiltered (p: 1, q: 1 despite equal first ts)",
        [
          {
            pattern: "p",
            events: "3",
            episodes: "1",
            nodes: "2",
            active_days: "1",
          },
          {
            pattern: "q",
            events: "2",
            episodes: "1",
            nodes: "2",
            active_days: "1",
          },
        ],
        unfiltered
      ),
      equals(
        "episodes after node filter are recomputed (p on A: 2)",
        [
          {
            pattern: "p",
            events: "2",
            episodes: "2",
            nodes: "1",
            active_days: "1",
          },
          {
            pattern: "q",
            events: "1",
            episodes: "1",
            nodes: "1",
            active_days: "1",
          },
        ],
        nodeA
      ),
      equals(
        "percentile_cont WITHIN GROUP equals quantile_cont; list form works",
        { p50: 30, p95: 48, q95: 48, q_list: [30, 46, 48, 49.6], max: 50 },
        percentiles
      ),
      equals(
        "date_trunc hour/day/week under UTC (weeks start Monday); ts - ts is INTERVAL",
        {
          hour: "2005-06-03 23:00:00+00",
          day: "2005-06-03 00:00:00+00",
          week: "2005-05-30 00:00:00+00",
          diff_type: "INTERVAL",
        },
        buckets
      ),
      equals(
        "date_trunc('day') follows the session TimeZone (UTC is mandatory)",
        "2005-06-03 00:00:00-07",
        laDay
      ),
    ]
  },
}
