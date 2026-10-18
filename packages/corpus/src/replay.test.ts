import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { DATASETS } from "@workspace/domain/datasets"
import { describe, expect, it, vi } from "vitest"

import {
  newReplayRun,
  postOtlp,
  readReplayFixture,
  replayPayload,
} from "./replay.ts"
import { buildSource } from "./sources.ts"

const source = buildSource("samples", [], ["otel_replay"])
const load = source.replay
if (load === null) throw new Error("missing replay source")
const corpusDir = fileURLToPath(new URL("..", import.meta.url))

const run = newReplayRun(
  load.fixture.sha256,
  new Date("2026-10-18T12:34:56.789Z")
)

describe("committed OTLP replay fixture", () => {
  it("targets the same sample and corpus databases as the mounted listener configuration", async () => {
    const config = await readFile(
      new URL("../../../serened.conf", import.meta.url),
      "utf8"
    )
    const listener = config
      .split("\n")
      .find((line) => line.startsWith("--listen="))
    expect(listener).toContain("postgres://0.0.0.0:7890")
    expect(listener).toContain(
      `http://0.0.0.0:4319?api=otel&db=${load.database}&schema=${load.schema}`
    )
    const corpus = buildSource("corpus", [], ["otel_replay"]).replay
    expect(corpus).toMatchObject({
      database: "postgres",
      schema: "otlp",
      table: "otel_logs",
      portEnv: "SERENEDB_OTLP_PORT",
    })
    expect(load.portEnv).toBe("SERENEDB_OTLP_SAMPLES_PORT")
    expect(listener).toContain("http://0.0.0.0:4318?api=otel&schema=otlp")
  })

  it("matches its catalog pin and keeps only the selected resource attributes", async () => {
    const { records } = await readReplayFixture(load, corpusDir)
    expect(records).toHaveLength(365)
    expect(run.replayedAt).toBe("2026-10-18T12:34:56.789000000Z")
    expect(run.replayedAtNanos).toBe("1792326896789000000")
    expect(new Set(records.map((record) => record.fixture_row)).size).toBe(365)
    for (const record of records) {
      expect(
        Object.keys(record.resource).every((key) =>
          DATASETS.otel_replay.replay.fixture.resourceKeys.includes(key)
        )
      ).toBe(true)
      expect(record.body).not.toMatch(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b[0-9]{13,19}\b|\b(?:[0-9]{4}[ -]){2,3}[0-9]{3,4}\b/i
      )
    }
    const raw: unknown = JSON.parse(
      await readFile(
        new URL("../fixtures/otel-replay/part_000.json", import.meta.url),
        "utf8"
      )
    )
    expect(raw).toMatchObject({
      selection: DATASETS.otel_replay.replay.fixture.selection,
    })
  })

  it("preserves original record times and body, sends load time separately, and drops LogAttributes", async () => {
    const { records } = await readReplayFixture(load, corpusDir)
    const first = records[0]
    if (first === undefined) throw new Error("empty fixture")
    const payload: unknown = JSON.parse(replayPayload([first], run))
    expect(payload).toMatchObject({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: first.time_unix_nano,
                  observedTimeUnixNano: "1792326896789000000",
                  body: { stringValue: first.body },
                  attributes: [
                    {
                      key: "log_insights.replay_id",
                      value: { stringValue: run.replayId },
                    },
                    {
                      key: "log_insights.fixture_row",
                      value: { intValue: "0" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })
  })
})

describe("OTLP export has no automatic retries", () => {
  const target = "http://127.0.0.1:4319/v1/logs"
  const credentials = { user: "test", password: "secret" }

  it("authenticates one JSON POST and accepts a complete export", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"))
    await postOtlp(target, credentials, "{}", send)
    expect(send).toHaveBeenCalledExactlyOnceWith(
      target,
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
          authorization: "Basic dGVzdDpzZWNyZXQ=",
        },
        signal: expect.any(AbortSignal),
      })
    )
  })

  it("never retries a 503, a rejected partial export or an ambiguous network failure", async () => {
    for (const response of [
      new Response("unavailable", { status: 503 }),
      new Response('{"partialSuccess":{"rejectedLogRecords":"1"}}'),
    ]) {
      const send = vi.fn<typeof fetch>().mockResolvedValue(response)
      await expect(postOtlp(target, credentials, "{}", send)).rejects.toThrow(
        /HTTP 503|rejected 1/
      )
      expect(send).toHaveBeenCalledTimes(1)
    }
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("connection lost after send"))
    await expect(postOtlp(target, credentials, "{}", send)).rejects.toThrow(
      "connection lost after send"
    )
    expect(send).toHaveBeenCalledTimes(1)
  })
})
