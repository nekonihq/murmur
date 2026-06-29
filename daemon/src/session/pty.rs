//! Interactive PTY session backing **shell mode**. Spawns a login shell on a
//! pseudo-terminal, streams its output to the transport, and forwards stdin,
//! resizes, and signals.

use std::io::{Read, Write};

use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::protocol::messages::Signal;
use crate::protocol::Opcode;
use crate::session::OutEvent;

/// Bytes read from the PTY per chunk before emitting a `DATA` event.
const READ_CHUNK: usize = 4096;

/// A running PTY-backed shell. The master read side is drained on a dedicated
/// blocking thread that pushes `DATA` (and a final `CLOSE_SESSION`) onto the
/// shared out-channel; the controlling task calls [`write_stdin`], [`resize`],
/// and [`signal`] from this struct.
pub struct PtySession {
    session_id: u8,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    /// Open a PTY, spawn `shell`, and start streaming output to `out`.
    pub fn start(
        session_id: u8,
        shell: &str,
        cols: u16,
        rows: u16,
        out: tokio::sync::mpsc::UnboundedSender<OutEvent>,
    ) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("openpty failed")?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn shell")?;
        // Drop the slave so the master sees EOF when the shell exits.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .context("clone pty reader failed")?;
        let writer = pair.master.take_writer().context("take pty writer failed")?;

        // Blocking reader thread: PTY reads are synchronous. UnboundedSender::send
        // is non-async and safe to call from any thread.
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF: shell exited
                    Ok(n) => {
                        let event = OutEvent {
                            session_id,
                            opcode: Opcode::Data,
                            flags: 0,
                            payload: buf[..n].to_vec(),
                        };
                        if out.send(event).is_err() {
                            break; // transport gone
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = out.send(OutEvent::close(session_id));
        });

        Ok(Self {
            session_id,
            master: pair.master,
            writer,
            child,
        })
    }

    pub fn session_id(&self) -> u8 {
        self.session_id
    }

    /// Forward keystrokes / stdin bytes to the shell.
    pub fn write_stdin(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()
    }

    /// Apply a terminal resize (SIGWINCH via the PTY ioctl).
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("pty resize failed")
    }

    /// Deliver a signal. `INT` is written as the terminal interrupt byte (0x03)
    /// so the line discipline raises SIGINT in the foreground process group;
    /// `TERM`/`HUP` terminate the child directly.
    pub fn signal(&mut self, sig: Signal) -> Result<()> {
        match sig {
            Signal::Int => {
                self.write_stdin(&[0x03])?;
            }
            Signal::Term | Signal::Hup => {
                self.child.kill().context("failed to kill child")?;
            }
        }
        Ok(())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}
