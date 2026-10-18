/**
 * `pnpm data:setup --samples --with all` against SereneDB: the five Loghub
 * extension datasets (hdfs, openssh, apache, linux, zookeeper) loaded next to
 * BGL and OpenStack into the separate database `log_insights_samples_ext`
 * (U26, LOG-40).
 *
 * Every expected value was determined independently from the raw 2k files in
 * .data/raw/loghub-2k/ with Python, never from the loader or the tools. The
 * commands used are noted next to the literals so a reviewer can reproduce
 * them, e.g. (in .data/raw/loghub-2k):
 *
 *   python3 - <<'PY'
 *   import re
 *   h=[l for l in open('HDFS_2k.log',encoding='utf-8',errors='replace')]
 *   blk=re.compile(r'blk_-?\d+')
 *   print(sum(1 for l in h if len(set(blk.findall(l)))==1))  # 1997 with one block
 *   print(sum(1 for l in h if len(set(blk.findall(l)))>1))   # 3 with several -> NULL
 *   PY
 *
 * The base samples database (log_insights_samples) must stay free of the
 * extension rows: loading the extensions goes into its own database.
 */
import type { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  SAMPLES_DATABASE,
  SAMPLES_EXTENDED_DATABASE,
} from "../../src/sources.ts"
import {
  closeIfOpen,
  connectTo,
  dataVersionOf,
  loadEnv,
  rows,
  runSetupCli,
} from "./helpers.ts"

loadEnv()

const EXTENSIONS = ["hdfs", "openssh", "apache", "linux", "zookeeper"] as const

let client: Client
let baseClient: Client
/** Set only when this run loaded the database; drives the idempotence check. */
let loadOutput = ""

async function hasManifest(database: string): Promise<boolean> {
  const probe = await connectTo(database)
  try {
    const found = await rows(
      probe,
      "SELECT 1 FROM pg_tables WHERE tablename = 'load_manifest'"
    )
    if (found.length === 0) return false
    const manifest = await rows(
      probe,
      "SELECT count(*) AS n FROM load_manifest"
    )
    return manifest[0]?.["n"] === "1"
  } finally {
    await closeIfOpen(probe)
  }
}

beforeAll(async () => {
  if (!(await hasManifest(SAMPLES_EXTENDED_DATABASE))) {
    loadOutput = await runSetupCli(["--samples", "--with", "all"], "UTC")
  }
  client = await connectTo(SAMPLES_EXTENDED_DATABASE)
  baseClient = await connectTo(SAMPLES_DATABASE)
})

afterAll(async () => {
  await closeIfOpen(client)
  await closeIfOpen(baseClient)
})

describe("load balance", () => {
  it("loads all seven datasets without rejects", async () => {
    // wc -l on each *_2k.log is 2000; no file ends without a newline here.
    expect(
      await rows(
        client,
        `SELECT dataset, source_file, lines_read, events_loaded, rejected
         FROM load_report WHERE dataset <> 'bgl' AND dataset <> 'openstack'
         ORDER BY dataset`
      )
    ).toEqual([
      {
        dataset: "apache",
        source_file: "Apache_2k.log",
        lines_read: "2000",
        events_loaded: "2000",
        rejected: "0",
      },
      {
        dataset: "hdfs",
        source_file: "HDFS_2k.log",
        lines_read: "2000",
        events_loaded: "2000",
        rejected: "0",
      },
      {
        dataset: "linux",
        source_file: "Linux_2k.log",
        lines_read: "2000",
        events_loaded: "2000",
        rejected: "0",
      },
      {
        dataset: "openssh",
        source_file: "OpenSSH_2k.log",
        lines_read: "2000",
        events_loaded: "2000",
        rejected: "0",
      },
      {
        dataset: "zookeeper",
        source_file: "Zookeeper_2k.log",
        lines_read: "2000",
        events_loaded: "2000",
        rejected: "0",
      },
    ])
    expect(
      await rows(
        client,
        `SELECT count(*) AS n FROM load_rejects
         WHERE dataset <> 'bgl' AND dataset <> 'openstack'`
      )
    ).toEqual([{ n: "0" }])
  })

  it("passes every load check (25 total, none failing)", async () => {
    expect(
      await rows(client, "SELECT check_name FROM load_checks WHERE NOT ok")
    ).toEqual([])
    // The base checks plus the extension checks (hdfs 20/21, openssh 22,
    // apache 23, linux 24/25): all 25 ran.
    expect(await rows(client, "SELECT count(*) AS n FROM load_checks")).toEqual(
      [{ n: "25" }]
    )
  })
})

