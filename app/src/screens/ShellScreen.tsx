// Shell mode: the xterm terminal with an accessory key bar pinned just above the
// keyboard — Esc, Tab, a sticky Ctrl modifier, arrows — plus copy/paste.

import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { MurmurClient } from "../client.ts";
import { Terminal, type TerminalHandle } from "../terminal/Terminal.tsx";
import { colors } from "../theme.ts";

interface Props {
  client: MurmurClient;
}

const ESC = Uint8Array.of(0x1b);
const TAB = Uint8Array.of(0x09);
const UP = Uint8Array.of(0x1b, 0x5b, 0x41);
const DOWN = Uint8Array.of(0x1b, 0x5b, 0x42);
const RIGHT = Uint8Array.of(0x1b, 0x5b, 0x43);
const LEFT = Uint8Array.of(0x1b, 0x5b, 0x44);

/** Map a typed byte to its control code (Ctrl+letter): 'c'/'C' -> 0x03, etc. */
function toCtrl(bytes: Uint8Array): Uint8Array {
  return bytes.length ? Uint8Array.of(bytes[0] & 0x1f) : bytes;
}

export function ShellScreen({ client }: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const opened = useRef(false);
  const ctrlArmed = useRef(false);
  const [ctrlOn, setCtrlOn] = useState(false);
  // The Shell tab hides the nav header, so the only thing above the keyboard-
  // avoiding view is the status-bar safe area.
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void client.openShell(80, 24, (bytes) => termRef.current?.write(bytes));
  }, [client]);

  function setCtrl(on: boolean) {
    ctrlArmed.current = on;
    setCtrlOn(on);
  }

  function handleInput(bytes: Uint8Array) {
    if (ctrlArmed.current) {
      client.sendStdin(toCtrl(bytes));
      setCtrl(false);
      return;
    }
    client.sendStdin(bytes);
  }

  function sendKey(seq: Uint8Array) {
    client.sendStdin(seq);
    if (ctrlArmed.current) setCtrl(false);
    termRef.current?.focus();
  }

  return (
    <SafeAreaView edges={["top"]} style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top}
      >
        <Terminal
          ref={termRef}
          onInput={handleInput}
          onResize={(cols, rows) => client.resize(cols, rows)}
        />
      <View style={styles.barWrap}>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.barContent}
        >
          <Key label="esc" onPress={() => sendKey(ESC)} />
          <Key label="tab" onPress={() => sendKey(TAB)} />
          <Key
            label="ctrl"
            active={ctrlOn}
            onPress={() => {
              setCtrl(!ctrlArmed.current);
              termRef.current?.focus();
            }}
          />
          <Key label="←" onPress={() => sendKey(LEFT)} />
          <Key label="↑" onPress={() => sendKey(UP)} />
          <Key label="↓" onPress={() => sendKey(DOWN)} />
          <Key label="→" onPress={() => sendKey(RIGHT)} />
          <View style={styles.divider} />
          <Key label="copy" onPress={() => termRef.current?.copy()} />
          <Key label="paste" onPress={() => void termRef.current?.paste()} />
          <Key label="⤓" onPress={() => termRef.current?.scrollToBottom()} />
        </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Key({
  label,
  onPress,
  active,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.key, active && styles.keyActive]}>
      <Text style={[styles.keyText, active && styles.keyTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

const BAR_HEIGHT = 48;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#000" },
  container: { flex: 1, backgroundColor: "#000" },
  barWrap: {
    height: BAR_HEIGHT,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  barContent: { alignItems: "center", gap: 6, paddingHorizontal: 8 },
  divider: { width: 1, height: 22, backgroundColor: colors.border, marginHorizontal: 2 },
  key: {
    minWidth: 40,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    backgroundColor: colors.surfaceAlt,
  },
  keyActive: { backgroundColor: colors.accent },
  keyText: { color: colors.textHigh, fontSize: 14 },
  keyTextActive: { color: "#fff", fontWeight: "700" },
});
