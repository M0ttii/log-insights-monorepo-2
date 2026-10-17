/**
 * Prints selected timestamps of the samples database as JSON. Run in child
 * processes with different TZ values: the output must not depend on the
 * process time zone (technical.md § 6.1, Zeitvertrag).
 */
import { SAMPLES_DATABASE } from "../../src/sources.ts"
import { connectTo, loadEnv } from "./helpers.ts"

loadEnv()
const client = await connectTo(SAMPLES_DATABASE)
try {
  const { rows } = await client.query<Record<string, unknown>>(
    `SELECT event_id, ts, strftime(ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS iso,
       date_trunc('day', ts) AS day
     FROM log_events WHERE event_id IN (1, 9, 10000001) ORDER BY event_id`
  )
  console.log(JSON.stringify(rows))
} finally {
  await client.end()
}
