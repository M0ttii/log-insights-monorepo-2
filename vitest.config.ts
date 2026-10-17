import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "mcp-smoke",
          root: import.meta.dirname,
          environment: "node",
          include: ["apps/mcp/tests/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      // Unit tests live beside the code in every workspace and run in Node.
      {
        test: {
          name: "packages",
          environment: "node",
          include: [
            "packages/*/src/**/*.test.{ts,tsx}",
            "apps/mcp/src/**/*.test.ts",
          ],
        },
      },
      // Loader against a running SereneDB (Compose, .env): `pnpm test:integration`.
      // Not part of `pnpm test`, which runs without Docker.
      {
        test: {
          name: "corpus-integration",
          environment: "node",
          include: ["packages/corpus/tests/integration/**/*.test.ts"],
          testTimeout: 180_000,
          hookTimeout: 300_000,
        },
      },
      // Registry, pool and describe_corpus against the 2k samples loaded by
      // `pnpm data:setup --samples`; part of `pnpm test:integration`.
      {
        test: {
          name: "analytics-integration",
          environment: "node",
          include: ["packages/analytics/tests/integration/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
