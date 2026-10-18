import {
  EXTENSION_DATASETS,
  type ExtensionDataset,
} from "@workspace/domain/datasets"

export const USAGE = `usage: pnpm data:setup [--samples] [--with <${EXTENSION_DATASETS.join("|")}>[,…] | --with all]`

/** Parses the arguments; a string is an error message. */
export function parseArgs(
  args: readonly string[]
): { samples: boolean; extensions: ExtensionDataset[] } | string {
  let samples = false
  const extensions = new Set<ExtensionDataset>()
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
      if (name === "all") EXTENSION_DATASETS.forEach((d) => extensions.add(d))
      else {
        const known = EXTENSION_DATASETS.find((d) => d === name)
        if (known === undefined)
          return `Unknown dataset ${JSON.stringify(name)} for --with; ${USAGE}`
        extensions.add(known)
      }
    }
  }
  return { samples, extensions: [...extensions] }
}
