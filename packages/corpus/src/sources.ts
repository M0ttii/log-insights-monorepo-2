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
 */
import {
  BASE_DATASETS,
  DATASETS,
  datasetSpecs,
  LOGHUB_COMMIT,
  type Archive,
  type Dataset,
  type DirectFile,
  type PinnedFile,
} from "@workspace/domain/datasets"

export type { Archive, Dataset, DirectFile, PinnedFile }

/** One dataset of a source: its log files, labels and expected line count. */
export type DatasetLoad = {
  dataset: Dataset
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
}

export const SAMPLES_DATABASE = "log_insights_samples"
/** 2k samples of the base corpus and the extensions (U26). */
export const SAMPLES_EXTENDED_DATABASE = "log_insights_samples_ext"

/**
 * The corpus or the samples with the base datasets plus `extensions`. The
 * base corpus is always part of a load (concept 5.5).
 */
export function buildSource(
  kind: "corpus" | "samples",
  extensions: readonly Dataset[] = []
): Source {
  const specs = datasetSpecs([...BASE_DATASETS, ...extensions])
  const extended = specs.length > BASE_DATASETS.length
  const sourceOf = (dataset: Dataset) =>
    kind === "corpus" ? DATASETS[dataset].corpus : DATASETS[dataset].samples
  const titles = specs.map((spec) => spec.title).join(", ")
  return {
    id: kind,
    description:
      kind === "corpus"
        ? `Loghub ${titles} (Zenodo record 8196385)`
        : `Loghub 2k samples of ${titles} (logpai/loghub@${LOGHUB_COMMIT.slice(0, 7)})`,
    database:
      kind === "corpus"
        ? null
        : extended
          ? SAMPLES_EXTENDED_DATABASE
          : SAMPLES_DATABASE,
    archives: specs.flatMap((spec) => sourceOf(spec.id).archives),
    downloads: specs.flatMap((spec) => sourceOf(spec.id).downloads),
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
