import { fileURLToPath } from "node:url"

import { globalIgnores } from "eslint/config"
import eslintConfigPrettier from "eslint-config-prettier"
import oxlint from "eslint-plugin-oxlint"
import turboPlugin from "eslint-plugin-turbo"
import tseslint from "typescript-eslint"

// Oxlint runs first from the repository root; ESLint skips the rules it already
// enforces. The path is resolved from this file so every workspace shares it.
const oxlintConfigFile = fileURLToPath(
  new URL("../../.oxlintrc.json", import.meta.url)
)

/** @type {import("eslint").Linter.Config[]} */
export const oxlintOverlap = oxlint.buildFromOxlintConfigFile(oxlintConfigFile)

/** @type {import("eslint").Linter.Config} */
export const turboConfig = {
  plugins: { turbo: turboPlugin },
  // Env vars must be declared in turbo.json so task caching sees them.
  rules: { "turbo/no-undeclared-env-vars": "error" },
}

export const sharedIgnores = globalIgnores([
  "**/.next/**",
  "**/out/**",
  "**/build/**",
  "**/dist/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/playwright-report/**",
  "**/test-results/**",
  "**/next-env.d.ts",
])

/**
 * Node and TypeScript packages without React (domain, analytics, agent, mcp, …).
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const config = [
  ...tseslint.configs.recommended,
  turboConfig,
  eslintConfigPrettier,
  ...oxlintOverlap,
  sharedIgnores,
]
