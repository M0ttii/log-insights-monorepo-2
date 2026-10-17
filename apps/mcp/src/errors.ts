import {
  ErrorCode,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js"
import type { ToolError } from "@workspace/domain/errors"

const unexpected = {
  code: "internal_error",
  message: "The operation failed unexpectedly.",
  hint: "Check the local server configuration and restart the client before trying again.",
}

/** One mapping for every expected ToolError; never serialize caught exceptions. */
export function toToolErrorResult(error?: ToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(error ?? unexpected) }],
  }
}

/** MCP resources report protocol errors rather than tool result envelopes. */
export function toResourceError(error?: ToolError): McpError {
  const safe = error ?? unexpected
  return new McpError(ErrorCode.InvalidParams, safe.message, safe)
}
