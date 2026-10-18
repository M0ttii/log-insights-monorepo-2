/**
 * Pattern masks of the extension datasets (concept R-04, technical.md § 7.1,
 * U26/LOG-40).
 *
 * 1. Every extension mask on hand-written messages; the expected patterns are
 *    written from the rules in sql/20_patterns.sql (the extension chain) and
 *    confirmed by calling SELECT log_pattern($dataset, $message).
 * 2. Pattern check 1 for the extensions: our patterns against the Loghub
 *    templates of the HDFS, OpenSSH, Apache, Linux and ZooKeeper 2k samples
 *    (sql/profiling/61_loghub_templates_ext.sql). The reviewed result is
 *    pinned here (verified by running the profiling SQL): patterns/templates
 *    per dataset, no merge, and only the justified splits. A mask change that
 *    merges templates or adds a split fails this test.
 */
import { readFile } from "node:fs/promises"

import type { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { profilingQueries } from "../../src/profiling-queries.ts"
import { SAMPLES_EXTENDED_DATABASE } from "../../src/sources.ts"
import {
  closeIfOpen,
  connectTo,
  loadEnv,
  rows,
  runSetupCli,
} from "./helpers.ts"

loadEnv()

let client: Client

async function extensionsLoaded(): Promise<boolean> {
  const probe = await connectTo(SAMPLES_EXTENDED_DATABASE).catch(() => null)
  if (probe === null) return false
  try {
    const manifest = await probe.query("SELECT data_version FROM load_manifest")
    return manifest.rowCount === 1
  } catch {
    return false
  } finally {
    await probe.end()
  }
}

beforeAll(async () => {
  if (!(await extensionsLoaded()))
    await runSetupCli(["--samples", "--with", "all"], "UTC")
  client = await connectTo(SAMPLES_EXTENDED_DATABASE)
})

afterAll(async () => {
  await closeIfOpen(client)
})

async function pattern(dataset: string, message: string): Promise<unknown> {
  const [row] = await rows(client, "SELECT log_pattern($1, $2) AS p", [
    dataset,
    message,
  ])
  return row?.["p"]
}

describe("extension masks", () => {
  it.each([
    // HDFS: the block ID is masked to <BLOCK>; numbers to <NUM>; the DataNode
    // IP:port and packet sizes vary.
    [
      "hdfs",
      "PacketResponder 1 for block blk_38865049064139660 terminating",
      "PacketResponder <NUM> for block <BLOCK> terminating",
    ],
    [
      "hdfs",
      "Received block blk_-1608999687919862906 of size 91178 from /10.250.19.102",
      "Received block <BLOCK> of size <NUM> from /<IP>",
    ],
    // OpenSSH: user, IP and port vary; the diagnostic word (password, ssh2)
    // and the fixed phrase stay.
    [
      "openssh",
      "Failed password for root from 183.62.140.253 port 51885 ssh2",
      "Failed password for <USER> from <IP> port <NUM> ssh2",
    ],
    [
      "openssh",
      "Accepted password for fztu from 119.137.62.142 port 49116 ssh2",
      "Accepted password for <USER> from <IP> port <NUM> ssh2",
    ],
    // Apache: PIDs and slot numbers vary; the [client ip] block is parsed
    // into client_ip, so it never appears in the message pattern.
    [
      "apache",
      "jk2_init() Found child 6725 in scoreboard slot 10",
      "jk2_init() Found child <NUM> in scoreboard slot <NUM>",
    ],
    [
      "apache",
      "Directory index forbidden by rule: /var/www/html/",
      "Directory index forbidden by rule: <PATH>",
    ],
    // Linux: numeric IDs mask to <NUM>, the host after rhost= to <HOST>; the
    // syslog program and PID are parsed into component/process_id.
    [
      "linux",
      "authentication failure; logname= uid=0 euid=0 tty=NODEVssh ruser= rhost=218.188.2.4",
      "authentication failure; logname= uid=<NUM> euid=<NUM> tty=NODEVssh ruser= rhost=<HOST>",
    ],
    [
      "linux",
      "session opened for user cyrus by (uid=0)",
      "session opened for user <USER> by (uid=<NUM>)",
    ],
    // ZooKeeper: the thread in brackets is parsed into thread; numeric IDs
    // mask to <NUM>.
    [
      "zookeeper",
      "Connection broken for id 188978561024, my id = 2, error =",
      "Connection broken for id <NUM>, my id = <NUM>, error =",
    ],
    [
      "zookeeper",
      "Received connection request /10.10.34.11:45307",
      "Received connection request /<IP>",
    ],
  ])("%s: %s", async (dataset, message, expected) => {
    expect(await pattern(dataset, message)).toBe(expected)
  })
})

/** Runs a query of the ext profiling file by its title, so test and profile share the SQL. */
async function runTemplateQuery(titlePrefix: string) {
  const queries = profilingQueries(
    await readFile(
      new URL(
        "../../sql/profiling/61_loghub_templates_ext.sql",
        import.meta.url
      ),
      "utf8"
    )
  )
  const query = queries.find((q) => q.title.startsWith(titlePrefix))
  if (query === undefined) throw new Error(`No query "${titlePrefix}"`)
  return rows(client, query.sql)
}

describe("Loghub comparison on the extension 2k samples", () => {
  const run = runTemplateQuery

  it("covers every sample line with the expected pattern/template counts", async () => {
    // Patterns and templates counted by the profiling SQL (verified in U26):
    // apache 6/6, hdfs 14/14, linux 122/118, openssh 32/27, zookeeper 57/50.
    expect(
      (await run("Patterns and templates")).map((row) => ({
        dataset: row["dataset"],
        patterns: row["patterns"],
        templates: row["templates"],
      }))
    ).toEqual([
      { dataset: "apache", patterns: "6", templates: "6" },
      { dataset: "hdfs", patterns: "14", templates: "14" },
      { dataset: "linux", patterns: "122", templates: "118" },
      { dataset: "openssh", patterns: "32", templates: "27" },
      { dataset: "zookeeper", patterns: "57", templates: "50" },
    ])
  })

  it("merges no two Loghub templates into one pattern", async () => {
    expect(await run("Merges")).toEqual([])
  })

  it("splits templates only where the split is justified (R-04 per component)", async () => {
    const splits = (await run("Splits")).map((row) => ({
      dataset: row["dataset"],
      template: row["event_template_id"],
      patterns: row["patterns"],
      events: row["events"],
    }))
    // Every split is one Loghub template whose lines our masks separate for a
    // documented reason; the numbers are pinned from the profiling run.
    expect(splits).toEqual([
      // Same PAM text logged by three different programs; R-04 keys the
      // pattern on (dataset, component), so one pattern per component. Like
      // Loghub's own Linux templates E17–E19, the PAM account is kept.
      { dataset: "linux", template: "E101", patterns: "3", events: "123" },
      // Same text in sshd(pam_unix) and su(pam_unix): one pattern per component.
      { dataset: "linux", template: "E102", patterns: "2", events: "122" },
      // Same text in gdm(pam_unix) and sshd(pam_unix): one pattern per component.
      { dataset: "linux", template: "E27", patterns: "2", events: "117" },
      // "PAM ... user=<*>": the account name is kept, as Loghub keeps it for
      // the Linux PAM templates, so the user splits this OpenSSH template.
      { dataset: "openssh", template: "E20", patterns: "6", events: "384" },
      // "Reading configuration from: <*>" and friends: one pattern per
      // ZooKeeper environment key, so the key is a diagnostic distinction.
      { dataset: "zookeeper", template: "E44", patterns: "8", events: "11" },
    ])
  })
})
