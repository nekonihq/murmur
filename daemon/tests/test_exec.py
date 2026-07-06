import asyncio
import shutil
import time
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

    async def test_sudo_password_wires_up_askpass(self):
        # Invoking $SUDO_ASKPASS is exactly what sudo does when it needs a
        # password and has no tty; the helper must echo the supplied password.
        r = await run_exec('sh "$SUDO_ASKPASS"', None, sudo_password="hunter2")
        self.assertEqual(r["stdout"].strip(), "hunter2")
        self.assertEqual(r["exit_code"], 0)

    async def test_no_sudo_password_leaves_askpass_unset(self):
        r = await run_exec('printf "%s" "${SUDO_ASKPASS:-unset}"', None)
        self.assertEqual(r["stdout"], "unset")

    async def test_cancellation_kills_the_command_promptly(self):
        # Stop sends CLOSE_SESSION -> the daemon cancels the exec task; run_exec
        # must kill the process and propagate CancelledError without waiting out
        # the command.
        task = asyncio.ensure_future(run_exec("sleep 30", None))
        await asyncio.sleep(0.1)  # let the process spawn
        task.cancel()
        started = time.monotonic()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertLess(time.monotonic() - started, 5)

    @unittest.skipUnless(shutil.which("sudo"), "sudo not installed")
    async def test_sudo_shim_shadows_real_sudo_on_path(self):
        # With a password set, `sudo` must resolve to our shim (which forces -A)
        # rather than the system binary.
        r = await run_exec("command -v sudo", None, sudo_password="x")
        self.assertIn("murmur-sudo", r["stdout"])


if __name__ == "__main__":
    unittest.main()
