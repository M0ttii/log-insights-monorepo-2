import { AxeBuilder } from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { z } from "zod"
import { toolResultSchema } from "@workspace/domain/tool"
import { toolErrorSchema } from "@workspace/domain/errors"

// Composer tests never call a paid provider, even with a configured local key.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Test connection unavailable" }),
    })
  )
})

test("roles, drafts, theme, navigation and accessible layouts", async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/investigations/new")
  await expect(
    page.getByRole("heading", { name: "What do you need to know?" })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Choose perspective, Engineer" })
    .click()
  await page.getByRole("menuitemradio", { name: /Team Lead/ }).click()
  const example = page
    .getByRole("region", { name: "Example questions for Team Lead" })
    .getByRole("button")
    .first()
  await example.click()
  await expect(
    page.getByRole("textbox", { name: "Your question" })
  ).toHaveValue(/Workload Runtime/)
  await expect(
    page.getByRole("button", { name: "Send question" })
  ).toBeEnabled()
  await expect(
    page.getByRole("button", { name: /^Remove teams filter/ })
  ).toBeVisible()
  await expect(page.getByText(/Follow the receipts/)).toBeVisible()
  expect(
    await page
      .getByRole("textbox", { name: "Your question" })
      .evaluate(
        (element) =>
          element.getBoundingClientRect().bottom <= window.innerHeight
      )
  ).toBe(true)
  const ask = await new AxeBuilder({ page }).analyze()
  expect(
    ask.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical"
    )
  ).toEqual([])
  await page.screenshot({
    path: testInfo.outputPath("ask.png"),
    fullPage: true,
  })
  for (const [path, heading] of [
    ["/workspace", "Corpus overview"],
    ["/logs", "Explore the logs"],
    ["/datasets", "Know your corpus"],
  ]) {
    await page.goto(path ?? "/")
    await expect(page.getByRole("heading", { name: heading })).toBeVisible()
    const results = await new AxeBuilder({ page }).analyze()
    expect(
      results.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical"
      )
    ).toEqual([])
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath(`${path?.slice(1)}.png`),
      fullPage: true,
    })
  }
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Toggle Sidebar" }).first().click()
  await page.getByRole("button", { name: "Light theme", exact: true }).click()
  if (testInfo.project.name === "mobile") await page.keyboard.press("Escape")
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator("html")).not.toHaveClass(/dark/)
  await expect(
    page.getByRole("heading", { name: "Know your corpus" })
  ).toBeVisible()
  const light = await new AxeBuilder({ page }).analyze()
  expect(
    light.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical"
    )
  ).toEqual([])
  expect(errors).toEqual([])
})

test("composer retains the question across roles and validates the UTC scope", async ({
  page,
}) => {
  await page.goto("/investigations/new")
  const input = page.getByRole("textbox", { name: "Your question" })
  await input.fill("Keep my investigation question")
  await page
    .getByRole("button", { name: "Choose perspective, Engineer" })
    .click()
  await page.getByRole("menuitemradio", { name: /Manager/ }).click()
  await expect(input).toHaveValue("Keep my investigation question")
  await page.getByRole("button", { name: /^Choose dataset/ }).click()
  await expect(
    page.getByRole("menuitemradio", { name: "Agent chooses dataset" })
  ).toBeVisible()
  const loaded = await page
    .getByRole("menuitemradio", { name: "BGL", exact: true })
    .count()
  if (loaded)
    await page.getByRole("menuitemradio", { name: "BGL", exact: true }).click()
  else {
    await expect(page.getByText(/Loaded datasets unavailable/)).toBeVisible()
    await page.keyboard.press("Escape")
  }
  const windowButton = page.getByRole("button", { name: /^Set time window/ })
  await windowButton.click()
  await page.getByLabel("From · inclusive").fill("2005-07-01T00:00:00Z")
  await page.getByLabel("To · exclusive").fill("2005-06-01T00:00:00Z")
  await page.getByRole("button", { name: "Apply window" }).click()
  await expect(page.locator("#scope-error")).toContainText("later")
  await page.getByLabel("To · exclusive").fill("2005-08-01T00:00:00Z")
  await page.getByRole("button", { name: "Apply window" }).click()
  await expect(page.getByText("Custom window", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: /^Choose dataset/ }).click()
  if (loaded) {
    await page
      .getByRole("menuitemradio", { name: "OpenStack", exact: true })
      .click()
    await expect(page.getByText("Full span", { exact: true })).toBeVisible()
  } else {
    await page
      .getByRole("menuitemradio", { name: "Agent chooses dataset" })
      .click()
  }
  await expect(input).toHaveValue("Keep my investigation question")
  await input.press("Enter")
  await expect(page.getByText("Response interrupted")).toBeVisible()
  await expect(input).toHaveValue("Keep my investigation question")
  await page.getByRole("button", { name: "New chat", exact: true }).click()
  await expect(input).toHaveValue("")
})

