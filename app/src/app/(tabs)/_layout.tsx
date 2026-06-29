import React, { useEffect } from "react";
import { Tabs, Redirect } from "expo-router";

import { useConnection } from "../../ConnectionContext.tsx";
import { colors } from "../../theme.ts";

export default function TabsLayout() {
  const { client, refreshProvider } = useConnection();

  useEffect(() => {
    void refreshProvider();
  }, [refreshProvider]);

  // No live connection (e.g. app relaunch) — back to device selection.
  if (!client) return <Redirect href="/" />;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.textHigh,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMid,
        tabBarHideOnKeyboard: true,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      {/* The terminal owns the full screen; no nav header to overlap it. */}
      <Tabs.Screen name="shell" options={{ title: "Shell", headerShown: false }} />
      <Tabs.Screen name="agent" options={{ title: "Agent" }} />
      <Tabs.Screen name="settings" options={{ title: "Settings" }} />
    </Tabs>
  );
}
