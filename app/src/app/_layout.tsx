import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { ConnectionProvider } from "../ConnectionContext.tsx";
import { colors } from "../theme.ts";

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
