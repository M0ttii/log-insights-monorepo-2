/**
 * Dataset catalog (technical.md § 7.1, concept 5.5, A-39): the one source for
 * dataset IDs, raw sources with their pinned checksums, licence and citation,
 * time basis, the meaning of every column per dataset, counting units, the
 * error definition (R-02), the breadth unit (R-08), context scopes and
 * capabilities. Filters, dimensions, the loader plan and describe_corpus
 * derive from it; no other module lists datasets.
 *
 * Pure data without dependencies, so the corpus loader can read it too.
 * Adding a similarly structured source is one entry here, a parser SQL file
 * (packages/corpus/sql/) and ownership rows. Remote Parquet datasets
 * (LOG-35) carry an allowlist instead of checksums; the loader pins each
 * file's size, ETag and Last-Modified at load time.
 */

export const DATASET_IDS = [
  "bgl",
  "openstack",
  "hdfs",
  "openssh",
  "apache",
  "linux",
  "zookeeper",
  "otel",
] as const

export type Dataset = (typeof DATASET_IDS)[number]

/** The base corpus of the brief; always loaded (concept 5.1). */
export const BASE_DATASETS = [
  "bgl",
  "openstack",
] as const satisfies readonly Dataset[]

/** Loghub datasets loaded on request with `--with` (concept 5.5). */
export const EXTENSION_DATASETS = [
  "hdfs",
  "openssh",
  "apache",
  "linux",
  "zookeeper",
] as const satisfies readonly Dataset[]

export type ExtensionDataset = (typeof EXTENSION_DATASETS)[number]

export function isExtension(dataset: Dataset): dataset is ExtensionDataset {
  return (EXTENSION_DATASETS as readonly Dataset[]).includes(dataset)
}

/**
 * Datasets read in place from external storage (LOG-35, A-32): not stored in
 * log_events, never part of `--with all` and never included in a query
 * without `dataset`. Loaded on request with `--with otel`.
 */
export const EXTERNAL_DATASETS = ["otel"] as const satisfies readonly Dataset[]

export type ExternalDataset = (typeof EXTERNAL_DATASETS)[number]

export function isExternal(dataset: Dataset): dataset is ExternalDataset {
  return (EXTERNAL_DATASETS as readonly Dataset[]).includes(dataset)
}

/** Datasets stored in log_events (base corpus and Loghub extensions). */
export type TableDataset = Exclude<Dataset, ExternalDataset>

export function isTableDataset(dataset: Dataset): dataset is TableDataset {
  return !isExternal(dataset)
}

/** log_events columns whose meaning the catalog states per dataset. */
export const DATASET_COLUMNS = [
  "ts",
  "level",
  "component",
  "source_type",
  "message",
  "is_error",
  "node",
  "midplane",
  "rack",
  "alert_label",
  "request_id",
  "instance_id",
  "http_method",
  "endpoint",
  "http_status",
  "latency_ms",
  "is_anomalous",
  "host",
  "process_id",
  "client_ip",
  "thread",
  "block_id",
  "trace_id",
  "span_id",
  "severity_number",
] as const

export type DatasetColumn = (typeof DATASET_COLUMNS)[number]

/** Columns that only some datasets fill; they never change meaning between datasets. */
export const SPECIFIC_COLUMNS = [
  "node",
  "midplane",
  "rack",
  "alert_label",
  "request_id",
  "instance_id",
  "http_method",
  "endpoint",
  "http_status",
  "latency_ms",
  "host",
  "process_id",
  "client_ip",
  "thread",
  "block_id",
  "trace_id",
  "span_id",
  "severity_number",
] as const satisfies readonly DatasetColumn[]

export type SpecificColumn = (typeof SPECIFIC_COLUMNS)[number]

/** Columns added for the extensions; NULL for BGL and OpenStack (technical.md § 6.1). */
export const EXTENSION_COLUMNS = [
  "host",
  "process_id",
  "client_ip",
  "thread",
  "block_id",
] as const satisfies readonly SpecificColumn[]

export type ExtensionColumn = (typeof EXTENSION_COLUMNS)[number]

/**
 * Columns of the OpenTelemetry dataset (LOG-35). They exist only in its
 * relations, never in log_events, and keep the OTel meaning as logged.
 */
export const OTEL_COLUMNS = [
  "trace_id",
  "span_id",
  "severity_number",
] as const satisfies readonly SpecificColumn[]

export type OtelColumn = (typeof OTEL_COLUMNS)[number]

/** Filter fields bound to a dataset-specific column (technical.md § 8.1). */
export const SPECIFIC_FILTER_COLUMNS = {
  node: "node",
  rack: "rack",
  alert_label: "alert_label",
  only_alerts: "alert_label",
  request_id: "request_id",
  instance_id: "instance_id",
  endpoints: "endpoint",
  http_status: "http_status",
  block_id: "block_id",
  host: "host",
  process_id: "process_id",
  client_ip: "client_ip",
  thread: "thread",
  trace_id: "trace_id",
} as const satisfies Record<string, SpecificColumn>

