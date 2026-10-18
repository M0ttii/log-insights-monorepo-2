import { describe, expect, it } from "vitest"
import { loadQuestions } from "./contracts.ts"
import {
  experimentPlan,
  experimentProjection,
  validateCommonCase,
} from "./experiment.ts"

describe("LOG-53 predeclared development experiment", () => {
  it("keeps the role comparison separate from balanced high/medium controls", async () => {
    const bank = await loadQuestions()
    const plan = experimentPlan(bank)
    const roles = plan.filter((a) => a.experiment === "roles")
    const effort = plan.filter((a) => a.experiment === "effort")
    expect(roles).toHaveLength((bank.questions.length + 6) * 2)
    expect(effort).toHaveLength(12)
    for (const level of ["high", "medium"])
      for (const variant of ["baseline", "playbook"])
        expect(
          effort.filter((a) => a.effort === level && a.variant === variant)
        ).toHaveLength(3)
    expect(new Set(plan.map((a) => a.id)).size).toBe(plan.length)
    expect(plan.every((a, i) => a.order === i)).toBe(true)
    expect(experimentProjection(plan, bank).maximum_model_calls).toBe(
      plan.length * 16
    )
    expect(
      experimentProjection(plan, bank).planned_judge_calls
    ).toBeGreaterThan(plan.length)
  })
  it("requires the common S-13 scope and question to be identical across roles", async () => {
    const bank = await loadQuestions()
    expect(() => validateCommonCase(bank)).not.toThrow()
    const broken = structuredClone(bank)
    const member = broken.questions.find((q) => q.common_case !== undefined)
    if (member === undefined) throw new Error("Missing common-case question")
    member.scope = { dataset: "openstack" }
    expect(() => validateCommonCase(broken)).toThrow(/common case/i)
  })
})
