// OpenAI provider adapter — Chat Completions with function/tool calling.

import {
  SHELL_TOOL,
  type LLMProvider,
  type ProviderTurn,
  type ToolCall,
  type Turn,
} from "../agent/types.ts";
import {
  DEFAULT_MODELS,
  formatResult,
  parseToolArgs,
  postJson,
  type ProviderConfig,
} from "./common.ts";

const API_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAIToolCall {
  id: string;
  function: { name: string; arguments: string };
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai";
  readonly model: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODELS.openai;
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
      { authorization: `Bearer ${this.apiKey}` },
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

export function toOpenAIMessages(turn: Turn): unknown[] {
  switch (turn.role) {
    case "user":
      return [{ role: "user", content: turn.text }];
    case "assistant": {
      const toolCalls = turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: {
          name: SHELL_TOOL.name,
          arguments: JSON.stringify({
            command: c.command,
            ...(c.timeoutMs != null ? { timeout_seconds: c.timeoutMs / 1000 } : {}),
          }),
        },
      }));
      // Only send `tool_calls` when non-empty — OpenAI rejects an empty array
      // (400). `content` may be null only when tool_calls are present.
      return [
        {
          role: "assistant",
          content: turn.text || (toolCalls.length ? null : ""),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      ];
    }
    case "tool":
      return turn.results.map((r) => ({
        role: "tool",
        tool_call_id: r.id,
        content: formatResult(r.result),
      }));
  }
}
