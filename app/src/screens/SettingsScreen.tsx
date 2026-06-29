// Manage the bring-your-own LLM provider: pick a provider, paste an API key,
// optionally override the model. Keys are stored in the OS secure store.

import React, { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, ScrollView } from "react-native";

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
} from "../storage/keys.ts";

const PROVIDERS: ProviderId[] = ["anthropic", "openai", "gemini"];

interface Props {
  onChanged?: () => void;
}

export function SettingsScreen({ onChanged }: Props) {
  const [selected, setSelected] = useState<ProviderId>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void (async () => {
      const sel = (await loadSelectedProvider()) ?? "anthropic";
      setSelected(sel);
      const stored = await loadProvider(sel);
      setApiKey(stored?.apiKey ?? "");
      setModel(stored?.model ?? "");
    })();
  }, []);

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
    setSaved(true);
    onChanged?.();
  }

  return (
    <ScrollView style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "700", marginBottom: 12 }}>LLM provider</Text>

      <View style={{ flexDirection: "row", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {PROVIDERS.map((id) => (
          <TouchableOpacity
            key={id}
            onPress={() => pick(id)}
            style={{
              paddingVertical: 8,
              paddingHorizontal: 12,
              borderRadius: 20,
              backgroundColor: selected === id ? "#2563eb" : "#e5e7eb",
            }}
          >
            <Text style={{ color: selected === id ? "#fff" : "#111" }}>{PROVIDER_LABELS[id]}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={{ marginBottom: 4 }}>API key (stored in the device keychain)</Text>
      <TextInput
        value={apiKey}
        onChangeText={(t) => {
          setApiKey(t);
          setSaved(false);
        }}
        placeholder="sk-…"
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, marginBottom: 12 }}
      />

      <Text style={{ marginBottom: 4 }}>Model (optional)</Text>
      <TextInput
        value={model}
        onChangeText={(t) => {
          setModel(t);
          setSaved(false);
        }}
        placeholder={DEFAULT_MODELS[selected]}
        autoCapitalize="none"
        autoCorrect={false}
        style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, marginBottom: 16 }}
      />

      <TouchableOpacity
        onPress={save}
        style={{ backgroundColor: "#2563eb", padding: 12, borderRadius: 8 }}
      >
        <Text style={{ color: "#fff", textAlign: "center" }}>Save</Text>
      </TouchableOpacity>
      {saved && <Text style={{ color: "#16a34a", marginTop: 8, textAlign: "center" }}>Saved.</Text>}
    </ScrollView>
  );
}
