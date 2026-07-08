// Agent mode: a chat UI that runs the phone-side agent loop. The model issues
// run_shell_command calls; the client executes them on the Pi over BLE; results
// flow back into the loop. Each step is rendered so the user can audit it.

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Easing,
} from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { Ionicons } from "@expo/vector-icons";

import { MurmurClient } from "../client.ts";
import { runAgent } from "../agent/loop.ts";
import { formatResult } from "../providers/common.ts";
import type { ChatLine, LLMProvider, Turn } from "../agent/types.ts";
import { loadSystemPrompt, loadSudoPassword } from "../storage/keys.ts";
import {
  saveConversation,
  loadConversation,
  newConversationId,
  titleFromGoal,
} from "../storage/conversations.ts";
import { HistoryModal } from "../agent/History.tsx";
import { useTheme } from "../ThemeContext.tsx";
import type { ThemeColors } from "../theme.ts";
import { Markdown } from "../agent/Markdown.tsx";

interface Props {
  client: MurmurClient;
  provider: LLMProvider | null;
}

const USES_SUDO = /\bsudo\b/;

export function AgentScreen({ client, provider }: Props) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The running model transcript, persisted across questions so the agent keeps
  // context. runAgent appends to this array in place.
  const turnsRef = useRef<Turn[]>([]);
  // A ref mirror of `lines`, so we can snapshot the final transcript when saving
  // from inside an async callback without racing React's state batching.
  const linesRef = useRef<ChatLine[]>([]);
  // Identity of the conversation currently on screen. `convIdRef` is null until
  // the first message allocates one; then this chat is saved under that id.
  const convIdRef = useRef<string | null>(null);
  const createdAtRef = useRef<number>(0);
  const titleRef = useRef<string>("");
  const { colors } = useTheme();
  const headerHeight = useHeaderHeight();

  const push = (line: ChatLine) =>
    setLines((prev) => {
      const next = [...prev, line];
      linesRef.current = next;
      return next;
    });

  // Write the current chat (rendered lines + model transcript) to disk. No-op
  // until a conversation id has been allocated (i.e. after the first message).
  async function persist() {
    const id = convIdRef.current;
    if (!id) return;
    await saveConversation({
      id,
      title: titleRef.current || "New conversation",
      createdAt: createdAtRef.current || Date.now(),
      updatedAt: Date.now(),
      lines: linesRef.current,
      turns: turnsRef.current,
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
    // First message of a fresh chat allocates its persistent identity; the
    // title is taken from this opening goal and kept for the rest of the chat.
    if (!convIdRef.current) {
      convIdRef.current = newConversationId();
      createdAtRef.current = Date.now();
      titleRef.current = titleFromGoal(goal);
    }
    push({ kind: "user", text: goal });
    setRunning(true);
    // Read prompt + sudo password fresh each run so edits in Settings take
    // effect without remounting; undefined prompt falls back to the default.
    const systemPrompt = (await loadSystemPrompt()) ?? undefined;
    const sudoPassword = (await loadSudoPassword()) ?? undefined;
    const controller = new AbortController();
    abortRef.current = controller;
    // Only attach the password to commands that actually invoke sudo, to keep
    // the secret off the wire otherwise.
    const runCommand = (cmd: string, t?: number) =>
      client.exec(cmd, t, USES_SUDO.test(cmd) ? sudoPassword : undefined, controller.signal);
    try {
      for await (const ev of runAgent(provider, goal, runCommand, {
        systemPrompt,
        signal: controller.signal,
        history: turnsRef.current,
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
          case "stopped":
            push({ kind: "note", text: "Stopped." });
            break;
          case "error":
            push({ kind: "error", text: ev.message });
            break;
        }
        setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 0);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
      // Save the conversation (including any partial progress if it was
      // stopped or errored) so it survives relaunch and shows up in history.
      void persist();
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Clear the screen and detach from the current conversation id.
  function reset() {
    abortRef.current?.abort();
    turnsRef.current = [];
    linesRef.current = [];
    convIdRef.current = null;
    createdAtRef.current = 0;
    titleRef.current = "";
    setLines([]);
  }

  // Start a fresh conversation. Non-destructive: the current chat is already
  // saved to history (auto-saved after each run), so this just clears the
  // screen and detaches from the current conversation id.
  function newConversation() {
    if (lines.length === 0 && turnsRef.current.length === 0) return;
    reset();
  }

  // Load a saved conversation from history into the screen, restoring both the
  // rendered chat and the model transcript so it can be read and resumed.
  async function openConversation(id: string) {
    setHistoryOpen(false);
    if (id === convIdRef.current) return;
    const conv = await loadConversation(id);
    if (!conv) return;
    abortRef.current?.abort();
    convIdRef.current = conv.id;
    createdAtRef.current = conv.createdAt;
    titleRef.current = conv.title;
    turnsRef.current = conv.turns;
    linesRef.current = conv.lines;
    setLines(conv.lines);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 0);
  }

  // A conversation was deleted from the history list. If it's the one on
  // screen, detach so we don't re-save it under the just-deleted id.
  function handleDeleted(id: string) {
    if (id === convIdRef.current) reset();
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <View style={{ flex: 1, padding: 12 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 18,
          marginBottom: 8,
        }}
      >
        <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {provider ? (
            <>
              <Pill label={provider.name} colors={colors} tone="accent" />
              <Pill label={provider.model} colors={colors} tone="muted" />
            </>
          ) : (
            <Pill label="No provider — configure in Settings" colors={colors} tone="muted" />
          )}
        </View>
        <TouchableOpacity
          onPress={() => setHistoryOpen(true)}
          hitSlop={8}
          style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
        >
          <Ionicons name="time-outline" size={16} color={colors.textMid} />
          <Text style={{ color: colors.textMid, fontSize: 13 }}>History</Text>
        </TouchableOpacity>
        {lines.length > 0 && (
          <TouchableOpacity
            onPress={newConversation}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
          >
            <Ionicons name="create-outline" size={16} color={colors.textMid} />
            <Text style={{ color: colors.textMid, fontSize: 13 }}>New</Text>
          </TouchableOpacity>
        )}
      </View>

      <HistoryModal
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        currentId={convIdRef.current}
        onOpen={openConversation}
        onDeleted={handleDeleted}
        colors={colors}
      />

      <ScrollView ref={scrollRef} style={{ flex: 1 }}>
        {lines.map((l, i) => (
          <LineView key={i} line={l} colors={colors} />
        ))}
        {running && <ThinkingIndicator colors={colors} />}
      </ScrollView>

      <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Describe what to do on the Pi…"
          placeholderTextColor={colors.textMid}
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            padding: 10,
            color: colors.textHigh,
            backgroundColor: colors.surface,
          }}
        />
        <TouchableOpacity
          onPress={running ? stop : submit}
          style={{
            backgroundColor: running ? colors.danger : colors.accent,
            paddingHorizontal: 16,
            justifyContent: "center",
            borderRadius: 8,
          }}
        >
          <Text style={{ color: colors.accentText }}>{running ? "Stop" : "Send"}</Text>
        </TouchableOpacity>
      </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function LineView({ line, colors }: { line: ChatLine; colors: ThemeColors }) {
  switch (line.kind) {
    case "user":
      return (
        <Bubble color={colors.accent} textColor={colors.accentText} align="flex-end" text={line.text} />
      );
    case "assistant":
      return (
        <View style={{ alignSelf: "flex-start", maxWidth: "85%", marginVertical: 4 }}>
          <View style={{ backgroundColor: colors.surfaceAlt, borderRadius: 12, padding: 10 }}>
            <Markdown text={line.text} color={colors.textHigh} colors={colors} />
          </View>
        </View>
      );
    case "command":
      return <Mono prefix="$ " text={line.text} bg={colors.codeBg} fg={colors.term} />;
    case "result":
      return <Mono text={line.text} bg={colors.codeBgAlt} fg={colors.codeFg} />;
    case "denied":
      return <Mono prefix="denied: " text={line.text} bg={colors.codeBg} fg={colors.warn} />;
    case "error":
      return <Text style={{ color: colors.danger, marginVertical: 4 }}>{line.text}</Text>;
    case "note":
      return (
        <Text style={{ color: colors.textMid, marginVertical: 6, textAlign: "center", fontSize: 13 }}>
          {line.text}
        </Text>
      );
  }
}

const THINKING_WORDS = [
  "Cogitating", "Percolating", "Noodling", "Conjuring", "Tinkering",
  "Summoning", "Musing", "Whirring", "Pondering", "Scheming",
  "Brewing", "Finagling", "Ruminating", "Vibing", "Wrangling",
  "Spelunking", "Bamboozling", "Galloping", "Marinating", "Concocting",
];

const randomWord = () => THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];

/**
 * Animated status while the agent works: whimsical words that rotate every few
 * seconds, with a single-hue highlight that sweeps across the letters (a soft
 * left-to-right shimmer, not a rainbow). Plus elapsed time.
 */
function ThinkingIndicator({ colors }: { colors: ThemeColors }) {
  const anim = useRef(new Animated.Value(0)).current;
  const [word, setWord] = useState(randomWord);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: 1500,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: false, // color interpolation isn't native-driver-safe
      }),
    );
    loop.start();
    const start = Date.now();
    const words = setInterval(() => setWord(randomWord()), 2600);
    const secs = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => {
      loop.stop();
      clearInterval(words);
      clearInterval(secs);
    };
  }, [anim]);

  const chars = word.split("");
  const L = chars.length;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, marginBottom: 4 }}>
      <View style={{ flexDirection: "row" }}>
        {chars.map((ch, i) => {
          // Each letter fades dim -> bright -> dim, phase-shifted by its position
          // so a single highlight band travels across the word (left to right).
          const phase = Animated.modulo(Animated.add(anim, (L - i) / L), 1);
          const color = phase.interpolate({
            inputRange: [0, 0.5, 1],
            outputRange: [colors.textMid, colors.textHigh, colors.textMid],
          });
          return (
            <Animated.Text key={i} style={{ color, fontSize: 13, fontWeight: "600", letterSpacing: 0.2 }}>
              {ch}
            </Animated.Text>
          );
        })}
        <Text style={{ color: colors.textMid, fontSize: 13, fontWeight: "600" }}>…</Text>
      </View>
      <Text style={{ color: colors.textMid, fontSize: 11, marginLeft: 8 }}>{elapsed}s</Text>
    </View>
  );
}

function Pill({
  label,
  colors,
  tone,
}: {
  label: string;
  colors: ThemeColors;
  tone: "accent" | "muted";
}) {
  const accent = tone === "accent";
  return (
    <View
      style={{
        backgroundColor: accent ? colors.accent : colors.surfaceAlt,
        borderRadius: 999,
        paddingVertical: 3,
        paddingHorizontal: 10,
      }}
    >
      <Text
        style={{
          color: accent ? colors.accentText : colors.textMid,
          fontSize: 12,
          fontWeight: accent ? "600" : "400",
        }}
      >
        {label}
      </Text>
    </View>
  );
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
