// Shared helpers for provider adapters.

import type { ExecResult } from "../protocol/messages.ts";

/** Provider identifiers persisted in settings. */
export type ProviderId = "anthropic" | "openai" | "gemini";

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

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}`);
  }
  return res.json();
}
