// Secure storage for the BLE pre-shared key (per device) and BYO LLM API keys.
// Backed by expo-secure-store (iOS Keychain / Android Keystore-encrypted store),
// matching the nekoni app's secret handling. Secrets never touch the JS bundle
// or plaintext disk.

import * as SecureStore from "expo-secure-store";

import { fromBase64 } from "../crypto/base64.ts";
import type { ProviderId } from "../providers/index.ts";

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

export async function forgetPsk(deviceId: string): Promise<void> {
  await SecureStore.deleteItemAsync(pskKey(deviceId));
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

export async function forgetProvider(id: ProviderId): Promise<void> {
  await SecureStore.deleteItemAsync(providerKey(id));
}

// ---- Selected provider --------------------------------------------------

export async function saveSelectedProvider(id: ProviderId): Promise<void> {
  await SecureStore.setItemAsync(SELECTED_KEY, id);
}

export async function loadSelectedProvider(): Promise<ProviderId | null> {
  const v = await SecureStore.getItemAsync(SELECTED_KEY);
  return v ? (v as ProviderId) : null;
}
