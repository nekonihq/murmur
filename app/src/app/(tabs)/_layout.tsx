import React, { useEffect } from "react";
import { View } from "react-native";
import { Tabs, Redirect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

import { useConnection } from "../../ConnectionContext.tsx";
import { useTheme } from "../../ThemeContext.tsx";

type IoniconName = React.ComponentProps<typeof Ionicons>["name"];

const ICON_SIZE = 24;

// Outline when inactive, filled when focused.
const ICONS: Record<string, [IoniconName, IoniconName]> = {
  shell: ["terminal-outline", "terminal"],
  agent: ["sparkles-outline", "sparkles"],
  settings: ["settings-outline", "settings"],
};

function tabIcon(name: keyof typeof ICONS) {
  return ({ focused, color }: { focused: boolean; color: string }) => {
    const [outline, filled] = ICONS[name];
    // Center every glyph in an identical box so their differing intrinsic
    // metrics (terminal vs sparkles vs gear) don't sit at different heights.
    return (
      <View style={{ width: ICON_SIZE, height: ICON_SIZE, alignItems: "center", justifyContent: "center" }}>
        <Ionicons name={focused ? filled : outline} color={color} size={ICON_SIZE} />
      </View>
    );
  };
}

export default function TabsLayout() {
  const { client, refreshProvider } = useConnection();
  const { colors } = useTheme();

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
        tabBarLabelStyle: { fontSize: 11 },
        tabBarIconStyle: { alignSelf: "center" },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      {/* The terminal owns the full screen; no nav header to overlap it. */}
      <Tabs.Screen
        name="shell"
        options={{ title: "Shell", headerShown: false, tabBarIcon: tabIcon("shell") }}
      />
      <Tabs.Screen name="agent" options={{ title: "Agent", tabBarIcon: tabIcon("agent") }} />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarIcon: tabIcon("settings") }}
      />
    </Tabs>
  );
}
