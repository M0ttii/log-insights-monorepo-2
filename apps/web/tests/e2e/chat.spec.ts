import { AxeBuilder } from "@axe-core/playwright"
import { readFile } from "node:fs/promises"
import { expect, test, type Page } from "@playwright/test"
import type { UIMessageChunk } from "ai"
import type { ToolResult } from "@workspace/domain/tool"

// Synthetic wire recording. No request in this suite reaches a model provider.
const receipt = {
  receipt_id: "r_deadbeef",
  input: { dataset: "bgl" },
  signature: "a".repeat(64),
  data_version: "test-only",
  sql: [],
  params: [],
  scope: { windows: [], filters: {} },
  population: null,
  rows_returned: 1,
  truncated: false,
  duration_ms: 12,
  result_digest: "b".repeat(64),
}
const evidence: ToolResult<unknown> = {
  data: { note: "Synthetic browser-test recording" },
  facts: [
    {
      id: "r_deadbeef.f1",
      path: "/result/events",
      value: 7,
      metric: "events",
      unit: "log_events",
      group: {},
    },
  ],
  receipt,
  notes: [],
}
function checkResult(id: string, verified: boolean): ToolResult<unknown> {
  return {
    ...evidence,
    receipt: { ...receipt, receipt_id: id },
    facts: ["checked", "verified", "mismatch", "unresolved"].map(
      (field, index) => ({
        id: `${id}.f${index + 1}`,
        path: `/result/summary/${field}`,
        value:
          field === "checked" ||
          (field === "verified" && verified) ||
          (field === "mismatch" && !verified)
            ? 1
            : 0,
        metric: `claims_${field}`,
        unit: "claims",
        group: {},
      })
    ),
    data: {
      claims: [
        {
          claim: {
            fact: "r_deadbeef.f1",
            value: verified ? 7 : 9,
            metric: "events",
            group: {},
          },
          status: verified ? "verified" : "mismatch",
          mismatch_on: verified ? [] : ["value"],
          reason: verified ? null : "Synthetic mismatch",
          fact: null,
          receipt: null,
        },
      ],
      summary: {
        checked: 1,
        verified: verified ? 1 : 0,
        mismatch: verified ? 0 : 1,
        unresolved: 0,
        text: `1 claims checked · ${verified ? 0 : 1} mismatch · 0 unresolved`,
      },
    },
  }
}
function tool(
  id: string,
  name: string,
  result: ToolResult<unknown>
): UIMessageChunk[] {
  return [
    {
      type: "tool-input-available",
      toolCallId: id,
      toolName: name,
      input: {},
      dynamic: true,
    },
    {
      type: "tool-output-available",
      toolCallId: id,
      output: { ok: true, result },
    },
  ]
}
const finalAnswer =
  "## Scope\nBGL.\n## Answer\n7 events [r_deadbeef.f1].\n## Evidence\nSee the receipt.\n## Timeline\nUnknown.\n## Narrowing\nUnknown.\n## Hypotheses\nOpen.\n## Next check\nInspect the message.\n## Unknown\nCause unknown.\n## Verification\nSee the checks."
const run = {
  run_id: "run_deadbeef",
  status: "completed",
  duration_ms: 30,
  usage: { input: 12, output: 15, cache_read: null, cache_write: null },
}
const recording: UIMessageChunk[] = [
  { type: "start", messageId: "recorded-revision" },
  { type: "data-phase", data: { kind: "preflight", draft: "draft" } },
  ...tool("corpus", "describe_corpus", evidence),
  { type: "data-phase", data: { kind: "investigate", draft: "draft" } },
  ...tool("draft-check", "check_claims", checkResult("r_aaaaaaaa", false)),
  {
    type: "data-phase",
    data: {
      kind: "investigate",
      draft: "draft",
      requirement: "event_trend; 1 claim(s) mismatch their cited fact",
    },
  },
  { type: "data-phase", data: { kind: "answer", draft: "draft" } },
  { type: "text-start", id: "draft" },
  {
    type: "text-delta",
    id: "draft",
    delta: "## Answer\n9 events [r_deadbeef.f1]. Another 44 without evidence.",
  },
  { type: "text-end", id: "draft" },
  {
    type: "data-gate",
    data: {
      version: "draft",
      findings: [
        {
          kind: "mismatch",
          fact: "r_deadbeef.f1",
          mismatch_on: ["value"],
          check_receipt_id: "r_aaaaaaaa",
          excerpt: "9 events",
        },
        {
          kind: "uncited",
          value: "44",
          start: 0,
          end: 2,
          excerpt: "Another 44",
        },
      ],
    },
  },
  { type: "data-phase", data: { kind: "revise", draft: "final" } },
  ...tool("final-check", "check_claims", checkResult("r_bbbbbbbb", true)),
  { type: "text-start", id: "final" },
  { type: "text-delta", id: "final", delta: finalAnswer },
  { type: "text-end", id: "final" },
  { type: "data-gate", data: { version: "final", findings: [] } },
  { type: "data-run", data: run },
  { type: "finish", finishReason: "stop" },
]
async function mockChat(page: Page, chunks: UIMessageChunk[]) {
  const requests: object[] = []
  await page.route("**/api/chat", async (route) => {
    requests.push(route.request().postDataJSON())
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
        "cache-control": "no-cache",
      },
      body:
        chunks
          .map(
            (chunk) =>
              `data: ${JSON.stringify(chunk.type === "start" ? { ...chunk, messageId: `${chunk.messageId}-${requests.length}` } : chunk)}\n\n`
          )
          .join("") + "data: [DONE]\n\n",
    })
  })
  return requests
}

