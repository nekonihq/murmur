// Shell mode: wire the xterm Terminal to an interactive PTY session.

import React, { useEffect, useRef } from "react";
import { View } from "react-native";

import { MurmurClient } from "../client.ts";
import { Terminal, type TerminalHandle } from "../terminal/Terminal.tsx";

interface Props {
  client: MurmurClient;
}

export function ShellScreen({ client }: Props) {
  const termRef = useRef<TerminalHandle>(null);
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    // Open the pty session and pipe its output into the terminal.
    void client.openShell(80, 24, (bytes) => {
      termRef.current?.write(bytes);
    });
  }, [client]);

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <Terminal
        ref={termRef}
        onInput={(bytes) => client.sendStdin(bytes)}
        onResize={(cols, rows) => client.resize(cols, rows)}
      />
    </View>
  );
}
