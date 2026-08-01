// Renders the Markdown subset parsed in markdown.ts into React Native views,
// themed via the active palette. Used for assistant messages in the agent chat.

import React, { useMemo } from "react";
import { View, Text, ScrollView } from "react-native";

import { parseBlocks, parseInline, type Span, type Align } from "./markdown.ts";
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
          case "table":
            return <Table key={i} header={b.header} aligns={b.aligns} rows={b.rows} color={color} colors={colors} />;
        }
      })}
    </View>
  );
}

// Renders wide relative to the chat bubble, so it scrolls horizontally within
// its own bordered frame rather than squeezing columns unreadably narrow or
// blowing out the bubble width on a phone screen.
function Table({
  header,
  aligns,
  rows,
  color,
  colors,
}: {
  header: string[];
  aligns: Align[];
  rows: string[][];
  color: string;
  colors: ThemeColors;
}) {
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 8,
        marginVertical: 4,
        overflow: "hidden",
      }}
    >
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <View style={{ flexDirection: "row", backgroundColor: colors.surfaceAlt }}>
            {Array.from({ length: cols }, (_, c) => (
              <TableCell key={c} text={header[c] ?? ""} align={aligns[c]} color={color} colors={colors} header last={c === cols - 1} />
            ))}
          </View>
          {rows.map((r, ri) => (
            <View
              key={ri}
              style={{
                flexDirection: "row",
                borderTopWidth: 1,
                borderTopColor: colors.border,
                backgroundColor: ri % 2 ? colors.surface : "transparent",
              }}
            >
              {Array.from({ length: cols }, (_, c) => (
                <TableCell key={c} text={r[c] ?? ""} align={aligns[c]} color={color} colors={colors} last={c === cols - 1} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function TableCell({
  text,
  align,
  color,
  colors,
  header,
  last,
}: {
  text: string;
  align?: Align;
  color: string;
  colors: ThemeColors;
  header?: boolean;
  last?: boolean;
}) {
  return (
    <View
      style={{
        minWidth: 90,
        maxWidth: 240,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRightWidth: last ? 0 : 1,
        borderRightColor: colors.border,
      }}
    >
      <Text style={{ color, fontWeight: header ? "700" : "400", textAlign: align ?? "left" }}>
        <InlineText spans={parseInline(text)} color={color} colors={colors} />
      </Text>
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
