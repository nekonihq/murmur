// Devices route: scan for murmur peripherals, then connect (if paired) or route
// to the pairing screen.

import React, { useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { BleTransport, type DiscoveredDevice } from "../ble/transport.ts";
import { useConnection } from "../ConnectionContext.tsx";
import { useTheme } from "../ThemeContext.tsx";
import { loadPsk } from "../storage/keys.ts";
import type { ThemeColors } from "../theme.ts";

export default function DevicesRoute() {
  const router = useRouter();
  const { connect } = useConnection();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
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
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.scanTitle}>Connecting…</Text>
      </View>
    );
  }

  // No devices yet: a friendly full-screen scanning (or error) state instead of
  // a lone line of text.
  if (devices.length === 0) {
    return (
      <View style={styles.center}>
        {error ? (
          <>
            <Ionicons name="bluetooth-outline" size={44} color={colors.danger} />
            <Text style={styles.scanTitle}>Can’t scan</Text>
            <Text style={styles.error}>{error}</Text>
            <Text style={styles.scanHint}>Check that Bluetooth is on and permission is granted.</Text>
          </>
        ) : (
          <>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.scanTitle}>Scanning for nearby Pis…</Text>
            <Text style={styles.scanHint}>
              Make sure your Pi is powered on and running murmurd.
            </Text>
            <Ionicons
              name="bluetooth-outline"
              size={40}
              color={colors.textMid}
              style={{ marginTop: 24 }}
            />
          </>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        ListHeaderComponent={<Text style={styles.listHeader}>Nearby devices</Text>}
        ListFooterComponent={
          <View style={styles.scanFooter}>
            <ActivityIndicator color={colors.textMid} />
            <Text style={styles.dim}>Scanning…</Text>
          </View>
        }
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

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, padding: 16 },
    center: {
      flex: 1,
      backgroundColor: colors.bg,
      justifyContent: "center",
      alignItems: "center",
      padding: 32,
    },
    row: { paddingVertical: 14, borderBottomWidth: 1, borderColor: colors.border },
    name: { fontSize: 16, color: colors.textHigh },
    id: { fontSize: 12, color: colors.textMid },
    dim: { color: colors.textMid },
    listHeader: { color: colors.textMid, fontSize: 13, fontWeight: "600", marginBottom: 4 },
    scanTitle: { color: colors.textHigh, fontSize: 17, fontWeight: "600", marginTop: 16 },
    scanHint: { color: colors.textMid, fontSize: 14, textAlign: "center", marginTop: 8, lineHeight: 20 },
    scanFooter: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center", paddingVertical: 20 },
    error: { color: colors.danger, textAlign: "center", marginTop: 8 },
  });
