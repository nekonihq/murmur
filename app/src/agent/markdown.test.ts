import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBlocks, parseInline } from "./markdown.ts";

test("plain paragraph, soft-wrapped lines joined", () => {
  assert.deepEqual(parseBlocks("hello\nworld"), [{ type: "paragraph", text: "hello world" }]);
});

test("blank line separates paragraphs", () => {
  assert.deepEqual(parseBlocks("a\n\nb"), [
    { type: "paragraph", text: "a" },
    { type: "paragraph", text: "b" },
  ]);
});

test("headings by level", () => {
  assert.deepEqual(parseBlocks("# Title\n## Sub"), [
    { type: "heading", level: 1, text: "Title" },
    { type: "heading", level: 2, text: "Sub" },
  ]);
});

test("bullet and ordered lists", () => {
  assert.deepEqual(parseBlocks("- one\n* two\n1. three\n2) four"), [
    { type: "bullet", text: "one" },
    { type: "bullet", text: "two" },
    { type: "ordered", marker: "1", text: "three" },
    { type: "ordered", marker: "2", text: "four" },
  ]);
});

test("fenced code block preserves inner lines and language fence", () => {
  assert.deepEqual(parseBlocks("```sh\nls -la\necho hi\n```"), [
    { type: "code", text: "ls -la\necho hi" },
  ]);
});

test("unterminated code fence runs to end of input", () => {
  assert.deepEqual(parseBlocks("```\nx"), [{ type: "code", text: "x" }]);
});

test("inline code is isolated and not emphasis-parsed", () => {
  assert.deepEqual(parseInline("run `a*b*c` now"), [
    { text: "run " },
    { text: "a*b*c", code: true },
    { text: " now" },
  ]);
});

test("bold and italic", () => {
  assert.deepEqual(parseInline("**b** and *i* and _j_"), [
    { text: "b", bold: true },
    { text: " and " },
    { text: "i", italic: true },
    { text: " and " },
    { text: "j", italic: true },
  ]);
});

test("plain text passes through as a single span", () => {
  assert.deepEqual(parseInline("nothing special"), [{ text: "nothing special" }]);
});

test("GFM table with alignment row", () => {
  const md = ["| Name | Count | Note |", "| :--- | :---: | ---: |", "| a | 1 | x |", "| b | 2 | y |"].join("\n");
  assert.deepEqual(parseBlocks(md), [
    {
      type: "table",
      header: ["Name", "Count", "Note"],
      aligns: ["left", "center", "right"],
      rows: [
        ["a", "1", "x"],
        ["b", "2", "y"],
      ],
    },
  ]);
});

test("table cells support escaped pipes and inline formatting", () => {
  const md = ["| A | B |", "| --- | --- |", "| **bold** | a \\| b |"].join("\n");
  assert.deepEqual(parseBlocks(md), [
    {
      type: "table",
      header: ["A", "B"],
      aligns: ["left", "left"],
      rows: [["**bold**", "a | b"]],
    },
  ]);
});

test("a bare pipe-containing line without a delimiter row is a paragraph", () => {
  assert.deepEqual(parseBlocks("a | b\nnot a table"), [{ type: "paragraph", text: "a | b not a table" }]);
});
