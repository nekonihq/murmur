"""Session layer: multiplexes ``pty`` (shell mode) and ``exec`` (agent mode)
sessions, turning inbound :class:`Message`s into outbound :class:`OutEvent`s for
the transport to fragment and send."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal as signalmod
import struct
import threading
from dataclasses import dataclass

from .protocol import Message, Opcode

log = logging.getLogger("murmurd.session")

# Per-stream capture cap for exec; output beyond this is dropped + flagged.
MAX_CAPTURE = 256 * 1024
TIMEOUT_EXIT = 124
READ_CHUNK = 4096


@dataclass
class OutEvent:
    session_id: int
    opcode: Opcode
    flags: int
    payload: bytes

    @classmethod
    def json(cls, session_id: int, opcode: Opcode, value: dict) -> "OutEvent":
        payload = json.dumps(value, separators=(",", ":")).encode()
        return cls(session_id, opcode, 0, payload)

    @classmethod
    def close(cls, session_id: int) -> "OutEvent":
        return cls.json(session_id, Opcode.CLOSE_SESSION, {"session_id": session_id})

    @classmethod
    def error(cls, session_id: int, code: str, msg: str) -> "OutEvent":
        return cls.json(session_id, Opcode.ERROR, {"code": code, "msg": msg})


# ---- exec (agent mode) --------------------------------------------------


def _cap(data: bytes) -> tuple[str, bool]:
    if len(data) > MAX_CAPTURE:
        return data[:MAX_CAPTURE].decode("utf-8", "replace"), True
    return data.decode("utf-8", "replace"), False


_askpass_path: str | None = None
_sudo_shim_dir: str | None = None


def _kill_group(proc) -> None:
    """SIGKILL the command's whole process group (it's a session leader via
    ``start_new_session``), so children die too — not just the top ``/bin/sh``.
    Root-owned children spawned by sudo may survive if the daemon isn't root."""
    try:
        os.killpg(os.getpgid(proc.pid), signalmod.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _askpass_helper() -> str:
    """Path to a cached askpass helper that echoes ``$MURMUR_SUDO_PASS``.

    The password lives only in the child process's environment; the helper
    script on disk contains no secret. sudo invokes it (via ``sudo -A``, forced
    by the shim below) to read the password without a terminal.
    """
    global _askpass_path
    if _askpass_path and os.path.exists(_askpass_path):
        return _askpass_path
    import stat
    import tempfile

    fd, path = tempfile.mkstemp(prefix="murmur-askpass-")
    with os.fdopen(fd, "w") as f:
        f.write('#!/bin/sh\nprintf \'%s\\n\' "$MURMUR_SUDO_PASS"\n')
    os.chmod(path, stat.S_IRWXU)  # 0700: only the daemon user may read/run it
    _askpass_path = path
    return path


def _sudo_shim_bindir() -> str | None:
    """Directory holding a ``sudo`` shim that re-execs the real sudo with ``-A``.

    Prepended to the command's PATH so any bare ``sudo`` becomes ``sudo -A`` and
    reads the password from our askpass helper. This is needed because many sudo
    builds (Raspberry Pi OS among them) only consult ``SUDO_ASKPASS`` when ``-A``
    is given — without it they demand a terminal and fail. Returns None if sudo
    isn't installed.
    """
    global _sudo_shim_dir
    if _sudo_shim_dir and os.path.exists(_sudo_shim_dir):
        return _sudo_shim_dir
    import shlex
    import shutil
    import stat
    import tempfile

    # Resolve using the daemon's own PATH (no shim on it), so there's no
    # recursion when the shim execs the real sudo.
    real = shutil.which("sudo")
    if not real:
        return None
    d = tempfile.mkdtemp(prefix="murmur-sudo-")
    shim = os.path.join(d, "sudo")
    with open(shim, "w") as f:
        f.write(f'#!/bin/sh\nexec {shlex.quote(real)} -A "$@"\n')
    os.chmod(shim, stat.S_IRWXU)
    _sudo_shim_dir = d
    return d


async def run_exec(cmd: str, timeout_ms: int | None, sudo_password: str | None = None) -> dict:
    """Run ``cmd`` via /bin/sh -c, optionally bounded by ``timeout_ms``.

    Runs in a new session (no controlling terminal) so an interactive ``sudo``
    can never grab the daemon's tty and prompt on the Pi's console. When
    ``sudo_password`` is supplied, a PATH shim forces ``sudo -A`` and an askpass
    helper feeds it the password; without one, a password-requiring sudo fails
    fast with sudo's own error rather than hanging.
    """
    env = None
    if sudo_password:
        env = {
            **os.environ,
            "SUDO_ASKPASS": _askpass_helper(),
            "MURMUR_SUDO_PASS": sudo_password,
        }
        bindir = _sudo_shim_bindir()
        if bindir:
            env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
    try:
        proc = await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-c",
            cmd,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
            env=env,
        )
    except OSError as e:
        return {"stdout": "", "stderr": f"failed to spawn command: {e}",
                "exit_code": -1, "truncated": False}

    try:
        if timeout_ms is not None:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout_ms / 1000
            )
        else:
            stdout, stderr = await proc.communicate()
    except asyncio.TimeoutError:
        _kill_group(proc)
        await proc.wait()
        return {"stdout": "", "stderr": f"command timed out after {timeout_ms} ms",
                "exit_code": TIMEOUT_EXIT, "truncated": False}
    except asyncio.CancelledError:
        # The central sent CLOSE_SESSION (Stop). Kill the whole process group so
        # the command and its children die, then propagate the cancellation.
        _kill_group(proc)
        await proc.wait()
        raise

    out, t1 = _cap(stdout)
    err, t2 = _cap(stderr)
    return {"stdout": out, "stderr": err,
            "exit_code": proc.returncode if proc.returncode is not None else -1,
            "truncated": t1 or t2}