export type SpecificFilter = keyof typeof SPECIFIC_FILTER_COLUMNS

/** Grouping dimensions bound to a dataset-specific column. */
export const SPECIFIC_DIMENSION_COLUMNS = {
  alert_label: "alert_label",
  rack: "rack",
  node: "node",
  http_status: "http_status",
  endpoint: "endpoint",
  host: "host",
  client_ip: "client_ip",
  thread: "thread",
  block_id: "block_id",
} as const satisfies Record<string, SpecificColumn>

export type SpecificDimension = keyof typeof SPECIFIC_DIMENSION_COLUMNS

/**
 * Context scopes of get_log_context mode event bound to a column of the
 * anchor event; `same_component` and `dataset` apply to every dataset.
 */
export const SPECIFIC_CONTEXT_SCOPES = {
  same_node: "node",
  same_request: "request_id",
  same_block: "block_id",
  same_process: "process_id",
  same_client: "client_ip",
  same_thread: "thread",
  same_trace: "trace_id",
} as const satisfies Record<string, SpecificColumn>

export type SpecificContextScope = keyof typeof SPECIFIC_CONTEXT_SCOPES

/** R-08 breadth units; the extra unit is shown, never ranked. */
export type BreadthUnit = "nodes" | "instances" | "blocks" | "client_ips"
export type ExtraBreadthUnit = "racks" | "requests"

/** A file below .data/raw, addressed by its POSIX path relative to that directory. */
export type PinnedFile = {
  path: string
  bytes: number
  sha256: string
}

export type Archive = PinnedFile & {
  url: string
  format: "zip" | "tar.gz"
  /** Directory (relative to .data/raw) the entries are extracted into. */
  extractTo: string
  /** Exactly these entries must be in the archive; others are listed and skipped. */
  entries: readonly PinnedFile[]
}

export type DirectFile = PinnedFile & { url: string }

/** What the loader reads for one dataset from one source (corpus or samples). */
export type DatasetSource = {
  archives: readonly Archive[]
  downloads: readonly DirectFile[]
  /** Log files in their fixed load order (event_id follows it). */
  logs: readonly string[]
  /** Dataset label file, or null when this source has none. */
  labels: string | null
  /** Loghub's structured file with templates (2k samples only, pattern check). */
  templates: string | null
  /** Physical lines the load balance compares against (A-02). */
  expectedLines: number
  expectedLinesSource: string
}

type CommonSpec = {
  title: string
  /** System and collection, as Loghub describes it. */
  origin: string
  citation: readonly string[]
  /**
   * First event_id of the dataset; event_id = base + running line number
   * (log_events) or base + file index · stride + file row number (remote
   * Parquet, RemoteParquetSource.eventIdFileStride).
   */
  eventIdBase: number
  /** Stored in corpus_stats.time_basis; names every assumption. */
  timeBasis: string
  /** R-02 error definition; null when the log carries none (is_error unknown). */
  errorDefinition: string | null
  /** Meaning of every column that carries values for this dataset. */
  fields: Readonly<Partial<Record<DatasetColumn, string>>>
  breadth: {
    unit: BreadthUnit
    column: SpecificColumn
    extra: { unit: ExtraBreadthUnit; column: SpecificColumn } | null
  } | null
  /** Specific context scopes; the first is the default when the anchor has its value. */
  contextScopes: readonly SpecificContextScope[]
  /** True when the default scope is the first specific scope (else same_component). */
  defaultsToSpecificScope: boolean
  /** Dataset labels: what they mark. Never findings of this system. */
  labels: { marks: "line" | "instance" | "block"; source: string } | null
  /** OpenStack API accesses (R-01); only datasets with HTTP access lines. */
  apiAccesses: boolean
  /**
   * Message patterns (R-04): pattern_id, recurring_patterns, the pattern
   * dimension and get_log_context aggregate. False for remote datasets,
   * whose messages are not normalised at load time (LOG-35).
   */
  patterns: boolean
  /** Known term of the dataset for the full-text visibility check (90_checks.sql). */
  probeTerm: string
}

/** A dataset loaded into log_events from pinned local files. */
export type TableDatasetSpec = CommonSpec & {
  id: TableDataset
  storage: "log_events"
  corpus: DatasetSource
  samples: DatasetSource
}

/** One allowlisted remote Parquet file; its pins (size, ETag, Last-Modified) come from the loader. */
export type RemoteParquetFile = {
  /** Position in the allowlist; part of the event_id. */
  index: number
  /** HTTPS URL the direct scans and the source check read. */
  url: string
  /** The same object as an s3:// key, used in the reference-window glob. */
  s3: string
}

/** A committed Parquet fixture with the real schema, for hermetic CI (D8). */
export type ParquetFixture = {
  index: number
  /** Repository path relative to packages/corpus. */
  fixture: string
  /** Copy below .data/raw, POSIX path relative to that directory. */
  path: string
  bytes: number
  sha256: string
}