test("recorded SDK revision, fact chips, independent checks and accessible composer", async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const requests = await mockChat(page, recording)
  await page.route("**/api/receipts/r_deadbeef", (route) =>
    route.fulfill({
      json: {
        ...receipt,
        created_at: "2026-10-18T00:00:00Z",
        client: "test",
        tool: "count_events",
        tool_version: "test-only",
        row_limit: null,
        result: evidence.data,
        facts: evidence.facts,
      },
    })
  )
  await page.route("**/api/runs/run_deadbeef", (route) =>
    route.fulfill({
      json: {
        ...run,
        model_id: "recorded-test-model",
        guidance_version: "test-only",
        contract_version: "test-only",
        data_version: "test-only",
        started_at: "2026-10-18T00:00:00Z",
        instruction_texts: ["private metadata must not export"],
      },
    })
  )
  await page.goto("/investigations/new")
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill("Investigate the synthetic recording")
  await page.getByRole("button", { name: "Send question" }).click()
  await expect(page.getByRole("button", { name: "Export run" })).toBeVisible()
  await expect(
    page.getByText(
      "Required evidence requested: event_trend; 1 claim(s) mismatch their cited fact"
    )
  ).toBeVisible()
  const outline = page.getByLabel("Answer outline")
  const answerJump = outline.getByRole("link", { name: "Answer", exact: true })
  const jumpTarget = await answerJump.getAttribute("href")
  expect(jumpTarget).toMatch(/^#.+/)
  await answerJump.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("heading", { name: "Answer", exact: true })
  ).toBeFocused()
  expect(
    await page
      .getByRole("heading", { name: "Answer", exact: true })
      .getAttribute("id")
  ).toBe(jumpTarget?.slice(1))
  const verifiedChip = page.getByRole("link", {
    name: "Fact r_deadbeef.f1, verified, open evidence",
  })
  await expect(verifiedChip).toBeVisible()
  await verifiedChip.focus()
  const preview = page.getByRole("tooltip")
  await expect(preview.getByText("Value", { exact: true })).toBeVisible()
  await expect(preview.getByText("7", { exact: true })).toBeVisible()
  await expect(preview.getByText("events", { exact: true })).toBeVisible()
  await expect(preview.getByText("log_events", { exact: true })).toBeVisible()
  await expect(preview.getByText("Ungrouped", { exact: true })).toBeVisible()
  await expect(preview.getByText("No corpus time window.")).toBeVisible()
  await page.getByRole("button", { name: "Export run" }).focus()
  await expect(preview).toHaveCount(0)
  await expect(
    page.getByText(/Markings: 0 unchecked fact IDs · 0 uncited numbers/)
  ).toBeVisible()
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export run" }).click()
  const saved = await download
  const exportPath = testInfo.outputPath("recorded-run.json")
  await saved.saveAs(exportPath)
  const exported = await readFile(exportPath, "utf8")
  expect(exported).toContain("Investigate the synthetic recording")
  expect(exported).toContain("recorded-test-model")
  expect(exported).not.toContain("instruction_texts")
  expect(exported).not.toContain("private metadata must not export")
  await expect(
    page.getByText("1 claims checked · 1 mismatch · 0 unresolved")
  ).toHaveCount(2)
  await expect(
    page.getByText("1 claims checked · 0 mismatch · 0 unresolved")
  ).toHaveCount(2)
  await expect(
    page.getByRole("button", {
      name: "Uncited number 44: No fact ID next to this number",
    })
  ).toHaveCount(0)
  await page.getByRole("button", { name: /Draft · 2 findings/ }).click()
  await expect(
    page.getByRole("button", {
      name: "Uncited number 44: No fact ID next to this number",
    })
  ).toBeVisible()
  const mismatchChip = page.getByRole("link", {
    name: "Fact r_deadbeef.f1, mismatch, open evidence",
  })
  await expect(mismatchChip).toBeVisible()
  await mismatchChip.hover()
  await expect(
    page.getByRole("tooltip").getByText("Mismatch on: value")
  ).toBeVisible()
  await expect(
    page.getByRole("tooltip").getByText("7", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: /Draft · 2 findings/ }).click()
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill("Follow up on this recording")
  await page.getByRole("button", { name: "Send question" }).click()
  await expect.poll(() => requests.length).toBe(2)
  // Follow-ups carry trusted run references, not prior tool results or reasoning.
  expect(JSON.stringify(requests[1])).toContain("run_deadbeef")
  expect(JSON.stringify(requests[1])).not.toContain(
    "Synthetic browser-test recording"
  )
  await expect(page.getByRole("button", { name: "Export run" })).toHaveCount(2)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(
    accessibility.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical"
    )
  ).toEqual([])
  expect(errors).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath("chat-recorded-revision.png"),
    fullPage: true,
  })
})

test("recorded refusal preserves the question and has no verification mark", async ({
  page,
}) => {
  await mockChat(page, [
    { type: "start", messageId: "recorded-refusal" },
    { type: "data-run", data: { ...run, status: "refusal" } },
    { type: "finish", finishReason: "stop" },
  ])
  await page.goto("/investigations/new")
  await page
    .getByRole("textbox", { name: "Your question" })
    .fill("Keep this declined question")
  await page.getByRole("button", { name: "Send question" }).click()
  await expect(page.getByText(/The model declined this request/)).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Your question" })
  ).toHaveValue("Keep this declined question")
  await expect(
    page.getByRole("region", { name: "Claim verification" })
  ).toHaveCount(0)
})
