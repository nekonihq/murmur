// The phone-side agent loop: call the LLM → run its command on the Pi over BLE
// → feed the result back → repeat until the model stops requesting tools.
//
// Transport-agnostic: it depends only on a `runCommand` function (backed by the
// BLE exec session in production, a fake in tests) and an `LLMProvider`.

import type { ExecResult } from "../protocol/messages.ts";
import {
  type AgentError,
  type AgentEvent,
  type LLMProvider,
  type ToolResult,
  type Turn,
  DEFAULT_SYSTEM_PROMPT,
} from "./types.ts";

export interface AgentOptions {
  systemPrompt?: string;
  /** Hard cap on agent steps to prevent runaway loops. */
  maxSteps?: number;
  /**
   * Optional gate for destructive commands. Return false to deny a command;
   * the model is told it was denied and can adjust. Defaults to allow-all.
   */
  confirm?: (command: string) => boolean | Promise<boolean>;
  /**
   * Aborts the run. Checked before each LLM call and each command, so a stopped
   * agent halts within (at most) the current command's timeout — no further
   * steps or tool calls are issued.
   */
  signal?: AbortSignal;
  /**
   * Prior conversation to continue. The new goal and every assistant/tool turn
   * are appended to this array in place, so the caller keeps the running
   * transcript across calls (multi-turn memory). Omit to start fresh.
   */
  history?: Turn[];
}

/** Run a command on the Pi (BLE exec session) and return its result. */
export type RunCommand = (command: string, timeoutMs?: number) => Promise<ExecResult>;

const DENIED: ExecResult = {
  stdout: "",
  stderr: "command was denied by the user",
  exit_code: 126,
  truncated: false,
};

const STOPPED: ExecResult = {
  stdout: "",
  stderr: "command was stopped by the user",
  exit_code: 130, // 128 + SIGINT, the conventional "interrupted" code
  truncated: false,
};

/**
 * Providers require every assistant `tool_use` to be answered by a matching
 * `tool_result` in the next turn. If a previous run was aborted between issuing
 * tool calls and recording their results, the transcript can end with a
 * dangling assistant tool-call turn — which makes the next request malformed
 * (Anthropic returns HTTP 400). Seal any such tail with "stopped" results so a
 * continued conversation (or a reopened, previously-corrupted one) stays valid.
 */
function sealPendingToolCalls(turns: Turn[]): void {
  const last = turns[turns.length - 1];
  if (last && last.role === "assistant" && last.toolCalls.length > 0) {
    turns.push({
      role: "tool",
      results: last.toolCalls.map((c) => ({ id: c.id, result: STOPPED })),
    });
  }
}

/**
 * Drive the agent to completion, yielding {@link AgentEvent}s as it goes.
 * Consumers render each event (assistant text, command, result) in the chat UI.
 */
export async function* runAgent(
  provider: LLMProvider,
  goal: string,
  runCommand: RunCommand,
  options: AgentOptions = {},
): AsyncGenerator<AgentEvent> {
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxSteps = options.maxSteps ?? 25;
  const confirm = options.confirm ?? (() => true);
  const signal = options.signal;

  // Continue the caller's transcript (mutated in place) so context carries
  // across questions; fall back to a fresh one when no history is supplied.
  const turns: Turn[] = options.history ?? [];
  // Snapshot the last known-good length so a failed *first* call can be rolled
  // back to it (see below).
  const goodLen = turns.length;
  // Repair a transcript left dangling by a prior hard stop before appending the
  // new turn, so continuing (or resuming a saved chat) can't send a malformed
  // request.
  sealPendingToolCalls(turns);
  turns.push({ role: "user", text: goal });

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      yield { type: "stopped" };
      return;
    }
    let turn;
    try {
      turn = await provider.next(systemPrompt, turns, signal);
    } catch (e) {
      if (signal?.aborted) {
        yield { type: "stopped" };
        return;
      }
      // If the very first call fails (the common case: the provider's content
      // filter rejects the reply to the new message), the goal we just appended
      // — and any healing seal — would otherwise stay in the transcript, so
      // every later message resends the rejected content and hits the same wall,
      // bricking the conversation. Roll back to the last good state so the user
      // can retry, rephrase, or ask something else cleanly. Later steps already
      // committed real work and ended on a valid tool turn, so those are kept.
      if (step === 0) turns.length = goodLen;
      yield { type: "error", error: toAgentError(e) };
      return;
    }

    if (turn.text) {
      yield { type: "assistant", text: turn.text };
    }
    turns.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls });

    if (turn.toolCalls.length === 0) {
      yield { type: "done" };
      return;
    }

    const results: ToolResult[] = [];
    let stopped = false;
    for (const call of turn.toolCalls) {
      if (signal?.aborted) stopped = true;
      if (stopped) {
        // Aborted mid-batch: still record a result for every remaining call so
        // each of the assistant's tool_use blocks has a matching tool_result
        // and the transcript stays valid for the next request.
        results.push({ id: call.id, result: STOPPED });
        continue;
      }
      const allowed = await confirm(call.command);
      if (!allowed) {
        yield { type: "command_denied", id: call.id, command: call.command };
        results.push({ id: call.id, result: DENIED });
        continue;
      }
      yield { type: "command", id: call.id, command: call.command };
      let result: ExecResult;
      try {
        result = await runCommand(call.command, call.timeoutMs);
      } catch (e) {
        if (signal?.aborted) {
          // Stop hit while the command was in flight. Record it as stopped and
          // let the loop seal the rest, rather than returning with a dangling
          // tool call.
          stopped = true;
          results.push({ id: call.id, result: STOPPED });
          continue;
        }
        result = {
          stdout: "",
          stderr: `transport error: ${errMessage(e)}`,
          exit_code: -1,
          truncated: false,
        };
      }
      yield { type: "result", id: call.id, result };
      results.push({ id: call.id, result });
    }
    // Always append the tool turn (one result per call) before possibly
    // stopping, so the assistant's tool_use blocks are never left unanswered.
    turns.push({ role: "tool", results });
    if (stopped) {
      yield { type: "stopped" };
      return;
    }
  }

  yield {
    type: "error",
    error: {
      kind: "step_limit",
      title: "Step limit reached",
      detail:
        `The agent stopped after ${maxSteps} steps to avoid running forever. ` +
        "If it was on the right track, ask it to continue.",
      retryable: false,
    },
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Normalize any thrown value into an {@link AgentError}. Provider adapters throw
 * a `ProviderError` carrying a pre-classified `agentError`; we read it by duck
 * typing so this transport-agnostic loop needn't depend on the providers layer.
 * Anything else (an unexpected bug) becomes a generic, retryable error.
 */
function toAgentError(e: unknown): AgentError {
  const carried = (e as { agentError?: AgentError } | null | undefined)?.agentError;
  if (carried && typeof carried === "object" && typeof carried.title === "string") {
    return carried;
  }
  const msg = errMessage(e);
  return {
    kind: "unknown",
    title: "Something went wrong",
    detail: msg,
    retryable: true,
    raw: msg,
  };
}
