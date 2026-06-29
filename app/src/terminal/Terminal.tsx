// A real terminal for shell mode: xterm.js running inside a WebView. RN has no
// native terminal emulator, and xterm gives full ANSI/color/cursor handling.
// The bridge: keystrokes -> postMessage -> client.sendStdin; PTY bytes ->
// injectJavaScript(murmurWrite) -> term.write. Copy/paste go through the host
// clipboard since a WebView canvas has no native selection UI on mobile.

import React, { useImperativeHandle, useRef, forwardRef } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";

import { toBase64 } from "../crypto/base64.ts";

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

// xterm + addons from CDN. The phone has internet (only the Pi is offline); for
// a fully offline app, vendor these into the bundle.
const HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  html,body{margin:0;height:100%;background:#000;overflow:hidden}
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
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  // WebGL renderer = much smoother scrolling/painting; fall back silently.
  try { term.loadAddon(new WebglAddon.WebglAddon()); } catch (e) {}
  fit.fit();
  const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
  term.onData((d) => post({ t: 'data', d }));
  const reportSize = () => post({ t: 'resize', cols: term.cols, rows: term.rows });
  window.addEventListener('resize', () => { fit.fit(); reportSize(); });

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

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { onInput, onResize, onCopied },
  ref,
) {
  const webRef = useRef<WebView>(null);
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
      source={{ html: HTML }}
      onMessage={handleMessage}
      keyboardDisplayRequiresUserAction={false}
      // Let xterm's own viewport handle scrolling; the page itself doesn't scroll.
      scrollEnabled={false}
      overScrollMode="never"
      style={{ flex: 1, backgroundColor: "#000" }}
    />
  );
});
