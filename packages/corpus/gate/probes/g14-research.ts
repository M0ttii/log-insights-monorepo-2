import { LOG_TEXT_ANALYZER } from "../../src/analyzer.ts"
import { failureOf } from "../db.ts"
import { check, equals, type Check, type Info, type Probe } from "../probe.ts"

/** Synthetic vectors test retrieval mechanics, never model relevance. */
export const g14Research: Probe = {
  id: "G14",
  title: "Versioned retrieval primitives and AI provider availability (LOG-41)",
  async run({ db }) {
    const checks: Array<Check | Info> = []
    // The deliberately absent secret prevents provider calls, even on a configured server.
    for (const [name, sql] of [
      [
        "ai_embed",
        "SELECT ai_embed('synthetic capability probe', 'log41-unconfigured', 'log41_deliberately_absent')",
      ],
      [
        "ai_summarize_agg",
        "SELECT ai_summarize_agg(message, secret_name := 'log41_deliberately_absent') FROM (VALUES ('synthetic capability probe')) t(message)",
      ],
    ]) {
      const failure = await failureOf(() => db.rows(sql ?? ""))
      checks.push(
        check(
          `${name} exists and explicitly rejects an unavailable provider secret`,
          "42704, secret 'log41_deliberately_absent' not found",
          failure,
          failure?.code === "42704" &&
            failure.message.includes(
              "secret 'log41_deliberately_absent' not found"
            )
        )
      )
    }
    checks.push({
      info: "No external model was called. AI function availability does not demonstrate summary usefulness or semantic relevance; provider-backed evaluations remain required.",
    })
    const providers = await db.value(
      "SELECT count(*) FROM sdb_secrets() WHERE lower(type) = 'openai'"
    )
    checks.push({
      info: `Configured OpenAI-compatible provider secrets: ${String(providers)} (metadata count only; no secret content read).`,
    })
    if (String(providers) === "0") {
      const failure = await failureOf(() =>
        db.rows(
          "SELECT ai_summarize_agg(message) FROM (VALUES ('synthetic capability probe')) t(message)"
        )
      )
      checks.push(
        check(
          "default summary explicitly fails without a configured provider",
          "22023: ai_summarize_agg: no secret given",
          failure,
          failure?.code === "22023" &&
            failure.message === "ai_summarize_agg: no secret given"
        )
      )
    }
    await db.rows("CREATE SCHEMA gate_research")
    try {
      await db.rows(`CREATE TEXT SEARCH DICTIONARY gate_research.text AS
        ${LOG_TEXT_ANALYZER} WITH (frequency, position, norm)`)
      await db.rows(`CREATE TABLE gate_research.events (
        event_id BIGINT, dataset VARCHAR, message VARCHAR, embedding FLOAT[3])`)
      await db.rows(`INSERT INTO gate_research.events VALUES
        (1, 'bgl', 'disk parity error', [1,0,0]::FLOAT[3]),
        (2, 'bgl', 'network parity error', [0,1,0]::FLOAT[3]),
        (3, 'openstack', 'disk parity error', [1,0,0]::FLOAT[3])`)
      await db.rows(`CREATE INDEX events_idx ON gate_research.events
        USING inverted (dataset, message gate_research.text,
          embedding ivf(metric='cosine', quant='none')) INCLUDE(event_id)`)
      const nearest = `SELECT event_id, embedding <=> [1,0,0]::FLOAT[3] AS distance
        FROM gate_research.events_idx WHERE dataset = 'bgl'
        ORDER BY distance, event_id LIMIT 2`
      checks.push(
        equals(
          "filtered cosine retrieval uses fixed vectors and unique ties",
          [
            { event_id: "1", distance: 0 },
            { event_id: "2", distance: 1 },
          ],
          await db.rows(nearest)
        )
      )
      const plan = (await db.rows(`EXPLAIN ${nearest}`))
        .map((row) => Object.values(row).join(" "))
        .join("\n")
      checks.push(
        check(
          "cosine retrieval reads the vector index",
          "IRESEARCH_SCAN with cosine_distance",
          plan,
          plan.includes("IRESEARCH_SCAN") && plan.includes("cosine_distance")
        )
      )
      const fused = await db.rows(`WITH branches AS (
        SELECT * FROM (VALUES (1::BIGINT, 1::BIGINT), (2, 2), (2, 1), (1, 2)) t(event_id, rank)
      ) SELECT event_id, sum(1.0 / (60 + rank)) AS score
        FROM branches GROUP BY event_id ORDER BY score DESC, event_id`)
      checks.push(
        equals(
          "RRF fusion sums ranks and breaks equal scores by event ID",
          ["1", "2"],
          fused.map((row) => row.event_id)
        )
      )
      checks.push(
        check(
          "equal reciprocal rank sums agree",
          "two equal positive scores",
          fused,
          fused.length === 2 &&
            fused[0]?.score === fused[1]?.score &&
            Number(fused[0]?.score) > 0
        )
      )
      return checks
    } finally {
      await db.rows("DROP SCHEMA gate_research CASCADE")
    }
  },
}
