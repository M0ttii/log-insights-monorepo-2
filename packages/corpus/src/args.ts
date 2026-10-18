import {
  EXTENSION_DATASETS,
  EXTERNAL_DATASETS,
  type ExtensionDataset,
  type ExternalDataset,
} from "@workspace/domain/datasets"

export const USAGE = `usage: pnpm data:setup [--samples] [--with <${[...EXTENSION_DATASETS, ...EXTERNAL_DATASETS].join("|")}>[,…] | --with all]; all = every Loghub extension, without ${EXTERNAL_DATASETS.join(", ")}`

export type SetupArgs = {
  samples: boolean
  extensions: ExtensionDataset[]
  /** Remote datasets (LOG-35); never part of `all`. */
  external: ExternalDataset[]
}

/** Parses the arguments; a string is an error message. */
export function parseArgs(args: readonly string[]): SetupArgs | string {
  let samples = false
  const extensions = new Set<ExtensionDataset>()
  const external = new Set<ExternalDataset>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ""
    if (arg === "--samples") {
      samples = true
      continue
    }
    const value = arg.startsWith("--with=")
      ? arg.slice("--with=".length)
      : arg === "--with"
        ? args[++i]
        : undefined
    if (value === undefined) return `Unknown argument ${arg}; ${USAGE}`
    for (const name of value.split(",")) {
      if (name === "all") {
        EXTENSION_DATASETS.forEach((d) => extensions.add(d))
        continue
      }
      const known = EXTENSION_DATASETS.find((d) => d === name)
      const remote = EXTERNAL_DATASETS.find((d) => d === name)
      if (known !== undefined) extensions.add(known)
      else if (remote !== undefined) external.add(remote)
      else return `Unknown dataset ${JSON.stringify(name)} for --with; ${USAGE}`
    }
  }
  // Catalog order, independent of the argument order.
  return {
    samples,
    extensions: EXTENSION_DATASETS.filter((d) => extensions.has(d)),
    external: EXTERNAL_DATASETS.filter((d) => external.has(d)),
  }
}
