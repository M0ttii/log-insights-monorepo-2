/**
 * Pattern masks (concept R-04, technical.md § 7, U03/LOG-12).
 *
 * 1. Every mask and every diagnostic code on hand-written messages; the
 *    expected patterns are written down from the rules in sql/20_patterns.sql.
 * 2. Pattern check 1: our patterns against the Loghub templates of the 2k
 *    samples (sql/profiling/60_loghub_templates.sql). The reviewed result is
 *    pinned here: no merge, and only the splits justified below. A mask
 *    change that merges templates or adds a split fails this test.
 */
import { readFile } from "node:fs/promises"

import type { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { profilingQueries } from "../../src/profiling-queries.ts"
import { SAMPLES_DATABASE } from "../../src/sources.ts"
import {
  closeIfOpen,
  connectTo,
  loadEnv,
  rows,
  runSetupCli,
} from "./helpers.ts"

loadEnv()

let client: Client

/** CI loads the samples before the tests; a local run without them loads them here. */
async function samplesLoaded(): Promise<boolean> {
  const probe = await connectTo(SAMPLES_DATABASE).catch(() => null)
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
  if (!(await samplesLoaded())) await runSetupCli(["--samples"], "UTC")
  client = await connectTo(SAMPLES_DATABASE)
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

describe("masks", () => {
  it.each([
    // Paths of user jobs (BGL only), also without a slash after "Error loading".
    [
      "bgl",
      "ciod: Error loading /home/spelce1/HPCC_IBM/Urgent/VNM/64K/vnm.rts: invalid or missing program image, Permission denied",
      "ciod: Error loading <PATH>: invalid or missing program image, Permission denied",
    ],
    [
      "bgl",
      "ciod: Error loading allreduce_int_V1R1.rts: invalid or missing program image, No such file or directory",
      "ciod: Error loading <PATH>: invalid or missing program image, No such file or directory",
    ],
    [
      "bgl",
      "ciod: LOGIN chdir(/p/gb2/glosli/8M_5000K/t800) failed: No such file or directory",
      "ciod: LOGIN chdir(<PATH>) failed: No such file or directory",
    ],
    [
      "bgl",
      "ciod: Error creating node map from file /bgl/BlueLight/V1R1M1_120_2005-050719_10:22:18Tue19Jul05/../sles_9_ppc64/mapfile/8k.map: Bad file descriptor",
      "ciod: Error creating node map from file <PATH>: Bad file descriptor",
    ],
    // Node locations, I/O nodes, card slots and unit positions.
    [
      "bgl",
      "Node card VPD check: U01 node in processor card slot J05 do not match. VPD ecid 0123456789ABCDEF0123, found 1234567890ABCDEF1234",
      "Node card VPD check: <NODE> node in processor card slot <NODE> do not match. VPD ecid <ID>, found <ID>",
    ],
    [
      "bgl",
      "Lustre mount FAILED : bglio11 : point /p/gb1",
      "Lustre mount FAILED : <NODE> : point <PATH>",
    ],
    // Operators of service actions; "by peer" elsewhere is text.
    [
      "bgl",
      "EndServiceAction 422 was performed upon R77-M0-L1 by root",
      "EndServiceAction <NUM> was performed upon <NODE> by <USER>",
    ],
    [
      "bgl",
      "ciod: Error reading message prefix on CioStream socket to 172.16.96.116:33569, Connection reset by peer",
      "ciod: Error reading message prefix on CioStream socket to <IP>, Connection reset by peer",
    ],
    // Register values: multi-word fpr values, soft header, names and indices.
    ["bgl", "fpr9=0x00000000 00000000 00000000 bfe00000", "fpr9=<ADDR>"],
    [
      "bgl",
      "Error receiving packet on tree network, expecting type 57 instead of type 3 (softheader=0064588e 8aff0003 00000002 00000000) PSR0=00001f01 PSR1=00000000 PRXF=00000002 PIXF=00000007",
      "Error receiving packet on tree network, expecting type <NUM> instead of type <NUM> (softheader=<ADDR> <ADDR> <ADDR> <ADDR>) PSR0=<ADDR> PSR1=<ADDR> PRXF=<ADDR> PIXF=<ADDR>",
    ],
    [
      "bgl",
      "lr:00115504 cr:84848448 xer:20000002 ctr:00000002",
      "lr:<ADDR> cr:<ADDR> xer:<ADDR> ctr:<ADDR>",
    ],
    [
      "bgl",
      "8:0006d600 9:00591040 10:00591040 11:0dfc8330",
      "<NUM>:<ADDR> <NUM>:<ADDR> <NUM>:<ADDR> <NUM>:<ADDR>",
    ],
    // An 8-digit decimal count is a number, not an address.
    [
      "bgl",
      "16176627 L3 EDRAM error(s) (dcr 0x0157) detected and corrected",
      "<NUM> L3 EDRAM error(s) (dcr <ADDR>) detected and corrected",
    ],
    [
      "bgl",
      "rts: bad message header: too many packets, type=0, cpu=0, index=12288, total=16777216, max=366",
      "rts: bad message header: too many packets, type=<NUM>, cpu=<NUM>, index=<NUM>, total=<NUM>, max=<NUM>",
    ],
    [
      "bgl",
      "idoproxydb has been started: $Name: V1R1M0_241_2005 $ Input parameters: -enableflush -loguserinfo db.properties BlueGene1",
      "idoproxydb has been started: $Name: <ID> $ Input parameters: -enableflush -loguserinfo db.properties BlueGene1",
    ],
    // Diagnostic codes stay (BGL).
    [
      "bgl",
      "rts: kernel terminated for reason 1004",
      "rts: kernel terminated for reason 1004",
    ],
    [
      "bgl",
      "ciod: Received signal 15, code=0, errno=0, address=0x00000207",
      "ciod: Received signal 15, code=0, errno=0, address=<ADDR>",
    ],
    [
      "bgl",
      "mmcs_server exited normally with exit code 15",
      "mmcs_server exited normally with exit code 15",
    ],
    [
      "bgl",
      "ciod: Message code 2 is not 3 or 4294967295",
      "ciod: Message code 2 is not <NUM> or <NUM>",
    ],
    [
      "bgl",
      "machine check interrupt (bit=0x09): Torus/Tree/GI read error 0",
      "machine check interrupt (bit=<ADDR>): Torus/Tree/GI read error 0",
    ],
    [
      "bgl",
      "program interrupt: illegal instruction......1",
      "program interrupt: illegal instruction......1",
    ],
    // A value after dot leaders that is not a 0/1 state bit is a count.
    [
      "bgl",
      "number of correctable errors detected in L3 EDRAMs........61",
      "number of correctable errors detected in L3 EDRAMs........<NUM>",
    ],
    [
      "bgl",
      "DISCOVERY found 32 node cards on Wed Sep 14 12:34:56 PDT 2005",
      "DISCOVERY found <NUM> node cards on <TS>",
    ],
    // OpenStack: query strings, HTTP version, dated metadata API, status.
    [
      "openstack",
      '10.11.10.1 "GET /v2/54fadb412c4e40cdbaed9335e4c35a9e/servers/detail?all_tenants=True&changes-since=2017-05-16T21%3A44%3A58.589278%2B00%3A00 HTTP/1.1" status: 200 len: 1893 time: 0.2477829',
      '<IP> "GET /v2/<ID>/servers/detail?<QUERY> HTTP/1.1" status: 200 len: <NUM> time: <NUM>',
    ],
    [
      "openstack",
      '10.11.10.1,10.11.21.1 "GET /openstack/2013-10-17/meta_data.json HTTP/1.1" status: 404 len: 967 time: 0.2223',
      '<IP>,<IP> "GET /openstack/2013-10-17/meta_data.json HTTP/1.1" status: 404 len: <NUM> time: <NUM>',
    ],
    [
      "openstack",
      "[instance: 544fd51c-4edc-4780-baae-ba1d80a0acfc] Took 0.54 seconds to deallocate network for instance.",
      "[instance: <UUID>] Took <NUM> seconds to deallocate network for instance.",
    ],
    [
      "openstack",
      "Final resource view: name=cp-1.slowvm1.tcloud-pg0.utah.cloudlab.us phys_ram=64172MB used_ram=2560MB phys_disk=15GB used_disk=20GB total_vcpus=16 used_vcpus=1 pci_stats=[]",
      "Final resource view: name=cp-<NUM>.slowvm1.tcloud-pg0.utah.cloudlab.us phys_ram=<NUM>MB used_ram=<NUM>MB phys_disk=<NUM>GB used_disk=<NUM>GB total_vcpus=<NUM> used_vcpus=<NUM> pci_stats=[]",
    ],
    [
      "openstack",
      "Bad response code while validating token: 503",
      "Bad response code while validating token: 503",
    ],
    ["openstack", "Exit code: 1", "Exit code: 1"],
    // OpenStack paths are code locations and stay.
    [
      "openstack",
      '  File "/usr/lib/python2.7/dist-packages/nova/virt/images.py", line 241, in qemu_img_info',
      '  File "/usr/lib/python2.<NUM>/dist-packages/nova/virt/images.py", line <NUM>, in qemu_img_info',
    ],
    [
      "openstack",
      "req-38101a0b-2096-447d-96ea-a692162415ae failed",
      "<REQ> failed",
    ],
  ])("%s: %s", async (dataset, message, expected) => {
    expect(await pattern(dataset, message)).toBe(expected)
  })
})

/** Runs a query of the profiling file by its title, so test and profile share the SQL. */
async function runTemplateQuery(titlePrefix: string) {
  const queries = profilingQueries(
    await readFile(
      new URL("../../sql/profiling/60_loghub_templates.sql", import.meta.url),
      "utf8"
    )
  )
  const query = queries.find((q) => q.title.startsWith(titlePrefix))
  if (query === undefined) throw new Error(`No query "${titlePrefix}"`)
  return rows(client, query.sql)
}

describe("Loghub comparison on the 2k samples", () => {
  const run = runTemplateQuery

  it("covers every sample line", async () => {
    // 120 BGL and 43 OpenStack templates (Loghub CSV, counted with awk).
    expect(await run("Patterns and templates")).toEqual([
      { dataset: "bgl", events: "2000", patterns: "123", templates: "120" },
      { dataset: "openstack", events: "2000", patterns: "68", templates: "43" },
    ])
  })

  it("merges no two Loghub templates into one pattern", async () => {
    expect(await run("Merges")).toEqual([])
  })

  it("splits templates only where the split is justified", async () => {
    const splits = (await run("Splits")).map((row) => ({
      dataset: row["dataset"],
      template: row["event_template_id"],
      patterns: row["patterns"],
      events: row["events"],
    }))
    expect(splits).toEqual([
      // "illegal instruction......<*>": the final 0/1 is the register state bit.
      { dataset: "bgl", template: "E101", patterns: "2", events: "8" },
      // "kernel terminated for reason <*>": the reason is a diagnostic code.
      { dataset: "bgl", template: "E111", patterns: "2", events: "6" },
      // "LOGIN chdir(<*>) failed": `chdir(pwd)` is a literal word, not a
      // path; it marks an unexpanded working directory, a different fault.
      { dataset: "bgl", template: "E37", patterns: "2", events: "18" },
      // "<*> "GET <*>" status: <*> …": endpoint and HTTP status stay (A-12, R-04).
      { dataset: "openstack", template: "E25", patterns: "24", events: "931" },
      // "<*> "POST <*>" status: <*> …": same reason.
      { dataset: "openstack", template: "E26", patterns: "3", events: "64" },
    ])
  })
})
