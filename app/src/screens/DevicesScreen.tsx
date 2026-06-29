// Scan for murmur peripherals, pair (enter the PSK printed by `murmurd --pair`)
// if needed, and connect — establishing the authenticated MurmurClient.

import React, { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, TextInput, ActivityIndicator } from "react-native";

import { MurmurClient } from "../client.ts";
import { BleTransport, type DiscoveredDevice } from "../ble/transport.ts";
import { loadPsk, savePsk } from "../storage/keys.ts";

interface Props {
  onConnected: (client: MurmurClient, deviceId: string) => void;
}

export function DevicesScreen({ onConnected }: Props) {
  const [transport] = useState(() => new BleTransport());
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<DiscoveredDevice | null>(null);
  const [pskInput, setPskInput] = useState("");

  useEffect(() => {
    const stop = transport.scan(
      (d) =>
        setDevices((prev) => (prev.some((p) => p.id === d.id) ? prev : [...prev, d])),
      (e) => setError(e.message),
    );
    return () => stop();
  }, [transport]);

  async function connectWith(deviceId: string, psk: Uint8Array) {
    setBusy(true);
    setError(null);
    try {
      const client = new MurmurClient(psk);
      await client.connect(deviceId);
      onConnected(client, deviceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onPick(device: DiscoveredDevice) {
    const psk = await loadPsk(device.id);
    if (psk) {
      await connectWith(device.id, psk);
    } else {
      setPairing(device);
    }
  }

  async function confirmPairing() {
    if (!pairing) return;
    const trimmed = pskInput.trim();
    if (!trimmed) return;
    await savePsk(pairing.id, trimmed);
    const psk = await loadPsk(pairing.id);
    setPairing(null);
    setPskInput("");
    if (psk) await connectWith(pairing.id, psk);
  }

  if (busy) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 12 }}>Connecting…</Text>
      </View>
    );
  }

  if (pairing) {
    return (
      <View style={{ flex: 1, padding: 20, gap: 12 }}>
        <Text style={{ fontSize: 18, fontWeight: "600" }}>Pair “{pairing.name ?? pairing.id}”</Text>
        <Text>
          Run <Text style={{ fontFamily: "monospace" }}>murmurd --pair</Text> on the Pi and paste
          the key it prints:
        </Text>
        <TextInput
          value={pskInput}
          onChangeText={setPskInput}
          placeholder="base64 pairing key"
          autoCapitalize="none"
          autoCorrect={false}
          style={{ borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10 }}
        />
        <TouchableOpacity
          onPress={confirmPairing}
          style={{ backgroundColor: "#2563eb", padding: 12, borderRadius: 8 }}
        >
          <Text style={{ color: "#fff", textAlign: "center" }}>Pair & connect</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setPairing(null)}>
          <Text style={{ color: "#2563eb", textAlign: "center" }}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 20, fontWeight: "700", marginBottom: 12 }}>murmur devices</Text>
      {error && <Text style={{ color: "#dc2626", marginBottom: 8 }}>{error}</Text>}
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        ListEmptyComponent={<Text style={{ color: "#888" }}>Scanning for nearby Pis…</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity
            onPress={() => onPick(item)}
            style={{ paddingVertical: 14, borderBottomWidth: 1, borderColor: "#eee" }}
          >
            <Text style={{ fontSize: 16 }}>{item.name ?? "(unnamed)"}</Text>
            <Text style={{ color: "#888", fontSize: 12 }}>{item.id}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
