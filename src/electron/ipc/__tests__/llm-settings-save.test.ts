import { describe, expect, it } from "vitest";
import type { LLMSettingsData } from "../../../shared/types";
import { buildSavedLLMSettings } from "../llm-settings-save";

describe("buildSavedLLMSettings", () => {
  it("persists fallbackProviders while preserving cached model metadata", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/free",
      cachedOpenRouterModels: [
        {
          key: "openrouter/free",
          displayName: "OpenRouter Free",
          description: "cached",
        },
      ],
    };

    const validated: LLMSettingsData = {
      providerType: "openrouter",
      modelKey: "openrouter/free",
      fallbackProviders: [
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
        { providerType: "openai", modelKey: "gpt-4.1-mini" },
      ],
      failoverPrimaryRetryCooldownSeconds: 90,
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.fallbackProviders).toEqual(validated.fallbackProviders);
    expect(saved.failoverPrimaryRetryCooldownSeconds).toBe(90);
    expect(saved.cachedOpenRouterModels).toEqual(
      existingSettings.cachedOpenRouterModels,
    );
  });

  it("preserves OpenAI OAuth tokens when saving unrelated settings changes", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiresAt: 12345,
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      fallbackProviders: [
        { providerType: "anthropic", modelKey: "sonnet-4-5" },
      ],
      openai: {
        model: "gpt-4.1",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openai).toMatchObject({
      authMethod: "oauth",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenExpiresAt: 12345,
      model: "gpt-4.1",
    });
    expect(saved.fallbackProviders).toEqual(validated.fallbackProviders);
  });

  it("allows switching OpenAI auth from OAuth to API key", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: {
        authMethod: "oauth",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenExpiresAt: 12345,
      },
    };

    const validated: LLMSettingsData = {
      providerType: "openai",
      modelKey: "gpt-4.1",
      openai: {
        apiKey: "sk-new-api-key",
        model: "gpt-4.1",
        authMethod: "api_key",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.openai).toEqual({
      apiKey: "sk-new-api-key",
      model: "gpt-4.1",
      authMethod: "api_key",
    });
  });

  it("persists hidden prompt-caching settings without disturbing provider settings", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        apiKey: "existing-key",
      },
      promptCaching: {
        mode: "off",
        ttl: "5m",
      },
    };

    const validated: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        apiKey: "existing-key",
      },
      promptCaching: {
        mode: "auto",
        ttl: "1h",
        openRouterClaudeStrategy: "explicit_system_and_3",
        strictStablePrefix: true,
        surfaceCoverage: {
          executor: true,
          followUps: true,
          chatMode: true,
          sideCalls: false,
        },
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.promptCaching).toEqual(validated.promptCaching);
    expect(saved.anthropic).toEqual(existingSettings.anthropic);
  });

  it("persists Claude subscription auth settings", () => {
    const existingSettings: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
    };

    const validated: LLMSettingsData = {
      providerType: "anthropic",
      modelKey: "sonnet-4-5",
      anthropic: {
        authMethod: "subscription",
        subscriptionToken: "sk-ant-oat01-subscription-token",
        apiKey: "sk-ant-api-key",
      },
    };

    const saved = buildSavedLLMSettings(validated, existingSettings);

    expect(saved.anthropic).toMatchObject({
      authMethod: "subscription",
      subscriptionToken: "sk-ant-oat01-subscription-token",
      apiKey: "sk-ant-api-key",
    });
  });
});
