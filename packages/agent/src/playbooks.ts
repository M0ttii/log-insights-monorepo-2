import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { Filter } from "@workspace/domain/filters"
import { roleGuidanceSchema, type RoleGuidance } from "@workspace/domain/tool"

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

function readRole(name: string) {
  const text = read(name)
  const title = text.split("\n")[0]?.replace(/^# /, "")
  if (!title) throw new Error(`Missing playbook title: ${name}`)
  return {
    text,
    title,
    description: section(text, "Goal"),
    summary: section(text, "Summary"),
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
