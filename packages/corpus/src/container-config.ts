import { parseArgs } from "./args.ts"
import { LOCAL_IMAGES, type ImageIdentity } from "./image.ts"
import { buildSource, type Source } from "./sources.ts"

// Registry index -> linux/amd64 manifest -> config digest, inspected with
// `docker buildx imagetools inspect --raw` (2026-10-18). Compose uses this
// exact immutable reference, so the loader needs no host Docker socket.
const OFFICIAL_IMAGE: ImageIdentity = {
  reference:
    "serenedb/serenedb:26.10.1@sha256:6d41ac6577e797289158786a2015ba8fbd6875feadb5c491518e166c011058c9",
  imageId:
    "sha256:01b7f879a34e77409b3cbfb5d25ab08c72646d2a07c69fc498a3bbe29682f6e0",
}

/** Only identities whose config digest is known without inspecting the host. */
export function immutableImage(reference: string): ImageIdentity {
  if (reference === OFFICIAL_IMAGE.reference) return { ...OFFICIAL_IMAGE }
  if (LOCAL_IMAGES.some((image) => image.imageId === reference)) {
    return { reference, imageId: reference }
  }
  throw new Error(
    "Set LOG_INSIGHTS_CONTAINER_IMAGE to a verified immutable SereneDB " +
      "reference (compose.jury.yaml). On ARM64 use the restored image's " +
      "full sha256 image ID, never its mutable local tag."
  )
}

/** The jury supports the pinned Loghub corpus and its separate 2k samples. */
export function containerSource(
  env: Record<string, string | undefined>
): Source {
  const mode = env["LOG_INSIGHTS_DATA_MODE"] || "corpus"
  if (mode !== "corpus" && mode !== "samples") {
    throw new Error("LOG_INSIGHTS_DATA_MODE must be corpus or samples")
  }
  const datasets = env["LOG_INSIGHTS_DATASETS"]
  const args = parseArgs([
    ...(mode === "samples" ? ["--samples"] : []),
    ...(datasets ? ["--with", datasets] : []),
  ])
  if (typeof args === "string") throw new Error(args)
  if (args.external.length > 0) {
    throw new Error(
      "LOG_INSIGHTS_DATASETS supports Loghub extensions only; " +
        "use the local developer setup for remote OTel and OTLP replay."
    )
  }
  const source = buildSource(mode, args.extensions)
  if (
    source.database !== null &&
    env["SERENEDB_DATABASE"] !== source.database
  ) {
    throw new Error(
      `Set SERENEDB_DATABASE=${source.database} so the web app reads the loaded samples`
    )
  }
  return source
}
