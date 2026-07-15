// Devices route: scan for murmur peripherals, then connect (if paired) or route
// to the pairing screen.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, Alert } from "react-native";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { BleTransport, type DiscoveredDevice } from "../ble/transport.ts";
import { useConnection } from "../ConnectionContext.tsx";
import { useTheme } from "../ThemeContext.tsx";
import { loadPsk, loadPairedDevices, forgetDevice, type PairedDevice } from "../storage/keys.ts";
import type { ThemeColors } from "../theme.ts";

export default function DevicesRoute() {
  const router = useRouter();
  const { connect } = useConnection();
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [transport] = useState(() => new BleTransport());
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [paired, setPaired] = useState<PairedDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const stop = transport.scan(
      (d) => setDevices((prev) => (prev.some((p) => p.id === d.id) ? prev : [...prev, d])),
      (e) => setError(e.message),
    );
    return () => stop();
  }, [transport]);

  // Reload the paired index whenever this screen gains focus, so a device
  // forgotten from Settings (or pairing a new one) is reflected without
  // requiring a remount.
  useFocusEffect(
    useCallback(() => {
      void loadPairedDevices().then(setPaired);
    }, []),
  );

  const pairedIds = useMemo(() => new Set(paired.map((p) => p.id)), [paired]);
  const nearbyDevices = useMemo(() => devices.filter((d) => !pairedIds.has(d.id)), [devices, pairedIds]);

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

  async function onConnectPaired(device: PairedDevice) {
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

  // Forgetting works even when the Pi is off/out of range/unreachable — it
  // only touches this phone's local pairing key, no connection required.
  function onForget(device: PairedDevice) {
    Alert.alert(
      "Forget this device?",
      "Removes its pairing key from this phone. You'll need to pair again to reconnect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: async () => {
            await forgetDevice(device.id);
            setPaired((prev) => prev.filter((p) => p.id !== device.id));
          },
        },
      ],
    );
  }

  if (busy) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={styles.scanTitle}>Connecting…</Text>
      </View>
    );
  }

  // No paired devices and nothing scanned yet: a friendly full-screen
  // scanning (or error) state instead of a lone line of text. Paired devices
  // always take you past this, even if none are currently in range.
  if (paired.length === 0 && devices.length === 0) {
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
        data={nearbyDevices}
        keyExtractor={(d) => d.id}
        ListHeaderComponent={
          <>
            {paired.length > 0 && (
              <>
                <Text style={styles.listHeader}>Paired devices</Text>
                {paired.map((p) => {
                  const inRange = devices.some((d) => d.id === p.id);
                  return (
                    <TouchableOpacity
                      key={p.id}
                      style={styles.row}
                      onPress={() => onConnectPaired(p)}
                      onLongPress={() => onForget(p)}
                      delayLongPress={400}
                    >
                      <View style={styles.pairedRow}>
                        <View>
                          <Text style={styles.name}>{p.name}</Text>
                          <Text style={styles.id}>{p.id}</Text>
                        </View>
                        {!inRange && <Text style={styles.dim}>not in range</Text>}
                      </View>
                    </TouchableOpacity>
                  );
                })}
                <Text style={styles.scanHint}>Long-press a paired device to forget it.</Text>
              </>
            )}
            <Text style={styles.listHeader}>Nearby devices</Text>
          </>
        }
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
    pairedRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
    name: { fontSize: 16, color: colors.textHigh },
    id: { fontSize: 12, color: colors.textMid },
    dim: { color: colors.textMid },
    listHeader: { color: colors.textMid, fontSize: 13, fontWeight: "600", marginBottom: 4 },
    scanTitle: { color: colors.textHigh, fontSize: 17, fontWeight: "600", marginTop: 16 },
    scanHint: { color: colors.textMid, fontSize: 14, textAlign: "center", marginTop: 8, lineHeight: 20 },
    scanFooter: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center", paddingVertical: 20 },
    error: { color: colors.danger, textAlign: "center", marginTop: 8 },
  });
