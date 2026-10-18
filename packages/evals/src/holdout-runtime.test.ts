import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sourceReceipt } from "./report-fixtures.ts"
import { digest } from "./artifacts.ts"
import { observeEvalRuntime } from "./holdout-runtime.ts"

const state = vi.hoisted(() => ({
  port: "17954",
  host: "127.0.0.1",
  image: "synthetic/26.10.1",
  running: true,
  bind: "127.0.0.1",
  database_created: 0,
  disposed: 0,
  registry_failed: false,
  source: "corpus",
  datasets: ["bgl", "openstack"],
}))
vi.mock("node:child_process", () => ({
  execFileSync: (_command: string, args: string[]) =>
    args[0] === "compose"
      ? "a".repeat(64)
      : JSON.stringify({
          image_id: `sha256:${"1".repeat(64)}`,
          image: state.image,
          running: state.running,
          ports: [{ HostIp: state.bind, HostPort: state.port }],
        }),
}))
vi.mock("@workspace/analytics/config", async (original) => ({
  ...(await original<typeof import("@workspace/analytics/config")>()),
  loadConfig: () => ({
    connection: {
      host: state.host,
      port: 17954,
      user: "fixture",
      password: "SYNTHETIC_PASSWORD_NEVER_EXPORT",
      database: "fixture",
    },
    receiptsDir: "unused",
    workspaceTools: false,
  }),
}))
vi.mock("@workspace/analytics/db", () => ({
  createDatabase: () => {
    state.database_created += 1
    return {
      query: () => {
        throw new Error("Unit boundary must not query a DB")
      },
      timeoutMs: 10_000,
      dispose: async () => {
        state.disposed += 1
      },
    }
  },
}))
vi.mock("@workspace/analytics/registry", async (original) => ({
  ...(await original<typeof import("@workspace/analytics/registry")>()),
  createRegistry: (options: {
    receipts: { put(receipt: unknown): Promise<void> }
  }) => ({
    runTool: async () => {
      if (state.registry_failed)
        throw new Error("SYNTHETIC_RAW_DATABASE_SECRET")
      const data = {
        datasets: state.datasets.map((dataset) => ({ dataset })),
        versions: { data_version: "dv_syntheticRuntime", source: state.source },
      }
      const receipt = {
        ...sourceReceipt,
        receipt_id: "r_00000001",
        created_at: new Date().toISOString(),
        tool: "describe_corpus",
        data_version: "dv_syntheticRuntime",
        result: data,
        result_digest: digest(data),
      }
      await options.receipts.put(receipt)
      return {
        ok: true,
        result: { data, receipt: { receipt_id: receipt.receipt_id } },
      }
    },
  }),
}))

const directories: string[] = []
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "log54-runtime-"))
  directories.push(dir)
  return dir
}
afterEach(async () => {
  vi.unstubAllEnvs()
  Object.assign(state, {
    port: "17954",
    host: "127.0.0.1",
    image: "synthetic/26.10.1",
    running: true,
    bind: "127.0.0.1",
    database_created: 0,
    disposed: 0,
    registry_failed: false,
    source: "corpus",
    datasets: ["bgl", "openstack"],
  })
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

describe("holdout runtime provenance external boundary", () => {
  it("binds running image, loopback connection, full base corpus and saved receipt", async () => {
    vi.stubEnv("SERENEDB_IMAGE", "synthetic/26.10.1")
    const dir = await directory()
    const observed = await observeEvalRuntime(dir)
    expect(observed).toMatchObject({
      configured_image: "synthetic/26.10.1",
      running_image_id: `sha256:${"1".repeat(64)}`,
      published_port: 17954,
      data_version: "dv_syntheticRuntime",
      source: "corpus",
      datasets: ["bgl", "openstack"],
    })
    const receipt: unknown = JSON.parse(
      await readFile(join(dir, `${observed.corpus_receipt_id}.json`), "utf8")
    )
    expect(digest(receipt)).toBe(observed.corpus_receipt_sha256)
    expect(JSON.stringify(observed)).not.toContain(
      "SYNTHETIC_PASSWORD_NEVER_EXPORT"
    )
    expect(state.disposed).toBe(1)
  })

  it.each(["port", "bind", "image", "stopped"])(
    "rejects a different %s before constructing a DB",
    async (change) => {
      vi.stubEnv("SERENEDB_IMAGE", "synthetic/26.10.1")
      if (change === "port") state.port = "17955"
      if (change === "bind") state.bind = "0.0.0.0"
      if (change === "image") state.image = "different/26.10.1"
      if (change === "stopped") state.running = false
      await expect(observeEvalRuntime(await directory())).rejects.toThrow(
        /SereneDB/
      )
      expect(state.database_created).toBe(0)
    }
  )

  it.each(["samples", "extensions", "failure"])(
    "rejects %s and always disposes the DB without exporting raw errors",
    async (change) => {
      vi.stubEnv("SERENEDB_IMAGE", "synthetic/26.10.1")
      if (change === "samples") state.source = "samples"
      if (change === "extensions") state.datasets.push("hdfs")
      if (change === "failure") state.registry_failed = true
      await expect(observeEvalRuntime(await directory())).rejects.toThrow(
        "Cannot verify the full base-corpus database"
      )
      expect(state.disposed).toBe(1)
    }
  )
})
