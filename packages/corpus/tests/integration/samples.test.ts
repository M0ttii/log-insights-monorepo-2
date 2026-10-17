/**
 * `pnpm data:setup --samples` against SereneDB with the Loghub 2k samples.
 * Every expected value was determined by hand from the sample files with
 * grep/awk/date (LOG-11), not from the loader.
 */
import type { Client } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { SAMPLES_DATABASE } from "../../src/sources.ts"
import {
  connectTo,
  dataVersionOf,
  loadEnv,
  rows,
  runScript,
  runSetupCli,
} from "./helpers.ts"

loadEnv()

let client: Client
let firstOutput = ""

beforeAll(async () => {
  // A non-UTC process time zone must not change the loaded data.
  firstOutput = await runSetupCli(["--samples"], "Asia/Kolkata")
  client = await connectTo(SAMPLES_DATABASE)
})

afterAll(async () => {
  await client.end()
})

describe("load balance", () => {
  it("reads, loads and rejects as counted in the files", async () => {
    expect(
      await rows(
        client,
        `SELECT dataset, source_file, lines_read, events_loaded, rejected, reason_counts
         FROM load_report ORDER BY dataset`
      )
    ).toEqual([
      {
        dataset: "bgl",
        source_file: "BGL_2k.log",
        lines_read: "2000",
        events_loaded: "2000",
        rejected: "0",
        reason_counts: {},
      },
      {
        dataset: "openstack",
        source_file: "OpenStack_2k.log",
        lines_read: "2000",
        events_loaded: "2000",
        rejected: "0",
        reason_counts: {},
      },
    ])
    expect(
      await rows(client, "SELECT count(*) AS n FROM load_rejects")
    ).toEqual([{ n: "0" }])
  })

  it("passes every load check", async () => {
    expect(
      await rows(client, "SELECT check_name FROM load_checks WHERE NOT ok")
    ).toEqual([])
  })
})

describe("BGL fields", () => {
  it("parses a non-alert line with microseconds from the text timestamp", async () => {
    expect(
      await rows(
        client,
        `SELECT event_id, dataset, source_file, line_no, ts, level, component,
           source_type, node, rack, midplane, alert_label, is_alert, is_error,
           request_id, http_status, is_anomalous, message
         FROM log_events WHERE event_id = 1`
      )
    ).toEqual([
      {
        event_id: "1",
        dataset: "bgl",
        source_file: "BGL_2k.log",
        line_no: "1",
        // Unix 1117838570 = 2005-06-03 22:42:50 UTC; text time 15.42.50.675872 (PDT).
        ts: "2005-06-03 22:42:50.675872+00",
        level: "INFO",
        component: "KERNEL",
        source_type: "RAS",
        node: "R02-M1-N0-C:J12-U11",
        rack: "R02",
        midplane: "R02-M1",
        alert_label: null,
        is_alert: false,
        is_error: false,
        request_id: null,
        http_status: null,
        is_anomalous: null,
        message: "instruction cache parity error corrected",
      },
    ])
  })

  it("parses an alert line (line 9)", async () => {
    expect(
      await rows(
        client,
        `SELECT ts, level, component, node, rack, midplane, alert_label, is_alert,
           is_error, message
         FROM log_events WHERE event_id = 9`
      )
    ).toEqual([
      {
        ts: "2005-06-04 07:24:32.432192+00",
        level: "FATAL",
        component: "APP",
        node: "R04-M1-N4-I:J18-U11",
        rack: "R04",
        midplane: "R04-M1",
        alert_label: "APPREAD",
        is_alert: true,
        is_error: true,
        message:
          "ciod: failed to read message prefix on control stream (CioStream socket to 172.16.96.116:33569",
      },
    ])
  })

  it("counts levels, alerts, errors and node markers", async () => {
    expect(
      await rows(
        client,
        `SELECT level, count(*) AS n FROM log_events
         WHERE dataset = 'bgl' GROUP BY level ORDER BY level`
      )
    ).toEqual([
      { level: "ERROR", n: "41" },
      { level: "FATAL", n: "347" },
      { level: "INFO", n: "1597" },
      { level: "SEVERE", n: "7" },
      { level: "WARNING", n: "8" },
    ])
    expect(
      await rows(
        client,
        `SELECT count(*) FILTER (WHERE is_alert) AS alerts,
           count(*) FILTER (WHERE is_error) AS errors,
           count(*) FILTER (WHERE node IS NULL) AS no_node,
           count(*) FILTER (WHERE node = 'UNKNOWN_LOCATION') AS unknown_location,
           count(*) FILTER (WHERE rack IS NULL) AS no_rack,
           count(*) FILTER (WHERE midplane IS NULL) AS no_midplane,
           min(ts) AS first_ts, max(ts) AS last_ts
         FROM log_events WHERE dataset = 'bgl'`
      )
    ).toEqual([
      {
        alerts: "143",
        // ERROR 41 + SEVERE 7 + FATAL 347 (no FAILURE in the sample).
        errors: "395",
        // 35 lines with the log's own NULL marker as node.
        no_node: "35",
        unknown_location: "10",
        no_rack: "45",
        no_midplane: "45",
        first_ts: "2005-06-03 22:42:50.675872+00",
        // Unix 1136301189 = 2006-01-03 15:13:09 UTC, text .127918.
        last_ts: "2006-01-03 15:13:09.127918+00",
      },
    ])
  })
})

