import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import eslintConfigPrettier from "eslint-config-prettier"

import { oxlintOverlap, sharedIgnores, turboConfig } from "./base.js"
import { primitiveSystemRules } from "./next.js"

/**
 * React libraries (packages/ui). eslint-config-next brings the React, Hooks,
 * jsx-a11y and TypeScript rules the app uses; the page-specific Next rule is
 * off because a library has no pages directory.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const config = [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@next/next/no-html-link-for-pages": "off",
      "no-restricted-imports": ["error", primitiveSystemRules],
    },
  },
  turboConfig,
  eslintConfigPrettier,
  ...oxlintOverlap,
  sharedIgnores,
]
