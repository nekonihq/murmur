// murmur app root: connect (Devices) → then a simple tab switch between Shell,
// Agent, and Settings. Keeps the active MurmurClient and the configured LLM
// provider in state.

import React, { useCallback, useEffect, useState } from "react";
import { SafeAreaView, View, Text, TouchableOpacity } from "react-native";

import { MurmurClient } from "./client.ts";
import { DevicesScreen } from "./screens/DevicesScreen.tsx";
import { ShellScreen } from "./screens/ShellScreen.tsx";
import { AgentScreen } from "./screens/AgentScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { createProvider } from "./providers/index.ts";
import type { LLMProvider } from "./agent/types.ts";
import { loadProvider, loadSelectedProvider } from "./storage/keys.ts";

type Tab = "shell" | "agent" | "settings";

export default function App() {
  const [client, setClient] = useState<MurmurClient | null>(null);
  const [tab, setTab] = useState<Tab>("shell");
  const [provider, setProvider] = useState<LLMProvider | null>(null);

  const refreshProvider = useCallback(async () => {
    const id = await loadSelectedProvider();
    if (!id) {
      setProvider(null);
      return;
    }
    const stored = await loadProvider(id);
    if (!stored?.apiKey) {
      setProvider(null);
      return;
    }
    setProvider(createProvider(id, { apiKey: stored.apiKey, model: stored.model }));
  }, []);

  useEffect(() => {
    void refreshProvider();
  }, [refreshProvider]);

  if (!client) {
    return (
      <SafeAreaView style={{ flex: 1 }}>
        <DevicesScreen onConnected={(c) => setClient(c)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {tab === "shell" && <ShellScreen client={client} />}
        {tab === "agent" && <AgentScreen client={client} provider={provider} />}
        {tab === "settings" && <SettingsScreen onChanged={refreshProvider} />}
      </View>
      <TabBar
        tab={tab}
        onSelect={setTab}
        onDisconnect={async () => {
          await client.disconnect();
          setClient(null);
        }}
      />
    </SafeAreaView>
  );
}

function TabBar({
  tab,
  onSelect,
  onDisconnect,
}: {
  tab: Tab;
  onSelect: (t: Tab) => void;
  onDisconnect: () => void;
}) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "shell", label: "Shell" },
    { id: "agent", label: "Agent" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <View
      style={{
        flexDirection: "row",
        borderTopWidth: 1,
        borderColor: "#e5e7eb",
        paddingVertical: 8,
      }}
    >
      {tabs.map((t) => (
        <TabButton key={t.id} label={t.label} active={tab === t.id} onPress={() => onSelect(t.id)} />
      ))}
      <TabButton label="Disconnect" active={false} onPress={onDisconnect} />
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity onPress={onPress} style={{ flex: 1, alignItems: "center" }}>
      <Text style={{ color: active ? "#2563eb" : "#6b7280", fontWeight: active ? "700" : "400" }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}
