import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Unit tests live beside the code in every workspace and run in Node.
    projects: [
      {
        test: {
          name: "packages",
          environment: "node",
          include: ["packages/*/src/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
})
