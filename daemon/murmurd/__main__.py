"""murmurd CLI. Run with ``python -m murmurd`` (or the ``murmurd`` console
script). Exposes a shell and a one-shot command runner over a BLE GATT service;
the AI agent loop lives on the phone."""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from . import config


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="murmurd", description="murmur BLE remote shell daemon")
    parser.add_argument(
        "--config-dir", type=Path, default=Path("/etc/murmur"),
        help="directory holding the pre-shared key (default: /etc/murmur)",
    )
    parser.add_argument(
        "--shell", default="/bin/bash", help="shell to spawn for pty sessions",
    )
    parser.add_argument(
        "--pair", action="store_true", help="print pairing material for a phone, then exit",
    )
    parser.add_argument(
        "--adapter", default=None, help="BLE adapter name (e.g. hci0); defaults to the first",
    )
    parser.add_argument(
        "--log-level", default="INFO", help="logging level (DEBUG, INFO, WARNING, ...)",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.pair:
        config.print_pairing(args.config_dir)
        return 0

    psk = config.load_or_create_psk(args.config_dir)

    # Import here so `--pair` works without BlueZ/bless installed.
    from . import ble

    try:
        asyncio.run(ble.run(psk, args.shell, args.adapter))
    except KeyboardInterrupt:
        logging.getLogger("murmurd").info("shutting down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
