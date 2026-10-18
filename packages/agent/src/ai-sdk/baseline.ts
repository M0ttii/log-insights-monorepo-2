import type { RoleGuidance } from "@workspace/domain/tool"

/**
 * Baseline instruction texts (technical.md § 13.2 "Fairer Baseline-Vergleich").
 *
 * The baseline variant is a FAIR comparison baseline, selectable only in the
 * eval runner: it shares the "gemeinsame Grundlage" (the same model, data
 * version, the eight tools with identical schemas, descriptions and limits, and
 * the shared safety, domain and number rules including `check_claims`) but gets
 * NO full playbooks, no required-evidence catalogue and no role answer
 * templates — only a simple instruction per role (or simple role detection for
 * `auto`). § 13.2 "Keine indirekte Playbook-Zufuhr" requires every role hint
 * delivered to the agent — system instructions, MCP prompts and
 * `describe_corpus.answer_guidance` — to carry, in the baseline, only the simple
 * role instruction. So the simple role texts live here in ONE place, the run
 * record stores them, and the baseline `describe_corpus` receives the guidance
 * built from the SAME strings (never the playbook summaries).
 *
 * The shared safety/domain/number rules are NOT a second copy here: they are
 * `loadPlaybooks().sharedRules` (common.md without Routing, technical.md § 10),
 * the SAME shared rules the playbook variant honours (§ 13.2), passed in via
 * `InvestigationPlaybooks.sharedRules`. AGENTS.md forbids a second copy of the
 * playbook texts, so this module no longer holds a hand-written `SHARED_RULES`.
 */

/** The simple per-role instruction (no playbook content). */
const ROLE_INSTRUCTIONS = {
  engineer:
    "Answer as an engineer investigating a specific failure: find the evidence, place it in time, narrow the cause and state the next check. Keep hypotheses separate from proven causes.",
  team_lead:
    "Answer as a team lead reviewing recurring problems: separate recurring from one-off issues, say what to investigate first and what to improve.",
  manager:
    "Answer as a manager setting priorities: rank by breadth and recurrence, explain the order, name the decision needed and the missing information. Do not invent business impact.",
  auto: "Decide from the question whether the user is an engineer, a team lead or a manager, and answer in that role's terms. Ask if it is unclear.",
} as const

export type BaselineRole = keyof typeof ROLE_INSTRUCTIONS

/** The simple role instruction for a requested role (no playbook content). */
export function baselineRoleInstruction(role: BaselineRole): string {
  return ROLE_INSTRUCTIONS[role]
}

/**
 * The role guidance injected into the baseline `describe_corpus` registry
 * (technical.md § 13.2): routing = the auto instruction, each role = its simple
 * instruction. This is the baseline's `answer_guidance`; it never contains the
 * playbook summaries, so the eval's "no indirect playbook feed" check passes.
 * `version` marks it as the baseline guidance in the receipt and run record.
 */
export function baselineRegistryGuidance(version: string): RoleGuidance {
  return {
    version: `baseline:${version}`,
    routing: ROLE_INSTRUCTIONS.auto,
    roles: {
      engineer: ROLE_INSTRUCTIONS.engineer,
      team_lead: ROLE_INSTRUCTIONS.team_lead,
      manager: ROLE_INSTRUCTIONS.manager,
    },
  }
}
