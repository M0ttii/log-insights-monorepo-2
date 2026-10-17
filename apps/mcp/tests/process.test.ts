import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

import {
  JSONRPCMessageSchema,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js"
import { findWorkspaceRoot } from "@workspace/analytics/config"
import { describe, expect, it } from "vitest"

const root = findWorkspaceRoot()
const envFile = join(root, ".env")
if (existsSync(envFile)) process.loadEnvFile(envFile)

describe("MCP process lifecycle", () => {
  it.each(["eof", "SIGINT", "SIGTERM"] as const)(
    "releases an opened pool and exits on %s with protocol-only stdout",
    async (termination) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(root, "apps/mcp/src/server.ts")],
        {
          cwd: join(root, "apps/mcp"),
          env: { ...process.env, SERENEDB_DATABASE: "log_insights_samples" },
          stdio: ["pipe", "pipe", "pipe"],
        }
      )
      const exited = once(child, "exit")
      const lines = createInterface({ input: child.stdout })
      const messages: unknown[] = []
      const protocolErrors: unknown[] = []
      let stderr = ""
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      const completed = new Promise<void>((resolve, reject) => {
        lines.on("line", (line) => {
          try {
            const message = JSONRPCMessageSchema.parse(JSON.parse(line))
            messages.push(message)
            if ("id" in message && message.id === 1 && "result" in message) {
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`
              )
              child.stdin.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "describe_corpus", arguments: {} } })}\n`
              )
            }
            if ("id" in message && message.id === 2) resolve()
          } catch (error) {
            protocolErrors.push(error)
            reject(error)
          }
        })
        child.once("error", reject)
        child.once("exit", () =>
          reject(new Error("MCP exited before the tool response"))
        )
      })
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
      try {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: LATEST_PROTOCOL_VERSION,
              clientInfo: { name: "lifecycle-test", version: "1" },
              capabilities: {},
            },
          })}\n`
        )
        await completed
        if (termination === "eof") child.stdin.end()
        else child.kill(termination)
        const [code, signal] = await exited
        expect(code).toBe(0)
        expect(signal).toBeNull()
        expect(protocolErrors).toEqual([])
        expect(messages).toEqual([
          expect.objectContaining({ id: 1, result: expect.any(Object) }),
          expect.objectContaining({
            id: 2,
            result: expect.objectContaining({
              structuredContent: expect.objectContaining({
                receipt: expect.objectContaining({
                  receipt_id: expect.stringMatching(/^r_[0-9a-f]{8}$/),
                }),
              }),
            }),
          }),
        ])
        expect(stderr).toContain("tool=describe_corpus")
      } finally {
        clearTimeout(timeout)
        lines.close()
        child.kill("SIGKILL")
        await exited
      }
    }
  )
})
