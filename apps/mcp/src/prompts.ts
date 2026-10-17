import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { datasetSchema } from "@workspace/domain/filters"
import { instantSchema } from "@workspace/domain/time"
import type { RoleGuidance } from "@workspace/domain/tool"
import { z } from "zod"

const promptArguments = z.object({
  question: z
    .string()
    .min(1)
    .max(4_000)
    .optional()
    .describe("Question to investigate."),
  dataset: datasetSchema.optional().describe("Dataset to investigate."),
  from: instantSchema
    .optional()
    .describe("Inclusive start, ISO-8601 with UTC or offset."),
  to: instantSchema
    .optional()
    .describe("Exclusive end, ISO-8601 with UTC or offset."),
})

export type PromptArguments = z.infer<typeof promptArguments>

const PROMPT_NAMES = [
  "engineer_investigation",
  "team_lead_review",
  "manager_priorities",
] as const

/** U15 supplies all prose from agent/playbooks; U06 ships no role text. */
export type PlaybookSource = {
  instructions: string
  guidance: RoleGuidance
  prompts: Record<
    (typeof PROMPT_NAMES)[number],
    {
      title: string
      description: string
      render(args: PromptArguments): string
    }
  >
}

export function registerPrompts(
  server: McpServer,
  source?: PlaybookSource
): void {
  if (source === undefined) return
  for (const name of PROMPT_NAMES) {
    const prompt = source.prompts[name]
    server.registerPrompt(
      name,
      {
        title: prompt.title,
        description: prompt.description,
        argsSchema: promptArguments.shape,
      },
      (args) => ({
        messages: [
          {
            role: "user",
            content: { type: "text", text: prompt.render(args) },
          },
        ],
      })
    )
  }
}
