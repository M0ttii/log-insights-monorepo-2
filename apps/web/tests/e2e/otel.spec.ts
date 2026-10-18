import { AxeBuilder } from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { z } from "zod"
import { toolResultSchema } from "@workspace/domain/tool"
import { searchLogsOutputSchema } from "@workspace/domain/tools/search-logs"
import { countEventsOutputSchema } from "@workspace/domain/tools/count-events"
import { describeCorpusOutputSchema } from "@workspace/analytics/registry"

const resultSchema = toolResultSchema(z.unknown())

test("OTel selection, search, context and source receipts use the real registry", async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const catalog = await page.request.post("/api/tools/describe_corpus", {
    data: {},
  })
  await page.goto("/logs")
  const dataset = page.getByLabel("Dataset", { exact: true })
  const otel = dataset.locator('option[value="otel"]')
  if (!catalog.ok()) {
    // The quality CI job has no database. Verify its honest unavailable state;
    // the loader CI job exercises the OTel registry/MCP against real fixtures.
    await expect(otel).toHaveCount(0)
    await page.goto("/investigations/new")
    await page.getByRole("button", { name: /^Choose dataset/ }).click()
    await expect(page.getByText(/Loaded datasets unavailable/)).toBeVisible()
    return
  }
  const corpus = describeCorpusOutputSchema.parse(
    resultSchema.parse((await catalog.json()).result).data
  )
  if (!corpus.datasets.some((entry) => entry.dataset === "otel")) {
    await expect(otel).toHaveCount(0)
    await expect(dataset).toContainText("excludes OTel")
    return
  }
  await expect(otel).toHaveCount(1)
  await dataset.selectOption("otel")
  await page
    .getByRole("textbox", { name: "Search message text" })
    .fill("called")
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page).toHaveURL(/dataset=otel/)
  await expect(
    page.getByRole("region", { name: "Search results" })
  ).toContainText("matching log events")
  await expect(dataset).toHaveValue("otel")
  await page
    .getByRole("button", { name: /^Open context for event/ })
    .first()
    .click()
  await expect(
    page.getByRole("heading", { name: "Event context" })
  ).toBeVisible()
  await expect(page.getByRole("dialog")).toContainText(
    "context covers only the indexed reference window"
  )
  await page.getByRole("button", { name: "Back to results" }).click()

  for (const id of ["otel", "otel_replay"]) {
    const hitsResponse = await page.request.post("/api/tools/search_logs", {
      data: { dataset: id, query: "called" },
    })
    expect(hitsResponse.ok()).toBe(true)
    const hits = resultSchema.parse((await hitsResponse.json()).result)
    const countsResponse = await page.request.post("/api/tools/count_events", {
      data: { dataset: id, text: "called", group_by: ["component"] },
    })
    expect(countsResponse.ok()).toBe(true)
    const counts = resultSchema.parse((await countsResponse.json()).result)
    expect(countEventsOutputSchema.parse(counts.data).total).toBe(
      searchLogsOutputSchema.parse(hits.data).total_matches
    )
    await page
      .getByRole("textbox", { name: "Open receipt", exact: true })
      .fill(counts.receipt.receipt_id)
    await page
      .getByRole("textbox", { name: "Open receipt", exact: true })
      .press("Enter")
    await page.getByRole("tab", { name: "Source", exact: true }).click()
    await expect(
      page.getByRole("tabpanel", { name: "Source", exact: true })
    ).toContainText(id === "otel" ? "remote_parquet" : "otlp_replay")
    await page.screenshot({
      path: testInfo.outputPath(`${id}-source.png`),
      fullPage: true,
    })
    await page.keyboard.press("Escape")
  }
  const accessibility = await new AxeBuilder({ page }).analyze()
  expect(
    accessibility.violations.filter(
      (item) => item.impact === "serious" || item.impact === "critical"
    )
  ).toEqual([])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
})