test("search keeps filter scope in the URL and exposes real evidence or a recoverable error", async ({
  page,
}, testInfo) => {
  await page.goto("/logs?dataset=bgl")
  await page
    .getByRole("textbox", { name: "Search message text" })
    .fill("parity")
  await page.getByRole("button", { name: "Filters", exact: true }).click()
  await page.getByLabel("Components · comma separated").fill("KERNEL")
  await page.getByRole("button", { name: "Filters", exact: true }).click()
  await page.getByRole("button", { name: "Search", exact: true }).click()
  await expect(page).toHaveURL(/components=KERNEL/)
  await expect(
    page.getByRole("textbox", { name: "Search message text" })
  ).toHaveValue("parity")
  await expect(
    page.getByRole("region", { name: "Search results" })
  ).toContainText(/matching log events|unavailable|could not|not loaded/i)
  await page.screenshot({
    path: testInfo.outputPath("search.png"),
    fullPage: true,
  })
})

test("receipt IDs are validated and unresolved receipts are explicit", async ({
  page,
}, testInfo) => {
  await page.goto("/logs")
  await page
    .getByRole("textbox", { name: "Open receipt", exact: true })
    .fill("not-a-receipt")
  await page
    .getByRole("textbox", { name: "Open receipt", exact: true })
    .press("Enter")
  await expect(
    page.getByText("Enter a receipt or fact ID", { exact: false })
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Open receipt", exact: true })
    .fill("r_00000000.f1")
  await page
    .getByRole("textbox", { name: "Open receipt", exact: true })
    .press("Enter")
  await expect(
    page.getByRole("dialog", { name: "Query receipt" })
  ).toBeVisible()
  await expect(page.getByRole("dialog")).toContainText("Receipt unavailable")
  await page.screenshot({
    path: testInfo.outputPath("receipt.png"),
    fullPage: true,
  })
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
})

test("tool routes reject foreign origins and oversized requests", async ({
  request,
}) => {
  const foreign = await request.post("/api/tools/search_logs", {
    headers: { origin: "https://example.com" },
    data: { query: "parity" },
  })
  expect(foreign.status()).toBe(403)
  const oversized = await request.post("/api/tools/search_logs", {
    data: { query: "x".repeat(17000) },
  })
  expect(oversized.status()).toBe(400)
  const optional = await request.post("/api/tools/create_index", { data: {} })
  expect(optional.status()).toBe(404)
})

test("real receipts expose SQL and link the re-run result", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/tools/describe_corpus", {
    data: {},
  })
  const body: unknown = await response.json()
  if (!response.ok()) {
    const unavailable = z.object({ error: toolErrorSchema }).parse(body)
    expect(unavailable.error.code).toBe("db_unavailable")
    return
  }
  const { result } = z
    .object({ result: toolResultSchema(z.unknown()) })
    .parse(body)
  await page.goto(`/logs?receipt=${result.receipt.receipt_id}`)
  const drawer = page.getByRole("dialog", { name: "Query receipt" })
  await expect(drawer.getByText("client web", { exact: true })).toBeVisible()
  await drawer.getByRole("tab", { name: "SQL", exact: true }).click()
  await expect(
    drawer.getByLabel("SQL · statement 1", { exact: true })
  ).toBeVisible()
  await drawer.getByRole("button", { name: "Re-run", exact: true }).click()
  await expect(drawer).toContainText("Same result")
  await expect(
    drawer.getByRole("link", { name: /Open receipt r_/ }).last()
  ).toBeVisible()
})
