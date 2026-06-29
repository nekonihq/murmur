import tempfile
import unittest
from pathlib import Path

from murmurd import auth, config


class TestConfig(unittest.TestCase):
    def test_psk_persists_across_loads(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / "murmur"
            first = config.load_or_create_psk(cfg)
            second = config.load_or_create_psk(cfg)
            self.assertEqual(first, second)
            self.assertEqual(len(first), auth.PSK_LEN)
            # stored file is 0600
            self.assertEqual(config.psk_path(cfg).stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
