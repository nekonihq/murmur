// A modal list of saved agent conversations. Tap a row to reopen it in the
// agent screen; tap the trash to delete it. Kept as an in-screen modal (rather
// than a separate route) so reopening a conversation is a plain state update in
// AgentScreen — no cross-route data passing, and the live client/provider stay
// in scope.

import React, { useCallback, useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

import {
  listConversations,
  deleteConversation,
  type ConversationMeta,
} from "../storage/conversations.ts";
import type { ThemeColors } from "../theme.ts";

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The conversation currently open in the agent, highlighted in the list. */
  currentId: string | null;
  /** Open the chosen conversation (loads it into the agent screen). */
  onOpen: (id: string) => void;
  /** A conversation was deleted; the agent screen resets if it was the open one. */
  onDeleted: (id: string) => void;
  colors: ThemeColors;
}

export function HistoryModal({ visible, onClose, currentId, onOpen, onDeleted, colors }: Props) {
  const [items, setItems] = useState<ConversationMeta[] | null>(null);

  const refresh = useCallback(() => {
    setItems(null);
    void listConversations().then(setItems);
  }, []);

  // Reload the list every time the modal opens so it reflects the latest saves.
  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  function confirmDelete(item: ConversationMeta) {
    Alert.alert("Delete conversation?", `"${item.title}" will be removed permanently.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await deleteConversation(item.id);
          onDeleted(item.id);
          refresh();
        },
      },
    ]);
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      // pageSheet presents below the notch on iOS (no status-bar overlap) and
      // reads as a modern dismissable sheet; statusBarTranslucent covers the
      // Android full-screen fallback.
      presentationStyle="pageSheet"
      statusBarTranslucent
    >
      {/* Modals render in a separate native host where the app's safe-area
          insets don't propagate, so give the sheet its own provider — otherwise
          SafeAreaView measures 0 and the header collides with the status bar. */}
      <SafeAreaProvider>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top", "bottom"]}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <Text style={{ flex: 1, fontSize: 18, fontWeight: "600", color: colors.textHigh }}>
            History
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={8}>
            <Ionicons name="close" size={24} color={colors.textMid} />
          </TouchableOpacity>
        </View>

        {items === null ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : items.length === 0 ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
            <Ionicons name="chatbubbles-outline" size={40} color={colors.textMid} />
            <Text style={{ color: colors.textMid, marginTop: 12, textAlign: "center" }}>
              No saved conversations yet.
            </Text>
          </View>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(it) => it.id}
            contentContainerStyle={{ padding: 12 }}
            renderItem={({ item }) => (
              <Row
                item={item}
                active={item.id === currentId}
                colors={colors}
                onOpen={() => onOpen(item.id)}
                onDelete={() => confirmDelete(item)}
              />
            )}
          />
        )}
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

function Row({
  item,
  active,
  colors,
  onOpen,
  onDelete,
}: {
  item: ConversationMeta;
  active: boolean;
  colors: ThemeColors;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: colors.surface,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: active ? colors.accent : colors.border,
        paddingHorizontal: 12,
        paddingVertical: 12,
        marginBottom: 8,
      }}
    >
      <TouchableOpacity onPress={onOpen} style={{ flex: 1 }}>
        <Text numberOfLines={1} style={{ color: colors.textHigh, fontSize: 15, fontWeight: "500" }}>
          {item.title}
        </Text>
        <Text style={{ color: colors.textMid, fontSize: 12, marginTop: 3 }}>
          {relativeTime(item.updatedAt)}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onDelete} hitSlop={10} style={{ paddingLeft: 12 }}>
        <Ionicons name="trash-outline" size={18} color={colors.textMid} />
      </TouchableOpacity>
    </View>
  );
}

/** Compact "how long ago" label, degrading to an absolute date past a week. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
