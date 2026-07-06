import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

import { ConnectionProvider } from "../ConnectionContext.tsx";
import { ThemeProvider, useTheme } from "../ThemeContext.tsx";
import { log } from "../log.ts";

// Logs once per bundle evaluation. If this reappears during a live session, the
// app is reloading (Metro/dev-client), which would drop the BLE link.
log("boot", "app bundle evaluated");

export default function RootLayout() {
  return (
    <ThemeProvider>
      <ConnectionProvider>
        <RootNav />
      </ConnectionProvider>
    </ThemeProvider>
  );
}

// Split out so it can read the resolved palette from ThemeProvider above it.
function RootNav() {
  const { colors, scheme } = useTheme();
  return (
    <>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
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
    </>
  );
}
