/**
 * Identity of the SereneDB image a load ran against (technical.md § 5.1).
 *
 * Two different hashes identify an image and must not be confused:
 * - the registry manifest digest (`repo:tag@sha256:…`) names what a registry
 *   serves; for a multi-arch tag it is the digest of the index, not of one
 *   platform's image, and a local build that was never pushed has none;
 * - the image ID (`docker image inspect … .Id`, the container's `.Image`) is
 *   the SHA-256 of the image configuration on this Docker host. It is
 *   immutable for given content and exists for local builds too.
 *
 * A reference pinned by digest is accepted as before. A plain tag is mutable,
 * so it is accepted only if it is listed in LOCAL_IMAGES and the container
 * runs exactly the listed image ID; anything else stops the load before SQL.
 */

/** A locally built image that passed the gate (technical.md § 5.2). */
export type LocalImage = {
  reference: string
  imageId: string
  platform: string
  /** Version reported by `SELECT version()`, checked at load time. */
  serverVersion: string
  sourceTag: string
  sourceCommit: string
  /** How to get the exact image back without rebuilding. */
  restore: string
}

export const LOCAL_IMAGES: readonly LocalImage[] = [
  {
    // Unofficial, unpublished build: the official 26.10.1 release ships
    // linux/amd64 only. Built from the tag's source with the single CMake
    // override -DDUCKDB_OPTIMIZATION_PROFILE=NONE (upstream fix 85e6982b).
    reference: "local/serenedb:26.10.1-arm64",
    imageId:
      "sha256:fd1b13533ceff354ffb48901dd63aa36a4b1d3c2b055b872e572bf83f38a7fb0",
    platform: "linux/arm64",
    serverVersion: "PostgreSQL 18.3 (SereneDB 26.10.1)",
    sourceTag: "v26.10.1",
    sourceCommit: "3d12e1a8473b2f63b3a08f197f7adf4bbb3bdf47",
    restore: "docker image load --input <archive>/docker-image.tar.gz",
  },
]

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/
const PINNED = /@sha256:[0-9a-f]{64}$/

export type ImageIdentity = {
  /** The reference Compose started (SERENEDB_IMAGE), tag and digest if pinned. */
  reference: string
  /** Docker image ID (config digest) of the running container. */
  imageId: string
}

/** True if Docker may pull the reference: only an immutable digest pin. */
export function isDigestPinned(reference: string): boolean {
  return PINNED.test(reference)
}

/**
 * Validates the image of the running container. Throws with a corrective
 * hint if the reference is neither digest-pinned nor a listed local build
 * with the listed image ID.
 */
export function validateImage(identity: ImageIdentity): ImageIdentity {
  const { reference, imageId } = identity
  if (!IMAGE_ID.test(imageId)) {
    throw new Error(`SereneDB container reports no image ID (${imageId})`)
  }
  if (isDigestPinned(reference)) return identity
  const local = LOCAL_IMAGES.find((image) => image.reference === reference)
  if (local === undefined) {
    throw new Error(
      `SereneDB image ${reference} is neither pinned by digest nor a verified ` +
        `local build (packages/corpus/src/image.ts); set SERENEDB_IMAGE in .env`
    )
  }
  if (imageId !== local.imageId) {
    throw new Error(
      `SereneDB image ${reference} has image ID ${imageId}, expected ` +
        `${local.imageId}; restore the verified build (${local.restore}) ` +
        "instead of rebuilding or retagging"
    )
  }
  return identity
}

/** Server version a listed local build must report, or null for other images. */
export function expectedServerVersion(reference: string): string | null {
  return (
    LOCAL_IMAGES.find((image) => image.reference === reference)
      ?.serverVersion ?? null
  )
}
