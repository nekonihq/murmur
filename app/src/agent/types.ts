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
 * Coarse classification of a failed run, so the UI can present each failure in
 * plain language (and decide whether offering a one-tap retry makes sense)
 * instead of dumping a raw HTTP body at the user.
 *
 * `content_filter` is the notable one: the provider's own safety system withheld
 * the model's reply (HTTP 400). It depends on the surrounding conversation, so
 * it is retryable and often clears on a rephrase or a fresh conversation.
 */
export type AgentErrorKind =
  | "content_filter"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "server"
  | "network"
  | "timeout"
  | "step_limit"
  | "unknown";

/**
 * A failure rendered in the chat. Structured (not just a string) so the UI can
 * show a friendly title + explanation, gate a retry button on {@link retryable},
 * and tuck the original provider message away in {@link raw} for debugging.
 */
export interface AgentError {
  kind: AgentErrorKind;
  /** Short, human heading, e.g. "Response blocked by the content filter". */
  title: string;
  /** One or two sentences explaining what happened and what to do next. */
  detail: string;
  /** Whether a plain re-send has any chance of succeeding. */
  retryable: boolean;
  /** The original provider/transport message, for a collapsible detail view. */
  raw?: string;
}

/**
 * One rendered line in the agent chat transcript. This is the *display* model
 * (what the UI shows), distinct from {@link Turn} (what the model sees). Both
 * are persisted with a conversation so a reopened chat renders exactly as it
 * did and can still be resumed with full model context.
 */
export interface ChatLine {
  /**
   * Stable identity for this line, used as the React key when rendering the
   * chat. Lines can be spliced out of the middle of the array (an error
   * rollback drops the second-to-last line, not just the last), so the array
   * index isn't a safe key — reusing an index across a splice reassigns an
   * existing rendered instance to different content, which can leave stale
   * native layout behind it. Optional only because conversations saved before
   * this field existed don't have one; those are backfilled on load.
   */
  id?: string;
  kind: "user" | "assistant" | "command" | "result" | "denied" | "error" | "note";
  text: string;
  /** Present on `error` lines: the structured failure to render richly. */
  error?: AgentError;
}

/** Events emitted by the agent loop for the UI to render. */
export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "command"; id: string; command: string }
  | { type: "command_denied"; id: string; command: string }
  | { type: "result"; id: string; result: ExecResult }
  | { type: "done" }
  | { type: "stopped" }
  | { type: "error"; error: AgentError };

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
  "For commands that need root, just prefix them with `sudo` — a password is " +
  "supplied automatically and non-interactively (an askpass helper answers the " +
  "prompt), so sudo will not hang or block. Do NOT use `sudo -n`, and do not " +
  "conclude that privilege escalation is impossible. If a command fails with a " +
  "permission error (EPERM / \"operation not permitted\"), retry it with `sudo`. " +
  "Only if sudo itself reports an authentication failure should you tell the user " +
  "to set the sudo password in Settings. " +
  "Run small, targeted commands; check results before continuing; and explain " +
  "what you find. When the goal is met, stop calling tools and summarize.";
