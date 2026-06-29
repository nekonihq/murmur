// Devices route: scan for murmur peripherals, then connect (if paired) or route
// to the pairing screen.

import React, { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";

import { BleTransport, type DiscoveredDevice } from "../ble/transport.ts";
import { useConnection } from "../ConnectionContext.tsx";
import { loadPsk } from "../storage/keys.ts";
import { colors } from "../theme.ts";

export default function DevicesRoute() {
  const router = useRouter();
  const { connect } = useConnection();
  const [transport] = useState(() => new BleTransport());
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stop = transport.scan(
      (d) => setDevices((prev) => (prev.some((p) => p.id === d.id) ? prev : [...prev, d])),
      (e) => setError(e.message),
    );
    return () => stop();
  }, [transport]);

  async function onPick(device: DiscoveredDevice) {
    const psk = await loadPsk(device.id);
    if (!psk) {
      router.push({ pathname: "/pair", params: { deviceId: device.id, name: device.name ?? "" } });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connect(device.id);
      router.replace("/(tabs)/shell");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (busy) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.dim}>Connecting…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        ListEmptyComponent={<Text style={styles.dim}>Scanning for nearby Pis…</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => onPick(item)}>
            <Text style={styles.name}>{item.name ?? "(unnamed)"}</Text>
            <Text style={styles.id}>{item.id}</Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 16 },
  center: { flex: 1, backgroundColor: colors.bg, justifyContent: "center", alignItems: "center" },
  row: { paddingVertical: 14, borderBottomWidth: 1, borderColor: colors.border },
  name: { fontSize: 16, color: colors.textHigh },
  id: { fontSize: 12, color: colors.textMid },
  dim: { color: colors.textMid, marginTop: 12 },
  error: { color: colors.danger, marginBottom: 8 },
});
