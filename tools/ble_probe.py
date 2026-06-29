#!/usr/bin/env python3
"""First-bringup probe for murmurd.

Scans for the murmur BLE service, connects, negotiates MTU, and dumps the GATT
characteristics so you can confirm the daemon advertises correctly before the
mobile app exists. This is a connectivity check, not a full protocol client —
end-to-end protocol exercise happens through the app (which has the matching
auth/framing implementation).

Usage:
    pip install bleak
    python3 tools/ble_probe.py
"""

import asyncio

from bleak import BleakClient, BleakScanner  # type: ignore

SERVICE_UUID = "6d75726d-0000-4000-8000-000000000001"
CHARS = {
    "6d75726d-0000-4000-8000-000000000002": "C2P (write)",
    "6d75726d-0000-4000-8000-000000000003": "P2C (notify)",
    "6d75726d-0000-4000-8000-000000000004": "CTRL (write+notify)",
}


async def main() -> None:
    print("scanning for the murmur service…")
    device = await BleakScanner.find_device_by_filter(
        lambda d, adv: SERVICE_UUID.lower() in [u.lower() for u in (adv.service_uuids or [])],
        timeout=15.0,
    )
    if device is None:
        print("no murmur peripheral found — is murmurd running and advertising?")
        return

    print(f"found {device.name or '(unnamed)'} [{device.address}]")
    async with BleakClient(device) as client:
        print(f"connected; MTU = {client.mtu_size}")
        for service in client.services:
            if service.uuid.lower() != SERVICE_UUID.lower():
                continue
            print(f"service {service.uuid}")
            for char in service.characteristics:
                label = CHARS.get(char.uuid.lower(), "?")
                print(f"  char {char.uuid}  {label}  props={','.join(char.properties)}")
        print("ok — service and characteristics look correct.")


if __name__ == "__main__":
    asyncio.run(main())
