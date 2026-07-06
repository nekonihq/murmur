// Google Gemini provider adapter — generateContent with functionDeclarations.

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

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? DEFAULT_MODELS.gemini;
  }

  async next(systemPrompt: string, turns: Turn[], signal?: AbortSignal): Promise<ProviderTurn> {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: turns.map(toGeminiContent),
      tools: [
        {
          functionDeclarations: [
            {
              name: SHELL_TOOL.name,
              description: SHELL_TOOL.description,
              parameters: SHELL_TOOL.parameters,
            },
          ],
        },
      ],
    };

    const res = (await postJson(url, { "x-goog-api-key": this.apiKey }, body, signal)) as {
      candidates?: { content?: { parts?: GeminiPart[] } }[];
    };

    const parts = res.candidates?.[0]?.content?.parts ?? [];
    let text = "";
    const toolCalls: ToolCall[] = [];
    let i = 0;
    for (const part of parts) {
      if (part.text) {
        text += part.text;
      } else if (part.functionCall) {
        const { command, timeoutMs } = parseToolArgs(part.functionCall.args);
        // Gemini function calls have no id; synthesize a stable one for pairing.
        toolCalls.push({ id: `gem-${i++}`, command, timeoutMs });
      }
    }
    return { text, toolCalls };
  }
}

function toGeminiContent(turn: Turn): unknown {
  switch (turn.role) {
    case "user":
      return { role: "user", parts: [{ text: turn.text }] };
    case "assistant": {
      const parts: unknown[] = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const call of turn.toolCalls) {
        parts.push({
          functionCall: {
            name: SHELL_TOOL.name,
            args: {
              command: call.command,
              ...(call.timeoutMs != null ? { timeout_seconds: call.timeoutMs / 1000 } : {}),
            },
          },
        });
      }
      // A content entry must have at least one part.
      if (parts.length === 0) parts.push({ text: "(no content)" });
      return { role: "model", parts };
    }
    case "tool":
      return {
        role: "user",
        parts: turn.results.map((r) => ({
          functionResponse: {
            name: SHELL_TOOL.name,
            response: { result: formatResult(r.result) },
          },
        })),
      };
  }
}
