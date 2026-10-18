import "server-only"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { z } from "zod"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { loadPlaybooks } from "@workspace/agent/playbooks"

const questionSchema = z.object({
  id: z.string(),
  role: z.enum(["engineer", "team_lead", "manager"]).nullable(),
  demo: z.boolean().optional(),
  question: z.string(),
  scope: z.record(z.string(), z.unknown()).optional(),
})
const questionsSchema = z.object({ questions: z.array(questionSchema) })
export function loadBrief() {
  const playbooks = loadPlaybooks()
  const { questions } = questionsSchema.parse(
    parse(
      readFileSync(
        join(findWorkspaceRoot(), "packages/evals/questions/dev.yaml"),
        "utf8"
      )
    )
  )
  return {
    version: playbooks.version,
    roles: Object.entries(playbooks.roles).map(([id, role]) => ({
      id,
      title: role.title,
      description: role.description,
      summary: role.summary,
    })),
    examples: questions.filter((question) => question.demo === true),
  }
}
export type Brief = ReturnType<typeof loadBrief>
