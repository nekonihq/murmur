// A real terminal for shell mode: xterm.js running inside a WebView. RN has no
// native terminal emulator, and xterm gives full ANSI/color/cursor handling.
// The bridge: keystrokes -> postMessage -> client.sendStdin; PTY bytes ->
// injectJavaScript(murmurWrite) -> term.write.

import React, { useImperativeHandle, useRef, forwardRef } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { toBase64 } from "../crypto/base64.ts";

export interface TerminalHandle {
  /** Write raw PTY bytes into the terminal. */
  write(bytes: Uint8Array): void;
}

export interface TerminalProps {
  /** Called with keystroke bytes the user typed. */
  onInput: (bytes: Uint8Array) => void;
  /** Called when the terminal geometry changes. */
  onResize?: (cols: number, rows: number) => void;
}

// xterm from CDN. The phone has internet (only the Pi is offline); for a fully
// offline app, vendor xterm into the bundle and load it from a local asset.
const HTML = `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>html,body,#t{margin:0;height:100%;background:#000}</style>
</head><body><div id="t"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script>
  const term = new Terminal({ convertEol: false, fontSize: 13, cursorBlink: true });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById('t'));
  fit.fit();
  const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
  term.onData((d) => post({ t: 'data', d }));
  const reportSize = () => post({ t: 'resize', cols: term.cols, rows: term.rows });
  window.addEventListener('resize', () => { fit.fit(); reportSize(); });
  // Receive base64 PTY bytes from RN.
  window.murmurWrite = (b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    term.write(arr);
  };
  reportSize();
</script></body></html>`;

export const Terminal = forwardRef<TerminalHandle, TerminalProps>(function Terminal(
  { onInput, onResize },
  ref,
) {
  const webRef = useRef<WebView>(null);

  useImperativeHandle(ref, () => ({
    write(bytes: Uint8Array) {
      const b64 = toBase64(bytes);
      webRef.current?.injectJavaScript(`window.murmurWrite(${JSON.stringify(b64)}); true;`);
    },
  }));

  const handleMessage = (e: WebViewMessageEvent) => {
    let msg: { t: string; d?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.t === "data" && msg.d != null) {
      onInput(new TextEncoder().encode(msg.d));
    } else if (msg.t === "resize" && msg.cols && msg.rows) {
      onResize?.(msg.cols, msg.rows);
    }
  };

  return (
    <WebView
      ref={webRef}
      originWhitelist={["*"]}
      source={{ html: HTML }}
      onMessage={handleMessage}
      keyboardDisplayRequiresUserAction={false}
      style={{ flex: 1, backgroundColor: "#000" }}
    />
  );
});
