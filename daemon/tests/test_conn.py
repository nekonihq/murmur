import json
import unittest

from murmurd import auth
from murmurd.conn import AuthHandler, OutboundPump
from murmurd.protocol import Message, Opcode, Reassembler
from murmurd.session import OutEvent


def _decode_one(frames):
    re = Reassembler()
    msg = None
    for f in frames:
        msg = re.push(f) or msg
    return msg


def _msg(opcode, payload):
    return Message(opcode, 0, 0, payload)


class TestAuthHandler(unittest.TestCase):
    def test_full_handshake_succeeds(self):
        psk = auth.random_psk()
        h = AuthHandler(psk)
        hello = _msg(Opcode.HELLO, json.dumps({"proto": 1, "client": "t"}).encode())
        challenge = _decode_one(h.handle(hello))
        self.assertEqual(challenge.opcode, Opcode.AUTH_CHALLENGE)
        nonce = auth.decode_b64(json.loads(challenge.payload)["nonce"])
        mac = auth.encode_b64(auth.compute_mac(psk, nonce))
        ok = _decode_one(h.handle(_msg(Opcode.AUTH_RESPONSE, json.dumps({"mac": mac}).encode())))
        self.assertEqual(ok.opcode, Opcode.AUTH_OK)
        self.assertTrue(h.is_authenticated)

    def test_bad_mac_fails(self):
        h = AuthHandler(auth.random_psk())
        h.handle(_msg(Opcode.HELLO, b'{"proto":1}'))
        bad = auth.encode_b64(b"\x00" * 32)
        fail = _decode_one(h.handle(_msg(Opcode.AUTH_RESPONSE, json.dumps({"mac": bad}).encode())))
        self.assertEqual(fail.opcode, Opcode.AUTH_FAIL)
        self.assertFalse(h.is_authenticated)

    def test_version_mismatch_rejected(self):
        h = AuthHandler(auth.random_psk())
        fail = _decode_one(h.handle(_msg(Opcode.HELLO, b'{"proto":99}')))
        self.assertEqual(fail.opcode, Opcode.AUTH_FAIL)


class TestOutboundPump(unittest.TestCase):
    def test_control_opcodes_bypass_credits(self):
        pump = OutboundPump(100)
        frames = pump.submit(OutEvent(1, Opcode.SESSION_OPENED, 0, b'{"session_id":1}'))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].opcode, Opcode.SESSION_OPENED)

    def test_data_waits_for_credits(self):
        pump = OutboundPump(100)
        self.assertEqual(pump.submit(OutEvent(1, Opcode.DATA, 0, b"hello")), [])
        self.assertEqual(pump.pending_len, 1)
        released = pump.grant(1, 1)
        self.assertEqual(len(released), 1)
        self.assertEqual(released[0].opcode, Opcode.DATA)
        self.assertEqual(pump.pending_len, 0)

    def test_fragmented_data_needs_credits_for_all_fragments(self):
        pump = OutboundPump(16)  # max_payload 8 -> 20 bytes = 3 frames
        self.assertEqual(pump.submit(OutEvent(2, Opcode.DATA, 0, bytes(20))), [])
        self.assertEqual(pump.grant(2, 2), [])  # not enough for 3
        frames = pump.grant(2, 1)
        self.assertEqual(len(frames), 3)
        self.assertTrue(frames[0].has_more)
        self.assertFalse(frames[2].has_more)


if __name__ == "__main__":
    unittest.main()