# ---- pty (shell mode) ---------------------------------------------------


class PtySession:
    """A running PTY-backed shell. Output is drained on a dedicated thread that
    pushes DATA (and a final CLOSE_SESSION) onto the asyncio out-queue."""

    def __init__(self, session_id: int, master_fd: int, proc, loop, queue) -> None:
        self.session_id = session_id
        self._master_fd = master_fd
        self._proc = proc
        self._loop = loop
        self._queue = queue
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    @classmethod
    def start(cls, session_id: int, shell: str, cols: int, rows: int, loop, queue) -> "PtySession":
        import pty

        master_fd, slave_fd = pty.openpty()
        _set_winsize(master_fd, cols, rows)

        def _preexec() -> None:
            os.setsid()
            try:
                import fcntl
                import termios

                fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            except OSError:
                pass

        import subprocess

        proc = subprocess.Popen(
            [shell],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            preexec_fn=_preexec,
            env={**os.environ, "TERM": "xterm-256color"},
            close_fds=True,
        )
        os.close(slave_fd)  # child holds its own copy
        return cls(session_id, master_fd, proc, loop, queue)

    def _emit(self, event: OutEvent) -> None:
        self._loop.call_soon_threadsafe(self._queue.put_nowait, event)

    def _read_loop(self) -> None:
        while True:
            try:
                data = os.read(self._master_fd, READ_CHUNK)
            except OSError:
                break
            if not data:
                break  # EOF: shell exited
            log.debug("pty session %d: %d bytes out", self.session_id, len(data))
            self._emit(OutEvent(self.session_id, Opcode.DATA, 0, data))
        log.info("pty session %d: shell exited", self.session_id)
        self._emit(OutEvent.close(self.session_id))

    def write_stdin(self, data: bytes) -> None:
        os.write(self._master_fd, data)

    def resize(self, cols: int, rows: int) -> None:
        _set_winsize(self._master_fd, cols, rows)

    def signal(self, name: str) -> None:
        if name == "INT":
            os.write(self._master_fd, b"\x03")  # terminal interrupt -> SIGINT
        elif name in ("TERM", "HUP"):
            sig = signalmod.SIGTERM if name == "TERM" else signalmod.SIGHUP
            try:
                os.killpg(os.getpgid(self._proc.pid), sig)
            except (ProcessLookupError, OSError):
                pass

    def close(self) -> None:
        try:
            os.killpg(os.getpgid(self._proc.pid), signalmod.SIGKILL)
        except (ProcessLookupError, OSError):
            pass
        try:
            os.close(self._master_fd)
        except OSError:
            pass


def _set_winsize(fd: int, cols: int, rows: int) -> None:
    import fcntl
    import termios

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


