// A real terminal for shell mode: xterm.js running inside a WebView. RN has no
// native terminal emulator, and xterm gives full ANSI/color/cursor handling.
// The bridge: keystrokes -> postMessage -> client.sendStdin; PTY bytes ->
// injectJavaScript(murmurWrite) -> term.write. Copy/paste go through the host
// clipboard since a WebView canvas has no native selection UI on mobile.

import React, { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";

import { toBase64 } from "../crypto/base64.ts";
import { useTheme } from "../ThemeContext.tsx";
import type { ColorScheme, ThemeColors } from "../theme.ts";

export interface TerminalHandle {
  /** Write raw PTY bytes into the terminal. */
  write(bytes: Uint8Array): void;
  /** Copy the current selection (or the whole buffer) to the clipboard. */
  copy(): void;
  /** Paste the clipboard into the shell (sent as stdin). */
  paste(): Promise<void>;
  /** Jump to the bottom of the scrollback. */
  scrollToBottom(): void;
  /** Refocus the terminal so the soft keyboard stays up. */
  focus(): void;
}

export interface TerminalProps {
  /** Called with keystroke / pasted bytes the user produced. */
  onInput: (bytes: Uint8Array) => void;
  /** Called when the terminal geometry changes. */
  onResize?: (cols: number, rows: number) => void;
  /** Called after a copy with the copied text (e.g. to show a toast). */
  onCopied?: (text: string) => void;
}

/** xterm theme derived from the app palette. On a light background the default
 *  ANSI palette (bright whites/yellows) is unreadable, so light mode ships a
 *  darker, legible palette; dark mode keeps xterm's tuned defaults. */
function terminalTheme(scheme: ColorScheme, colors: ThemeColors): Record<string, string> {
  const base = {
    background: colors.bg,
    foreground: colors.textHigh,
    cursor: colors.accent,
    cursorAccent: colors.bg,
  };
  if (scheme === "light") {
    return {
      ...base,
      selectionBackground: "#c7ddfb",
      black: "#1f2937", red: "#b91c1c", green: "#15803d", yellow: "#b45309",
      blue: "#1d4ed8", magenta: "#a21caf", cyan: "#0e7490", white: "#374151",
      brightBlack: "#6b7280", brightRed: "#dc2626", brightGreen: "#16a34a",
      brightYellow: "#d97706", brightBlue: "#2563eb", brightMagenta: "#c026d3",
      brightCyan: "#0891b2", brightWhite: "#111827",
    };
  }
  return { ...base, selectionBackground: "#264f78" };
}

// xterm + addons from CDN. The phone has internet (only the Pi is offline); for
// a fully offline app, vendor these into the bundle.
function buildHtml(theme: Record<string, string>): string {
  const themeJson = JSON.stringify(theme);
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  html,body{margin:0;height:100%;background:${theme.background};overflow:hidden}
  #t{height:100%;width:100%}
  /* let touch scroll the xterm viewport smoothly */
  .xterm-viewport{-webkit-overflow-scrolling:touch}
</style>
</head><body><div id="t"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js"></script>
<script>
  const term = new Terminal({
    convertEol: false, fontSize: 13, cursorBlink: true, scrollback: 5000,
    scrollSensitivity: 3, fastScrollSensitivity: 8, smoothScrollDuration: 0,
    theme: ${themeJson},
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  // WebGL renderer = much smoother scrolling/painting; fall back silently.
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch (e) {}
  const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
  term.onData((d) => post({ t: 'data', d }));
  const reportSize = () => post({ t: 'resize', cols: term.cols, rows: term.rows });
  // Fit against the *settled* layout. Fitting once at script-eval time can
  // measure a stale/rounded height and leave the top row clipped, so also refit
  // on the next frame and whenever the container actually changes size.
  const el = document.getElementById('t');
  const refit = () => { try { fit.fit(); } catch (e) {} reportSize(); };
  refit();
  requestAnimationFrame(refit);
  if (window.ResizeObserver) new ResizeObserver(refit).observe(el);
  window.addEventListener('resize', refit);

  // Re-theme live (e.g. system light/dark switch) without reloading the session.
  window.murmurTheme = (t) => {
    term.options.theme = t;
    document.body.style.background = t.background;
  };

  window.murmurWrite = (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    term.write(arr);
  };
  function bufferText() {
    const buf = term.buffer.active, out = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) out.push(line.translateToString(true));
    }
    return out.join('\\n').replace(/\\n+$/, '') + '\\n';
  }
  window.murmurCopy = () => post({ t: 'copy', text: term.getSelection() || bufferText() });
  window.murmurPaste = (text) => term.paste(text);
  window.murmurBottom = () => term.scrollToBottom();
  window.murmurFocus = () => term.focus();

  reportSize();
  term.focus();
  document.getElementById('t').addEventListener('click', () => term.focus());
</script></body></html>`;
}

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { onInput, onResize, onCopied },
  ref,
) {
  const webRef = useRef<WebView>(null);
  const { scheme, colors } = useTheme();
  // Freeze the initial HTML so changing the theme doesn't reload the WebView
  // (which would drop the live session); live changes go through murmurTheme.
  const htmlRef = useRef<string | undefined>(undefined);
  if (!htmlRef.current) htmlRef.current = buildHtml(terminalTheme(scheme, colors));
  const onCopiedRef = useRef(onCopied);
  onCopiedRef.current = onCopied;

  useImperativeHandle(ref, () => ({
    write(bytes: Uint8Array) {
      const b64 = toBase64(bytes);
      webRef.current?.injectJavaScript(`window.murmurWrite(${JSON.stringify(b64)}); true;`);
    },
    copy() {
      webRef.current?.injectJavaScript(`window.murmurCopy(); true;`);
    },
    async paste() {
      const text = await Clipboard.getStringAsync();
      if (text) {
        webRef.current?.injectJavaScript(`window.murmurPaste(${JSON.stringify(text)}); true;`);
      }
    },
    scrollToBottom() {
      webRef.current?.injectJavaScript(`window.murmurBottom(); true;`);
    },
    focus() {
      webRef.current?.injectJavaScript(`window.murmurFocus(); true;`);
    },
  }));

  // Push theme changes into the live terminal (no reload).
  useEffect(() => {
    const t = JSON.stringify(terminalTheme(scheme, colors));
    webRef.current?.injectJavaScript(`window.murmurTheme && window.murmurTheme(${t}); true;`);
  }, [scheme, colors]);

  const handleMessage = (e: WebViewMessageEvent) => {
    let msg: { t: string; d?: string; cols?: number; rows?: number; text?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.t === "data" && msg.d != null) {
      onInput(new TextEncoder().encode(msg.d));
    } else if (msg.t === "resize" && msg.cols && msg.rows) {
      onResize?.(msg.cols, msg.rows);
    } else if (msg.t === "copy" && msg.text != null) {
      void Clipboard.setStringAsync(msg.text);
      onCopiedRef.current?.(msg.text);
    }
  };

  return (
    <WebView
      ref={webRef}
      originWhitelist={["*"]}
      source={{ html: htmlRef.current }}
      onMessage={handleMessage}
      keyboardDisplayRequiresUserAction={false}
      // Let xterm's own viewport handle scrolling; the page itself doesn't scroll.
      scrollEnabled={false}
      overScrollMode="never"
      style={{ flex: 1, backgroundColor: colors.bg }}
    />
  );
});