describe("per-dataset figures (hand-derived from the raw files)", () => {
  // corpus_stats, spans in UTC. HDFS/Apache/Linux/ZooKeeper have whole-second
  // or millisecond timestamps; the spans are the min/max of the parsed times.
  const EXPECTED = {
    hdfs: {
      events: "2000",
      error_events: "0", // no ERROR/FATAL line in the HDFS sample (log4j)
      first: "2008-11-09T20:36:15.000000Z",
      last: "2008-11-11T10:20:17.000000Z",
      levels: [
        { level: "INFO", events: 1920 },
        { level: "WARN", events: 80 },
      ],
    },
    openssh: {
      events: "2000",
      error_events: "48", // messages prefixed error:/fatal: (grep -cE)
      first: "2017-12-10T06:55:46.000000Z",
      last: "2017-12-10T11:04:45.000000Z",
      // OpenSSH has no level field; levels are all null.
      levels: [{ level: null, events: 2000 }],
    },
    apache: {
      events: "2000",
      error_events: "595", // [.. ] [error] lines
      first: "2005-12-04T04:47:44.000000Z",
      last: "2005-12-05T19:15:57.000000Z",
      levels: [
        { level: "error", events: 595 },
        { level: "notice", events: 1405 },
      ],
    },
    linux: {
      events: "2000",
      error_events: null, // Linux has no error definition (R-02): is_error unknown
      first: "2005-06-14T15:16:01.000000Z",
      last: "2005-07-27T14:42:00.000000Z",
      levels: [{ level: null, events: 2000 }],
    },
    zookeeper: {
      events: "2000",
      error_events: "13", // log4j ERROR lines
      first: "2015-07-29T17:41:44.747000Z",
      last: "2015-08-25T11:26:28.145000Z",
      levels: [
        { level: "ERROR", events: 13 },
        { level: "INFO", events: 669 },
        { level: "WARN", events: 1318 },
      ],
    },
  } as const

  for (const dataset of EXTENSIONS) {
    it(`${dataset}: events, errors, span and levels`, async () => {
      const expected = EXPECTED[dataset]
      const [stats] = await rows(
        client,
        `SELECT events, error_events,
           strftime(first_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS first,
           strftime(last_ts, '%Y-%m-%dT%H:%M:%S.%fZ') AS last
         FROM corpus_stats WHERE dataset = $1`,
        [dataset]
      )
      expect(stats).toEqual({
        events: expected.events,
        error_events: expected.error_events,
        first: expected.first,
        last: expected.last,
      })
      expect(
        await rows(
          client,
          `SELECT level, count(*)::INTEGER AS events FROM log_events
           WHERE dataset = $1 GROUP BY level ORDER BY level`,
          [dataset]
        )
      ).toEqual(expected.levels)
    })
  }
})

