import { equals, type Probe } from "../probe.ts"

// Deliberately unordered IDs, a timestamp tie, A/B/A, and both sides of
// the 30-minute boundary. Missing dimensions must survive ALL ROWS.
const FIXTURE = `(VALUES
  (2::BIGINT, 'p', 'B', TIMESTAMPTZ '2005-06-03 00:00:00Z'),
  (1, 'p', 'A', TIMESTAMPTZ '2005-06-03 00:00:00Z'),
  (3, 'p', 'B', TIMESTAMPTZ '2005-06-03 00:20:00Z'),
  (4, 'p', 'A', TIMESTAMPTZ '2005-06-03 00:40:00Z'),
  (5, 'q', NULL, TIMESTAMPTZ '2005-06-03 00:00:00Z'),
  (6, 'q', 'A', TIMESTAMPTZ '2005-06-03 00:29:59.999999Z'),
  (7, 'q', 'A', TIMESTAMPTZ '2005-06-03 00:59:59.999999Z')
) v(event_id, pattern_id, node, ts)`

const MATCH = `MATCH_RECOGNIZE (
  PARTITION BY pattern_id ORDER BY ts, event_id
  MEASURES FIRST(event_id) AS anchor_id, FIRST(ts) AS start_ts,
    LAST(ts) AS end_ts, COUNT(*) AS events
  ONE ROW PER MATCH AFTER MATCH SKIP PAST LAST ROW
  PATTERN (s n*) DEFINE n AS ts - PREV(ts) < $1::INTERVAL
)`

/** Literal-only: also runs unchanged against the official amd64 image in CI. */
export const g11MatchRecognize: Probe = {
  id: "G11",
  title: "MATCH_RECOGNIZE episodes and anchors (R-05, R-11)",
  async run({ db }) {
    const all = await db.rows(
      `SELECT pattern_id, anchor_id, start_ts::VARCHAR, end_ts::VARCHAR, events FROM ${FIXTURE} ${MATCH} ORDER BY pattern_id, start_ts, anchor_id`,
      ["30 minutes"]
    )
    const filtered = await db.rows(
      `WITH scoped AS (SELECT * FROM ${FIXTURE} WHERE node = $2)
       SELECT pattern_id, anchor_id, events FROM scoped ${MATCH}
       ORDER BY pattern_id, start_ts, anchor_id`,
      ["30 minutes", "A"]
    )
    const perRow = await db.rows(
      `SELECT pattern_id, event_id, node, phase, episode FROM ${FIXTURE}
       MATCH_RECOGNIZE (PARTITION BY pattern_id ORDER BY ts, event_id
         MEASURES node AS node, CLASSIFIER() AS phase, MATCH_NUMBER() AS episode
         ALL ROWS PER MATCH AFTER MATCH SKIP PAST LAST ROW
         PATTERN (s n*) DEFINE n AS ts - PREV(ts) < $1::INTERVAL)
       ORDER BY pattern_id, ts, event_id`,
      ["30 minutes"]
    )
    const empty = await db.rows(
      `WITH scoped AS (SELECT * FROM ${FIXTURE} WHERE false)
       SELECT anchor_id FROM scoped ${MATCH} ORDER BY anchor_id`,
      ["30 minutes"]
    )
    // Loaded events have non-null timestamps. Document the engine's NULL
    // behavior separately: UNKNOWN in DEFINE does not consume the row.
    const nulls = await db.rows(
      `SELECT anchor_id, events FROM (VALUES (1::BIGINT, NULL::TIMESTAMPTZ), (2, NULL)) v(event_id, ts)
       MATCH_RECOGNIZE (ORDER BY ts, event_id
         MEASURES FIRST(event_id) AS anchor_id, COUNT(*) AS events
         ONE ROW PER MATCH AFTER MATCH SKIP PAST LAST ROW
         PATTERN (s n*) DEFINE n AS ts - PREV(ts) < $1::INTERVAL)
       ORDER BY anchor_id`,
      ["30 minutes"]
    )
    return [
      equals(
        "partition, tie order, exact threshold, start/end/count",
        [
          {
            pattern_id: "p",
            anchor_id: "1",
            start_ts: "2005-06-03 00:00:00+00",
            end_ts: "2005-06-03 00:40:00+00",
            events: "4",
          },
          {
            pattern_id: "q",
            anchor_id: "5",
            start_ts: "2005-06-03 00:00:00+00",
            end_ts: "2005-06-03 00:29:59.999999+00",
            events: "2",
          },
          {
            pattern_id: "q",
            anchor_id: "7",
            start_ts: "2005-06-03 00:59:59.999999+00",
            end_ts: "2005-06-03 00:59:59.999999+00",
            events: "1",
          },
        ],
        all
      ),
      equals(
        "filter before matching: A/B/A splits into two episodes",
        [
          { pattern_id: "p", anchor_id: "1", events: "1" },
          { pattern_id: "p", anchor_id: "4", events: "1" },
          { pattern_id: "q", anchor_id: "6", events: "1" },
          { pattern_id: "q", anchor_id: "7", events: "1" },
        ],
        filtered
      ),
      equals(
        "ALL ROWS preserves dimensions, NULL, classifier and match number",
        [
          {
            pattern_id: "p",
            event_id: "1",
            node: "A",
            phase: "s",
            episode: "1",
          },
          {
            pattern_id: "p",
            event_id: "2",
            node: "B",
            phase: "n",
            episode: "1",
          },
          {
            pattern_id: "p",
            event_id: "3",
            node: "B",
            phase: "n",
            episode: "1",
          },
          {
            pattern_id: "p",
            event_id: "4",
            node: "A",
            phase: "n",
            episode: "1",
          },
          {
            pattern_id: "q",
            event_id: "5",
            node: null,
            phase: "s",
            episode: "1",
          },
          {
            pattern_id: "q",
            event_id: "6",
            node: "A",
            phase: "n",
            episode: "1",
          },
          {
            pattern_id: "q",
            event_id: "7",
            node: "A",
            phase: "s",
            episode: "2",
          },
        ],
        perRow
      ),
      equals("empty scope has no episodes", [], empty),
      equals(
        "NULL timestamps do not continue a match",
        [
          { anchor_id: "1", events: "1" },
          { anchor_id: "2", events: "1" },
        ],
        nulls
      ),
    ]
  },
}
