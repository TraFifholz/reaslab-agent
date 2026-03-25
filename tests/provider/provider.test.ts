import { describe, test, expect, beforeEach } from "bun:test"
import { Provider } from "../../src/provider/provider"

describe("Provider.fromMeta", () => {
  beforeEach(() => {
    Provider.clearCache()
  })

  test("creates LanguageModelV2 from meta", () => {
    const model = Provider.fromMeta({
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-key",
    })
    expect(model).toBeDefined()
    expect(model.modelId).toBe("gpt-4o")
  })

  test("handles reasoningEffort option", () => {
    const model = Provider.fromMeta({
      model: "claude-sonnet-4-5",
      baseUrl: "https://api.anthropic.com",
      apiKey: "sk-ant-test",
      reasoningEffort: "high",
    })
    expect(model).toBeDefined()
  })

  test("throws on missing required fields", () => {
    expect(() => Provider.fromMeta({ model: "", baseUrl: "", apiKey: "" })).toThrow()
  })

  test("caches models with same config", () => {
    const meta = {
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test-key",
    }
    const model1 = Provider.fromMeta(meta)
    const model2 = Provider.fromMeta(meta)
    expect(model1).toBe(model2) // Same reference
  })

  test("modelFromMeta creates MinimalModel", () => {
    const model = Provider.modelFromMeta({
      model: "gpt-4o",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
    })
    expect(model.id).toBe("gpt-4o")
    expect(model.providerID).toBe("reaslab")
    expect(model.api.id).toBe("gpt-4o")
  })
})
