import { performance } from "node:perf_hooks"

import type { PoolConfig } from "pg"
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"

import { createDatabase } from "./db.ts"

type Result = {
  rows: { pid?: string; n?: string }[]
  fields: { dataTypeID: number }[]
}
type TestClient = {
  query: Mock<
    (sql: string | { text: string; values: unknown[] }) => Promise<Result>
  >
  release: Mock<(destroy?: boolean) => void>
}

const driver = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<TestClient>>(),
  end: vi.fn<() => Promise<void>>(),
  cancel: vi.fn<() => Promise<Result>>(),
  configurations: new Array<PoolConfig>(),
}))

vi.mock("pg", async (original) => ({
  ...(await original<typeof import("pg")>()),
  Pool: class {
    waitingCount = 0
    totalCount = 1

    constructor(configuration: PoolConfig) {
      driver.configurations.push(configuration)
    }

    on() {
      return this
    }

    connect() {
      return driver.connect()
    }

    end() {
      return driver.end()
    }
  },
  Client: class {
    async connect() {}

    query() {
      return driver.cancel()
    }

    async end() {}
  },
}))

const connection = {
  host: "127.0.0.1",
  port: 1,
  user: "unused",
  password: "unused",
  database: "unused",
}

const ignore = () => undefined

function deferred<T>() {
  let resolve: (value: T) => void = ignore
  let reject: (reason: Error) => void = ignore
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const ready: Result = { rows: [{ pid: "123", n: "1" }], fields: [] }

const SETUP_SQL = {
  timezone: "SET TimeZone = 'UTC'",
  http_timeout: "SET GLOBAL http_timeout = 3",
  http_retries: "SET GLOBAL http_retries = 1",
  pid: "SELECT pg_backend_pid() AS pid",
} as const

type SetupStage = keyof typeof SETUP_SQL

function client(stall?: SetupStage, blocked = deferred<Result>()) {
  const query = vi.fn<TestClient["query"]>().mockImplementation(async (sql) => {
    if (stall !== undefined && sql === SETUP_SQL[stall]) return blocked.promise
    return ready
  })
  return {
    query,
    release: vi.fn<TestClient["release"]>(),
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  vi.spyOn(performance, "now").mockImplementation(() => Date.now())
  driver.connect.mockReset()
  driver.end.mockReset().mockResolvedValue(undefined)
  driver.cancel.mockReset().mockResolvedValue(ready)
  driver.configurations.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("database acquisition and session setup", () => {
  it.each([
    { stage: "timezone", stop: "abort" },
    { stage: "timezone", stop: "deadline" },
    { stage: "http_timeout", stop: "abort" },
    { stage: "http_timeout", stop: "deadline" },
    { stage: "http_retries", stop: "abort" },
    { stage: "http_retries", stop: "deadline" },
    { stage: "pid", stop: "abort" },
    { stage: "pid", stop: "deadline" },
  ] as const)(
    "bounds a stalled $stage query on $stop",
    async ({ stage, stop }) => {
      const blocked = deferred<Result>()
      const stalled = client(stage, blocked)
      const closed = deferred<void>()
      stalled.release.mockImplementation(() => closed.resolve(undefined))
      driver.end.mockImplementation(() => closed.promise)
      const healthy = client()
      driver.connect
        .mockResolvedValueOnce(stalled)
        .mockResolvedValueOnce(healthy)
      const db = createDatabase(connection, { timeoutMs: 1_000 })
      const controller = new AbortController()
      const outcome = db
        .query("SELECT 1", [], controller.signal)
        .catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      expect(stalled.query).toHaveBeenCalledWith(SETUP_SQL[stage])

      if (stop === "abort") controller.abort()
      else await vi.advanceTimersByTimeAsync(1_000)
      expect(await outcome).toMatchObject({
        kind: stop === "abort" ? "cancelled" : "timeout",
      })
      expect(stalled.release).toHaveBeenCalledExactlyOnceWith(true)
      expect(driver.cancel).not.toHaveBeenCalled()

      // A late driver rejection after socket destruction cannot release twice.
      blocked.reject(new Error("connection ended"))
      await vi.advanceTimersByTimeAsync(0)
      expect(stalled.release).toHaveBeenCalledTimes(1)
      expect(stalled.query).not.toHaveBeenCalledWith({
        text: "SELECT 1",
        values: [],
      })
      expect(
        await db.query("SELECT 1", [], new AbortController().signal)
      ).toMatchObject({ rows: ready.rows })
      expect(healthy.release).toHaveBeenCalledExactlyOnceWith(false)
      await db.dispose()
      expect(driver.end).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(["abort", "deadline"] as const)(
    "discards a late checkout after acquisition %s and finishes disposal",
    async (stop) => {
      const connecting = deferred<TestClient>()
      const closed = deferred<void>()
      const late = client()
      late.release.mockImplementation(() => closed.resolve(undefined))
      driver.connect.mockReturnValue(connecting.promise)
      driver.end.mockImplementation(() => closed.promise)
      const db = createDatabase(connection, { timeoutMs: 1_000 })
      const controller = new AbortController()
      const outcome = db
        .query("SELECT 1", [], controller.signal)
        .catch((error: unknown) => error)
      if (stop === "abort") controller.abort()
      else await vi.advanceTimersByTimeAsync(1_000)
      expect(await outcome).toMatchObject({
        kind: stop === "abort" ? "cancelled" : "timeout",
      })

      const disposing = db.dispose()
      expect(driver.end).toHaveBeenCalledTimes(1)
      connecting.resolve(late)
      await disposing
      expect(late.release).toHaveBeenCalledExactlyOnceWith(true)
      expect(late.query).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)

      const healthy = client()
      driver.connect.mockResolvedValueOnce(healthy)
      expect(
        await db.query("SELECT 1", [], new AbortController().signal)
      ).toMatchObject({ rows: ready.rows })
      await db.dispose()
      expect(driver.configurations).toHaveLength(2)
      expect(driver.configurations[0]?.max).toBe(4)
    }
  )

  it("uses the remaining deadline for the analytical query after setup", async () => {
    const setup = deferred<Result>()
    const running = deferred<Result>()
    const active = client("timezone", setup)
    active.query.mockImplementation(async (sql) => {
      if (sql === "SET TimeZone = 'UTC'") return setup.promise
      if (typeof sql === "string") return ready
      return running.promise
    })
    driver.connect.mockResolvedValue(active)
    driver.cancel.mockImplementation(async () => {
      running.reject(new Error("cancelled on server"))
      return ready
    })
    const db = createDatabase(connection, { timeoutMs: 1_000 })
    const outcome = db
      .query("SELECT 1", [], new AbortController().signal)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(600)
    setup.resolve(ready)
    await vi.advanceTimersByTimeAsync(399)
    expect(driver.cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(driver.cancel).toHaveBeenCalledTimes(1)
    expect(await outcome).toMatchObject({ kind: "timeout" })
    expect(active.release).toHaveBeenCalledExactlyOnceWith(true)
    await db.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("discards a failed setup once and keeps its database text out of errors", async () => {
    const failed = client()
    failed.query.mockRejectedValueOnce(new Error("private database text"))
    const healthy = client()
    driver.connect.mockResolvedValueOnce(failed).mockResolvedValueOnce(healthy)
    const lines: string[] = []
    const db = createDatabase(connection, { log: (line) => lines.push(line) })
    await expect(
      db.query("SELECT 1", [], new AbortController().signal)
    ).rejects.toMatchObject({
      kind: "unavailable",
      message: "query unavailable",
    })
    expect(failed.release).toHaveBeenCalledExactlyOnceWith(true)
    expect(lines).toEqual(["db session setup failed kind=Error"])
    expect(
      await db.query("SELECT 1", [], new AbortController().signal)
    ).toMatchObject({ rows: ready.rows })
    await db.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
