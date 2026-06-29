import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { ConnectionProvider } from "../ConnectionContext.tsx";
import { colors } from "../theme.ts";
import { log } from "../log.ts";

// Logs once per bundle evaluation. If this reappears during a live session, the
// app is reloading (Metro/dev-client), which would drop the BLE link.
log("boot", "app bundle evaluated");

export default function RootLayout() {
  return (
    <ConnectionProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.textHigh,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: "murmur" }} />
        <Stack.Screen name="pair" options={{ title: "Pair device" }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
    </ConnectionProvider>
  );
}