describe("extension columns (hand-derived coverage)", () => {
  it("hdfs sets block_id on 1997 lines; 3 lines name several blocks -> NULL", async () => {
    expect(
      await rows(
        client,
        `SELECT count(block_id)::INTEGER AS with_block,
           count(*) FILTER (WHERE block_id IS NULL)::INTEGER AS without
         FROM log_events WHERE dataset = 'hdfs'`
      )
    ).toEqual([{ with_block: 1997, without: 3 }])
  })

  it("openssh carries an IPv4 client_ip on 1734 lines (30 distinct) and a process_id on every line", async () => {
    expect(
      await rows(
        client,
        `SELECT count(client_ip)::INTEGER AS ip_lines,
           count(DISTINCT client_ip)::INTEGER AS ip_distinct,
           count(process_id)::INTEGER AS pid_lines
         FROM log_events WHERE dataset = 'openssh'`
      )
    ).toEqual([{ ip_lines: 1734, ip_distinct: 30, pid_lines: 2000 }])
  })

  it("apache carries a client_ip on 32 [client ...] lines (32 distinct)", async () => {
    expect(
      await rows(
        client,
        `SELECT count(client_ip)::INTEGER AS ip_lines,
           count(DISTINCT client_ip)::INTEGER AS ip_distinct
         FROM log_events WHERE dataset = 'apache'`
      )
    ).toEqual([{ ip_lines: 32, ip_distinct: 32 }])
  })

  it("zookeeper names 62 distinct threads", async () => {
    expect(
      await rows(
        client,
        `SELECT count(DISTINCT thread)::INTEGER AS threads
         FROM log_events WHERE dataset = 'zookeeper'`
      )
    ).toEqual([{ threads: 62 }])
  })

  it("linux carries one host (combo) and a process_id on most lines", async () => {
    expect(
      await rows(
        client,
        `SELECT count(DISTINCT host)::INTEGER AS hosts,
           count(DISTINCT host) FILTER (WHERE host = 'combo')::INTEGER AS combo
         FROM log_events WHERE dataset = 'linux'`
      )
    ).toEqual([{ hosts: 1, combo: 1 }])
  })
})

describe("one concrete first line per dataset", () => {
  // event_id = base + running line number, so the first line of each dataset
  // is base + 1 (HDFS 100000000, OpenSSH 200000000, Apache 300000000,
  // Linux 400000000, ZooKeeper 500000000).
  it("parses the first raw line of each dataset into the right fields", async () => {
    const got = await rows(
      client,
      `SELECT event_id, dataset, component, host, process_id, client_ip, thread,
         block_id, level, is_error
       FROM log_events
       WHERE event_id IN (100000001, 200000001, 300000001, 400000001, 500000001)
       ORDER BY dataset`
    )
    expect(got).toEqual([
      {
        // "[Sun Dec 04 04:47:44 2005] [notice] workerEnv.init() ok ..."
        event_id: "300000001",
        dataset: "apache",
        component: "httpd",
        host: null,
        process_id: null,
        client_ip: null,
        thread: null,
        block_id: null,
        level: "notice",
        is_error: false,
      },
      {
        // "081109 203615 148 INFO dfs.DataNode$PacketResponder: ... blk_38865049064139660"
        event_id: "100000001",
        dataset: "hdfs",
        component: "dfs.DataNode$PacketResponder",
        host: null,
        process_id: null,
        client_ip: null,
        thread: null,
        block_id: "blk_38865049064139660",
        level: "INFO",
        is_error: false,
      },
      {
        // "Jun 14 15:16:01 combo sshd(pam_unix)[19939]: authentication failure; ..."
        event_id: "400000001",
        dataset: "linux",
        component: "sshd(pam_unix)",
        host: "combo",
        process_id: "19939",
        client_ip: null,
        thread: null,
        block_id: null,
        level: null,
        is_error: null,
      },
      {
        // "Dec 10 06:55:46 LabSZ sshd[24200]: reverse mapping checking ... [173.234.31.186]"
        event_id: "200000001",
        dataset: "openssh",
        component: "sshd",
        host: "LabSZ",
        process_id: "24200",
        client_ip: "173.234.31.186",
        thread: null,
        block_id: null,
        level: null,
        is_error: false,
      },
      {
        // "2015-07-29 17:41:44,747 - INFO  [QuorumPeer[myid=1]/0:0:0:0:0:0:0:0:2181:FastLeaderElection@...] - ..."
        event_id: "500000001",
        dataset: "zookeeper",
        component: "FastLeaderElection",
        host: null,
        process_id: null,
        client_ip: null,
        thread: "QuorumPeer[myid=1]/0:0:0:0:0:0:0:0:2181",
        block_id: null,
        level: "INFO",
        is_error: false,
      },
    ])
  })
})

