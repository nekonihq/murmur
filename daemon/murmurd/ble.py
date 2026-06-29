"""BLE GATT peripheral (Linux/BlueZ via the ``bless`` library).

Integration glue between BlueZ and the transport-agnostic, unit-tested core
(``conn``, ``session``, ``protocol``). **Requires a real BlueZ adapter to
validate** — there is no host-side substitute, which is why all wire-format and
flow-control correctness lives in the tested modules and this layer only shuttles
bytes.

``bless`` install: ``pip install bless`` (pulls in ``dbus-fast``/``bleak``).
"""

from __future__ import annotations

import asyncio
import json
import logging

from bless import (  # type: ignore
    BlessServer,
    GATTAttributePermissions,
    GATTCharacteristicProperties,
)

from .conn import AuthHandler, OutboundPump
from .protocol import Frame, Opcode, ProtocolError, Reassembler
from .session import OutEvent, SessionManager

log = logging.getLogger("murmurd.ble")

SERVICE_UUID = "6d75726d-0000-4000-8000-000000000001"
C2P_UUID = "6d75726d-0000-4000-8000-000000000002"
P2C_UUID = "6d75726d-0000-4000-8000-000000000003"
CTRL_UUID = "6d75726d-0000-4000-8000-000000000004"

LOCAL_NAME = "murmur"
# A BLE notification carries at most (ATT_MTU - 3) bytes per PDU. iOS negotiates
# an ATT MTU of ~185 by default (it just doesn't expose the value, so ble-plx
# reports 23). Now that bonding works, large notifications should go through, so
# we size frames for the ~185 MTU: 175-byte frames (8-byte header + 167 payload)
# stay under 185 - 3 = 182. If a device negotiates only the 23-byte minimum this
# is too big and the central will disconnect — the proper fix is to negotiate the
# real MTU, but this is correct for iOS and ~15x faster than the 20-byte floor.
ASSUMED_MTU = 175

# Pace outbound notifications. bless's update_value is synchronous, so a burst
# (e.g. an 18-frame prompt) is fired back-to-back with no yield, which can make
# BlueZ on a constrained adapter drop the link. A few ms between frames lets each
# notification actually go out over the air.
NOTIFY_PACING_S = 0.006


async def run(psk: bytes, shell: str, adapter: str | None = None) -> None:
    loop = asyncio.get_running_loop()

    # Inbound writes funnel here as (char_uuid, bytes).
    inbound: asyncio.Queue[tuple[str, bytes]] = asyncio.Queue()
    # SessionManager emits OutEvents here.
    out_queue: asyncio.Queue[OutEvent] = asyncio.Queue()

    # All per-connection state lives here so a fresh HELLO (a reconnecting
    # central) can reset it. bless gives us no disconnect callback, so we treat
    # a new HELLO as the start of a new connection.
    class ConnState:
        def __init__(self) -> None:
            self.reset()

        def reset(self) -> None:
            self.auth = AuthHandler(psk)
            self.sessions = SessionManager(out_queue, shell)
            self.pump = OutboundPump(ASSUMED_MTU)
            self.re_c2p = Reassembler()
            self.re_ctrl = Reassembler()

    state = ConnState()

    server = BlessServer(name=LOCAL_NAME, loop=loop)

    def on_write(characteristic, value, **kwargs) -> None:
        # Called by BlueZ when a central writes; hop onto the loop thread.
        uuid = str(characteristic.uuid).lower()
        loop.call_soon_threadsafe(inbound.put_nowait, (uuid, bytes(value)))

    def on_read(characteristic, **kwargs):
        return characteristic.value

    server.write_request_func = on_write
    server.read_request_func = on_read

    await server.add_new_service(SERVICE_UUID)

    write_props = (
        GATTCharacteristicProperties.write
        | GATTCharacteristicProperties.write_without_response
    )
    notify_props = GATTCharacteristicProperties.notify
    rw = GATTAttributePermissions.readable | GATTAttributePermissions.writeable

    await server.add_new_characteristic(
        SERVICE_UUID, C2P_UUID, write_props, bytearray(), rw
    )
    await server.add_new_characteristic(
        SERVICE_UUID, P2C_UUID, notify_props, bytearray(), GATTAttributePermissions.readable
    )
    await server.add_new_characteristic(
        SERVICE_UUID, CTRL_UUID, write_props | notify_props, bytearray(), rw
    )

    await server.start()
    log.info("advertising as '%s' (%s)", LOCAL_NAME, SERVICE_UUID)

    def notify(char_uuid: str, frame: Frame) -> None:
        char = server.get_characteristic(char_uuid)
        char.value = bytearray(frame.encode())
        server.update_value(SERVICE_UUID, char_uuid)

    async def inbound_consumer() -> None:
        while True:
            uuid, data = await inbound.get()
            try:
                _dispatch_inbound(uuid, data)
            except Exception:
                # Never let one bad frame escape to gather() and tear down the link.
                log.exception("inbound handler error")

    def _dispatch_inbound(uuid: str, data: bytes) -> None:
        try:
            frame = Frame.decode(data)
        except ProtocolError as e:
            log.warning("dropping malformed frame: %s", e)
            return
        log.debug("inbound %s on %s (%d bytes)", frame.opcode.name, uuid[-4:], len(data))
        if uuid == CTRL_UUID:
            # A fresh HELLO means a (re)connecting central — reset all
            # per-connection state so the handshake starts clean.
            if frame.opcode == Opcode.HELLO and not frame.has_more and state.auth.is_authenticated:
                log.info("central reconnecting; resetting connection state")
                state.sessions.shutdown()
                state.reset()
            msg = state.re_ctrl.push(frame)
            if not msg:
                return
            if msg.opcode == Opcode.CREDIT:
                if state.auth.is_authenticated:
                    c = json.loads(msg.payload)
                    for f in state.pump.grant(int(c["session_id"]), int(c["n"])):
                        notify(P2C_UUID, f)
            else:
                was_authed = state.auth.is_authenticated
                frames = state.auth.handle(msg)
                if not was_authed and state.auth.is_authenticated:
                    log.info("central authenticated")
                for f in frames:
                    notify(CTRL_UUID, f)
        elif uuid == C2P_UUID:
            msg = state.re_c2p.push(frame)
            if not msg:
                return
            if state.auth.is_authenticated:
                state.sessions.handle(msg)
            else:
                log.warning("dropping pre-auth C2P frame")

    async def outbound_consumer() -> None:
        while True:
            event = await out_queue.get()
            try:
                frames = state.pump.submit(event)
                log.debug(
                    "out %s session %d -> %d frame(s)",
                    event.opcode.name,
                    event.session_id,
                    len(frames),
                )
                for f in frames:
                    notify(P2C_UUID, f)
                    await asyncio.sleep(NOTIFY_PACING_S)
            except Exception:
                log.exception("outbound notify error")

    try:
        await asyncio.gather(inbound_consumer(), outbound_consumer())
    finally:
        await server.stop()
