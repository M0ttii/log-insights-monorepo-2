import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { canonicalJson } from "@workspace/domain/receipt"
import { EVAL_VERSION } from "./contracts.ts"
import { recomputeReport, saveReport } from "./report.ts"
import { semanticAssessmentSchema } from "./evaluate.ts"
import { runFixtureRound, runLiveRound } from "./runner.ts"

export async function main(argv: string[]): Promise<void> {
  const [command, path, ...rest] = argv
  if (
    path === undefined ||
    !["run", "fixture", "report", "assess"].includes(command ?? "")
  )
    throw new Error(
      "Usage: eval fixture <new-directory> | run <new-directory> --data-version <current-version> | report <directory> [reviewer-version] | assess <directory> <new-reviewer-version> <assessments.json>"
    )
  const dir = resolve(findWorkspaceRoot(), path)
  if (command === "fixture") {
    if (rest.length !== 0) throw new Error("Unexpected fixture arguments")
    await runFixtureRound(dir)
  } else if (command === "run") {
    if (
      rest.length !== 2 ||
      rest[0] !== "--data-version" ||
      rest[1] === undefined
    )
      throw new Error("run requires --data-version <current-version>")
    const controller = new AbortController(),
      onSignal = () => controller.abort()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    try {
      await runLiveRound(dir, rest[1], controller.signal)
    } finally {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    }
  } else if (command === "assess") {
    const [version, file] = rest
    if (version === undefined || file === undefined || rest.length !== 2)
      throw new Error(
        "assess requires new reviewer version and assessment file"
      )
    const assessments = z
      .array(semanticAssessmentSchema)
      .parse(
        JSON.parse(await readFile(resolve(findWorkspaceRoot(), file), "utf8"))
      )
    process.stdout.write(
      `${JSON.stringify(await saveReport(dir, version, assessments), null, 2)}\n`
    )
  } else {
    if (rest.length > 1) throw new Error("Unexpected report arguments")
    const version = rest[0] ?? EVAL_VERSION
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(version))
      throw new Error("Invalid reviewer version")
    const assessments = z
      .array(semanticAssessmentSchema)
      .parse(
        JSON.parse(
          await readFile(resolve(dir, "assessments", `${version}.json`), "utf8")
        )
      )
    const report = await recomputeReport(dir, version, assessments)
    const original = JSON.parse(
      await readFile(resolve(dir, "reports", `${version}.json`), "utf8")
    )
    if (canonicalJson(report) !== canonicalJson(original))
      throw new Error("Report changed; save a new reviewer version with assess")
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
}
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href)
  void main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Evaluation failed: verify command, configuration and saved artifact integrity.\n"
    )
    process.exitCode = 1
  })
