/** One load before the web server starts; Compose owns the SereneDB lifecycle. */
import { containerSource, immutableImage } from "./container-config.ts"
import { runLoad } from "./load.ts"

async function main(): Promise<void> {
  const image = immutableImage(
    process.env["LOG_INSIGHTS_CONTAINER_IMAGE"] ?? ""
  )
  const source = containerSource(process.env)
  const result = await runLoad(source, console.log, image)
  console.log(
    `Corpus ready: ${result.dataVersion} in ${result.database}; ` +
      `${result.checks.length} load checks passed. Starting the web server.`
  )
  if (!process.env["ANTHROPIC_API_KEY"]?.trim()) {
    console.log(
      "ANTHROPIC_API_KEY is empty: Ask is disabled; data views and receipts are available."
    )
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Corpus load failed")
  process.exitCode = 1
})
