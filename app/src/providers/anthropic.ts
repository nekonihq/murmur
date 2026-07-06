// Anthropic (Claude) provider adapter — the default. Calls the Messages API
// tool-use loop directly with fetch (React Native is not a browser, so there is
// no CORS constraint; the user's own key is sent from their device).
//
// Model defaults to claude-opus-4-8 per the Claude API guidance. Extended
// thinking is intentionally left off here so the neutral transcript need not
// round-trip thinking blocks; revisit if deeper reasoning is wanted.

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

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_TOKENS = 8000;

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODELS.anthropic;
  }

  async next(systemPrompt: string, turns: Turn[], signal?: AbortSignal): Promise<ProviderTurn> {
    const body = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      tools: [
        {
          name: SHELL_TOOL.name,
          description: SHELL_TOOL.description,
          input_schema: SHELL_TOOL.parameters,
        },
      ],
      messages: turns.map(toAnthropicMessage),
    };

    const res = (await postJson(
      API_URL,
      {
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body,
      signal,
    )) as { content?: AnthropicBlock[]; stop_reason?: string };

    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of res.content ?? []) {
      if (block.type === "text" && block.text) {
        text += block.text;
      } else if (block.type === "tool_use" && block.id) {
        const { command, timeoutMs } = parseToolArgs(block.input);
        toolCalls.push({ id: block.id, command, timeoutMs });
      }
    }
    return { text, toolCalls };
  }
}

function toAnthropicMessage(turn: Turn): unknown {
  switch (turn.role) {
    case "user":
      return { role: "user", content: turn.text };
    case "assistant": {
      const content: unknown[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: SHELL_TOOL.name,
          input: {
            command: call.command,
            ...(call.timeoutMs != null ? { timeout_seconds: call.timeoutMs / 1000 } : {}),
          },
        });
      }
      // A message must have at least one content block.
      if (content.length === 0) content.push({ type: "text", text: "(no content)" });
      return { role: "assistant", content };
    }
    case "tool":
      return {
        role: "user",
        content: turn.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.id,
          content: formatResult(r.result),
          is_error: r.result.exit_code !== 0,
        })),
      };
  }
}
