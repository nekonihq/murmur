// Renders the Markdown subset parsed in markdown.ts into React Native views,
// themed via the active palette. Used for assistant messages in the agent chat.

import React, { useMemo } from "react";
import { View, Text } from "react-native";

import { parseBlocks, parseInline, type Span } from "./markdown.ts";
import type { ThemeColors } from "../theme.ts";

interface Props {
  text: string;
  /** Base text color (bubbles set this to contrast their background). */
  color: string;
  colors: ThemeColors;
}

export function Markdown({ text, color, colors }: Props) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <View>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "code":
            return (
              <View key={i} style={{ backgroundColor: colors.codeBg, borderRadius: 8, padding: 8, marginVertical: 4 }}>
                <Text style={{ color: colors.codeFg, fontFamily: "monospace", fontSize: 12 }}>{b.text}</Text>
              </View>
            );
          case "heading":
            return (
              <Text
                key={i}
                style={{ color, fontWeight: "700", fontSize: b.level <= 2 ? 18 : 16, marginTop: i ? 8 : 0, marginBottom: 2 }}
              >
                <InlineText spans={parseInline(b.text)} color={color} colors={colors} />
              </Text>
            );
          case "bullet":
            return (
              <ListItem key={i} bullet="•  " color={color}>
                <InlineText spans={parseInline(b.text)} color={color} colors={colors} />
              </ListItem>
            );
          case "ordered":
            return (
              <ListItem key={i} bullet={`${b.marker}.  `} color={color}>
                <InlineText spans={parseInline(b.text)} color={color} colors={colors} />
              </ListItem>
            );
          case "paragraph":
            return (
              <Text key={i} style={{ color, marginVertical: 2 }}>
                <InlineText spans={parseInline(b.text)} color={color} colors={colors} />
              </Text>
            );
        }
      })}
    </View>
  );
}

function ListItem({
  bullet,
  color,
  children,
}: {
  bullet: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", marginVertical: 2 }}>
      <Text style={{ color, fontVariant: ["tabular-nums"] }}>{bullet}</Text>
      <Text style={{ flex: 1, color }}>{children}</Text>
    </View>
  );
}

function InlineText({ spans, color, colors }: { spans: Span[]; color: string; colors: ThemeColors }) {
  return (
    <>
      {spans.map((s, i) =>
        s.code ? (
          <Text
            key={i}
            style={{ fontFamily: "monospace", fontSize: 13, color: colors.codeFg, backgroundColor: colors.codeBg }}
          >
            {" "}
            {s.text}{" "}
          </Text>
        ) : (
          <Text
            key={i}
            style={{
              color,
              fontWeight: s.bold ? "700" : "400",
              fontStyle: s.italic ? "italic" : "normal",
            }}
          >
            {s.text}
          </Text>
        ),
      )}
    </>
  );
}