/** The indexed reference window (D3.1): one view over a glob plus an inverted index. */
export type ReferenceWindow = {
  /** Allowlist indexes the glob matches, in order; nothing else matches it. */
  files: readonly number[]
  /** Glob over exactly these files (s3:// for the bucket, a path for samples). */
  glob: string
  /** [from, to) in UTC, microseconds; crosses the boundary of the two files. */
  from: string
  to: string
}

export type RemoteParquetSource = {
  licence: string
  /** What the loader pins per file instead of a checksum. */
  pinKind: string
  /** The allowlist: the only files any query reads. */
  files: readonly RemoteParquetFile[]
  /** Files that exist in the bucket but are deliberately not allowlisted. */
  notAllowlisted: string
  /** Parquet column of each dataset column (renames only). */
  sourceColumns: Readonly<
    Record<
      | "ts"
      | "level"
      | "component"
      | "source_type"
      | "message"
      | "trace_id"
      | "span_id"
      | "severity_number",
      string
    >
  >
  /** SeverityText values that are errors (R-02), as observed in the data. */
  errorLevels: readonly string[]
  /** event_id = eventIdBase + file index · stride + file_row_number. */
  eventIdFileStride: number
  reference: ReferenceWindow
  samples: {
    description: string
    files: readonly ParquetFixture[]
    /** Glob relative to .data/raw over exactly the fixture copies. */
    glob: string
    from: string
    to: string
  }
}

/** A dataset read in place from remote Parquet files (LOG-35, A-32). */
export type RemoteParquetSpec = CommonSpec & {
  id: ExternalDataset
  storage: "remote_parquet"
  remote: RemoteParquetSource
}

export type DatasetSpec = TableDatasetSpec | RemoteParquetSpec

/**
 * Pre-declared limits of a bounded direct scan over remote Parquet (D3.2):
 * the window and the number of files one count_events or event_trend call
 * may read. Measured on part_000 (LOG-35 probe § 3): counts and facets over
 * 60 s of data stayed below 2 s cold, inside the 10 s pool limit.
 */
export const REMOTE_SCAN_MAX_SECONDS = 60
export const REMOTE_SCAN_MAX_FILES = 2

const ZENODO = "https://zenodo.org/records/8196385/files"

const TEXT_BENCH_HTTPS =
  "https://public-pme.s3.eu-west-3.amazonaws.com/text_bench"
const TEXT_BENCH_S3 = "s3://public-pme/text_bench"

/** Loghub commit the 2k samples are pinned to (logpai/loghub, 17.10.2026). */
export const LOGHUB_COMMIT = "dd61d0952749ee7963bde24220d1be5ede023033"
const LOGHUB = `https://raw.githubusercontent.com/logpai/loghub/${LOGHUB_COMMIT}`

/** Zenodo record 8196385: CC BY 4.0 with Loghub's attribution condition. */
export const LICENSE =
  "Zenodo record 8196385 (CC BY 4.0): refer to https://github.com/logpai/loghub and cite the Loghub paper."

const LOGHUB_PAPER =
  "Jieming Zhu, Shilin He, Pinjia He, Jinyang Liu, Michael R. Lyu: Loghub: A Large Collection of System Log Datasets for AI-driven Log Analytics. ISSRE 2023."

const COMMON_FIELDS = {
  ts: "Event time, UTC with microseconds.",
  message: "Original log message after the header fields, untrusted text.",
} as const

const sample = (
  dataset: string,
  log: { bytes: number; sha256: string },
  structured: { bytes: number; sha256: string }
): DatasetSource => ({
  archives: [],
  downloads: [
    {
      path: `loghub-2k/${dataset}_2k.log`,
      url: `${LOGHUB}/${dataset}/${dataset}_2k.log`,
      ...log,
    },
    {
      path: `loghub-2k/${dataset}_2k.log_structured.csv`,
      url: `${LOGHUB}/${dataset}/${dataset}_2k.log_structured.csv`,
      ...structured,
    },
  ],
  logs: [`loghub-2k/${dataset}_2k.log`],
  labels: null,
  templates: `loghub-2k/${dataset}_2k.log_structured.csv`,
  expectedLines: 2_000,
  expectedLinesSource: "Loghub 2k samples",
})

