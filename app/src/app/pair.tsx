// Pairing route: paste the base64 key printed by `murmurd --pair`, store it,
// and connect.

import React, { useMemo, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useConnection } from "../ConnectionContext.tsx";
import { useTheme } from "../ThemeContext.tsx";
import { savePsk, loadPsk, rememberDevice } from "../storage/keys.ts";
import type { ThemeColors } from "../theme.ts";

export default function PairRoute() {
  const router = useRouter();
  const { deviceId, name } = useLocalSearchParams<{ deviceId: string; name?: string }>();
  const { connectWithPsk } = useConnection();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [psk, setPsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pair() {
    const trimmed = psk.trim();
    if (!trimmed || !deviceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await savePsk(deviceId, trimmed);
      const bytes = await loadPsk(deviceId);
      if (!bytes) throw new Error("could not store key");
      await rememberDevice(deviceId, name ?? "");
      await connectWithPsk(deviceId, bytes);
      router.replace("/(tabs)/shell");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Pair “{name || deviceId}”</Text>
      <Text style={styles.body}>
        Run <Text style={styles.mono}>murmurd --pair</Text> on the Pi and paste the key it prints:
      </Text>
      <TextInput
        value={psk}
        onChangeText={setPsk}
        placeholder="base64 pairing key"
        placeholderTextColor={colors.textMid}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        style={styles.input}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <TouchableOpacity
        style={[styles.button, busy && styles.buttonDisabled]}
        onPress={pair}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color={colors.accentText} />
        ) : (
          <Text style={styles.buttonText}>Pair & connect</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, padding: 20, gap: 12 },
    title: { fontSize: 18, fontWeight: "600", color: colors.textHigh },
    body: { color: colors.textMid },
    mono: { fontFamily: "monospace", color: colors.textHigh },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 10,
      color: colors.textHigh,
      backgroundColor: colors.surface,
    },
    button: { backgroundColor: colors.accent, padding: 12, borderRadius: 8 },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: colors.accentText, textAlign: "center" },
    error: { color: colors.danger },
  });