describe("OpenStack fields", () => {
  it("parses an API access line with request block", async () => {
    expect(
      await rows(
        client,
        `SELECT event_id, source_file, line_no, ts, level, component, source_type,
           request_id, user_id, tenant_id, instance_id, http_method, http_path,
           endpoint, http_status, response_bytes, latency_ms, is_error,
           is_anomalous, node, message
         FROM log_events WHERE event_id = 10000001`
      )
    ).toEqual([
      {
        event_id: "10000001",
        source_file: "OpenStack_2k.log",
        line_no: "1",
        ts: "2017-05-16 00:00:00.008+00",
        level: "INFO",
        component: "nova-api",
        source_type: "nova.osapi_compute.wsgi.server",
        request_id: "req-38101a0b-2096-447d-96ea-a692162415ae",
        user_id: "113d3a99c3da401fbd62cc2caa5b96d2",
        tenant_id: "54fadb412c4e40cdbaed9335e4c35a9e",
        instance_id: null,
        http_method: "GET",
        http_path: "/v2/54fadb412c4e40cdbaed9335e4c35a9e/servers/detail",
        endpoint: "/v2/<ID>/servers/detail",
        http_status: 200,
        response_bytes: "1893",
        latency_ms: 247.7829,
        is_error: false,
        // The samples have no anomaly labels: NULL, not false.
        is_anomalous: null,
        node: null,
        message:
          '10.11.10.1 "GET /v2/54fadb412c4e40cdbaed9335e4c35a9e/servers/detail HTTP/1.1" status: 200 len: 1893 time: 0.2477829',
      },
    ])
  })

  it("parses a line with [-] instead of a request block (line 24)", async () => {
    expect(
      await rows(
        client,
        `SELECT ts, component, source_type, request_id, user_id, instance_id,
           http_status, message
         FROM log_events WHERE event_id = 10000024`
      )
    ).toEqual([
      {
        ts: "2017-05-16 00:00:10.302+00",
        component: "nova-compute",
        source_type: "nova.virt.libvirt.driver",
        request_id: null,
        user_id: null,
        instance_id: "b9000564-fe1a-409b-b8cc-1e88b294cd1d",
        http_status: null,
        message:
          "[instance: b9000564-fe1a-409b-b8cc-1e88b294cd1d] Instance spawned successfully.",
      },
    ])
  })

  it("counts components, levels and instance lines", async () => {
    expect(
      await rows(
        client,
        `SELECT component, count(*) AS n FROM log_events
         WHERE dataset = 'openstack' GROUP BY component ORDER BY component`
      )
    ).toEqual([
      { component: "nova-api", n: "1060" },
      { component: "nova-compute", n: "933" },
      { component: "nova-scheduler", n: "7" },
    ])
    expect(
      await rows(
        client,
        `SELECT count(*) FILTER (WHERE level = 'INFO') AS info,
           count(*) FILTER (WHERE level = 'WARNING') AS warning,
           count(*) FILTER (WHERE is_error) AS errors,
           count(*) FILTER (WHERE instance_id IS NOT NULL) AS with_instance,
           min(ts) AS first_ts, max(ts) AS last_ts
         FROM log_events WHERE dataset = 'openstack'`
      )
    ).toEqual([
      {
        info: "1969",
        warning: "31",
        errors: "0",
        with_instance: "535",
        first_ts: "2017-05-16 00:00:00.008+00",
        last_ts: "2017-05-16 00:14:47.687+00",
      },
    ])
  })

  it("separates API accesses, those without request ID, and requests (R-01)", async () => {
    expect(
      await rows(
        client,
        `SELECT count(*) AS accesses,
           count(*) FILTER (WHERE request_id IS NULL) AS without_request_id,
           count(*) FILTER (WHERE request_id IS NULL AND http_status = 404) AS without_request_id_404,
           count(*) FILTER (WHERE http_status = 404) AS status_404,
           count(DISTINCT request_id) AS requests
         FROM api_access`
      )
    ).toEqual([
      {
        accesses: "1017",
        without_request_id: "89",
        without_request_id_404: "12",
        status_404: "41",
        requests: "928",
      },
    ])
  })
})

