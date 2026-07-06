// Secure storage for the BLE pre-shared key (per device) and BYO LLM API keys.
// Backed by expo-secure-store (iOS Keychain / Android Keystore-encrypted store).
// Secrets never touch the JS bundle or plaintext disk.

import * as SecureStore from "expo-secure-store";

import { fromBase64 } from "../crypto/base64.ts";
import type { ProviderId } from "../providers/index.ts";
import type { ThemeMode } from "../theme.ts";

// SecureStore keys allow only [A-Za-z0-9._-]; sanitize anything device-derived.
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

const pskKey = (deviceId: string) => `murmur.psk.${sanitize(deviceId)}`;
const providerKey = (id: ProviderId) => `murmur.provider.${id}`;
const SELECTED_KEY = "murmur.selectedProvider";

// ---- BLE pre-shared key (paired once per Pi) ----------------------------

/** Persist the base64 PSK obtained during pairing for a given device. */
export async function savePsk(deviceId: string, pskBase64: string): Promise<void> {
  await SecureStore.setItemAsync(pskKey(deviceId), pskBase64);
}

/** Load the PSK bytes for a device, or null if the device isn't paired. */
export async function loadPsk(deviceId: string): Promise<Uint8Array | null> {
  const b64 = await SecureStore.getItemAsync(pskKey(deviceId));
  return b64 ? fromBase64(b64) : null;
}

// ---- LLM provider keys --------------------------------------------------

export interface StoredProvider {
  apiKey: string;
  model?: string;
}

/** Store an API key (and optional model override) for a provider. */
export async function saveProvider(id: ProviderId, value: StoredProvider): Promise<void> {
  await SecureStore.setItemAsync(providerKey(id), JSON.stringify(value));
}

export async function loadProvider(id: ProviderId): Promise<StoredProvider | null> {
  const raw = await SecureStore.getItemAsync(providerKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredProvider;
  } catch {
    return null;
  }
}

// ---- Selected provider --------------------------------------------------

export async function saveSelectedProvider(id: ProviderId): Promise<void> {
  await SecureStore.setItemAsync(SELECTED_KEY, id);
}

export async function loadSelectedProvider(): Promise<ProviderId | null> {
  const v = await SecureStore.getItemAsync(SELECTED_KEY);
  return v ? (v as ProviderId) : null;
}

// ---- Theme preference ---------------------------------------------------
// Not a secret, but SecureStore is the only persistence the app wires up, so
// the preference rides along there rather than pulling in another dependency.

const THEME_KEY = "murmur.themePref";

export async function saveThemePref(mode: ThemeMode): Promise<void> {
  await SecureStore.setItemAsync(THEME_KEY, mode);
}

export async function loadThemePref(): Promise<ThemeMode> {
  const v = await SecureStore.getItemAsync(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

// ---- Agent system prompt ------------------------------------------------
// A blank/absent value means "use the built-in default" (DEFAULT_SYSTEM_PROMPT).

const SYSTEM_PROMPT_KEY = "murmur.systemPrompt";

export async function saveSystemPrompt(text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed) await SecureStore.setItemAsync(SYSTEM_PROMPT_KEY, trimmed);
  else await SecureStore.deleteItemAsync(SYSTEM_PROMPT_KEY);
}

export async function loadSystemPrompt(): Promise<string | null> {
  return SecureStore.getItemAsync(SYSTEM_PROMPT_KEY);
}

// ---- sudo password ------------------------------------------------------
// Used in agent mode: sent over the encrypted link only when a command uses
// sudo, so the daemon can answer sudo's password prompt via an askpass helper.

const SUDO_PASSWORD_KEY = "murmur.sudoPassword";

export async function saveSudoPassword(password: string): Promise<void> {
  if (password) await SecureStore.setItemAsync(SUDO_PASSWORD_KEY, password);
  else await SecureStore.deleteItemAsync(SUDO_PASSWORD_KEY);
}

export async function loadSudoPassword(): Promise<string | null> {
  return SecureStore.getItemAsync(SUDO_PASSWORD_KEY);
}
