/**
 * Regenerates tests/integration/fixtures/sql-rule-baseline.json from the
 * currently loaded Loghub 2k samples (`pnpm data:setup --samples`).
 *
 * The baseline is the LOG-31 characterization used by sql-rule-parity.test.ts.
 * The underlying 2k sample DATA never changes, but the loader's version stamps
 * (loader/parser/pattern/rules), the SQL digest, the dataset list and the tool
 * CONTRACT_VERSION do: those feed data_version and the describe_corpus and
 * recurring_patterns result shapes, so the pinned digests must be refreshed
 * when a work package bumps them (U26 did: contract 3.0.0, describe_corpus
 * 2.0.0, pattern_rules 1.1.0, rules concept-3.8).
 *
 * This helper refreshes only the load entry of the image it runs against
 * (`local/serenedb:26.10.1-arm64` locally, the official amd64 digest in CI),
 * preserving the other image's entry. Run it once per approved image so both
 * entries are current:
 *
 *   node --import tsx tests/integration/regen-sql-rule-baseline.ts
 *
 * It recomputes every case's result_digest and normalized_facts_sha256, the
 * fresh describe_corpus result, and the running image's data_version and
 * describe_result_digest (= resultDigest of the fresh describe_result). It
 * never computes expected values from the tool code it also drives: the test
 * still re-derives change classifications, bucket grids and zero fills from
 * the independent domain oracles.
 */
import { readFile, writeFile } from "node:fs/promises"

import { canonicalJson } from "@workspace/domain/receipt"
import { createHash } from "node:crypto"
import { z } from "zod"

import { createDatabase } from "../../src/db.ts"
import { FileReceiptStore, resultDigest } from "../../src/receipts.ts"
import { createRegistry } from "../../src/registry.ts"
import { describeCorpus } from "../../src/tools/describe-corpus.ts"
import { loadEnv, samplesConnection, temporaryDir } from "./helpers.ts"

loadEnv()

const PATH = new URL("./fixtures/sql-rule-baseline.json", import.meta.url)

const normalizedFactsHash = (facts: ReadonlyArray<{ id: string }>): string =>
  createHash("sha256")
    .update(
      canonicalJson(
        facts.map((fact) => ({
          ...fact,
          id: fact.id.replace(/^r_[0-9a-f]+\./, ""),
        }))
      )
    )
    .digest("hex")

const db = createDatabase(samplesConnection())
try {
  const baseline = JSON.parse(await readFile(PATH, "utf8"))
  const signal = new AbortController().signal

  const manifest = z
    .object({ image: z.string(), data_version: z.string() })
    .parse(
      (
        await db.query(
          "SELECT image, data_version FROM load_manifest",
          [],
          signal
        )
      ).rows[0]
    )

  const dir = await temporaryDir("regen-sql-rule-")
  const registry = createRegistry({
    db,
    receipts: new FileReceiptStore(dir),
    log: () => undefined,
  })

  // Fresh describe_corpus result (2.0.0 shape) for the stored describe_result.
  const describeOutcome = await registry.runTool(
    "describe_corpus",
    {},
    {
      client: "test",
      signal,
    }
  )
  if (!describeOutcome.ok) throw new Error(describeOutcome.error.message)
  const describeResult = describeCorpus.output.parse(
    describeOutcome.result.data
  )
  baseline.describe_result = describeResult

  // Every case's digest and normalized facts hash, from the registry.
  for (const c of baseline.cases) {
    const outcome = await registry.runTool(c.tool, c.input, {
      client: "test",
      signal,
    })
    if (!outcome.ok) throw new Error(`${c.name}: ${outcome.error.message}`)
    c.result_digest = resultDigest(outcome.result.data)
    c.normalized_facts_sha256 = normalizedFactsHash(outcome.result.facts)
  }

  // The describe_result_digest the test pins: the stored describe_result with
  // its own data_version/contract_version (both already current in the fresh
  // capture), hashed canonically.
  const describeResultDigest = resultDigest(describeResult)

  baseline.data_version = manifest.data_version
  const load = baseline.loads.find(
    (reference: { image: string }) => reference.image === manifest.image
  )
  if (load === undefined)
    throw new Error(`no load entry for image ${manifest.image}`)
  load.data_version = manifest.data_version
  load.describe_result_digest = describeResultDigest

  await writeFile(PATH, JSON.stringify(baseline, null, 2) + "\n")
  const others = baseline.loads
    .filter(
      (reference: { image: string }) => reference.image !== manifest.image
    )
    .map((reference: { image: string }) => reference.image)
  process.stdout.write(
    `Refreshed ${manifest.image} (${manifest.data_version}); ` +
      `still pinned (rerun on that image): ${others.join(", ") || "none"}\n`
  )
} finally {
  await db.dispose()
}
