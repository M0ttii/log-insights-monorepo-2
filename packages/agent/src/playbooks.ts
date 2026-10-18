import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Filter } from "@workspace/domain/filters"
import {
  roleGuidanceSchema,
  TOOL_NAME_PATTERN,
  type RoleGuidance,
} from "@workspace/domain/tool"
import { z } from "zod"

const inputKeySchema = z.string().regex(/^[a-z][a-z0-9_]*$/)

/** A string constrains the value; true requires a present input key. */
export const coverageAlternativeSchema = z.strictObject({
  tool: z.string().regex(TOOL_NAME_PATTERN),
  input: z
    .record(inputKeySchema, z.union([z.string().min(1), z.literal(true)]))
    .optional(),
})
export type CoverageAlternative = z.infer<typeof coverageAlternativeSchema>

export const coverageRequirementSchema = z.strictObject({
  label: z.string().min(1),
  anyOf: z.array(coverageAlternativeSchema).min(1),
  fallback: coverageAlternativeSchema.optional(),
})
export type CoverageRequirement = z.infer<typeof coverageRequirementSchema>

export const roleCoverageSchema = z.array(coverageRequirementSchema).min(1)
export type RoleCoverage = z.infer<typeof roleCoverageSchema>

type Role = keyof RoleGuidance["roles"]
type PromptArguments = Pick<Filter, "dataset" | "from" | "to"> & {
  question?: string
}

function read(name: string): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "playbooks", `${name}.md`),
    "utf8"
  ).trim()
}

/** Sections are editorial boundaries, not a second copy of the guidance. */
function section(text: string, heading: string): string {
  const marker = `\n## ${heading}\n`
  const start = text.indexOf(marker)
  if (start === -1) throw new Error(`Missing playbook section: ${heading}`)
  const body = text
    .slice(start + marker.length)
    .split("\n## ")[0]
    ?.trim()
  if (!body) throw new Error(`Empty playbook section: ${heading}`)
  return body
}

function coverageAlternative(text: string): CoverageAlternative {
  const match = text.match(
    /^([a-z][a-z0-9_]{0,63})(?: ([a-z][a-z0-9_]*)=([^\s|=]+)| with ([a-z][a-z0-9_]*))?$/
  )
  if (match === null) throw new Error(`Invalid playbook coverage: ${text}`)
  const [, tool, key, value, presentKey] = match
  const input =
    presentKey !== undefined
      ? { [presentKey]: true }
      : key !== undefined
        ? { [key]: value }
        : undefined
  return coverageAlternativeSchema.parse({
    tool,
    ...(input === undefined ? {} : { input }),
  })
}

/** Parses only the Coverage section body; prose and malformed lines fail closed. */
export function parseCoverage(text: string): RoleCoverage {
  const requirements = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      if (!line.startsWith("- "))
        throw new Error(`Invalid playbook coverage line: ${line}`)
      const [label, fallback, ...extra] = line.slice(2).split("; otherwise: ")
      if (label === undefined || extra.length > 0)
        throw new Error(`Invalid playbook coverage fallback: ${line}`)
      const choices = label.startsWith("one of: ")
        ? label.slice("one of: ".length).split("|")
        : [label]
      if (label.startsWith("one of: ") && choices.length < 2)
        throw new Error(
          `Coverage alternatives need at least two choices: ${line}`
        )
      return {
        label,
        anyOf: choices.map((choice) => coverageAlternative(choice.trim())),
        ...(fallback === undefined
          ? {}
          : { fallback: coverageAlternative(fallback.trim()) }),
      }
    })
  return roleCoverageSchema.parse(requirements)
}

function readRole(name: string) {
  const text = read(name)
  const title = text.split("\n")[0]?.replace(/^# /, "")
  if (!title) throw new Error(`Missing playbook title: ${name}`)
  return {
    text,
    title,
    description: section(text, "Goal"),
    summary: section(text, "Summary"),
    coverage: parseCoverage(section(text, "Coverage")),
  }
}

/** No provider or transport imports; all outputs share the same versioned files.
 * Loading is explicit so importing the package does not perform filesystem I/O.
 * Common rules, routing and role texts remain separate for the U16 eval runner.
 */
export function loadPlaybooks() {
  const common = read("common")
  const version = section(common, "Version")
  const routing = section(common, "Routing")
  const sharedRules = [
    "Evidence and precedence",
    "Domain rules",
    "Answer frame",
    "Request data",
  ]
    .map((heading) => `## ${heading}\n\n${section(common, heading)}`)
    .join("\n\n")
  const roles = {
    engineer: readRole("engineer"),
    team_lead: readRole("team-lead"),
    manager: readRole("manager"),
  }
  const guidance = roleGuidanceSchema.parse({
    version,
    routing,
    roles: {
      engineer: roles.engineer.summary,
      team_lead: roles.team_lead.summary,
      manager: roles.manager.summary,
    },
  })
  const instructions = [
    common,
    ...Object.values(roles).map((role) => role.summary),
  ].join("\n\n")
  const systemPrompt = (role: Role) => [common, roles[role].text].join("\n\n")
  const prompt = (role: Role) => ({
    title: roles[role].title,
    description: roles[role].description,
    render: (args: PromptArguments) =>
      [
        systemPrompt(role),
        section(common, "Request data"),
        JSON.stringify(args),
      ].join("\n\n"),
  })
  return {
    version,
    common,
    sharedRules,
    roles,
    coverage: {
      engineer: roles.engineer.coverage,
      team_lead: roles.team_lead.coverage,
      manager: roles.manager.coverage,
    },
    guidance,
    instructions,
    systemPrompt,
    prompts: {
      engineer_investigation: prompt("engineer"),
      team_lead_review: prompt("team_lead"),
      manager_priorities: prompt("manager"),
    },
  }
}
