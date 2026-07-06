// A small, dependency-free Markdown parser for rendering assistant messages in
// the agent chat. It covers the subset LLMs actually emit: fenced code blocks,
// headings, bullet/ordered lists, and inline bold / italic / code. Anything
// fancier degrades to plain text rather than showing raw syntax.
//
// Pure functions only (no React) so the parsing is unit-testable; the renderer
// lives in Markdown.tsx.

export type Block =
  | { type: "code"; text: string }
  | { type: "heading"; level: number; text: string }
  | { type: "bullet"; text: string }
  | { type: "ordered"; marker: string; text: string }
  | { type: "paragraph"; text: string };

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** Split Markdown source into block-level elements. */
export function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      // Soft-wrapped lines join into one paragraph, as Markdown prescribes.
      blocks.push({ type: "paragraph", text: para.join(" ") });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*```/);
    if (fence) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      // If the closing fence is missing we've consumed to EOF, which is fine.
      blocks.push({ type: "code", text: buf.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushPara();
      blocks.push({ type: "bullet", text: bullet[1].trim() });
      continue;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (ordered) {
      flushPara();
      blocks.push({ type: "ordered", marker: ordered[1], text: ordered[2].trim() });
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  return blocks;
}

/** Parse inline formatting within a single block of text into styled spans. */
export function parseInline(text: string): Span[] {
  const out: Span[] = [];
  // Inline code takes precedence and suppresses formatting inside, so peel it
  // off first, then parse emphasis in the remaining segments.
  for (const part of text.split(/(`[^`]+`)/g)) {
    if (!part) continue;
    if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push({ text: part.slice(1, -1), code: true });
    } else {
      out.push(...parseEmphasis(part));
    }
  }
  return out;
}

function parseEmphasis(text: string): Span[] {
  const out: Span[] = [];
  const re = /\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ text: m[1], bold: true });
    else if (m[2] !== undefined) out.push({ text: m[2], bold: true });
    else if (m[3] !== undefined) out.push({ text: m[3], italic: true });
    else if (m[4] !== undefined) out.push({ text: m[4], italic: true });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}
