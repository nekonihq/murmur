// Shared helpers for provider adapters.

import type { ExecResult } from "../protocol/messages.ts";
import type { AgentError } from "../agent/types.ts";

/** Provider identifiers persisted in settings. */
export type ProviderId = "anthropic" | "openai" | "gemini" | "openrouter";

export interface ProviderConfig {
  apiKey: string;
  /** Override the default model; falls back to {@link DEFAULT_MODELS}. */
  model?: string;
}

/**
 * Default models per provider. Anthropic defaults to the latest Opus per the
 * Claude API guidance; others use a current, widely available default the user
 * can override in Settings.
 */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
  openrouter: "qwen/qwen3.7-max",
};

/**
 * Render an {@link ExecResult} into the text the model sees as a tool result.
 * Compact but complete: exit code first, then streams, with a truncation note.
 */
export function formatResult(r: ExecResult): string {
  const parts: string[] = [`exit_code: ${r.exit_code}`];
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  if (r.truncated) parts.push("(output truncated)");
  return parts.join("\n");
}

/** Extract `{command, timeoutMs}` from a tool-call argument object. */
export function parseToolArgs(args: unknown): { command: string; timeoutMs?: number } {
  const a = (args ?? {}) as Record<string, unknown>;
  const command = typeof a.command === "string" ? a.command : "";
  const secs = typeof a.timeout_seconds === "number" ? a.timeout_seconds : undefined;
  return { command, timeoutMs: secs != null ? Math.round(secs * 1000) : undefined };
}

/**
 * A provider request that failed, carrying a {@link AgentError} the UI can
 * render in plain language. The loop pulls `.agentError` off it (duck-typed, so
 * the transport-agnostic loop needn't import this class) and surfaces it.
 */
export class ProviderError extends Error {
  readonly agentError: AgentError;
  /** HTTP status, or 0 for transport-level failures (network, timeout). */
  readonly status: number;

  constructor(agentError: AgentError, status: number) {
    super(agentError.title);
    this.name = "ProviderError";
    this.agentError = agentError;
    this.status = status;
  }
}

/**
 * Turn a non-2xx provider response into a friendly {@link AgentError}. Providers
 * wrap their errors in `{"error":{"type","message"}}`; we sniff the type and
 * message (plus the status code) to classify. Content-filter blocks are the
 * headline case — they come back as a 400 `invalid_request_error` whose message
 * mentions a filtering/blocked policy.
 */
export function classifyHttpError(status: number, bodyText: string): AgentError {
  let apiType = "";
  let apiMessage = "";
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { type?: string; status?: string; message?: string };
    };
    apiType = parsed.error?.type ?? parsed.error?.status ?? "";
    apiMessage = parsed.error?.message ?? "";
  } catch {
    // Non-JSON body (proxy error page, empty): fall back to the raw text.
  }
  const raw = apiMessage || bodyText.slice(0, 500) || `HTTP ${status}`;
  const hay = `${apiType} ${apiMessage}`.toLowerCase();

  if (
    hay.includes("content filter") ||
    hay.includes("content filtering") ||
    hay.includes("blocked by") ||
    hay.includes("safety")
  ) {
    return {
      kind: "content_filter",
      title: "Response blocked by the provider's content filter",
      detail:
        "The provider's safety system withheld the model's reply — this is not a " +
        "murmur error. It depends on the surrounding conversation, so retrying " +
        "usually hits the same wall. Use “Remove last exchange” to drop the " +
        "message that triggered it and continue, or start a new conversation.",
      retryable: true,
      raw,
    };
  }
  if (status === 401 || status === 403 || hay.includes("authentication") || hay.includes("api key")) {
    return {
      kind: "auth",
      title: "Authentication failed",
      detail: "The API key was rejected. Check the key for this provider in Settings.",
      retryable: false,
      raw,
    };
  }
  if (status === 429 || hay.includes("rate limit")) {
    return {
      kind: "rate_limit",
      title: "Rate limited",
      detail: "The provider is throttling requests. Wait a few seconds, then try again.",
      retryable: true,
      raw,
    };
  }
  if (status === 529 || hay.includes("overloaded")) {
    return {
      kind: "overloaded",
      title: "Provider overloaded",
      detail: "The provider is temporarily overloaded. Try again in a moment.",
      retryable: true,
      raw,
    };
  }
  if (status >= 500) {
    return {
      kind: "server",
      title: `Provider error (${status})`,
      detail: "The provider hit a server-side error. Try again shortly.",
      retryable: true,
      raw,
    };
  }
  if (status === 400) {
    return {
      kind: "invalid_request",
      title: "Request rejected",
      detail: apiMessage || "The provider rejected the request as invalid.",
      retryable: false,
      raw,
    };
  }
  return {
    kind: "unknown",
    title: `Request failed (${status})`,
    detail: apiMessage || "The provider returned an unexpected error.",
    retryable: false,
    raw,
  };
}

/** Backstop so a stalled LLM request can't hang the agent forever. */
const REQUEST_TIMEOUT_MS = 120_000;

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  // One controller drives both the caller's Stop signal and our own timeout, so
  // fetch is actually cancelled (RN fetch ignores everything but its signal).
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  // Distinguish our own timeout abort from the caller pressing Stop: both abort
  // the same controller, but only a timeout should surface as an error (a Stop
  // is reported as "stopped" by the loop).
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      // Caller pressed Stop: re-throw the raw abort so the loop treats it as a
      // clean stop rather than an error.
      if (signal?.aborted) throw e;
      if (timedOut) {
        throw new ProviderError(
          {
            kind: "timeout",
            title: "Request timed out",
            detail: `The provider didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s. Check your connection and try again.`,
            retryable: true,
            raw: e instanceof Error ? e.message : String(e),
          },
          0,
        );
      }
      throw new ProviderError(
        {
          kind: "network",
          title: "Couldn't reach the provider",
          detail: "The request failed before it got a response. Check your internet connection and try again.",
          retryable: true,
          raw: e instanceof Error ? e.message : String(e),
        },
        0,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ProviderError(classifyHttpError(res.status, text), res.status);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
