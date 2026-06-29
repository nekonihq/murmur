// BLE transport over react-native-ble-plx. Scans for the murmur service,
// connects, negotiates MTU, and exchanges raw frame bytes on the three
// characteristics. Framing/auth/sessions live one layer up in `client.ts`.

import { BleManager, Device, type Subscription } from "react-native-ble-plx";

import { toBase64, fromBase64 } from "../crypto/base64.ts";
import { log } from "../log.ts";

export const SERVICE_UUID = "6d75726d-0000-4000-8000-000000000001";
export const C2P_UUID = "6d75726d-0000-4000-8000-000000000002";
export const P2C_UUID = "6d75726d-0000-4000-8000-000000000003";
export const CTRL_UUID = "6d75726d-0000-4000-8000-000000000004";

/** Inbound characteristics the central subscribes to. */
export type NotifyChannel = "p2c" | "ctrl";
/** Outbound characteristics the central writes to. */
export type WriteChannel = "c2p" | "ctrl";

const REQUESTED_MTU = 247;
const DEFAULT_MTU = 23;

export interface DiscoveredDevice {
  id: string;
  name: string | null;
}

/**
 * Thin BLE wrapper. One instance per app; `connect` binds to a single device.
 */
export class BleTransport {
  private manager = new BleManager();
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private mtu = DEFAULT_MTU;
  private onBytes: ((chan: NotifyChannel, bytes: Uint8Array) => void) | null = null;
  private onDisc: ((reason: Error | null) => void) | null = null;

  /** Register a callback fired when the peripheral disconnects. */
  onDisconnected(cb: (reason: Error | null) => void): void {
    this.onDisc = cb;
  }

  /** Scan for murmur peripherals, invoking `onFound` for each unique device. */
  scan(onFound: (d: DiscoveredDevice) => void, onError: (e: Error) => void): () => void {
    this.manager.startDeviceScan([SERVICE_UUID], null, (error, device) => {
      if (error) {
        onError(error);
        return;
      }
      if (device) onFound({ id: device.id, name: device.name });
    });
    return () => this.manager.stopDeviceScan();
  }

  negotiatedMtu(): number {
    return this.mtu;
  }

  /** Connect to a device id, negotiate MTU, and discover services. */
  async connect(deviceId: string): Promise<void> {
    this.manager.stopDeviceScan();
    let device = await this.manager.connectToDevice(deviceId);
    device = await device.requestMTU(REQUESTED_MTU).catch(() => device);
    // ble-plx reports the ATT MTU including its own overhead; usable payload is
    // mtu - 3 (ATT opcode + handle). Frame.max_payload subtracts our 8-byte
    // header from whatever we pass as the working MTU.
    this.mtu = Math.max(DEFAULT_MTU, (device.mtu ?? DEFAULT_MTU) - 3);
    await device.discoverAllServicesAndCharacteristics();
    this.device = device;
    log("ble", "connected", device.id, "mtu", device.mtu, "-> working", this.mtu);
    // Surface link drops instead of letting later operations throw uncaught.
    this.subs.push(
      device.onDisconnected((error, dev) => {
        const e = error as { errorCode?: number; reason?: string | null; message?: string } | null;
        log("ble", "DISCONNECTED", dev?.id, {
          errorCode: e?.errorCode,
          reason: e?.reason,
          message: e?.message,
        });
        this.device = null;
        this.onDisc?.(error ? new Error(error.message ?? "disconnected") : null);
      }),
    );
  }

  /** Register the inbound-bytes handler and subscribe to P2C + CTRL notifies. */
  listen(onBytes: (chan: NotifyChannel, bytes: Uint8Array) => void): void {
    if (!this.device) throw new Error("not connected");
    this.onBytes = onBytes;
    this.subs.push(this.subscribe(P2C_UUID, "p2c"));
    this.subs.push(this.subscribe(CTRL_UUID, "ctrl"));
  }

  private subscribe(charUuid: string, chan: NotifyChannel): Subscription {
    return this.device!.monitorCharacteristicForService(
      SERVICE_UUID,
      charUuid,
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        this.onBytes?.(chan, fromBase64(characteristic.value));
      },
    );
  }

  /** Write one frame's bytes to a characteristic. */
  async send(chan: WriteChannel, bytes: Uint8Array): Promise<void> {
    if (!this.device) throw new Error("not connected");
    const uuid = chan === "c2p" ? C2P_UUID : CTRL_UUID;
    const b64 = toBase64(bytes);
    // Use write-with-response on both characteristics. bless (the Pi-side GATT
    // server) does not implement BlueZ's AcquireWrite socket, so
    // write-without-response is silently dropped — with-response goes through
    // BlueZ WriteValue and reliably reaches the daemon's write callback.
    await this.device.writeCharacteristicWithResponseForService(SERVICE_UUID, uuid, b64);
  }

  async disconnect(): Promise<void> {
    for (const s of this.subs) s.remove();
    this.subs = [];
    if (this.device) {
      await this.manager.cancelDeviceConnection(this.device.id).catch(() => {});
      this.device = null;
    }
  }

  destroy(): void {
    this.manager.destroy();
  }
}
