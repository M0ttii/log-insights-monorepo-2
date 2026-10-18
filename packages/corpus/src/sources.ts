/**
 * The inputs `pnpm data:setup` can load (technical.md § 7, § 7.1), built
 * from the dataset catalog (`@workspace/domain/datasets`), the one place
 * that pins every raw file by size and SHA-256:
 *
 * - `corpus`: the full Loghub files from Zenodo record 8196385, BGL and
 *   OpenStack by default, the extensions with `--with`. Loaded into
 *   SERENEDB_DATABASE.
 * - `samples`: the Loghub 2k samples, used by CI and the integration tests,
 *   in their own database so a sample run never replaces the full corpus;
 *   with extensions in a second one, so the base sample tests stay as they
 *   are.
 *
 * The archive digests match the MD5 checksums Zenodo publishes for the
 * record (checked 17./18.10.2026); a different file means different data, so
 * a mismatch stops the setup instead of silently changing the data version.
 *
 * Remote datasets (`--with otel`, LOG-35) are not part of log_events: the
 * corpus reads the allowlisted HTTPS files in place (pinned by HEAD at
 * load), the samples read the committed Parquet fixtures copied below
 * .data/raw, so CI stays hermetic. A samples load with a remote dataset goes
 * into its own database. The OTLP replay (`--with otel_replay`) posts a
 * committed fixture to SereneDB's own listener (serened.conf); with
 * --samples into the same database as the otel fixtures.
 */
import {
  BASE_DATASETS,
  DATASETS,
  datasetSpecs,
  LOGHUB_COMMIT,
  type Archive,
  type Dataset,
  type DirectFile,
  type ExternalDataset,
  type ParquetFixture,
  type PinnedFile,
  type ReplayFixture,
  type TableDataset,
} from "@workspace/domain/datasets"

import { CONTAINER_RAW_DIR } from "./config.ts"

export type { Archive, Dataset, DirectFile, PinnedFile }

/** One remote Parquet file as the server reads it. */
type ExternalFile = {
  file_index: number
  /** HTTPS URL (corpus) or container path of the fixture copy (samples). */
  location: string
  /** The location as the reference-window glob reports it (filename column). */
  globName: string
  /** Samples only: the committed fixture and its pin. */
  fixture: ParquetFixture | null
}

/** A remote Parquet dataset of a source (LOG-35). */
export type ExternalLoad = {
  dataset: "otel"
  /** remote: HTTPS files pinned by HEAD; fixture: committed local copies. */
  kind: "remote" | "fixture"
  files: readonly ExternalFile[]
  reference: {
    glob: string
    files: readonly number[]
    from: string
    to: string
  }
}

/** One dataset of a source: its log files, labels and expected line count. */
export type DatasetLoad = {
  dataset: TableDataset
  /** Log files in their fixed load order (event_id follows it). */
  logs: readonly string[]
  /** Dataset label file, or null if the source has no labels. */
  labels: string | null
  /** Physical lines the load report compares against (A-02). */
  expectedLines: number
  expectedLinesSource: string
}

export type Source = {
  id: string
  description: string
  /** Target database; null means SERENEDB_DATABASE. */
  database: string | null
  archives: readonly Archive[]
  downloads: readonly DirectFile[]
  /** Loaded datasets in catalog order; always BGL and OpenStack first. */
  datasets: readonly DatasetLoad[]
  /** Remote datasets read in place (LOG-35); not in log_events. */
  external: readonly ExternalLoad[]
  /** The OTLP replay (LOG-35, design D7); null without `--with otel_replay`. */
  replay: ReplayLoad | null
}

/**
 * The OTLP replay of a source: the committed fixture and the listener that
 * receives it (serened.conf), which writes into `database`. The loader posts
 * to 127.0.0.1 on the host port named by `portEnv`.
 */
export type ReplayLoad = {
  dataset: "otel_replay"
  fixture: ReplayFixture
  database: string
  portEnv: string
  schema: string
  table: string
}

export const SAMPLES_DATABASE = "log_insights_samples"
/** 2k samples of the base corpus and the extensions (U26). */
export const SAMPLES_EXTENDED_DATABASE = "log_insights_samples_ext"
/** 2k samples plus the otel Parquet fixtures (LOG-35). */
const SAMPLES_REMOTE_DATABASE = "log_insights_samples_otel"

/**
 * The corpus or the samples with the base datasets plus `extensions`. The
 * base corpus is always part of a load (concept 5.5).
 */
