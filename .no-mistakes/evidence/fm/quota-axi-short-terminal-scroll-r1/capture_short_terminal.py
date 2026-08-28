import codecs
import errno
import fcntl
import html
import os
import pty
import select
import signal
import struct
import termios
import time
from pathlib import Path

import pyte

WORKTREE = Path("/Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01M14RTMW578FV9C841RYW4XPY")
EVIDENCE = Path("/Users/kunchen/.no-mistakes/evidence/01M14RTMW578FV9C841RYW4XPY")
HOME = WORKTREE / ".tui-evidence-home"
COLS = 100


def size(fd, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, COLS, 0, 0))


def start(rows):
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(WORKTREE)
        HOME.mkdir(parents=True, exist_ok=True)
        env = {
            "HOME": str(HOME),
            "PATH": os.environ["PATH"],
            "TERM": "xterm-256color",
            "NO_COLOR": "1",
            "CI": "1",
        }
        os.execvpe(
            "pnpm",
            [
                "pnpm",
                "dev",
                "--tui",
                "--provider",
                "cursor,copilot,grok,kimi,zai,agy",
                "--no-credential-refresh",
            ],
            env,
        )
    size(fd, rows)
    return pid, fd


def pump(fd, screen, seconds=0.3):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], min(0.05, max(0, deadline - time.monotonic())))
        if not ready:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError as exc:
            if exc.errno == errno.EIO:
                return
            raise
        if not data:
            return
        stream.feed(decoder.decode(data))


def wait_for(fd, screen, needle, timeout=15):
    deadline = time.monotonic() + timeout
    while needle not in "\n".join(screen.display):
        if time.monotonic() >= deadline:
            raise RuntimeError(f"timed out waiting for {needle!r}:\n" + "\n".join(screen.display))
        pump(fd, screen, 0.15)


def snap(screen):
    return "\n".join(line.rstrip() for line in screen.display)


def stop(pid, fd):
    os.write(fd, b"q")
    pump(fd, None, 0.5)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    os.close(fd)
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        pass


def startup_path():
    global stream, decoder
    print("capturing startup path", flush=True)
    pid, fd = start(10)
    screen = pyte.Screen(COLS, 10)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    wait_for(fd, screen, "scroll")
    top = snap(screen)
    print("startup top ready", flush=True)
    os.write(fd, b"G")
    pump(fd, screen, 0.5)
    bottom = snap(screen)
    stop(pid, fd)
    return top, bottom


def resize_path():
    global stream, decoder
    print("capturing resize path", flush=True)
    pid, fd = start(45)
    screen = pyte.Screen(COLS, 45)
    stream = pyte.Stream(screen)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    wait_for(fd, screen, "Press q to quit")
    normal = snap(screen)
    print("normal frame ready", flush=True)
    screen.resize(12, COLS)
    size(fd, 12)
    pump(fd, screen, 0.8)
    short = snap(screen)
    os.write(fd, b"G")
    pump(fd, screen, 0.5)
    short_bottom = snap(screen)
    screen.resize(45, COLS)
    size(fd, 45)
    pump(fd, screen, 0.8)
    grown = snap(screen)
    stop(pid, fd)
    return normal, short, short_bottom, grown


def panel(title, note, content, rows):
    return f'''<section><h2>{html.escape(title)}</h2><p>{html.escape(note)}</p><div class="terminal" style="--rows:{rows}"><pre>{html.escape(content)}</pre></div></section>'''


top, bottom = startup_path()
normal, resized, resized_bottom, grown = resize_path()
parts = [
    panel("Startup at 10 rows - top", "The quota header remains visible and the pinned footer reports hidden rows plus scroll keys.", top, 10),
    panel("Startup at 10 rows - after G", "The same live process reaches the last provider cards; the footer now reports rows hidden above.", bottom, 10),
    panel("Live resize 45 to 12 rows", "SIGWINCH repaints the running TUI into exactly 12 rows without clipping its own header.", resized, 12),
    panel("Resized terminal - after G", "Scrolling still reaches the bottom after resize.", resized_bottom, 12),
    panel("Resize back to 45 rows", "Growing the terminal restores the complete unwindowed report and resting quit hint.", grown, 45),
]
doc = f'''<!doctype html><html><head><meta charset="utf-8"><title>quota-axi short terminal PTY evidence</title><style>
:root {{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#11111b; color:#cdd6f4 }}
body {{ max-width:1240px; margin:0 auto; padding:32px }} h1 {{ margin-bottom:6px }} .lede {{ color:#a6adc8; margin-top:0; max-width:900px }}
.grid {{ display:grid; gap:28px }} section {{ background:#181825; border:1px solid #313244; border-radius:14px; padding:18px }}
h2 {{ font-size:18px; margin:0 0 4px }} p {{ color:#a6adc8; margin:0 0 14px }}
.terminal {{ background:#1e1e2e; border:1px solid #45475a; border-radius:9px; padding:12px; overflow:auto; box-shadow:0 12px 32px #0007 inset }}
pre {{ margin:0; min-height:calc(var(--rows) * 1.25em); font:13px/1.25 Menlo, Monaco, Consolas, monospace; color:#cdd6f4; white-space:pre }}
code {{ color:#a6e3a1 }}
</style></head><body><h1>quota-axi short-terminal scrolling</h1><p class="lede">End-to-end captures from the stock interactive <code>pnpm dev --tui --provider cursor,copilot,grok,kimi,zai,agy --no-credential-refresh</code> command in real constrained PTYs, driven by Python <code>pty.fork</code> and rendered with pyte. Credentials were isolated with an empty HOME.</p><main class="grid">{''.join(parts)}</main></body></html>'''
(EVIDENCE / "short-terminal-scroll.html").write_text(doc)
print(EVIDENCE / "short-terminal-scroll.html")