export const DATASETS: { readonly [K in TableDataset]: TableDatasetSpec } & {
  readonly otel: RemoteParquetSpec
} = {
  bgl: {
    id: "bgl",
    storage: "log_events",
    patterns: true,
    title: "BGL",
    origin:
      "BlueGene/L supercomputer at Lawrence Livermore National Labs, 2005–2006.",
    citation: [
      LOGHUB_PAPER,
      "Adam Oliner, Jon Stearley: What Supercomputers Say: A Study of Five System Logs. DSN 2007.",
    ],
    eventIdBase: 0,
    timeBasis: "Unix seconds (UTC) + microseconds of the text timestamp",
    errorDefinition: "levels ERROR, SEVERE, FATAL, FAILURE",
    fields: {
      ...COMMON_FIELDS,
      level:
        "Severity as logged: INFO, WARNING, SEVERE, ERROR, FATAL, FAILURE.",
      component: "BGL component (KERNEL, APP, …).",
      source_type: "BGL message type (RAS, …).",
      is_error: "Error level after R-02.",
      node: "Node ID, e.g. R02-M1-N0-C:J12-U11.",
      midplane: "Midplane derived from the node, e.g. R02-M1.",
      rack: "Rack derived from the node, e.g. R02.",
      alert_label: "Dataset alert category; null for non-alert lines.",
    },
    breadth: {
      unit: "nodes",
      column: "node",
      extra: { unit: "racks", column: "rack" },
    },
    contextScopes: ["same_node"],
    defaultsToSpecificScope: true,
    labels: {
      marks: "line",
      source: "alert category in the first column (dataset label)",
    },
    apiAccesses: false,
    probeTerm: "parity",
    corpus: {
      archives: [
        {
          path: "BGL.zip",
          url: `${ZENODO}/BGL.zip?download=1`,
          format: "zip",
          bytes: 57_489_019,
          sha256:
            "d67fd82a711aea0157a9b83175892c6ee60e384a2ddf5bc51f39118453816da8",
          extractTo: "",
          entries: [
            {
              path: "BGL.log",
              bytes: 743_185_031,
              sha256:
                "666130b15ef44eb32fd02bd053e6c6e007c37696b5e7e8b9d8e45b729876a5d2",
            },
          ],
        },
      ],
      downloads: [],
      logs: ["BGL.log"],
      labels: null,
      templates: null,
      expectedLines: 4_747_963,
      expectedLinesSource: "challenge brief",
    },
    samples: sample(
      "BGL",
      {
        bytes: 317_150,
        sha256:
          "2a819ea540909db682005c9cf948387a40729b5c2e9f19d430e29ce704825496",
      },
      {
        bytes: 425_129,
        sha256:
          "3fe74103c0b02a28514534e2a47257a3f770135ca61afd425bbd3b9d6a31fe26",
      }
    ),
  },
  openstack: {
    id: "openstack",
    storage: "log_events",
    patterns: true,
    title: "OpenStack",
    origin: "Nova services nova-api, nova-compute, nova-scheduler, 2017.",
    citation: [LOGHUB_PAPER],
    eventIdBase: 10_000_000,
    timeBasis: "timestamp without zone, assumed UTC",
    errorDefinition: "levels ERROR, CRITICAL; failed API accesses are 5xx",
    fields: {
      ...COMMON_FIELDS,
      level: "Severity as logged: INFO, WARNING, ERROR, CRITICAL.",
      component: "OpenStack service from the file prefix (nova-api, …).",
      source_type: "OpenStack logger name.",
      is_error: "Error level after R-02.",
      request_id: "Request ID (req-…) of the request block.",
      instance_id: "Instance UUID named in the line.",
      http_method: "HTTP method of an API access line.",
      endpoint: "API path with IDs masked (R-04).",
      http_status: "HTTP status of an API access line.",
      latency_ms: "Response time of an API access in milliseconds.",
      is_anomalous: "Dataset anomaly label of the instance, where assignable.",
    },
    breadth: {
      unit: "instances",
      column: "instance_id",
      extra: { unit: "requests", column: "request_id" },
    },
    contextScopes: ["same_request"],
    defaultsToSpecificScope: false,
    labels: {
      marks: "instance",
      source:
        "instances with injected anomalies, anomaly_labels.txt (dataset label)",
    },
    apiAccesses: true,
    probeTerm: "image",
    corpus: {
      archives: [
        {
          path: "OpenStack.tar.gz",
          url: `${ZENODO}/OpenStack.tar.gz?download=1`,
          format: "tar.gz",
          bytes: 5_394_691,
          sha256:
            "87c98c5ed03262e05cdb7a6f3717033df76d88fda0f7d2db23bd9fa4200f1879",
          extractTo: "openstack",
          entries: [
            {
              path: "anomaly_labels.txt",
              bytes: 243,
              sha256:
                "0882aa484f285e3dda476ff39ed739603c446f27b76bb113e284cda6ebb09d0b",
            },
            {
              path: "openstack_abnormal.log",
              bytes: 5_436_122,
              sha256:
                "7ab718fbb2f2b804893955cecf37ad9533cfa0efaf5b03009474d5bb019b6af4",
            },
            {
              path: "openstack_normal1.log",
              bytes: 15_499_595,
              sha256:
                "4e4d47347bdae198056bb3b0a8a755e1cb0100d6c6a30bbd4058684234769199",
            },
            {
              path: "openstack_normal2.log",
              bytes: 40_506_365,
              sha256:
                "3c51741dcea1fb0731d1f86588b12587707e7abea01e725ee16c9441b8b68db7",
            },
          ],
        },
      ],
      downloads: [],
      // Alphabetical, which is also chronological (14.05., 16.05. night, 16.–17.05.).
      logs: [
        "openstack/openstack_abnormal.log",
        "openstack/openstack_normal1.log",
        "openstack/openstack_normal2.log",
      ],
      labels: "openstack/anomaly_labels.txt",
      templates: null,
      expectedLines: 207_820,
      expectedLinesSource: "challenge brief",
    },
    samples: sample(
      "OpenStack",
      {
        bytes: 595_119,
        sha256:
          "025a1bc64ff5b2ef4a4bda6c4ad5c5c5f18478b71cd1ad2b0676e01625629f2f",
      },
      {
        bytes: 719_703,
        sha256:
          "ecc88e7909777181824260e9bdacd1469bd24d55131d6fc14e9c8c17edc49ff0",
      }
    ),
  },
  hdfs: {
    id: "hdfs",
    storage: "log_events",
    patterns: true,
    title: "HDFS_v1",
    origin:
      "Hadoop Distributed File System in a private cloud under benchmark workloads, November 2008; blocks labelled by handcrafted rules.",
    citation: [
      LOGHUB_PAPER,
      "Wei Xu, Ling Huang, Armando Fox, David Patterson, Michael Jordan: Detecting Large-Scale System Problems by Mining Console Logs. SOSP 2009.",
    ],
    eventIdBase: 100_000_000,
    timeBasis:
      "yymmdd HHMMSS in the line, whole seconds; no zone in the log, assumed UTC",
    errorDefinition: "levels ERROR, FATAL (log4j); WARN is a warning",
    fields: {
      ...COMMON_FIELDS,
      level: "Severity as logged (log4j): INFO, WARN.",
      component:
        "Java class that logged the line, e.g. dfs.DataNode$PacketResponder.",
      is_error: "Error level after R-02 (ERROR, FATAL); none occur in HDFS_v1.",
      block_id:
        "HDFS block ID (blk_…) the line names; null for a line naming several different blocks (none in the full file).",
      is_anomalous:
        "Dataset label of the line's block (Normal/Anomaly in anomaly_label.csv); marks blocks, not lines.",
    },
    breadth: { unit: "blocks", column: "block_id", extra: null },
    contextScopes: ["same_block"],
    defaultsToSpecificScope: true,
    labels: {
      marks: "block",
      source:
        "blocks labelled Normal or Anomaly, preprocessed/anomaly_label.csv (dataset label)",
    },
    apiAccesses: false,
    probeTerm: "block",
    corpus: {
      archives: [
        {
          path: "HDFS_v1.zip",
          url: `${ZENODO}/HDFS_v1.zip?download=1`,
          format: "zip",
          bytes: 186_645_559,
          sha256:
            "04f919f2185821f23f045dca611a7586429bdabc601bd7b43f30005f8e289b01",
          extractTo: "hdfs",
          entries: [
            {
              path: "HDFS.log",
              bytes: 1_577_982_906,
              sha256:
                "0783096174d7832c618337f9609e06e04abd86ddd7089b3c12b407e63bfebc52",
            },
            {
              path: "preprocessed/anomaly_label.csv",
              bytes: 18_637_554,
              sha256:
                "1c711ed6c8848fc3243fb4d092f172f31d128c8a6ec7f26ebba72ab931885ed8",
            },
          ],
        },
      ],
      downloads: [],
      logs: ["hdfs/HDFS.log"],
      labels: "hdfs/preprocessed/anomaly_label.csv",
      templates: null,
      expectedLines: 11_175_629,
      expectedLinesSource: "Loghub README (#Lines)",
    },
    samples: sample(
      "HDFS",
      {
        bytes: 287_848,
        sha256:
          "7c967000980c086ed55fa6544ba4f05fe66d44622795e890c68caf8bbb635035",
      },
      {
        bytes: 414_635,
        sha256:
          "729df59774e3dde934044028546d2a55d5e3d4370b9d12fcebbe4c087b2bf7b4",
      }
    ),
  },
  openssh: {
    id: "openssh",
    storage: "log_events",
    patterns: true,
    title: "OpenSSH",
    origin:
      "One OpenSSH server (host LabSZ) in the Loghub lab, 10 Dec to 7 Jan, 28+ days.",
    citation: [LOGHUB_PAPER],
    eventIdBase: 200_000_000,
    timeBasis:
      "Mon dd HH:MM:SS without year or zone; year 2017 from December, 2018 after the single month wrap (archive entry dated 2018-01-07); assumed UTC",
    errorDefinition:
      "messages prefixed error: or fatal: (OpenSSH levels ERROR and FATAL); the log has no level field",
    fields: {
      ...COMMON_FIELDS,
      component: "Program of the syslog line (sshd).",
      is_error: "Message prefixed error: or fatal: (R-02).",
      host: "Syslog host name (LabSZ).",
      process_id:
        "sshd process ID; one process per connection, IDs repeat over time.",
      client_ip:
        "IPv4 address of the remote side in fixed message forms ([ip], from, by, rhost=, Address); null when the line names none or only a host name.",
    },
    breadth: { unit: "client_ips", column: "client_ip", extra: null },
    contextScopes: ["same_process", "same_client"],
    defaultsToSpecificScope: true,
    labels: null,
    apiAccesses: false,
    probeTerm: "password",
    corpus: {
      archives: [
        {
          path: "SSH.tar.gz",
          url: `${ZENODO}/SSH.tar.gz?download=1`,
          format: "tar.gz",
          bytes: 4_596_666,
          sha256:
            "296610a35773f58b7c295e5407fc5ccdf48beb3c544fc14a6309addf904a2712",
          extractTo: "openssh",
          entries: [
            {
              path: "SSH.log",
              bytes: 73_417_506,
              sha256:
                "89eee9e36c182722f9fadc6e5617a4818ffc66109e7e222b8f9e8b78fc3aa2f3",
            },
          ],
        },
      ],
      downloads: [],
      logs: ["openssh/SSH.log"],
      labels: null,
      templates: null,
      expectedLines: 655_147,
      expectedLinesSource:
        "Loghub README (#Lines 655,146 counts newlines; the last line has none)",
    },
    samples: sample(
      "OpenSSH",
      {
        bytes: 225_216,
        sha256:
          "1e4912727fa88245113d41b16a0cd25ceadba7f931e1c406542885b91254264f",
      },
      {
        bytes: 357_677,
        sha256:
          "c0996a11545f4b94b435993760afa441a9e373f7bfc9e787afdb8e62f65acb4f",
      }
    ),
  },
  apache: {
    id: "apache",
    storage: "log_events",
    patterns: true,
    title: "Apache",
    origin:
      "Error log of an Apache HTTP server on Linux (Public Security Log Sharing Site), June 2005 to February 2006.",
    citation: [LOGHUB_PAPER],
    eventIdBase: 300_000_000,
    timeBasis:
      "[Www Mon dd HH:MM:SS yyyy] in the line, whole seconds; no zone in the log, assumed UTC",
    errorDefinition: "levels error, crit, alert, emerg (as logged, lower case)",
    fields: {
      ...COMMON_FIELDS,
      level: "Severity as logged, lower case: error, notice, warn.",
      component:
        "httpd: the whole file is the httpd error log; lines name no module.",
      is_error: "Level error or higher after R-02.",
      client_ip: "Client address of the [client …] block; null without one.",
    },
    breadth: { unit: "client_ips", column: "client_ip", extra: null },
    contextScopes: ["same_client"],
    defaultsToSpecificScope: true,
    labels: null,
    apiAccesses: false,
    probeTerm: "directory",
    corpus: {
      archives: [
        {
          path: "Apache.tar.gz",
          url: `${ZENODO}/Apache.tar.gz?download=1`,
          format: "tar.gz",
          bytes: 262_905,
          sha256:
            "f2cb5014453c8a0f71596838e1639a2131ff6d360839ad280409f621a6cac452",
          extractTo: "apache",
          entries: [
            {
              path: "Apache.log",
              bytes: 5_135_876,
              sha256:
                "23e616a1ed529bab9b20b9bc345d37035061eee971d246102bcc4937e51a039b",
            },
          ],
        },
      ],
      downloads: [],
      logs: ["apache/Apache.log"],
      labels: null,
      templates: null,
      expectedLines: 56_482,
      expectedLinesSource:
        "Loghub README (#Lines 56,481 counts newlines; the last line has none)",
    },
    samples: sample(
      "Apache",
      {
        bytes: 171_239,
        sha256:
          "c7efa3eb686e3a96bd2f8f4457b2a7887e9cf2f3649327f1b4e87af841363ce8",
      },
      {
        bytes: 258_805,
        sha256:
          "54331d12eedf513f2127f4d89f0284c8b15fddfa5471103abf9db2c73d737778",
      }
    ),
  },
  linux: {
    id: "linux",
    storage: "log_events",
    patterns: true,
    title: "Linux",
    origin:
      "/var/log/messages of one Linux server (host combo, Public Security Log Sharing Site), 260+ days.",
    citation: [LOGHUB_PAPER],
    eventIdBase: 400_000_000,
    timeBasis:
      "Mon dd HH:MM:SS without year or zone; June–December 2005, January–February 2006 after the single month wrap (full dates in ftpd lines); assumed UTC",
    errorDefinition: null,
    fields: {
      ...COMMON_FIELDS,
      component:
        "Program of the syslog line as logged, e.g. kernel, sshd(pam_unix), ftpd; null for lines without one.",
      host: "Syslog host name (combo).",
      process_id: "Process ID in brackets after the program; null without one.",
    },
    breadth: null,
    contextScopes: ["same_process"],
    defaultsToSpecificScope: false,
    labels: null,
    apiAccesses: false,
    probeTerm: "authentication",
    corpus: {
      archives: [
        {
          path: "Linux.tar.gz",
          url: `${ZENODO}/Linux.tar.gz?download=1`,
          format: "tar.gz",
          bytes: 232_039,
          sha256:
            "7e1f820d8d45ae086032e515d9ce8d079a102a9b37dcff5b41a8e60b1f857820",
          extractTo: "linux",
          entries: [
            {
              path: "Linux.log",
              bytes: 2_349_686,
              sha256:
                "b541078328bf5402c254e7e8971a95963c464858031889ff6e15b6d1a857d490",
            },
          ],
        },
      ],
      downloads: [],
      logs: ["linux/Linux.log"],
      labels: null,
      templates: null,
      expectedLines: 25_567,
      expectedLinesSource: "Loghub README (#Lines)",
    },
    samples: sample(
      "Linux",
      {
        bytes: 216_485,
        sha256:
          "b3e20bc1afe732ab1bf3ed1de4bf9c809e4194e02f7dea911d918e5342e8e173",
      },
      {
        bytes: 327_804,
        sha256:
          "7c86d7b0ecb961a25f00d9475a154df97613b9974f31ce142a146caa2017c71e",
      }
    ),
  },
  zookeeper: {
    id: "zookeeper",
    storage: "log_events",
    patterns: true,
    title: "ZooKeeper",
    origin:
      "ZooKeeper service of 32 machines in the CUHK lab, aggregated, 26+ days in 2015.",
    citation: [LOGHUB_PAPER],
    eventIdBase: 500_000_000,
    timeBasis:
      "yyyy-mm-dd HH:MM:SS,mmm in the line, milliseconds; no zone in the log, assumed UTC",
    errorDefinition: "levels ERROR, FATAL (log4j); WARN is a warning",
    fields: {
      ...COMMON_FIELDS,
      level: "Severity as logged (log4j): INFO, WARN, ERROR.",
      component: "Java class that logged the line, e.g. QuorumCnxManager.",
      is_error: "Error level after R-02 (ERROR, FATAL).",
      thread:
        "Thread name as logged, e.g. QuorumPeer[myid=1]/0:0:0:0:0:0:0:0:2181 or SendWorker:188978561024.",
    },
    breadth: null,
    contextScopes: ["same_thread"],
    defaultsToSpecificScope: false,
    labels: null,
    apiAccesses: false,
    probeTerm: "connection",
    corpus: {
      archives: [
        {
          path: "Zookeeper.tar.gz",
          url: `${ZENODO}/Zookeeper.tar.gz?download=1`,
          format: "tar.gz",
          bytes: 459_911,
          sha256:
            "ea350b0d3ff22bca4764ae4a1521bd1b79c448db4ee99aac02fd82b9a0995f19",
          extractTo: "zookeeper",
          entries: [
            {
              path: "Zookeeper.log",
              bytes: 10_426_438,
              sha256:
                "5c793ff30e960e387845fa81e595977a9037bc4801ef67f6c3298622d5d4572a",
            },
          ],
        },
      ],
      downloads: [],
      logs: ["zookeeper/Zookeeper.log"],
      labels: null,
      templates: null,
      expectedLines: 74_380,
      expectedLinesSource: "Loghub README (#Lines)",
    },
    samples: sample(
      "Zookeeper",
      {
        bytes: 279_891,
        sha256:
          "e40e0af5ef9eb6e4097200f260b9d1f626b3676f861a432e87977242e75543d8",
      },
      {
        bytes: 372_360,
        sha256:
          "e4a450c67595828103cfab049d971f54eee778fdded061222ba6581bed2a210a",
      }
    ),
  },
  otel: {
    id: "otel",
    storage: "remote_parquet",
    title: "OpenTelemetry logs (text_bench)",
    origin:
      "OpenTelemetry demo logs (TextBench) of one UTC day, 2025-09-23, exported as Parquet (ClickHouse otel_logs schema): 50 files of 1,000,000,000 rows each in the public bucket public-pme/text_bench (eu-west-3), read in place over HTTPS, never downloaded.",
    citation: [
      "Public bucket public-pme/text_bench listed in the challenge brief (https://public-pme.s3.eu-west-3.amazonaws.com/text_bench/part_000.parquet … part_049.parquet); licence not stated.",
    ],
    eventIdBase: 1_000_000_000_000,
    timeBasis:
      "Timestamp (OTel time_unix_nano, Parquet TIMESTAMP isAdjustedToUTC, nanoseconds); outputs truncate to microseconds, order and ties keep the nanoseconds and then event_id; filters compare the nanosecond column exactly",
    errorDefinition:
      "SeverityText error or fatal as logged (lower case; the error texts observed in the data); SeverityNumber is not used",
    fields: {
      ts: "Event time (Timestamp), UTC; nanoseconds in the files, truncated to microseconds in outputs.",
      message: "Body as logged (OTel log body), untrusted text.",
      level:
        "SeverityText as logged: info, information, error, trace, warn, fatal; info and information stay distinct.",
      component:
        "ServiceName (OTel resource service.name); a record without a service has the empty string as logged.",
      source_type: "ScopeName (OTel instrumentation scope) as logged.",
      is_error: "SeverityText error or fatal (R-02).",
      trace_id:
        "TraceId as logged (hex); the empty string when the record carries no trace. No traces are loaded: the ID only groups log records.",
      span_id: "SpanId as logged (hex); the empty string when absent.",
      severity_number:
        "SeverityNumber as logged (OTel 1–24, 0 = unspecified, frequent here); never used to derive the level.",
    },
    breadth: null,
    contextScopes: ["same_trace"],
    defaultsToSpecificScope: false,
    labels: null,
    apiAccesses: false,
    patterns: false,
    probeTerm: "called",
    remote: {
      licence:
        "Public bucket listed in the challenge brief; licence not stated. Synthetic OpenTelemetry demo data, but bodies and attributes contain email- and card-number-like strings: treat all values as sensitive-looking untrusted text.",
      pinKind:
        "Per file at load: Content-Length, ETag and Last-Modified from an HTTP HEAD (Node), footer facts (rows, row groups, Timestamp min/max) from parquet_file_metadata/parquet_metadata (SQL). Not a checksum: the 41 GB files are never downloaded. Tools re-check size and Last-Modified (read_blob) before every query; SereneDB exposes no ETag, so the ETag is compared only at load.",
      files: Array.from({ length: 50 }, (_, index) => {
        const name = `part_${String(index).padStart(3, "0")}.parquet`
        return {
          index,
          url: `${TEXT_BENCH_HTTPS}/${name}`,
          s3: `${TEXT_BENCH_S3}/${name}`,
        }
      }),
      notAllowlisted:
        "part_050.parquet (94,407,674 rows, 23:57:23.98–23:59:59.99 UTC) exists in the bucket but is not in the brief's file list, so it is not allowlisted; the span therefore ends at part_049's last row.",
      sourceColumns: {
        ts: "Timestamp",
        level: "SeverityText",
        component: "ServiceName",
        source_type: "ScopeName",
        message: "Body",
        trace_id: "TraceId",
        span_id: "SpanId",
        severity_number: "SeverityNumber",
      },
      errorLevels: ["error", "fatal"],
      eventIdFileStride: 10_000_000_000,
      reference: {
        files: [0, 1],
        glob: `${TEXT_BENCH_S3}/part_00[0-1].parquet`,
        from: "2025-09-23T00:29:14.000000Z",
        to: "2025-09-23T00:29:34.000000Z",
      },
      samples: {
        description:
          "Two committed Parquet fixtures with the real text_bench schema (MAP columns included): the rows of part_000 in [00:29:24.037, 00:29:24.0390372] and of part_001 in [00:29:24.0390372, 00:29:24.041) UTC, in file order, without records whose body or attributes contain email-, card- or long-number-like strings. Both keep the boundary row duplicated at 00:29:24.0390372. Row numbers are those of the fixtures, not of the bucket.",
        files: [
          {
            index: 0,
            fixture: "fixtures/otel/part_000.parquet",
            path: "otel/part_000.parquet",
            bytes: 72_106,
            sha256:
              "0fed8bd04a669835682be5b5d75adb1c851c698e082bd7ba52ba03a71e6b0957",
          },
          {
            index: 1,
            fixture: "fixtures/otel/part_001.parquet",
            path: "otel/part_001.parquet",
            bytes: 63_427,
            sha256:
              "f55de8fb051809dde2398f34c94ce57d531791c2ce7bf819e1b312a98c7546b1",
          },
        ],
        glob: "otel/part_00[0-1].parquet",
        from: "2025-09-23T00:29:24.037000Z",
        to: "2025-09-23T00:29:24.041000Z",
      },
    },
  },
}

