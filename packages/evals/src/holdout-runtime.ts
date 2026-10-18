import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { findWorkspaceRoot, loadConfig } from "@workspace/analytics/config"
import { createDatabase } from "@workspace/analytics/db"
import { FileReceiptStore } from "@workspace/analytics/receipts"
import { createRegistry } from "@workspace/analytics/registry"
import { digest } from "./artifacts.ts"

const date = z.iso.datetime()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const corpusRuntimeSummarySchema = z.object({
  datasets: z.array(z.object({ dataset: z.string() })),
  versions: z.object({
    data_version: z.string(),
    source: z.literal("corpus"),
  }),
})
function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new Error("Invalid runtime observation")
  return result.data
}
export const runtimeSchema = z.strictObject({
  observed_at: date,
  configured_image: z.string().min(1).max(250),
  running_image_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  published_port: z.number().int().min(1).max(65535),
  corpus_receipt_id: z.string().regex(/^r_[a-f0-9]{8}$/),
  corpus_receipt_sha256: hash,
  data_version: z.string(),
  source: z.literal("corpus"),
  datasets: z.tuple([z.literal("bgl"), z.literal("openstack")]),
  lockfile_sha256: hash,
})
const inspectSchema = z.strictObject({
  image_id: runtimeSchema.shape.running_image_id,
  image: z.string(),
  running: z.literal(true),
  ports: z
    .array(
      z.strictObject({ HostIp: z.literal("127.0.0.1"), HostPort: z.string() })
    )
    .min(1),
})

/** Current database observation through the registry; no SQL or provider here. */
export async function observeEvalRuntime(receiptsDirectory: string) {
  const root = findWorkspaceRoot(),
    config = loadConfig()
  const configuredImage = process.env.SERENEDB_IMAGE
  if (
    configuredImage === undefined ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,249}$/.test(configuredImage) ||
    !["127.0.0.1", "localhost"].includes(config.connection.host)
  )
    throw new Error("A local configured SereneDB image is required")
  let observed: z.infer<typeof inspectSchema>
  try {
    const container = execFileSync(
      "docker",
      ["compose", "ps", "-q", "serenedb"],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim()
    if (!/^[a-f0-9]{12,64}$/.test(container))
      throw new Error("Missing running database")
    observed = checked(
      inspectSchema,
      JSON.parse(
        execFileSync(
          "docker",
          [
            "inspect",
            "--format",
            '{"image_id":{{json .Image}},"image":{{json .Config.Image}},"running":{{json .State.Running}},"ports":{{json (index .NetworkSettings.Ports "7890/tcp")}}}',
            container,
          ],
          {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
            stdio: ["ignore", "pipe", "pipe"],
          }
        ).trim()
      )
    )
  } catch {
    throw new Error("Cannot verify the running local SereneDB image")
  }
  if (
    observed.image !== configuredImage ||
    !observed.ports.some(
      (port) => port.HostPort === String(config.connection.port)
    )
  )
    throw new Error(
      "SereneDB container does not match the configured connection"
    )
  const db = createDatabase(config.connection)
  const receipts = new FileReceiptStore(receiptsDirectory)
  try {
    const result = await createRegistry({
      db,
      receipts,
      log: () => undefined,
    }).runTool(
      "describe_corpus",
      {},
      { client: "eval", signal: AbortSignal.timeout(10_000) }
    )
    if (!result.ok) throw new Error("Corpus observation unavailable")
    const summary = checked(corpusRuntimeSummarySchema, result.result.data)
    if (
      summary.datasets
        .map((dataset) => dataset.dataset)
        .toSorted()
        .join(",") !== "bgl,openstack"
    )
      throw new Error("The full base BGL/OpenStack corpus is required")
    const receipt = await receipts.get(result.result.receipt.receipt_id)
    if (receipt === null)
      throw new Error("Corpus observation receipt unavailable")
    return runtimeSchema.parse({
      observed_at: new Date().toISOString(),
      configured_image: configuredImage,
      running_image_id: observed.image_id,
      published_port: config.connection.port,
      corpus_receipt_id: receipt.receipt_id,
      corpus_receipt_sha256: digest(receipt),
      data_version: summary.versions.data_version,
      source: "corpus",
      datasets: ["bgl", "openstack"],
      lockfile_sha256: createHash("sha256")
        .update(await readFile(join(root, "pnpm-lock.yaml")))
        .digest("hex"),
    })
  } catch {
    throw new Error("Cannot verify the full base-corpus database")
  } finally {
    await db.dispose()
  }
}