# ---- session manager ----------------------------------------------------


class SessionManager:
    """Owns all active sessions for one authenticated connection."""

    def __init__(self, queue: "asyncio.Queue[OutEvent]", shell: str) -> None:
        self._queue = queue
        self._shell = shell
        self._loop = asyncio.get_event_loop()
        self._ptys: dict[int, PtySession] = {}
        self._execs: dict[int, "asyncio.Task"] = {}

    def _emit(self, event: OutEvent) -> None:
        self._queue.put_nowait(event)

    def handle(self, msg: Message) -> None:
        try:
            if msg.opcode == Opcode.OPEN_SESSION:
                self._on_open(msg.payload)
            elif msg.opcode == Opcode.DATA:
                self._on_data(msg.session_id, msg.payload)
            elif msg.opcode == Opcode.RESIZE:
                self._on_resize(msg.session_id, msg.payload)
            elif msg.opcode == Opcode.SIGNAL:
                self._on_signal(msg.session_id, msg.payload)
            elif msg.opcode == Opcode.EXEC:
                self._on_exec(msg.session_id, msg.payload)
            elif msg.opcode == Opcode.CLOSE_SESSION:
                self._on_close(msg.session_id)
            else:
                log.debug("ignoring inbound opcode %s", msg.opcode)
        except Exception as e:  # never let one bad message kill the loop
            log.exception("session handler error")
            self._emit(OutEvent.error(msg.session_id, "handler", str(e)))

    def _on_open(self, payload: bytes) -> None:
        req = json.loads(payload)
        sid = int(req["session_id"])
        mode = req.get("mode")
        if mode == "pty":
            try:
                self._ptys[sid] = PtySession.start(
                    sid, self._shell, int(req.get("cols", 80)),
                    int(req.get("rows", 24)), self._loop, self._queue,
                )
            except Exception as e:
                log.exception("pty start failed")
                self._emit(OutEvent.error(sid, "pty_start", str(e)))
                return
            log.info("pty session %d started", sid)
        else:
            log.info("exec session %d started", sid)
        self._emit(OutEvent.json(sid, Opcode.SESSION_OPENED, {"session_id": sid}))

    def _on_data(self, session_id: int, data: bytes) -> None:
        pty = self._ptys.get(session_id)
        if pty:
            log.debug("stdin %d bytes -> pty session %d", len(data), session_id)
            pty.write_stdin(data)
        else:
            log.warning("DATA for unknown session %d", session_id)

    def _on_resize(self, session_id: int, payload: bytes) -> None:
        req = json.loads(payload)
        pty = self._ptys.get(session_id)
        if pty:
            pty.resize(int(req["cols"]), int(req["rows"]))

    def _on_signal(self, session_id: int, payload: bytes) -> None:
        name = json.loads(payload)  # e.g. "INT"
        pty = self._ptys.get(session_id)
        if pty:
            pty.signal(name)

    def _on_exec(self, session_id: int, payload: bytes) -> None:
        req = json.loads(payload)
        cmd = req["cmd"]
        timeout_ms = req.get("timeout_ms")
        sudo_password = req.get("sudo_password")

        async def _run() -> None:
            try:
                result = await run_exec(cmd, timeout_ms, sudo_password)
            except asyncio.CancelledError:
                return  # Stop: command was killed, drop the (never-sent) result
            finally:
                self._execs.pop(session_id, None)
            self._emit(OutEvent.json(session_id, Opcode.EXEC_RESULT, result))

        # A prior exec on this session shouldn't still be running (the central
        # serializes them), but cancel any stragglers before starting a new one.
        old = self._execs.pop(session_id, None)
        if old and not old.done():
            old.cancel()
        self._execs[session_id] = asyncio.ensure_future(_run())

    def _on_close(self, session_id: int) -> None:
        pty = self._ptys.pop(session_id, None)
        if pty:
            pty.close()
        task = self._execs.pop(session_id, None)
        if task and not task.done():
            task.cancel()  # Stop: kills the running command (see run_exec)

    def shutdown(self) -> None:
        """Close every session (used when a connection is reset/replaced)."""
        for pty in self._ptys.values():
            pty.close()
        self._ptys.clear()
        for task in self._execs.values():
            if not task.done():
                task.cancel()
        self._execs.clear()
