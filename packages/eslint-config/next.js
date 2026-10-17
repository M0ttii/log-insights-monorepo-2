import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"
import eslintConfigPrettier from "eslint-config-prettier"

import { oxlintOverlap, sharedIgnores, turboConfig } from "./base.js"

// Base UI shadcn only, no chat runtime besides AI SDK useChat (AGENTS.md).
export const primitiveSystemRules = {
  paths: [
    {
      name: "radix-ui",
      message:
        "Use the Base UI shadcn primitives (@base-ui/react); Radix is not allowed.",
    },
  ],
  patterns: [
    {
      group: ["@radix-ui/*"],
      message:
        "Use the Base UI shadcn primitives (@base-ui/react); Radix is not allowed.",
    },
    {
      group: ["@assistant-ui/*"],
      message:
        "assistant-ui is excluded; use shadcn AI Elements patterns with useChat (ui-concept.md § 10).",
    },
  ],
}

// Web-app structure rules: partials stay private, adapted AI Elements live in
// their functional area.
const webStructurePatterns = [
  {
    group: ["@/components/*/partials/*", "@/components/*/partials/**"],
    message:
      "Partials are private to their area; import them relatively from within the area only.",
  },
  {
    group: ["@/components/ai-elements", "@/components/ai-elements/*"],
    message:
      "Adapted AI Elements patterns live in their functional area, not components/ai-elements.",
  },
]

/**
 * The Next.js app (apps/web).
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const nextJsConfig = [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: primitiveSystemRules.paths,
          patterns: [...primitiveSystemRules.patterns, ...webStructurePatterns],
        },
      ],
    },
  },
  turboConfig,
  eslintConfigPrettier,
  ...oxlintOverlap,
  sharedIgnores,
]
