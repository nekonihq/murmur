// Secure storage for the BLE pre-shared key (per device) and BYO LLM API keys.
// Backed by the OS Keychain (iOS) / Keystore-encrypted store (Android) via
// react-native-keychain. Secrets never touch the JS bundle or plaintext disk.

import * as Keychain from "react-native-keychain";

import { fromBase64 } from "../crypto/base64.ts";
import type { ProviderId } from "../providers/index.ts";

const PSK_SERVICE = (deviceId: string) => `murmur.psk.${deviceId}`;
const PROVIDER_SERVICE = (id: ProviderId) => `murmur.provider.${id}`;
const SELECTED_SERVICE = "murmur.selectedProvider";

// ---- BLE pre-shared key (paired once per Pi) ----------------------------

/** Persist the base64 PSK obtained during pairing for a given device. */
export async function savePsk(deviceId: string, pskBase64: string): Promise<void> {
  await Keychain.setGenericPassword("psk", pskBase64, { service: PSK_SERVICE(deviceId) });
}

/** Load the PSK bytes for a device, or null if the device isn't paired. */
export async function loadPsk(deviceId: string): Promise<Uint8Array | null> {
  const creds = await Keychain.getGenericPassword({ service: PSK_SERVICE(deviceId) });
  if (!creds) return null;
  return fromBase64(creds.password);
}

export async function forgetPsk(deviceId: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: PSK_SERVICE(deviceId) });
}

// ---- LLM provider keys --------------------------------------------------

export interface StoredProvider {
  apiKey: string;
  model?: string;
}

/** Store an API key (and optional model override) for a provider. */
export async function saveProvider(id: ProviderId, value: StoredProvider): Promise<void> {
  await Keychain.setGenericPassword(id, JSON.stringify(value), {
    service: PROVIDER_SERVICE(id),
  });
}

export async function loadProvider(id: ProviderId): Promise<StoredProvider | null> {
  const creds = await Keychain.getGenericPassword({ service: PROVIDER_SERVICE(id) });
  if (!creds) return null;
  try {
    return JSON.parse(creds.password) as StoredProvider;
  } catch {
    return null;
  }
}

export async function forgetProvider(id: ProviderId): Promise<void> {
  await Keychain.resetGenericPassword({ service: PROVIDER_SERVICE(id) });
}

// ---- Selected provider (non-secret, but kept alongside) -----------------

export async function saveSelectedProvider(id: ProviderId): Promise<void> {
  await Keychain.setGenericPassword("selected", id, { service: SELECTED_SERVICE });
}

export async function loadSelectedProvider(): Promise<ProviderId | null> {
  const creds = await Keychain.getGenericPassword({ service: SELECTED_SERVICE });
  return creds ? (creds.password as ProviderId) : null;
}