describe("manifest, field stats and ownership", () => {
  it("records all seven datasets in the manifest in catalog order", async () => {
    const [manifest] = await rows(client, "SELECT datasets FROM load_manifest")
    expect(manifest?.["datasets"]).toEqual([
      "bgl",
      "openstack",
      "hdfs",
      "openssh",
      "apache",
      "linux",
      "zookeeper",
    ])
  })

  it("writes a field guide (corpus_field_stats) for every dataset", async () => {
    const list = EXTENSIONS.map((d) => `'${d}'`).join(", ")
    expect(
      await rows(
        client,
        `SELECT dataset, count(*)::INTEGER AS fields FROM corpus_field_stats
         WHERE dataset IN (${list}) GROUP BY dataset ORDER BY dataset`
      )
    ).toEqual([
      // One row per catalog field with a meaning (except ts and message).
      { dataset: "apache", fields: expect.any(Number) },
      { dataset: "hdfs", fields: expect.any(Number) },
      { dataset: "linux", fields: expect.any(Number) },
      { dataset: "openssh", fields: expect.any(Number) },
      { dataset: "zookeeper", fields: expect.any(Number) },
    ])
    // Every extension dataset has at least one field-guide row.
    const [row] = await rows(
      client,
      `SELECT min(fields) AS min_fields FROM (
         SELECT dataset, count(*) AS fields FROM corpus_field_stats
         WHERE dataset IN (${list}) GROUP BY dataset)`
    )
    expect(Number(row?.["min_fields"])).toBeGreaterThan(0)
  })

  it("leaves the linux programs without a fictional team as unowned", async () => {
    // The Linux sample names many programs; ownership (30_ownership.sql) maps
    // the service-relevant ones and leaves the rest unowned, like SERV_NET for
    // BGL, so counts by team show the unowned category on real data. This is
    // the sorted set of linux components with no ownership row, taken straight
    // from the loaded sample (SELECT DISTINCT component ... LEFT JOIN ownership).
    const unownedList = await rows(
      client,
      `SELECT DISTINCT e.component FROM log_events e
       LEFT JOIN ownership o ON o.dataset = 'linux' AND o.component = e.component
       WHERE e.dataset = 'linux' AND e.component IS NOT NULL AND o.component IS NULL
       ORDER BY e.component`
    )
    expect(unownedList.map((row) => row["component"])).toEqual([
      "-- root",
      "bluetooth",
      "cups",
      "gdm(pam_unix)",
      "gdm-binary",
      "gpm",
      "hcid",
      "irqbalance",
      "logrotate",
      "named",
      "network",
      "nfslock",
      "portmap",
      "random",
      "rc",
      "rpc.statd",
      "rpcidmapd",
      "sdpd",
      "snmpd",
      "sysctl",
      "syslog",
      "syslogd 1.4.1",
    ])
  })
})

describe("the base samples database stays unextended", () => {
  it("has only bgl and openstack, no extension rows", async () => {
    expect(
      await rows(
        baseClient,
        "SELECT DISTINCT dataset FROM log_events ORDER BY dataset"
      )
    ).toEqual([{ dataset: "bgl" }, { dataset: "openstack" }])
  })
})

describe("idempotence", () => {
  it("a second --with all run yields the same data version", async ({
    skip,
  }) => {
    // Only when this run loaded the database itself: re-running the loader
    // reloads the shared extended samples database, which must not disturb a
    // parallel agent that is using an already-loaded one.
    if (loadOutput === "") {
      skip()
      return
    }
    const first = dataVersionOf(loadOutput)
    const second = dataVersionOf(
      await runSetupCli(["--samples", "--with", "all"], "UTC")
    )
    expect(second).toBe(first)
  })
})
