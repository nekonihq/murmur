// Manage the bring-your-own LLM provider: pick a provider, paste an API key,
// optionally override the model. Keys are stored in the OS secure store. Also
// hosts the appearance (light/dark/system) selector.

import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import { useRouter } from "expo-router";

import {
  DEFAULT_MODELS,
  PROVIDER_LABELS,
  type ProviderId,
} from "../providers/index.ts";
import {
  loadProvider,
  saveProvider,
  loadSelectedProvider,
  saveSelectedProvider,
  loadSystemPrompt,
  saveSystemPrompt,
  loadSudoPassword,
  saveSudoPassword,
  forgetDevice,
  deleteAllData,
} from "../storage/keys.ts";
import { deleteAllConversations } from "../storage/conversations.ts";
import { DEFAULT_SYSTEM_PROMPT } from "../agent/types.ts";
import { useConnection } from "../ConnectionContext.tsx";
import { useTheme } from "../ThemeContext.tsx";
import type { ThemeColors, ThemeMode } from "../theme.ts";

const PROVIDERS: ProviderId[] = ["anthropic", "openai", "gemini", "openrouter"];
const THEME_MODES: { id: ThemeMode; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

interface Props {
  onChanged?: () => void;
}

export function SettingsScreen({ onChanged }: Props) {
  const { colors, mode, setMode } = useTheme();
  const { deviceId, disconnect } = useConnection();
  const router = useRouter();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const headerHeight = useHeaderHeight();
  const [selected, setSelected] = useState<ProviderId>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [sudoPassword, setSudoPassword] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const sel = (await loadSelectedProvider()) ?? "anthropic";
      setSelected(sel);
      const stored = await loadProvider(sel);
      setApiKey(stored?.apiKey ?? "");
      setModel(stored?.model ?? "");
      setSystemPrompt((await loadSystemPrompt()) ?? "");
      setSudoPassword((deviceId && (await loadSudoPassword(deviceId))) || "");
    })();
  }, [deviceId]);

  async function pick(id: ProviderId) {
    setSelected(id);
    setSaved(false);
    const stored = await loadProvider(id);
    setApiKey(stored?.apiKey ?? "");
    setModel(stored?.model ?? "");
  }

  async function save() {
    await saveProvider(selected, {
      apiKey: apiKey.trim(),
      model: model.trim() || undefined,
    });
    await saveSelectedProvider(selected);
    await saveSystemPrompt(systemPrompt);
    if (deviceId) await saveSudoPassword(deviceId, sudoPassword);
    setSaved(true);
    onChanged?.();
  }

  // Drop the current Pi's pairing key and return to the device list. Requires
  // re-pairing to reconnect.
  function forgetThisDevice() {
    const id = deviceId;
    if (!id) return;
    Alert.alert(
      "Forget this device?",
      "Removes its pairing key from this phone. You'll need to pair again to reconnect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: async () => {
            await forgetDevice(id);
            await disconnect(); // client goes null → tabs redirect to the device list
          },
        },
      ],
    );
  }

  function clearHistory() {
    Alert.alert(
      "Clear conversation history?",
      "Deletes all saved agent conversations from this phone. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => void deleteAllConversations(),
        },
      ],
    );
  }

  // Nuke everything: pairings, API keys, sudo password, prompt, history, prefs.
  function deleteEverything() {
    Alert.alert(
      "Delete all data?",
      "Erases all pairings, API keys, the sudo password, agent history, and preferences from this phone. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete everything",
          style: "destructive",
          onPress: async () => {
            await deleteAllData();
            setMode("system");
            setApiKey("");
            setModel("");
            setSystemPrompt("");
            setSudoPassword("");
            onChanged?.(); // provider is gone now
            await disconnect(); // → device list
            router.replace("/");
          },
        },
      ],
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={headerHeight}
    >
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
      <Text style={styles.heading}>Appearance</Text>
      <View style={styles.chipRow}>
        {THEME_MODES.map(({ id, label }) => (
          <Chip key={id} styles={styles} active={mode === id} label={label} onPress={() => setMode(id)} />
        ))}
      </View>

      <Text style={styles.heading}>LLM provider</Text>
      <View style={styles.chipRow}>
        {PROVIDERS.map((id) => (
          <Chip
            key={id}
            styles={styles}
            active={selected === id}
            label={PROVIDER_LABELS[id]}
            onPress={() => pick(id)}
          />
        ))}
      </View>

      <Text style={styles.label}>API key (stored in the device keychain)</Text>
      <TextInput
        value={apiKey}
        onChangeText={(t) => {
          setApiKey(t);
          setSaved(false);
        }}
        placeholder="sk-…"
        placeholderTextColor={colors.textMid}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
      />

      <Text style={styles.label}>Model (optional)</Text>
      <TextInput
        value={model}
        onChangeText={(t) => {
          setModel(t);
          setSaved(false);
        }}
        placeholder={DEFAULT_MODELS[selected]}
        placeholderTextColor={colors.textMid}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />

      <View style={styles.promptHeader}>
        <Text style={[styles.heading, { marginBottom: 0 }]}>Agent system prompt</Text>
        {systemPrompt.trim().length > 0 && (
          <TouchableOpacity
            onPress={() => {
              setSystemPrompt("");
              setSaved(false);
            }}
          >
            <Text style={styles.reset}>Reset to default</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.label}>
        Instructions the agent follows. Leave blank to use the built-in default.
      </Text>
      <TextInput
        value={systemPrompt}
        onChangeText={(t) => {
          setSystemPrompt(t);
          setSaved(false);
        }}
        placeholder={DEFAULT_SYSTEM_PROMPT}
        placeholderTextColor={colors.textMid}
        multiline
        textAlignVertical="top"
        autoCapitalize="sentences"
        style={[styles.input, styles.promptInput]}
      />

      <Text style={[styles.heading, { marginTop: 8 }]}>sudo password</Text>
      <Text style={styles.label}>
        Lets the agent run sudo commands on the Pi. Stored in the device keychain and sent
        only for commands that use sudo. Leave blank if sudo needs no password (NOPASSWD).
      </Text>
      <TextInput
        value={sudoPassword}
        onChangeText={(t) => {
          setSudoPassword(t);
          setSaved(false);
        }}
        placeholder="sudo password"
        placeholderTextColor={colors.textMid}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={styles.input}
      />

      <TouchableOpacity onPress={save} style={styles.button}>
        <Text style={styles.buttonText}>Save</Text>
      </TouchableOpacity>
      {saved && <Text style={styles.savedText}>Saved.</Text>}

      <Text style={[styles.heading, styles.dangerHeading]}>Data</Text>
      {deviceId && (
        <DangerButton styles={styles} label="Forget this device" onPress={forgetThisDevice} />
      )}
      <DangerButton styles={styles} label="Clear conversation history" onPress={clearHistory} />
      <DangerButton
        styles={styles}
        label="Delete all data"
        onPress={deleteEverything}
        filled
      />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Chip({
  styles,
  active,
  label,
  onPress,
}: {
  styles: ReturnType<typeof createStyles>;
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

// A destructive action. `filled` makes it a solid red button (for the most
// severe action); otherwise it's an outlined red button.
function DangerButton({
  styles,
  label,
  onPress,
  filled,
}: {
  styles: ReturnType<typeof createStyles>;
  label: string;
  onPress: () => void;
  filled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.dangerButton, filled ? styles.dangerButtonFilled : styles.dangerButtonOutline]}
    >
      <Text style={filled ? styles.dangerButtonFilledText : styles.dangerButtonText}>{label}</Text>
    </TouchableOpacity>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.bg },
    // Extra bottom padding so the last fields scroll clear of the keyboard.
    content: { padding: 16, paddingBottom: 48 },
    heading: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.textHigh,
      marginBottom: 12,
      marginTop: 4,
    },
    chipRow: { flexDirection: "row", gap: 8, marginBottom: 20, flexWrap: "wrap" },
    chip: {
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 20,
      backgroundColor: colors.surfaceAlt,
    },
    chipActive: { backgroundColor: colors.accent },
    chipText: { color: colors.textHigh },
    chipTextActive: { color: colors.accentText, fontWeight: "600" },
    label: { marginBottom: 4, color: colors.textMid },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      padding: 10,
      marginBottom: 16,
      color: colors.textHigh,
      backgroundColor: colors.surface,
    },
    promptHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 4,
    },
    promptInput: { minHeight: 120 },
    reset: { color: colors.accent, fontSize: 13 },
    button: { backgroundColor: colors.accent, padding: 12, borderRadius: 8 },
    buttonText: { color: colors.accentText, textAlign: "center" },
    savedText: { color: colors.success, marginTop: 8, textAlign: "center" },
    dangerHeading: { marginTop: 36, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 20 },
    dangerButton: { padding: 12, borderRadius: 8, marginBottom: 10 },
    dangerButtonOutline: { borderWidth: 1, borderColor: colors.danger },
    dangerButtonFilled: { backgroundColor: colors.danger },
    dangerButtonText: { color: colors.danger, textAlign: "center", fontWeight: "600" },
    dangerButtonFilledText: { color: colors.accentText, textAlign: "center", fontWeight: "600" },
  });
