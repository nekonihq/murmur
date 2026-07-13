import unittest

from murmurd.protocol import (
    FRAG_MORE,
    HEADER_LEN,
    PROTO_VERSION,
    STREAM_ERR,
    Frame,
    Opcode,
    ProtocolError,
    Reassembler,
    SeqCounter,
    fragment,
    max_payload,
)


class TestProtocol(unittest.TestCase):
    def test_golden_vector_matches_ts(self):
        # ver=1, DATA(0x12), session=7, flags=STREAM_ERR(0x02), seq=0x1234, len=2, "hi"
        frame = Frame(Opcode.DATA, 7, STREAM_ERR, 0x1234, b"hi")
        self.assertEqual(
            list(frame.encode()),
            [0x01, 0x12, 0x07, 0x02, 0x12, 0x34, 0x00, 0x02, 0x68, 0x69],
        )

    def test_encode_decode_round_trip(self):
        frame = Frame(Opcode.EXEC, 3, FRAG_MORE, 65535, bytes([0, 1, 2, 250, 255]))
        self.assertEqual(Frame.decode(frame.encode()), frame)

    def test_decode_rejects_short_and_bad_version(self):
        with self.assertRaises(ProtocolError):
            Frame.decode(bytes([1, 2, 3]))
        bad = bytearray(Frame(Opcode.HELLO, 0, 0, 0, b"").encode())
        bad[0] = 99
        with self.assertRaises(ProtocolError):
            Frame.decode(bytes(bad))

    def test_decode_rejects_length_mismatch(self):
        buf = Frame(Opcode.DATA, 1, 0, 0, b"abc").encode()[:-1]
        with self.assertRaises(ProtocolError):
            Frame.decode(buf)

    def test_fragment_marks_all_but_last_and_keeps_flags(self):
        seq = SeqCounter()
        frames = fragment(Opcode.DATA, 2, STREAM_ERR, bytes(range(50)), 20, seq)
        self.assertEqual(len(frames), 3)
        self.assertTrue(frames[0].has_more and frames[1].has_more)
        self.assertFalse(frames[2].has_more)
        self.assertEqual(frames[0].flags, STREAM_ERR | FRAG_MORE)
        self.assertEqual(frames[2].flags, STREAM_ERR)
        self.assertEqual(seq.value, 3)

    def test_fragment_empty_payload_is_one_frame(self):
        seq = SeqCounter(5)
        frames = fragment(Opcode.AUTH_OK, 0, 0, b"", 100, seq)
        self.assertEqual(len(frames), 1)
        self.assertFalse(frames[0].has_more)
        self.assertEqual(frames[0].payload, b"")
        self.assertEqual(seq.value, 6)

    def test_reassembler_rebuilds_fragmented_message(self):
        seq = SeqCounter()
        payload = bytes(range(100))
        frames = fragment(Opcode.EXEC_RESULT, 4, 0, payload, 16, seq)
        self.assertGreater(len(frames), 1)
        re = Reassembler()
        msg = None
        for f in frames:
            msg = re.push(f) or msg
        self.assertEqual(msg.opcode, Opcode.EXEC_RESULT)
        self.assertEqual(msg.session_id, 4)
        self.assertEqual(msg.payload, payload)

    def test_fragmentation_round_trips_through_tiny_mtu(self):
        mtu = 23
        original = bytes(i % 256 for i in range(1000))
        seq = SeqCounter()
        frames = fragment(Opcode.DATA, 9, 0, original, max_payload(mtu), seq)
        re = Reassembler()
        rebuilt = None
        for f in frames:
            encoded = f.encode()
            self.assertLessEqual(len(encoded), mtu)
            msg = re.push(Frame.decode(encoded))
            if msg:
                rebuilt = msg.payload
        self.assertEqual(rebuilt, original)

    def test_reassembler_resyncs_after_lost_frame(self):
        re = Reassembler()
        # Message A starts at seq 0 with more to come.
        re.push(Frame(Opcode.DATA, 1, FRAG_MORE, 0, b"aa"))
        # seq 1 lost; next frame starts a new message at seq 2 — the gap must
        # drop A's partial so it doesn't corrupt the new message.
        self.assertIsNone(re.push(Frame(Opcode.DATA, 1, FRAG_MORE, 2, b"bb")))
        msg = re.push(Frame(Opcode.DATA, 1, 0, 3, b"cc"))
        self.assertIsNotNone(msg)
        self.assertEqual(msg.payload, b"bbcc")  # not b"aabbcc"

    def test_header_len_constant(self):
        self.assertEqual(HEADER_LEN, 8)
        self.assertEqual(PROTO_VERSION, 1)


if __name__ == "__main__":
    unittest.main()
