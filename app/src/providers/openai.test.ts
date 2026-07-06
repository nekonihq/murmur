import { test } from "node:test";
import assert from "node:assert/strict";

import { toOpenAIMessages } from "./openai.ts";
import type { Turn } from "../agent/types.ts";

test("assistant turn with tool calls includes a non-empty tool_calls array", () => {
  const turn: Turn = {
    role: "assistant",
    text: "running it",
    toolCalls: [{ id: "c1", command: "uname -r" }],
  };
  const [msg] = toOpenAIMessages(turn) as Array<Record<string, unknown>>;
  assert.equal(msg.role, "assistant");
  assert.equal(msg.content, "running it");
  assert.ok(Array.isArray(msg.tool_calls) && (msg.tool_calls as unknown[]).length === 1);
});

test("final assistant turn (no tool calls) omits tool_calls entirely", () => {
  // This is the shape replayed from history that made OpenAI 400 on an empty
  // tool_calls array.
  const turn: Turn = { role: "assistant", text: "all done", toolCalls: [] };
  const [msg] = toOpenAIMessages(turn) as Array<Record<string, unknown>>;
  assert.equal(msg.content, "all done");
  assert.ok(!("tool_calls" in msg), "tool_calls must be absent when empty");
});

test("assistant turn with neither text nor tool calls sends a string content", () => {
  const turn: Turn = { role: "assistant", text: "", toolCalls: [] };
  const [msg] = toOpenAIMessages(turn) as Array<Record<string, unknown>>;
  assert.equal(msg.content, ""); // must be a string, not null, when no tool_calls
  assert.ok(!("tool_calls" in msg));
});
