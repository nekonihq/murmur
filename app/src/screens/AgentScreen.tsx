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
import type { AgentError, ChatLine, LLMProvider, Turn } from "../agent/types.ts";
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
  deviceId: string;
}

const USES_SUDO = /\bsudo\b/;

export function AgentScreen({ client, provider, deviceId }: Props) {
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
  // The most recent goal, kept so a failed run can be re-sent with one tap
  // without the user retyping it.
  const lastGoalRef = useRef<string>("");
  const { colors } = useTheme();
  const headerHeight = useHeaderHeight();

  const push = (line: ChatLine) =>
    setLines((prev) => {
      const next = [...prev, line];
      linesRef.current = next;
      return next;
    });

  // Scroll after the pushed line has been laid out, otherwise scrollToEnd
  // measures the content height from before it was added and lands short.
  const scrollToBottom = (animated = true) =>
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated }), 0);

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
      push({
        kind: "error",
        text: "No provider configured",
        error: {
          kind: "auth",
          title: "No LLM provider configured",
          detail: "Set an API key in Settings to start chatting.",
          retryable: false,
        },
      });
      return;
    }
    setInput("");
    await runGoal(goal, { echoUser: true });
  }

  // Re-send the last goal after a failure. The user's bubble is already on
  // screen, so we drop the trailing error line and re-run without echoing a new
  // one. A failed first call rolled the transcript back to its last-good state,
  // so this retry is clean (no compounding of the rejected content).
  async function retry() {
    if (running || !provider || !lastGoalRef.current) return;
    setLines((prev) => {
      const next = prev.at(-1)?.kind === "error" ? prev.slice(0, -1) : prev.slice();
      linesRef.current = next;
      return next;
    });
    await runGoal(lastGoalRef.current, { echoUser: false });
  }

  // Drive one agent run for `goal`, streaming its events into the chat. With
  // `echoUser`, a user bubble is pushed first (a fresh message); a retry passes
  // false because that bubble is already present.
  async function runGoal(goal: string, { echoUser }: { echoUser: boolean }) {
    if (!provider) return;
    lastGoalRef.current = goal;
    // First message of a fresh chat allocates its persistent identity; the
    // title is taken from this opening goal and kept for the rest of the chat.
    if (!convIdRef.current) {
      convIdRef.current = newConversationId();
      createdAtRef.current = Date.now();
      titleRef.current = titleFromGoal(goal);
    }
    if (echoUser) {
      push({ kind: "user", text: goal });
      scrollToBottom();
    }
    setRunning(true);
    // Read prompt + sudo password fresh each run so edits in Settings take
    // effect without remounting; undefined prompt falls back to the default.
    const systemPrompt = (await loadSystemPrompt()) ?? undefined;
    const sudoPassword = (await loadSudoPassword(deviceId)) ?? undefined;
    const controller = new AbortController();
    abortRef.current = controller;
    // Only attach the password to commands that actually invoke sudo, to keep
    // the secret off the wire otherwise.
    const runCommand = (cmd: string, t?: number) =>
      client.exec(cmd, t, USES_SUDO.test(cmd) ? sudoPassword : undefined, controller.signal);
    // Track whether the run got past the first LLM call. If it errors without
    // producing anything, the loop rolled the failed turn out of `turns` — so we
    // roll the echoed user bubble out of the display too, keeping the transcript
    // and the on-screen chat in lockstep (drop-last-exchange relies on this).
    let producedContent = false;
    let errored = false;
    try {
      for await (const ev of runAgent(provider, goal, runCommand, {
        systemPrompt,
        signal: controller.signal,
        history: turnsRef.current,
      })) {
        switch (ev.type) {
          case "assistant":
            push({ kind: "assistant", text: ev.text });
            producedContent = true;
            break;
          case "command":
            push({ kind: "command", text: ev.command });
            producedContent = true;
            break;
          case "command_denied":
            push({ kind: "denied", text: ev.command });
            producedContent = true;
            break;
          case "result":
            push({ kind: "result", text: formatResult(ev.result) });
            producedContent = true;
            break;
          case "stopped":
            push({ kind: "note", text: "Stopped." });
            producedContent = true;
            break;
          case "error":
            push({ kind: "error", text: ev.error.title, error: ev.error });
            errored = true;
            break;
        }
        scrollToBottom();
      }
    } finally {
      if (errored && !producedContent && echoUser) {
        // Remove the echoed user bubble (now the second-to-last line, before the
        // error) so the display no longer shows a message the model never kept.
        setLines((prev) => {
          const next = prev.slice();
          if (next.length >= 2 && next[next.length - 2].kind === "user") {
            next.splice(next.length - 2, 1);
          }
          linesRef.current = next;
          return next;
        });
      }
      setRunning(false);
      abortRef.current = null;
      // Save the conversation (including any partial progress if it was
      // stopped or errored) so it survives relaunch and shows up in history.
      void persist();
    }
  }

  // Back out of a wedged conversation: drop the most recent exchange (the last
  // user message and everything the agent produced answering it) from BOTH the
  // model transcript and the display. A content-filter block depends on the
  // surrounding context, so removing the exchange that carries the flagged
  // content lets the chat continue instead of hitting the same wall forever.
  // Repeatable — each block offers it again, so the user can walk back as far as
  // needed.
  function dropLastExchange() {
    if (running) return;
    const turns = turnsRef.current;
    let turnCut = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        turnCut = i;
        break;
      }
    }
    if (turnCut < 0) return; // nothing to remove
    turnsRef.current = turns.slice(0, turnCut);

    setLines((prev) => {
      let lineCut = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].kind === "user") {
          lineCut = i;
          break;
        }
      }
      const next = lineCut < 0 ? [] : prev.slice(0, lineCut);
      linesRef.current = next;
      return next;
    });
    void persist();
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
    scrollToBottom(false);
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
        onClearedAll={reset}
        colors={colors}
      />

      <ScrollView ref={scrollRef} style={{ flex: 1 }}>
        {lines.map((l, i) => {
          // Recovery actions live only on the last line, and only while idle, so
          // an old error buried in the transcript doesn't sprout stale buttons.
          const isLast = i === lines.length - 1 && !running;
          // "Remove last exchange" only helps context-driven blocks — offer it
          // for those, when there's actually an exchange to drop.
          const contextBlock =
            l.error?.kind === "content_filter" || l.error?.kind === "invalid_request";
          return (
            <LineView
              key={i}
              line={l}
              colors={colors}
              onRetry={isLast ? retry : undefined}
              onRemoveLast={
                isLast && contextBlock && turnsRef.current.length > 0 ? dropLastExchange : undefined
              }
            />
          );
        })}
        {running && <ThinkingIndicator colors={colors} />}
      </ScrollView>

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, marginTop: 8 }}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Describe what to do on the Pi…"
          placeholderTextColor={colors.textMid}
          multiline
          style={{
            flex: 1,
            minHeight: 44,
            maxHeight: 140,
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 10,
            color: colors.textHigh,
            backgroundColor: colors.surface,
          }}
        />
        <TouchableOpacity
          onPress={running ? stop : submit}
          style={{
            backgroundColor: running ? colors.danger : colors.accent,
            height: 44,
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

function LineView({
  line,
  colors,
  onRetry,
  onRemoveLast,
}: {
  line: ChatLine;
  colors: ThemeColors;
  onRetry?: () => void;
  onRemoveLast?: () => void;
}) {
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
      return (
        <ErrorCard
          error={line.error}
          fallback={line.text}
          colors={colors}
          onRetry={onRetry}
          onRemoveLast={onRemoveLast}
        />
      );
    case "note":
      return (
        <Text style={{ color: colors.textMid, marginVertical: 6, textAlign: "center", fontSize: 13 }}>
          {line.text}
        </Text>
      );
  }
}

const ERROR_ICONS: Record<AgentError["kind"], keyof typeof Ionicons.glyphMap> = {
  content_filter: "shield-half-outline",
  auth: "key-outline",
  rate_limit: "hourglass-outline",
  overloaded: "cloud-offline-outline",
  invalid_request: "alert-circle-outline",
  server: "cloud-offline-outline",
  network: "wifi-outline",
  timeout: "time-outline",
  step_limit: "stop-circle-outline",
  unknown: "alert-circle-outline",
};

/**
 * A failure rendered as a bordered card: an icon + title, a plain-language
 * explanation, a one-tap Retry when it might help, and the raw provider message
 * tucked behind a "Details" toggle — instead of dumping an HTTP body in red.
 */
function ErrorCard({
  error,
  fallback,
  colors,
  onRetry,
  onRemoveLast,
}: {
  error?: AgentError;
  fallback: string;
  colors: ThemeColors;
  onRetry?: () => void;
  onRemoveLast?: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  // Older saved conversations stored errors as plain text; render those simply.
  if (!error) {
    return <Text style={{ color: colors.danger, marginVertical: 4 }}>{fallback}</Text>;
  }
  return (
    <View
      style={{
        marginVertical: 6,
        borderWidth: 1,
        borderColor: colors.danger,
        borderRadius: 10,
        backgroundColor: colors.surface,
        padding: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Ionicons name={ERROR_ICONS[error.kind]} size={18} color={colors.danger} />
        <Text style={{ color: colors.danger, fontWeight: "600", fontSize: 14, flex: 1 }}>
          {error.title}
        </Text>
      </View>
      <Text style={{ color: colors.textMid, fontSize: 13, marginTop: 6, lineHeight: 18 }}>
        {error.detail}
      </Text>

      <View style={{ flexDirection: "row", alignItems: "center", gap: 16, marginTop: 10 }}>
        {onRemoveLast && (
          <TouchableOpacity
            onPress={onRemoveLast}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
          >
            <Ionicons name="arrow-undo" size={15} color={colors.accent} />
            <Text style={{ color: colors.accent, fontSize: 13, fontWeight: "600" }}>
              Remove last exchange
            </Text>
          </TouchableOpacity>
        )}
        {error.retryable && onRetry && (
          <TouchableOpacity
            onPress={onRetry}
            hitSlop={8}
            style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
          >
            <Ionicons name="refresh" size={15} color={onRemoveLast ? colors.textMid : colors.accent} />
            <Text
              style={{
                color: onRemoveLast ? colors.textMid : colors.accent,
                fontSize: 13,
                fontWeight: "600",
              }}
            >
              Retry
            </Text>
          </TouchableOpacity>
        )}
        {error.raw && (
          <TouchableOpacity onPress={() => setShowRaw((v) => !v)} hitSlop={8}>
            <Text style={{ color: colors.textMid, fontSize: 13 }}>
              {showRaw ? "Hide details" : "Details"}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {showRaw && error.raw && (
        <View
          style={{
            marginTop: 10,
            backgroundColor: colors.codeBg,
            borderRadius: 8,
            padding: 8,
          }}
        >
          <Text style={{ color: colors.codeFg, fontFamily: "monospace", fontSize: 11 }}>
            {error.raw}
          </Text>
        </View>
      )}
    </View>
  );
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
