import type { GateConfig } from "./config.ts"
import type { Db } from "./db.ts"

/**
 * One observation of a gate probe. `ok` states whether the image behaves as
 * the expectation describes; an expectation can itself be a deviation from
 * PostgreSQL (for example "statement_timeout is not enforced"), so a changed
 * image shows up as a failed check instead of silently changing a rule.
 */
export type Check = {
  name: string
  expected: string
  observed: string
  ok: boolean
}

export type Skip = { skipped: string }

/** A recorded observation without a pass/fail expectation (for example a reproduced defect). */
export type Info = { info: string }

export type ProbeContext = {
  config: GateConfig
  db: Db
  /** Host path of the full BGL.log, or null if it has not been downloaded. */
  bglLog: string | null
  /** Ensures gate.bgl (full corpus) and its index exist; loads once per run. */
  loadBgl: () => Promise<{ loadMs: number; indexMs: number } | null>
}

export type Probe = {
  id: string
  title: string
  run: (ctx: ProbeContext) => Promise<Array<Check | Skip | Info>>
}

export function check(
  name: string,
  expected: string,
  observed: unknown,
  ok: boolean
): Check {
  return {
    name,
    expected,
    observed:
      typeof observed === "string" ? observed : JSON.stringify(observed),
    ok,
  }
}

export function equals(
  name: string,
  expected: unknown,
  observed: unknown
): Check {
  const want = JSON.stringify(expected)
  const got = JSON.stringify(observed)
  return { name, expected: want, observed: got, ok: want === got }
}

export async function timed<T>(
  run: () => Promise<T>
): Promise<{ result: T; ms: number }> {
  const start = performance.now()
  const result = await run()
  return { result, ms: Math.round(performance.now() - start) }
}
