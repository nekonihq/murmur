// Renders a Markdown subset into React Native views, themed via the active
// palette. Used for assistant messages in the agent chat.
//
// Uses react-native-marked (actively maintained, built on the marked.js
// CommonMark/GFM parser) rather than a hand-rolled parser+renderer. Two
// from-scratch attempts at this (a regex parser, then a rewrite on top of
// markdown-it) each turned out to have their own bugs, and the last one —
// correct markdown-it token stream, verified against real failing input —
// still reproduced an oversized/blank chat bubble on long reports, which
// means the defect was in this file's own hand-rolled React rendering, not
// in parsing. Letting a library that many other apps already render real
// content with own both parsing and RN rendering sidesteps needing to
// rediscover those patterns correctly here — except for tables, see
// ChatRenderer below.

import React, { useMemo, type ReactNode } from "react";
import { View, Text, type TextStyle } from "react-native";
import { useMarkdown, Renderer, type useMarkdownHookOptions } from "react-native-marked";

import type { ThemeColors } from "../theme.ts";

interface Props {
  text: string;
  /** Base text color (bubbles set this to contrast their background). */
  color: string;
  colors: ThemeColors;
}

/**
 * Two confirmed bugs in react-native-marked, both overridden here rather than
 * patched (no patch-package set up in this project, and both are cleanly
 * reachable through the public Renderer subclass API):
 *
 * 1. Its table rendering delegates to react-native-reanimated-table, a
 *    sub-dependency stuck at version 0.0.2 since December 2023 (effectively
 *    abandoned) — a table row blew out to a wildly oversized height through
 *    it. A first replacement wrapped a plain View grid in a horizontal
 *    ScrollView so wide tables could still scroll — but relying on a
 *    horizontal ScrollView to auto-size its own height from wrapped,
 *    multi-line cell content turned out to be exactly as fragile: a table
 *    with long cell values (wrapping to multiple lines) measured its
 *    *containing chat bubble* at 10x the height every table-less message in
 *    the same conversation needed, confirmed by comparing logged
 *    text-length-to-height ratios across messages. `table()` below instead
 *    lays out columns with `flex` so the whole table always fits the bubble
 *    width — no ScrollView, nothing for its height to be ambiguous about.
 *    Long values wrap within their cell instead of scrolling.
 *
 * 2. Parser.tsx composes a paragraph's mixed text/bold/italic/code content by
 *    recursively rendering each run with its own correct explicit style, then
 *    wrapping the whole thing in one more `<Text>` — but that outermost
 *    wrapper is built via `this.renderer.text(this.parse(tokenRenderQueue),
 *    {})`, an empty style object, for every ordinary paragraph. So the
 *    nested runs all get fontSize/lineHeight matching this app's chat bubble
 *    sizing, but the Text wrapping all of them falls back to RN's system
 *    default font metrics — an outer Text with different metrics than its
 *    nested children is a known trigger for badly wrong multi-line height
 *    measurement on iOS. `text()` below always applies a baseline style so
 *    that outer wrapper is never left unstyled.
 */
class ChatRenderer extends Renderer {
  constructor(
    private colors: ThemeColors,
    private baseTextStyle: TextStyle,
  ) {
    super();
  }

  override text(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    return super.text(text, { ...this.baseTextStyle, ...styles });
  }

  override table(header: ReactNode[][], rows: ReactNode[][][]): ReactNode {
    const cols = Math.max(header.length, ...rows.map((r) => r.length));
    const { border, surfaceAlt, surface } = this.colors;
    return (
      <View
        key={this.getKey()}
        style={{ borderWidth: 1, borderColor: border, borderRadius: 8, marginVertical: 4, overflow: "hidden" }}
      >
        <View style={{ flexDirection: "row", backgroundColor: surfaceAlt }}>
          {Array.from({ length: cols }, (_, c) => (
            <TableCell key={c} border={border} last={c === cols - 1}>
              {header[c]}
            </TableCell>
          ))}
        </View>
        {rows.map((r, ri) => (
          <View
            key={ri}
            style={{
              flexDirection: "row",
              borderTopWidth: 1,
              borderTopColor: border,
              backgroundColor: ri % 2 ? surface : "transparent",
            }}
          >
            {Array.from({ length: cols }, (_, c) => (
              <TableCell key={c} border={border} last={c === cols - 1}>
                {r[c]}
              </TableCell>
            ))}
          </View>
        ))}
      </View>
    );
  }
}

function TableCell({ children, border, last }: { children: ReactNode; border: string; last: boolean }) {
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRightWidth: last ? 0 : 1,
        borderRightColor: border,
      }}
    >
      <Text>{children}</Text>
    </View>
  );
}

export function Markdown({ text, color, colors }: Props) {
  const renderer = useMemo(() => new ChatRenderer(colors, { fontSize: 14, lineHeight: 20, color }), [colors, color]);
  const options: useMarkdownHookOptions = {
    renderer,
    theme: {
      colors: { text: color, code: colors.codeBg, link: colors.accent, border: colors.border },
      spacing: { xs: 2, s: 4, m: 6, l: 10 },
    },
    styles: {
      // The library's defaults (16px/24 line-height body text, 32px h1) are
      // sized for a full-screen reading view; this renders inside a chat
      // bubble, so match the sizes the rest of the chat UI uses.
      text: { fontSize: 14, lineHeight: 20 },
      paragraph: { paddingVertical: 2 },
      strong: { fontSize: 14, lineHeight: 20, fontWeight: "700" },
      em: { fontSize: 14, lineHeight: 20 },
      codespan: { fontSize: 13, fontFamily: "monospace", fontStyle: "normal", color: colors.codeFg },
      code: { padding: 8, borderRadius: 8, marginVertical: 4, minWidth: undefined },
      h1: { fontSize: 18, lineHeight: 24, fontWeight: "700", marginVertical: 4, paddingBottom: 0, borderBottomWidth: 0 },
      h2: { fontSize: 18, lineHeight: 24, fontWeight: "700", marginVertical: 4, paddingBottom: 0, borderBottomWidth: 0 },
      h3: { fontSize: 16, lineHeight: 22, fontWeight: "700", marginVertical: 4 },
      h4: { fontSize: 16, lineHeight: 22, fontWeight: "700", marginVertical: 4 },
      h5: { fontSize: 14, lineHeight: 20, fontWeight: "700", marginVertical: 2 },
      h6: { fontSize: 14, lineHeight: 20, fontWeight: "700", marginVertical: 2 },
      li: { fontSize: 14, lineHeight: 20 },
    },
  };
  const elements = useMarkdown(text, options);
  return <>{elements}</>;
}
