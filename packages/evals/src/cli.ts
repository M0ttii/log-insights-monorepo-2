import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { canonicalJson } from "@workspace/domain/receipt"
import { EVAL_VERSION } from "./contracts.ts"
import { recomputeReport, saveReport, readHoldoutStatus } from "./report.ts"
import { semanticAssessmentSchema } from "./evaluate.ts"
import {
  prepareReview,
  recomputeDevelopmentReport,
  saveDevelopmentReport,
} from "./development.ts"
import {
  executeRound,
  prepareRound,
  runFixtureRound,
  runLiveRound,
} from "./runner.ts"
import { registerHoldout, freezeHoldout, releaseHoldout } from "./holdout.ts"
import { prepareHoldoutRound, executeHoldoutRound } from "./holdout-executor.ts"

export async function main(argv: string[]): Promise<void> {
  const [command, path, ...rest] = argv
  if (
    path === undefined ||
    ![
      "plan",
      "execute",
      "run",
      "fixture",
      "report",
      "assess",
      "prepare-review",
      "review",
      "development-report",
      "holdout-register",
      "holdout-freeze",
      "holdout-release",
      "holdout-plan",
      "holdout-execute",
      "holdout-report",
      "holdout-status",
    ].includes(command ?? "")
  )
    throw new Error(
      "Usage: eval plan <new-directory> --data-version <version> | execute <prepared-directory> | fixture <new-directory> | run <new-directory> --data-version <version> | report <directory> [reviewer-version] | assess <directory> <new-reviewer-version> <assessments.json> | prepare-review <directory> <version> | review <directory> <version> <review-input.json> | development-report <directory> <version> | holdout-register <new-preparation-directory> <metadata.json> | holdout-freeze <new-freeze-directory> <preparation-directory> <development-directory> <reviewer-version> | holdout-release <preparation-directory> <freeze-directory> <private-vault-directory> | holdout-plan <new-directory> <preparation-directory> <freeze-directory> | holdout-execute <prepared-directory> | holdout-report <directory> <reviewer-version> | holdout-status <directory>"
    )
  const dir = resolve(findWorkspaceRoot(), path)
  if (command === "holdout-status") {
    if (rest.length !== 0)
      throw new Error("Unexpected holdout-status arguments")
    process.stdout.write(
      `${JSON.stringify(await readHoldoutStatus(dir), null, 2)}\n`
    )
    return
  }
  if (command === "holdout-plan") {
    const [preparation, freeze] = rest
    if (preparation === undefined || freeze === undefined || rest.length !== 2)
      throw new Error(
        "holdout-plan requires preparation and freeze directories"
      )
    const result = await prepareHoldoutRound(
      resolve(findWorkspaceRoot(), preparation),
      resolve(findWorkspaceRoot(), freeze),
      dir
    )
    process.stdout.write(
      `${JSON.stringify({ round_id: result.round_id, split: result.split, attempts: result.attempts.length, holdout: result.holdout }, null, 2)}\n`
    )
    return
  }
  if (command === "holdout-execute") {
    if (rest.length !== 0)
      throw new Error("Unexpected holdout-execute arguments")
    const controller = new AbortController(),
      onSignal = () => controller.abort()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    try {
      await executeHoldoutRound(dir, controller.signal)
    } finally {
      process.off("SIGINT", onSignal)
      process.off("SIGTERM", onSignal)
    }
    return
  }
  if (command === "holdout-register") {
    const [metadata] = rest
    if (metadata === undefined || rest.length !== 1)
      throw new Error("holdout-register requires one public metadata file")
    const result = await registerHoldout(
      resolve(findWorkspaceRoot(), metadata),
      dir
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (command === "holdout-freeze") {
    const [preparation, development, reviewer] = rest
    if (
      preparation === undefined ||
      development === undefined ||
      reviewer === undefined ||
      rest.length !== 3
    )
      throw new Error(
        "holdout-freeze requires preparation, development round and reviewer version"
      )
    const result = await freezeHoldout(
      resolve(findWorkspaceRoot(), preparation),
      resolve(findWorkspaceRoot(), development),
      reviewer,
      dir
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (command === "holdout-release") {
    const [freeze, vault] = rest
    if (freeze === undefined || vault === undefined || rest.length !== 2)
      throw new Error(
        "holdout-release requires freeze and private vault directories"
      )
    const result = await releaseHoldout(
      dir,
      resolve(findWorkspaceRoot(), freeze),
      resolve(findWorkspaceRoot(), vault),
      resolve(findWorkspaceRoot(), "packages/evals/questions")
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  if (
    [
      "prepare-review",
      "review",
      "development-report",
      "holdout-report",
    ].includes(command ?? "")
  ) {
    const [version, file] = rest
    if (version === undefined)
      throw new Error("A new reviewer version is required")
    if (command === "prepare-review") {
      if (rest.length !== 1)
        throw new Error("Unexpected review preparation arguments")
      const prepared = await prepareReview(dir, version)
      process.stdout.write(
        `${JSON.stringify({ version, packets: prepared.assignments.length, pairs: prepared.pairs.length, unavailable: prepared.unavailable, private_mapping: `private-review/${version}.json` }, null, 2)}\n`
      )
    } else if (command === "review") {
      if (file === undefined || rest.length !== 2)
        throw new Error("review requires version and review-input JSON")
      const input: unknown = JSON.parse(
        await readFile(resolve(findWorkspaceRoot(), file), "utf8")
      )
      process.stdout.write(
        `${JSON.stringify(await saveDevelopmentReport(dir, version, input), null, 2)}\n`
      )
    } else {
      if (
        rest.length !== 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(version)
      )
        throw new Error("Invalid development-report arguments")
      const input = JSON.parse(
        await readFile(resolve(dir, "review-input", `${version}.json`), "utf8")
      )
      const report = await recomputeDevelopmentReport(dir, version, input)
      if ((command === "holdout-report") !== (report.split === "holdout_first"))
        throw new Error(
          "Use the report command for the saved development or first-holdout split"
        )
      const original = JSON.parse(
        await readFile(
          resolve(
            dir,
            report.split === "holdout_first"
              ? "holdout-reports"
              : "development-reports",
            `${version}.json`
          ),
          "utf8"
        )
      )
      if (canonicalJson(report) !== canonicalJson(original))
        throw new Error(
          "Development report changed; prepare a new reviewer version"
        )
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } else if (command === "fixture") {
    if (rest.length !== 0) throw new Error("Unexpected fixture arguments")
    await runFixtureRound(dir)
  } else if (command === "run" || command === "plan" || command === "execute") {
    if (
      command !== "execute" &&
      (rest.length !== 2 ||
        rest[0] !== "--data-version" ||
        rest[1] === undefined)
    )
      throw new Error("run requires --data-version <current-version>")
    if (command === "plan") {
      const version = rest[1]
      if (version === undefined) throw new Error("Missing data version")
      const manifest = await prepareRound(dir, version)
      process.stdout.write(
        `${JSON.stringify({ round_id: manifest.round_id, attempts: manifest.attempts.length, experiment: manifest.experiment, pricing: manifest.pricing }, null, 2)}\n`
      )
      return
    }
    if (command === "execute" && rest.length !== 0)
      throw new Error("Unexpected execute arguments")
    const controller = new AbortController(),
      onSignal = () => controller.abort()
    process.once("SIGINT", onSignal)
    process.once("SIGTERM", onSignal)
    try {
      if (command === "execute") await executeRound(dir, controller.signal)
      else {
        const version = rest[1]
        if (version === undefined) throw new Error("Missing data version")
        await runLiveRound(dir, version, controller.signal)
      }
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