export function buildSource(
  kind: "corpus" | "samples",
  extensions: readonly TableDataset[] = [],
  external: readonly ExternalDataset[] = []
): Source {
  const specs = datasetSpecs([...BASE_DATASETS, ...extensions]).flatMap(
    (spec) => (spec.storage === "log_events" ? [spec] : [])
  )
  const extended = specs.length > BASE_DATASETS.length
  const sourceOf = (dataset: TableDataset) =>
    kind === "corpus" ? DATASETS[dataset].corpus : DATASETS[dataset].samples
  const titles = specs.map((spec) => spec.title).join(", ")
  const remote = external.includes("otel") ? [externalLoad(kind, "otel")] : []
  const replay = external.includes("otel_replay") ? replayLoad(kind) : null
  const remoteText =
    remote
      .map(({ dataset }) =>
        kind === "corpus"
          ? ` + ${DATASETS[dataset].title} read in place over HTTPS`
          : ` + ${DATASETS[dataset].title} Parquet fixtures`
      )
      .join("") +
    (replay === null
      ? ""
      : ` + ${DATASETS.otel_replay.title} via the OTLP listener`)
  return {
    id: kind,
    description:
      kind === "corpus"
        ? `Loghub ${titles} (Zenodo record 8196385)${remoteText}`
        : `Loghub 2k samples of ${titles} (logpai/loghub@${LOGHUB_COMMIT.slice(0, 7)})${remoteText}`,
    database:
      kind === "corpus"
        ? null
        : remote.length > 0 || replay !== null
          ? SAMPLES_REMOTE_DATABASE
          : extended
            ? SAMPLES_EXTENDED_DATABASE
            : SAMPLES_DATABASE,
    archives: specs.flatMap((spec) => sourceOf(spec.id).archives),
    downloads: specs.flatMap((spec) => sourceOf(spec.id).downloads),
    external: remote,
    replay,
    datasets: specs.map((spec) => {
      const source = sourceOf(spec.id)
      return {
        dataset: spec.id,
        logs: source.logs,
        labels: source.labels,
        expectedLines: source.expectedLines,
        expectedLinesSource: source.expectedLinesSource,
      }
    }),
  }
}

const container = (path: string) => joinPosix(CONTAINER_RAW_DIR, path)

/**
 * The replay of a source: corpus loads replay into the listener of database
 * postgres, samples into log_insights_samples_otel (serened.conf).
 */
function replayLoad(kind: "corpus" | "samples"): ReplayLoad {
  const { fixture, listener } = DATASETS.otel_replay.replay
  const target = kind === "corpus" ? listener.corpus : listener.samples
  if (kind === "samples" && target.database !== SAMPLES_REMOTE_DATABASE)
    throw new Error("the samples OTLP listener must write the otel samples database")
  return {
    dataset: "otel_replay",
    fixture,
    database: target.database,
    portEnv: target.portEnv,
    schema: listener.schema,
    table: listener.table,
  }
}

/** The files and reference window of a remote dataset in a source. */
function externalLoad(
  kind: "corpus" | "samples",
  dataset: "otel"
): ExternalLoad {
  const { remote } = DATASETS[dataset]
  if (kind === "corpus")
    return {
      dataset,
      kind: "remote",
      files: remote.files.map((file) => ({
        file_index: file.index,
        location: file.url,
        globName: file.s3,
        fixture: null,
      })),
      reference: {
        glob: remote.reference.glob,
        files: remote.reference.files,
        from: remote.reference.from,
        to: remote.reference.to,
      },
    }
  return {
    dataset,
    kind: "fixture",
    files: remote.samples.files.map((fixture) => ({
      file_index: fixture.index,
      location: container(fixture.path),
      globName: container(fixture.path),
      fixture,
    })),
    reference: {
      glob: container(remote.samples.glob),
      files: remote.samples.files.map((fixture) => fixture.index),
      from: remote.samples.from,
      to: remote.samples.to,
    },
  }
}

export const CORPUS: Source = buildSource("corpus")
export const SAMPLES: Source = buildSource("samples")

/** The load entry of a dataset in a source; throws if it is not part of it. */
export function datasetLoad(source: Source, dataset: Dataset): DatasetLoad {
  const load = source.datasets.find((entry) => entry.dataset === dataset)
  if (load === undefined)
    throw new Error(`${source.id} does not contain dataset ${dataset}`)
  return load
}

/** Every file of a source that ends up below .data/raw, in a fixed order. */
export function pinnedFiles(
  source: Source
): Array<PinnedFile & { kind: "archive" | "extracted" | "download" }> {
  return [
    ...source.archives.flatMap((archive) => [
      { kind: "archive" as const, ...pick(archive) },
      ...archive.entries.map((entry) => ({
        kind: "extracted" as const,
        ...pick(entry),
        path: joinPosix(archive.extractTo, entry.path),
      })),
    ]),
    ...source.downloads.map((file) => ({
      kind: "download" as const,
      ...pick(file),
    })),
  ]
}

function pick({ path, bytes, sha256 }: PinnedFile): PinnedFile {
  return { path, bytes, sha256 }
}

export function joinPosix(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`
}
