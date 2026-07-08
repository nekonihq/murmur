// Provider-agnostic agent types. The agent loop drives a neutral transcript;
// each provider adapter translates it to that vendor's tool-calling API.

import type { ExecResult } from "../protocol/messages.ts";

/** A shell command the model wants to run. */
export interface ToolCall {
  /** Provider-assigned id, echoed back with the result. */
  id: string;
  command: string;
  timeoutMs?: number;
}

/** The outcome of running a {@link ToolCall} on the Pi. */
export interface ToolResult {
  id: string;
  result: ExecResult;
}

/** One step of the conversation, neutral across providers. */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

/** What a provider returns for one assistant step. */
export interface ProviderTurn {
  /** Assistant prose for this step (may be empty when only calling tools). */
  text: string;
  /** Commands to run; empty array means the model is done. */
  toolCalls: ToolCall[];
}

/**
 * An LLM provider. `next` takes the system prompt and full neutral transcript
 * and returns the next assistant step. Adapters are stateless: the loop owns
 * the transcript and replays it each call.
 */
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  /** `signal` aborts the underlying request so the run can be stopped mid-call. */
  next(systemPrompt: string, turns: Turn[], signal?: AbortSignal): Promise<ProviderTurn>;
}

/**
 * One rendered line in the agent chat transcript. This is the *display* model
 * (what the UI shows), distinct from {@link Turn} (what the model sees). Both
 * are persisted with a conversation so a reopened chat renders exactly as it
 * did and can still be resumed with full model context.
 */
export interface ChatLine {
  kind: "user" | "assistant" | "command" | "result" | "denied" | "error" | "note";
  text: string;
}

/** Events emitted by the agent loop for the UI to render. */
export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "command"; id: string; command: string }
  | { type: "command_denied"; id: string; command: string }
  | { type: "result"; id: string; result: ExecResult }
  | { type: "done" }
  | { type: "stopped" }
  | { type: "error"; message: string };

/** The single tool exposed to every provider. */
export const SHELL_TOOL = {
  name: "run_shell_command",
  description:
    "Run a shell command on the connected Raspberry Pi and return its stdout, " +
    "stderr, and exit code. Commands run non-interactively via /bin/sh -c. Use " +
    "this to inspect and operate the system. Prefer small, targeted commands.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      timeout_seconds: {
        type: "number",
        description: "Optional timeout in seconds; the command is killed if it exceeds this.",
      },
    },
    required: ["command"],
  },
} as const;

/** Default system prompt for agent mode. */
export const DEFAULT_SYSTEM_PROMPT =
  "You are murmur, an assistant operating a Raspberry Pi over a Bluetooth link. " +
  "You accomplish the user's goal by running shell commands with the " +
  "run_shell_command tool and reasoning about their output. The Pi may be " +
  "offline except for this link, so do not assume internet access on the device. " +
  "Run small, targeted commands; check results before continuing; and explain " +
  "what you find. When the goal is met, stop calling tools and summarize.";
