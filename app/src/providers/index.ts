// Provider factory.

import type { LLMProvider } from "../agent/types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { OpenAIProvider } from "./openai.ts";
import { GeminiProvider } from "./gemini.ts";
import { OpenRouterProvider } from "./openrouter.ts";
import { DEFAULT_MODELS, type ProviderConfig, type ProviderId } from "./common.ts";

export { DEFAULT_MODELS };
export type { ProviderConfig, ProviderId };

export function createProvider(id: ProviderId, config: ProviderConfig): LLMProvider {
  switch (id) {
    case "anthropic":
      return new AnthropicProvider(config);
    case "openai":
      return new OpenAIProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    case "openrouter":
      return new OpenRouterProvider(config);
  }
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};
