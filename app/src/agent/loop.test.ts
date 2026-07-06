// Run with: node --test src/agent/loop.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { runAgent, type RunCommand } from "./loop.ts";
import type { ExecResult } from "../protocol/messages.ts";
import type { AgentEvent, LLMProvider, ProviderTurn, Turn } from "./types.ts";

/** A provider that replays a fixed script of turns regardless of input. */
function scriptedProvider(script: ProviderTurn[]): LLMProvider {
  let i = 0;
  return {
    name: "fake",
    model: "fake-1",
    async next(_system: string, _turns: Turn[]): Promise<ProviderTurn> {
      return script[i++] ?? { text: "", toolCalls: [] };
    },
  };
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exit_code: 0, truncated: false };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

test("runs a tool call, feeds result back, then completes", async () => {
  const provider = scriptedProvider([
    { text: "Checking the kernel.", toolCalls: [{ id: "c1", command: "uname -r" }] },
    { text: "It is 6.6.0.", toolCalls: [] },
  ]);
  const ran: string[] = [];
  const runCommand: RunCommand = async (cmd) => {
    ran.push(cmd);
    return ok("6.6.0\n");
  };

  const events = await collect(runAgent(provider, "what kernel?", runCommand));

  assert.deepEqual(ran, ["uname -r"]);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["assistant", "command", "result", "assistant", "done"]);
});

test("history carries conversation context across separate runs", async () => {
  const history: Turn[] = [];
  const seen: Turn[][] = [];
  const provider: LLMProvider = {
    name: "fake",
    model: "fake-1",
    async next(_s, turns) {
      seen.push(structuredClone(turns));
      return { text: "ok", toolCalls: [] };
    },
  };
  const noop: RunCommand = async () => ok("");

  await collect(runAgent(provider, "first question", noop, { history }));
  await collect(runAgent(provider, "second question", noop, { history }));

  // The second run's provider call must still see the first exchange.
  const userTexts = seen
    .at(-1)!
    .filter((t): t is Extract<Turn, { role: "user" }> => t.role === "user")
    .map((t) => t.text);
  assert.deepEqual(userTexts, ["first question", "second question"]);
});

test("an aborted signal stops the run before the next command", async () => {
  const controller = new AbortController();
  const provider = scriptedProvider([
    { text: "first", toolCalls: [{ id: "c1", command: "one" }] },
    { text: "second", toolCalls: [{ id: "c2", command: "two" }] },
  ]);
  const ran: string[] = [];
  const runCommand: RunCommand = async (cmd) => {
    ran.push(cmd);
    controller.abort(); // stop mid-run, after the first command completes
    return ok("");
  };

  const events = await collect(
    runAgent(provider, "go", runCommand, { signal: controller.signal }),
  );

  assert.deepEqual(ran, ["one"]); // the second command never runs
  assert.equal(events.at(-1)?.type, "stopped");
});

test("passes the command result back into the next provider call", async () => {
  const seen: Turn[][] = [];
  let i = 0;
  const script: ProviderTurn[] = [
    { text: "", toolCalls: [{ id: "c1", command: "echo hi" }] },
    { text: "done", toolCalls: [] },
  ];
  const provider: LLMProvider = {
    name: "fake",
    model: "fake-1",
    async next(_s, turns) {
      seen.push(structuredClone(turns));
      return script[i++];
    },
  };
  await collect(runAgent(provider, "go", async () => ok("hi\n")));

  // Second provider call must see the tool result turn.
  const secondCallTurns = seen[1];
  const toolTurn = secondCallTurns.find((t) => t.role === "tool");
  assert.ok(toolTurn, "tool result should be in the transcript");
});

test("confirm=false denies the command and the model is told", async () => {
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ id: "c1", command: "rm -rf /" }] },
    { text: "ok, stopping", toolCalls: [] },
  ]);
  let called = false;
  const runCommand: RunCommand = async () => {
    called = true;
    return ok("");
  };

  const events = await collect(
    runAgent(provider, "delete everything", runCommand, { confirm: () => false }),
  );

  assert.equal(called, false, "denied command must not run");
  assert.ok(events.some((e) => e.type === "command_denied"));
});

test("stops at maxSteps to prevent runaway loops", async () => {
  // Provider always asks for another command.
  const provider: LLMProvider = {
    name: "loopy",
    model: "fake-1",
    async next() {
      return { text: "", toolCalls: [{ id: "x", command: "true" }] };
    },
  };
  const events = await collect(
    runAgent(provider, "go", async () => ok(""), { maxSteps: 3 }),
  );
  const last = events[events.length - 1];
  assert.equal(last.type, "error");
});

test("surfaces transport errors as a failed result, not a crash", async () => {
  const provider = scriptedProvider([
    { text: "", toolCalls: [{ id: "c1", command: "oops" }] },
    { text: "recovered", toolCalls: [] },
  ]);
  const runCommand: RunCommand = async () => {
    throw new Error("BLE disconnected");
  };
  const events = await collect(runAgent(provider, "go", runCommand));
  const result = events.find((e) => e.type === "result");
  assert.ok(result && result.type === "result");
  assert.match(result.result.stderr, /BLE disconnected/);
});
