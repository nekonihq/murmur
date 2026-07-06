// Holds the active MurmurClient and the configured LLM provider across routes,
// so navigating between the Shell/Agent/Settings tabs doesn't drop the BLE
// connection.

import React, { createContext, useCallback, useContext, useState } from "react";

import { MurmurClient } from "./client.ts";
import { createProvider } from "./providers/index.ts";
import type { LLMProvider } from "./agent/types.ts";
import { loadPsk, loadProvider, loadSelectedProvider } from "./storage/keys.ts";
import { log } from "./log.ts";

interface ConnectionValue {
  client: MurmurClient | null;
  deviceId: string | null;
  provider: LLMProvider | null;
  /** Connect using a stored PSK (must already be paired). */
  connect: (deviceId: string) => Promise<void>;
  /** Connect using a PSK supplied during pairing. */
  connectWithPsk: (deviceId: string, psk: Uint8Array) => Promise<void>;
  disconnect: () => Promise<void>;
  /** Re-read the selected provider + key from secure storage. */
  refreshProvider: () => Promise<void>;
}

const ConnectionContext = createContext<ConnectionValue | null>(null);

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<MurmurClient | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [provider, setProvider] = useState<LLMProvider | null>(null);

  const connectWithPsk = useCallback(async (id: string, psk: Uint8Array) => {
    const c = new MurmurClient(psk);
    await c.connect(id);
    // Drop back to the device list if the link dies, instead of failing writes silently.
    c.onDisconnected((reason) => {
      log("ctx", "client disconnected -> device list:", reason.message);
      setClient(null);
      setDeviceId(null);
    });
    setClient(c);
    setDeviceId(id);
  }, []);

  const connect = useCallback(
    async (id: string) => {
      const psk = await loadPsk(id);
      if (!psk) throw new Error("device not paired");
      await connectWithPsk(id, psk);
    },
    [connectWithPsk],
  );

  const disconnect = useCallback(async () => {
    await client?.disconnect();
    setClient(null);
    setDeviceId(null);
  }, [client]);

  const refreshProvider = useCallback(async () => {
    const id = await loadSelectedProvider();
    if (!id) return setProvider(null);
    const stored = await loadProvider(id);
    if (!stored?.apiKey) return setProvider(null);
    setProvider(createProvider(id, { apiKey: stored.apiKey, model: stored.model }));
  }, []);

  return (
    <ConnectionContext.Provider
      value={{ client, deviceId, provider, connect, connectWithPsk, disconnect, refreshProvider }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}

export function useConnection(): ConnectionValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error("useConnection must be used within ConnectionProvider");
  return ctx;
}
