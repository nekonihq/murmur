import unittest

from murmurd import auth


class TestAuth(unittest.TestCase):
    def test_rfc4231_case1(self):
        key = bytes([0x0B]) * 20
        self.assertEqual(
            auth.compute_mac(key, b"Hi There").hex(),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
        )

    def test_rfc4231_case2(self):
        self.assertEqual(
            auth.compute_mac(b"Jefe", b"what do ya want for nothing?").hex(),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        )

    def test_rfc4231_case6_long_key(self):
        key = bytes([0xAA]) * 131
        data = b"Test Using Larger Than Block-Size Key - Hash Key First"
        self.assertEqual(
            auth.compute_mac(key, data).hex(),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
        )

    def test_verify_accepts_correct_and_rejects_wrong(self):
        psk = auth.random_psk()
        nonce = auth.random_nonce()
        mac = auth.encode_b64(auth.compute_mac(psk, nonce))
        self.assertTrue(auth.verify(psk, nonce, mac))
        self.assertFalse(auth.verify(auth.random_psk(), nonce, mac))
        self.assertFalse(auth.verify(psk, auth.random_nonce(), mac))
        self.assertFalse(auth.verify(psk, nonce, "not base64!!!"))


if __name__ == "__main__":
    unittest.main()
