// OpenRouter provider adapter — OpenRouter proxies many models behind an
// OpenAI-compatible Chat Completions endpoint, so this reuses the OpenAI
// adapter's message translation and only swaps the URL, headers, and default
// model (an OpenRouter-style "vendor/model" slug).

import {
  SHELL_TOOL,
  type LLMProvider,
  type ProviderTurn,
  type ToolCall,
  type Turn,
} from "../agent/types.ts";
import { toOpenAIMessages } from "./openai.ts";
import {
  DEFAULT_MODELS,
  parseToolArgs,
  postJson,
  type ProviderConfig,
} from "./common.ts";

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  readonly model: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODELS.openrouter;
  }

  async next(systemPrompt: string, turns: Turn[], signal?: AbortSignal): Promise<ProviderTurn> {
    const messages: unknown[] = [{ role: "system", content: systemPrompt }];
    for (const turn of turns) messages.push(...toOpenAIMessages(turn));

    const body = {
      model: this.model,
      messages,
      tools: [
        {
          type: "function",
          function: {
            name: SHELL_TOOL.name,
            description: SHELL_TOOL.description,
            parameters: SHELL_TOOL.parameters,
          },
        },
      ],
    };

    const res = (await postJson(
      API_URL,
      {
        authorization: `Bearer ${this.apiKey}`,
        // Identifies the app on OpenRouter's dashboard; not required for auth.
        "x-title": "murmur",
      },
      body,
      signal,
    )) as {
      choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[];
    };

    const message = res.choices?.[0]?.message;
    const text = message?.content ?? "";
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc) => {
      let args: unknown = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // leave args empty; loop will treat command as empty
      }
      const { command, timeoutMs } = parseToolArgs(args);
      return { id: tc.id, command, timeoutMs };
    });
    return { text, toolCalls };
  }
}
