"""BlueZ pairing agent + adapter bonding setup.

murmur's security is the app-layer PSK handshake (see :mod:`murmurd.conn`), not
BLE bonding. But BlueZ gates reads of a notifying characteristic's CCCD behind an
*authenticated* (bonded) link: a central that has never bonded with this adapter
gets ``Insufficient Authentication`` when it subscribes, so it tries to pair —
and if the adapter isn't pairable BlueZ refuses (``Pairing not supported``) and
drops the connection a couple seconds later. iOS reads the CCCD right after
connecting, so a phone that has never bonded can't hold a session: the shell
opens, then dies on the reconnect.

To let any central bond without a user prompt, we make the adapter pairable and
register a Just-Works (``NoInputNoOutput``) agent that accepts every request.
The bond grants no access on its own — the PSK handshake still gates every
session; it exists only to satisfy BlueZ's CCCD authentication gate.
"""

import logging

from dbus_next import Variant
from dbus_next.service import ServiceInterface, method

log = logging.getLogger("murmurd.ble")

AGENT_PATH = "/org/murmur/agent"
# NoInputNoOutput => Just-Works pairing: no passkey, no UI. BlueZ only asks us to
# authorize, which we always do (returning normally == accept; raising rejects).
AGENT_CAPABILITY = "NoInputNoOutput"


class _JustWorksAgent(ServiceInterface):
    """An ``org.bluez.Agent1`` that approves every pairing/authorization.

    dbus-next reads the DBus type of each argument from its (string) annotation
    (``o`` = object path, ``s`` = string, ``u``/``q`` = uint32/uint16); a method
    with no return annotation has an empty reply signature.
    """

    def __init__(self) -> None:
        super().__init__("org.bluez.Agent1")

    @method()
    def Release(self):  # noqa: N802 (BlueZ-defined method name)
        pass

    @method()
    def RequestPinCode(self, device: "o") -> "s":  # noqa: N802,F821
        return "0000"

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s"):  # noqa: N802,F821
        pass

    @method()
    def RequestPasskey(self, device: "o") -> "u":  # noqa: N802,F821
        return 0

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q"):  # noqa: N802,F821
        pass

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u"):  # noqa: N802,F821
        pass

    @method()
    def RequestAuthorization(self, device: "o"):  # noqa: N802,F821
        pass

    @method()
    def AuthorizeService(self, device: "o", uuid: "s"):  # noqa: N802,F821
        pass

    @method()
    def Cancel(self):  # noqa: N802
        pass


async def enable_bonding(bus, adapter) -> None:
    """Make ``adapter`` pairable and register a Just-Works agent on ``bus``.

    ``bus`` and ``adapter`` are the dbus-next ``MessageBus`` and adapter
    ``ProxyObject`` that bless creates (``server.bus`` / ``server.adapter``).
    """
    props = adapter.get_interface("org.freedesktop.DBus.Properties")
    await props.call_set("org.bluez.Adapter1", "Pairable", Variant("b", True))
    # 0 == stay pairable indefinitely, so a phone can bond at any time.
    await props.call_set("org.bluez.Adapter1", "PairableTimeout", Variant("u", 0))

    bus.export(AGENT_PATH, _JustWorksAgent())

    intro = await bus.introspect("org.bluez", "/org/bluez")
    manager = bus.get_proxy_object("org.bluez", "/org/bluez", intro).get_interface(
        "org.bluez.AgentManager1"
    )
    await manager.call_register_agent(AGENT_PATH, AGENT_CAPABILITY)
    try:
        await manager.call_request_default_agent(AGENT_PATH)
    except Exception:
        # Another default agent already holds the slot; ours is still registered
        # and BlueZ uses it for this adapter's pairings regardless.
        log.debug("RequestDefaultAgent failed; keeping registered agent", exc_info=True)
