// Agent mode: a chat UI that runs the phone-side agent loop. The model issues
// run_shell_command calls; the client executes them on the Pi over BLE; results
// flow back into the loop. Each step is rendered so the user can audit it.

import React, { useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  Alert,
} from "react-native";

import { MurmurClient } from "../client.ts";
import { runAgent } from "../agent/loop.ts";
import { formatResult } from "../providers/common.ts";
import type { LLMProvider } from "../agent/types.ts";

interface Props {
  client: MurmurClient;
  provider: LLMProvider | null;
}

interface Line {
  kind: "user" | "assistant" | "command" | "result" | "denied" | "error";
  text: string;
}

const DANGER = /\b(rm|mkfs|dd|shutdown|reboot|:\s*\(\)\s*\{|>\s*\/dev\/sd)\b|rm\s+-rf/;

export function AgentScreen({ client, provider }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [confirmDanger, setConfirmDanger] = useState(true);
  const scrollRef = useRef<ScrollView>(null);

  const push = (line: Line) =>
    setLines((prev) => {
      const next = [...prev, line];
      return next;
    });

  function confirm(command: string): Promise<boolean> {
    if (!confirmDanger || !DANGER.test(command)) return Promise.resolve(true);
    return new Promise((resolve) => {
      Alert.alert("Run this command?", command, [
        { text: "Deny", style: "cancel", onPress: () => resolve(false) },
        { text: "Run", style: "destructive", onPress: () => resolve(true) },
      ]);
    });
  }

  async function submit() {
    const goal = input.trim();
    if (!goal || running) return;
    if (!provider) {
      push({ kind: "error", text: "No LLM provider configured — set an API key in Settings." });
      return;
    }
    setInput("");
    push({ kind: "user", text: goal });
    setRunning(true);
    try {
      for await (const ev of runAgent(provider, goal, (cmd, t) => client.exec(cmd, t), {
        confirm,
      })) {
        switch (ev.type) {
          case "assistant":
            push({ kind: "assistant", text: ev.text });
            break;
          case "command":
            push({ kind: "command", text: ev.command });
            break;
          case "command_denied":
            push({ kind: "denied", text: ev.command });
            break;
          case "result":
            push({ kind: "result", text: formatResult(ev.result) });
            break;
          case "error":
            push({ kind: "error", text: ev.message });
            break;
        }
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 0);
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
        <Text style={{ flex: 1, fontSize: 18, fontWeight: "700" }}>
          Agent {provider ? `· ${provider.name}` : ""}
        </Text>
        <Text style={{ marginRight: 6 }}>Confirm risky</Text>
        <Switch value={confirmDanger} onValueChange={setConfirmDanger} />
      </View>

      <ScrollView ref={scrollRef} style={{ flex: 1 }}>
        {lines.map((l, i) => (
          <LineView key={i} line={l} />
        ))}
        {running && <Text style={{ color: "#888", marginTop: 6 }}>…working</Text>}
      </ScrollView>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Describe what to do on the Pi…"
          style={{ flex: 1, borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
        />
        <TouchableOpacity
          onPress={submit}
          disabled={running}
          style={{
            backgroundColor: running ? "#9ca3af" : "#2563eb",
            paddingHorizontal: 16,
            justifyContent: "center",
            borderRadius: 8,
          }}
        >
          <Text style={{ color: "#fff" }}>Send</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function LineView({ line }: { line: Line }) {
  switch (line.kind) {
    case "user":
      return <Bubble color="#2563eb" textColor="#fff" align="flex-end" text={line.text} />;
    case "assistant":
      return <Bubble color="#f3f4f6" textColor="#111" align="flex-start" text={line.text} />;
    case "command":
      return <Mono prefix="$ " text={line.text} bg="#111" fg="#0f0" />;
    case "result":
      return <Mono text={line.text} bg="#1f2937" fg="#d1d5db" />;
    case "denied":
      return <Mono prefix="denied: " text={line.text} bg="#111" fg="#f59e0b" />;
    case "error":
      return <Text style={{ color: "#dc2626", marginVertical: 4 }}>{line.text}</Text>;
  }
}

function Bubble(props: { color: string; textColor: string; align: "flex-start" | "flex-end"; text: string }) {
  return (
    <View style={{ alignSelf: props.align, maxWidth: "85%", marginVertical: 4 }}>
      <View style={{ backgroundColor: props.color, borderRadius: 12, padding: 10 }}>
        <Text style={{ color: props.textColor }}>{props.text}</Text>
      </View>
    </View>
  );
}

function Mono(props: { text: string; bg: string; fg: string; prefix?: string }) {
  return (
    <View style={{ backgroundColor: props.bg, borderRadius: 8, padding: 8, marginVertical: 4 }}>
      <Text style={{ color: props.fg, fontFamily: "monospace", fontSize: 12 }}>
        {(props.prefix ?? "") + props.text}
      </Text>
    </View>
  );
}