/** Datasets in catalog order. */
export function datasetSpecs(
  datasets: readonly Dataset[] = DATASET_IDS
): DatasetSpec[] {
  return DATASET_IDS.filter((id) => datasets.includes(id)).map(
    (id) => DATASETS[id]
  )
}

/** Datasets whose rows carry a value with this column's meaning. */
export function datasetsWithColumn(column: SpecificColumn): Dataset[] {
  return DATASET_IDS.filter((id) => DATASETS[id].fields[column] !== undefined)
}

/** Datasets with an error definition (R-02); is_error is unknown elsewhere. */
export function datasetsWithErrors(): Dataset[] {
  return DATASET_IDS.filter((id) => DATASETS[id].errorDefinition !== null)
}

/**
 * The external dataset that owns an event_id, from the catalog ID ranges
 * (eventIdBase up to the next 10^12); null for log_events IDs.
 */
export function externalDatasetOfEventId(
  eventId: number
): ExternalDataset | null {
  return (
    EXTERNAL_DATASETS.find((id) => {
      const base = DATASETS[id].eventIdBase
      return eventId >= base && eventId < base + EXTERNAL_ID_RANGE
    }) ?? null
  )
}

/** Width of an external dataset's event_id range. */
export const EXTERNAL_ID_RANGE = 1_000_000_000_000

/** One-line description of every dataset for tool and parameter descriptions. */
export function datasetList(): string {
  return DATASET_IDS.map((id) => `${id} (${DATASETS[id].title})`).join(", ")
}