describe("helper tables", () => {
  it("describes both datasets in corpus_stats", async () => {
    expect(
      await rows(
        client,
        `SELECT dataset, lines_read, events, rejected, first_ts, last_ts,
           api_accesses, api_accesses_without_request_id, requests
         FROM corpus_stats ORDER BY dataset`
      )
    ).toEqual([
      {
        dataset: "bgl",
        lines_read: "2000",
        events: "2000",
        rejected: "0",
        first_ts: "2005-06-03 22:42:50.675872+00",
        last_ts: "2006-01-03 15:13:09.127918+00",
        api_accesses: null,
        api_accesses_without_request_id: null,
        requests: null,
      },
      {
        dataset: "openstack",
        lines_read: "2000",
        events: "2000",
        rejected: "0",
        first_ts: "2017-05-16 00:00:00.008+00",
        last_ts: "2017-05-16 00:14:47.687+00",
        api_accesses: "1017",
        api_accesses_without_request_id: "89",
        requests: "928",
      },
    ])
  })

  it("assigns every observed component a fictional team or unowned", async () => {
    const teams = await rows(
      client,
      "SELECT dataset, component, team FROM component_teams ORDER BY dataset, component"
    )
    expect(
      teams.map(
        (row) => `${String(row["dataset"])}:${String(row["component"])}`
      )
    ).toEqual([
      "bgl:APP",
      "bgl:DISCOVERY",
      "bgl:HARDWARE",
      "bgl:KERNEL",
      "bgl:MMCS",
      "openstack:nova-api",
      "openstack:nova-compute",
      "openstack:nova-scheduler",
    ])
    expect(teams.every((row) => typeof row["team"] === "string")).toBe(true)
    expect(await rows(client, "SELECT DISTINCT note FROM ownership")).toEqual([
      { note: "fictional (Serene Platform); draft until U03" },
    ])
  })

  it("records checksums, image digest and versions in the manifest", async () => {
    const [manifest] = await rows(
      client,
      "SELECT data_version, source, files, image, pattern_rules_version FROM load_manifest"
    )
    expect(manifest).toMatchObject({
      data_version: dataVersionOf(firstOutput),
      source: "samples",
      files: [
        {
          path: "loghub-2k/BGL_2k.log",
          bytes: 317150,
          sha256:
            "2a819ea540909db682005c9cf948387a40729b5c2e9f19d430e29ce704825496",
        },
        {
          path: "loghub-2k/OpenStack_2k.log",
          bytes: 595119,
          sha256:
            "025a1bc64ff5b2ef4a4bda6c4ad5c5c5f18478b71cd1ad2b0676e01625629f2f",
        },
      ],
    })
    expect(String(manifest?.["image"])).toMatch(
      /^serenedb\/serenedb:.+@sha256:[0-9a-f]{64}$/
    )
  })

  it("finds known terms through the full-text index", async () => {
    // grep -ciw parity BGL_2k.log = 48
    expect(
      await rows(
        client,
        "SELECT count(*) AS n FROM log_events_idx WHERE message @@ 'parity' AND dataset = 'bgl'"
      )
    ).toEqual([{ n: "48" }])
  })
})

describe("time zones and idempotence", () => {
  it("returns identical timestamps under TZ=UTC, America/Los_Angeles and Asia/Kolkata", async () => {
    const outputs = await Promise.all(
      ["UTC", "America/Los_Angeles", "Asia/Kolkata"].map((zone) =>
        runScript("print-times.ts", [], zone)
      )
    )
    const [utc, ...others] = outputs.map(
      (output) => JSON.parse(output) as unknown
    )
    expect(utc).toEqual([
      {
        event_id: "1",
        ts: "2005-06-03 22:42:50.675872+00",
        iso: "2005-06-03T22:42:50.675872Z",
        day: "2005-06-03 00:00:00+00",
      },
      {
        event_id: "9",
        ts: "2005-06-04 07:24:32.432192+00",
        iso: "2005-06-04T07:24:32.432192Z",
        day: "2005-06-04 00:00:00+00",
      },
      {
        event_id: "10000001",
        ts: "2017-05-16 00:00:00.008+00",
        iso: "2017-05-16T00:00:00.008000Z",
        day: "2017-05-16 00:00:00+00",
      },
    ])
    for (const other of others) expect(other).toEqual(utc)
  })

  it("reloads without downloading and yields the same counts and data version", async () => {
    const before = await rows(
      client,
      "SELECT dataset, events, patterns FROM corpus_stats ORDER BY dataset"
    )
    const output = await runSetupCli(["--samples"], "America/Los_Angeles")
    expect(output).not.toMatch(/downloading|fetched/)
    expect(output).toMatch(/present {2}loghub-2k\/BGL_2k\.log/)
    expect(dataVersionOf(output)).toBe(dataVersionOf(firstOutput))
    expect(
      await rows(
        client,
        "SELECT dataset, events, patterns FROM corpus_stats ORDER BY dataset"
      )
    ).toEqual(before)
  })
})
