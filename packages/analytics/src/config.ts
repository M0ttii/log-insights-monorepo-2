import { existsSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

/**
 * Process configuration (technical.md § 4), validated once at startup by the
 * MCP server, the web app and the eval runner. Analytics cannot import the
 * corpus package (§ 4 package table), so the workspace-root search mirrors
 * `corpus/src/config.ts`.
 */

export type Connection = {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export type AnalyticsConfig = {
  connection: Connection
  /** Absolute directory of the receipt files. */
  receiptsDir: string
  /** Registers the optional index tools (A-33); read once per process. */
  workspaceTools: boolean
}

const required = (name: string) =>
  z
    .string({ error: `${name} is not set; copy .env.example to .env` })
    .min(1, `${name} is not set; copy .env.example to .env`)

const optional = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value))

const envSchema = z.object({
  SERENEDB_HOST: required("SERENEDB_HOST"),
  SERENEDB_PORT: required("SERENEDB_PORT")
    .regex(/^\d{1,5}$/, "SERENEDB_PORT must be a TCP port number")
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(1, "SERENEDB_PORT must be a TCP port number")
        .max(65_535, "SERENEDB_PORT must be a TCP port number")
    ),
  SERENEDB_USER: required("SERENEDB_USER"),
  SERENEDB_PASSWORD: required("SERENEDB_PASSWORD"),
  SERENEDB_DATABASE: required("SERENEDB_DATABASE"),
  LOG_INSIGHTS_RECEIPTS_DIR: optional,
  LOG_INSIGHTS_WORKSPACE_TOOLS: optional.pipe(
    z
      .enum(["0", "1"], {
        error: "LOG_INSIGHTS_WORKSPACE_TOOLS must be 1, 0 or empty",
      })
      .optional()
  ),
})

/** Throws one readable error listing every missing or invalid variable. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AnalyticsConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => `- ${issue.message}`)
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`)
  }
  loadRetrievalConfig(env)
  const values = parsed.data
  const root = findWorkspaceRoot()
  const receiptsDir = values.LOG_INSIGHTS_RECEIPTS_DIR
  return {
    connection: {
      host: values.SERENEDB_HOST,
      port: values.SERENEDB_PORT,
      user: values.SERENEDB_USER,
      password: values.SERENEDB_PASSWORD,
      database: values.SERENEDB_DATABASE,
    },
    // A relative directory is relative to the repository, never to the
    // working directory: Claude Desktop starts the MCP process elsewhere (T-11).
    receiptsDir:
      receiptsDir === undefined
        ? join(root, ".data", "receipts")
        : isAbsolute(receiptsDir)
          ? receiptsDir
          : resolve(root, receiptsDir),
    workspaceTools: values.LOG_INSIGHTS_WORKSPACE_TOOLS === "1",
  }
}

/** Searches upwards for pnpm-workspace.yaml; never uses process.cwd(). */
export function findWorkspaceRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error("pnpm-workspace.yaml not found above packages/analytics")
    }
    dir = parent
  }
  return dir
}

/** Retrieval is opt-in; the DB secret name is an identifier, never a credential. */
export function loadRetrievalConfig(
  env: Record<string, string | undefined> = process.env
): { directory: string; embeddingSecret?: string } {
  const parsed = z
    .object({
      LOG_INSIGHTS_RETRIEVAL_DIR: optional,
      LOG_INSIGHTS_EMBEDDING_SECRET: optional.pipe(
        z
          .string()
          .regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/,
            "LOG_INSIGHTS_EMBEDDING_SECRET must name a SereneDB secret"
          )
          .optional()
      ),
    })
    .parse(env)
  const directory = parsed.LOG_INSIGHTS_RETRIEVAL_DIR
  return {
    directory:
      directory === undefined
        ? join(findWorkspaceRoot(), ".data", "retrieval")
        : isAbsolute(directory)
          ? directory
          : resolve(findWorkspaceRoot(), directory),
    ...(parsed.LOG_INSIGHTS_EMBEDDING_SECRET === undefined
      ? {}
      : { embeddingSecret: parsed.LOG_INSIGHTS_EMBEDDING_SECRET }),
  }
}
