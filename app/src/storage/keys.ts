// Secure storage for the BLE pre-shared key (per device) and BYO LLM API keys.
// Backed by expo-secure-store (iOS Keychain / Android Keystore-encrypted store).
// Secrets never touch the JS bundle or plaintext disk.

import * as SecureStore from "expo-secure-store";

import { fromBase64 } from "../crypto/base64.ts";
import type { ProviderId } from "../providers/index.ts";
import type { ThemeMode } from "../theme.ts";
import { deleteAllConversations } from "./conversations.ts";

// SecureStore keys allow only [A-Za-z0-9._-]; sanitize anything device-derived.
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

const pskKey = (deviceId: string) => `murmur.psk.${sanitize(deviceId)}`;
const providerKey = (id: ProviderId) => `murmur.provider.${id}`;
const SELECTED_KEY = "murmur.selectedProvider";

// Concrete provider ids, kept in sync with providers/index.ts. Used to wipe
// every stored key on "delete all data" (SecureStore has no key enumeration).
const PROVIDER_IDS: ProviderId[] = ["anthropic", "openai", "gemini"];

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

// ---- Paired-device index ------------------------------------------------
// SecureStore can't enumerate keys, so we keep a small index of paired devices
// alongside the PSKs. It's what powers "forget device" and lets "delete all
// data" find every stored PSK to remove.

const PAIRED_KEY = "murmur.pairedDevices";

export interface PairedDevice {
  id: string;
  name: string;
}

/** The devices this phone has a stored pairing key for. */
export async function loadPairedDevices(): Promise<PairedDevice[]> {
  const raw = await SecureStore.getItemAsync(PAIRED_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as PairedDevice[];
  } catch {
    return [];
  }
}

/** Record a device in the paired index (call after {@link savePsk}). */
export async function rememberDevice(id: string, name: string): Promise<void> {
  const devices = await loadPairedDevices();
  const rest = devices.filter((d) => d.id !== id);
  rest.push({ id, name: name || id });
  await SecureStore.setItemAsync(PAIRED_KEY, JSON.stringify(rest));
}

/** Forget a single device: drop its PSK and remove it from the index. */
export async function forgetDevice(id: string): Promise<void> {
  await SecureStore.deleteItemAsync(pskKey(id));
  const rest = (await loadPairedDevices()).filter((d) => d.id !== id);
  await SecureStore.setItemAsync(PAIRED_KEY, JSON.stringify(rest));
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

// ---- Wipe everything ----------------------------------------------------

/**
 * Erase all app data from the phone: every device pairing key, all provider API
 * keys, the selected provider, the agent system prompt, the sudo password, the
 * theme preference, and all saved agent conversations. Irreversible.
 */
export async function deleteAllData(): Promise<void> {
  const devices = await loadPairedDevices();
  await Promise.all([
    ...devices.map((d) => SecureStore.deleteItemAsync(pskKey(d.id))),
    ...PROVIDER_IDS.map((id) => SecureStore.deleteItemAsync(providerKey(id))),
    SecureStore.deleteItemAsync(PAIRED_KEY),
    SecureStore.deleteItemAsync(SELECTED_KEY),
    SecureStore.deleteItemAsync(SYSTEM_PROMPT_KEY),
    SecureStore.deleteItemAsync(SUDO_PASSWORD_KEY),
    SecureStore.deleteItemAsync(THEME_KEY),
  ]);
  await deleteAllConversations();
}
