/**
 * The two inputs `pnpm data:setup` can load (technical.md § 7):
 *
 * - `corpus`: BGL and OpenStack from Zenodo record 8196385, the base corpus
 *   of the brief. Loaded into SERENEDB_DATABASE.
 * - `samples`: the Loghub 2k samples, used by CI and the integration tests.
 *   Loaded into their own database so a sample run never replaces the full
 *   corpus a developer has loaded.
 *
 * Every file is pinned by size and SHA-256. The archive digests match the MD5
 * checksums Zenodo publishes for the record (checked 17.10.2026); a different
 * file means different data, so a mismatch stops the setup instead of
 * silently changing the data version.
 */

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

export type Source = {
  id: string
  description: string
  /** Target database; null means SERENEDB_DATABASE. */
  database: string | null
  archives: readonly Archive[]
  downloads: readonly DirectFile[]
  bglLog: string
  /** OpenStack log files in their fixed load order (event_id follows it). */
  openstackLogs: readonly string[]
  /** Instance IDs with injected anomalies, or null if the source has no labels. */
  openstackLabels: string | null
  /** Line counts the load report compares against (A-02). */
  expectedLines: { bgl: number; openstack: number }
  expectedLinesSource: string
}

const ZENODO = "https://zenodo.org/records/8196385/files"

/** Loghub commit the 2k samples are pinned to (logpai/loghub, 17.10.2026). */
const LOGHUB_COMMIT = "dd61d0952749ee7963bde24220d1be5ede023033"
const LOGHUB = `https://raw.githubusercontent.com/logpai/loghub/${LOGHUB_COMMIT}`

export const SAMPLES_DATABASE = "log_insights_samples"

export const CORPUS: Source = {
  id: "corpus",
  description: "Loghub BGL and OpenStack (Zenodo record 8196385)",
  database: null,
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
  bglLog: "BGL.log",
  // Alphabetical, which is also chronological (14.05., 16.05. night, 16.–17.05.).
  openstackLogs: [
    "openstack/openstack_abnormal.log",
    "openstack/openstack_normal1.log",
    "openstack/openstack_normal2.log",
  ],
  openstackLabels: "openstack/anomaly_labels.txt",
  expectedLines: { bgl: 4_747_963, openstack: 207_820 },
  expectedLinesSource: "challenge brief",
}

export const SAMPLES: Source = {
  id: "samples",
  description: `Loghub 2k samples (logpai/loghub@${LOGHUB_COMMIT.slice(0, 7)})`,
  database: SAMPLES_DATABASE,
  archives: [],
  downloads: [
    {
      path: "loghub-2k/BGL_2k.log",
      url: `${LOGHUB}/BGL/BGL_2k.log`,
      bytes: 317_150,
      sha256:
        "2a819ea540909db682005c9cf948387a40729b5c2e9f19d430e29ce704825496",
    },
    {
      path: "loghub-2k/OpenStack_2k.log",
      url: `${LOGHUB}/OpenStack/OpenStack_2k.log`,
      bytes: 595_119,
      sha256:
        "025a1bc64ff5b2ef4a4bda6c4ad5c5c5f18478b71cd1ad2b0676e01625629f2f",
    },
    // Loghub's templates for the samples; not loaded, used by the pattern
    // comparison of U03 (technical.md § 7, "Musterprüfung").
    {
      path: "loghub-2k/BGL_2k.log_structured.csv",
      url: `${LOGHUB}/BGL/BGL_2k.log_structured.csv`,
      bytes: 425_129,
      sha256:
        "3fe74103c0b02a28514534e2a47257a3f770135ca61afd425bbd3b9d6a31fe26",
    },
    {
      path: "loghub-2k/OpenStack_2k.log_structured.csv",
      url: `${LOGHUB}/OpenStack/OpenStack_2k.log_structured.csv`,
      bytes: 719_703,
      sha256:
        "ecc88e7909777181824260e9bdacd1469bd24d55131d6fc14e9c8c17edc49ff0",
    },
  ],
  bglLog: "loghub-2k/BGL_2k.log",
  openstackLogs: ["loghub-2k/OpenStack_2k.log"],
  // The samples come without anomaly labels; is_anomalous stays NULL.
  openstackLabels: null,
  expectedLines: { bgl: 2_000, openstack: 2_000 },
  expectedLinesSource: "Loghub 2k samples",
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
