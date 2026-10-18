import { existsSync } from "node:fs"
import { resolve } from "node:path"
import type { NextConfig } from "next"

const envFile = resolve(process.cwd(), "../../.env")
if (existsSync(envFile)) process.loadEnvFile(envFile)

const config: NextConfig = {
  transpilePackages: [
    "@workspace/ui",
    "@workspace/domain",
    "@workspace/analytics",
    "@workspace/agent",
  ],
  serverExternalPackages: ["pg"],
  outputFileTracingIncludes: {
    "/*": [
      "../../packages/agent/src/playbooks/*.md",
      "../../packages/evals/questions/dev.yaml",
    ],
  },
}
export default config
