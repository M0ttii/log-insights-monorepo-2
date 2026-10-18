import { MockLanguageModelV3 } from "ai/test"
import { describe, expect, it } from "vitest"

import {
  CHAT_DISABLED_MESSAGE,
  ChatDisabledError,
  DEFAULT_EFFORT,
  DEFAULT_MODEL_ID,
  resolveModel,
} from "./model.ts"

const mock = () => new MockLanguageModelV3()

describe("resolveModel", () => {
  it("defaults the model id and effort", () => {
    const config = resolveModel({ model: mock(), env: {} })
    expect(config.modelId).toBe(DEFAULT_MODEL_ID)
    expect(config.effort).toBe(DEFAULT_EFFORT)
  })

  it("reads LOG_INSIGHTS_MODEL, treating empty string as the default", () => {
    expect(
      resolveModel({
        model: mock(),
        env: { LOG_INSIGHTS_MODEL: "claude-opus-5" },
      }).modelId
    ).toBe("claude-opus-5")
    expect(
      resolveModel({ model: mock(), env: { LOG_INSIGHTS_MODEL: "" } }).modelId
    ).toBe(DEFAULT_MODEL_ID)
  })

  it("lets an explicit override win over the env", () => {
    const config = resolveModel({
      model: mock(),
      modelId: "claude-sonnet-5",
      env: { LOG_INSIGHTS_MODEL: "claude-opus-5" },
    })
    expect(config.modelId).toBe("claude-sonnet-5")
  })

  it("carries the effort into the provider options", () => {
    const config = resolveModel({ model: mock(), effort: "max", env: {} })
    expect(config.effort).toBe("max")
    expect(config.providerOptions.anthropic.effort).toBe("max")
  })

  it("sets adaptive thinking, 1h prompt caching and default fallbacks", () => {
    const { anthropic } = resolveModel({
      model: mock(),
      env: {},
    }).providerOptions
    expect(anthropic.thinking).toEqual({ type: "adaptive", display: "updates" })
    expect(anthropic.cacheControl).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(anthropic.fallbacks).toBe("default")
  })

  it("throws a typed, clear error when the key is missing and no model is injected", () => {
    expect(() => resolveModel({ env: {} })).toThrow(ChatDisabledError)
    expect(() => resolveModel({ env: { ANTHROPIC_API_KEY: "" } })).toThrow(
      CHAT_DISABLED_MESSAGE
    )
  })

  it("creates a real provider model when a key is present", () => {
    const config = resolveModel({ env: { ANTHROPIC_API_KEY: "sk-test" } })
    expect(typeof config.model).not.toBe("string")
    expect(config.modelId).toBe(DEFAULT_MODEL_ID)
  })

  it("an injected model skips the key check", () => {
    expect(() => resolveModel({ model: mock(), env: {} })).not.toThrow()
  })
})
