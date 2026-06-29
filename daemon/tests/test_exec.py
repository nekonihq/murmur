import unittest

from murmurd.session import TIMEOUT_EXIT, MAX_CAPTURE, run_exec


class TestExec(unittest.IsolatedAsyncioTestCase):
    async def test_captures_stdout_and_exit_zero(self):
        r = await run_exec("echo hello", None)
        self.assertEqual(r["stdout"].strip(), "hello")
        self.assertEqual(r["exit_code"], 0)
        self.assertFalse(r["truncated"])

    async def test_propagates_nonzero_exit(self):
        r = await run_exec("exit 3", None)
        self.assertEqual(r["exit_code"], 3)

    async def test_captures_stderr(self):
        r = await run_exec("echo oops 1>&2", None)
        self.assertEqual(r["stderr"].strip(), "oops")
        self.assertEqual(r["exit_code"], 0)

    async def test_timeout_is_enforced(self):
        r = await run_exec("sleep 5", 100)
        self.assertEqual(r["exit_code"], TIMEOUT_EXIT)
        self.assertIn("timed out", r["stderr"])

    async def test_large_output_is_truncated(self):
        r = await run_exec("yes x | head -c 400000", None)
        self.assertTrue(r["truncated"])
        self.assertLessEqual(len(r["stdout"]), MAX_CAPTURE)


if __name__ == "__main__":
    unittest.main()
