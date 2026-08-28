/**
 * Live loop for the human terminal report: paint a frame, then repaint on a
 * fixed refresh interval until the operator quits with `q` or Ctrl+C. Every
 * terminal effect is injected so the loop is exercised without a real TTY, and
 * the alternate screen, cursor, and raw mode are always restored - including
 * when a refresh throws. This is presentation only; it derives nothing new.
 *
 * The loop owns the viewport: the report renders at whatever height its cards
 * need, and `scrollFrame` windows it onto the terminal's actual rows. Scroll
 * keys move that window, so a terminal too short for the whole report still
 * reaches every line instead of losing the top to the alternate screen.
 */

import { scrollFrame, type ScrollStatus } from "./tui-viewport.js";

export type LiveTuiWriter = { write(chunk: string): unknown };

export type LiveTuiInput = {
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export type LiveTuiIo = {
  stdout: LiveTuiWriter;
  stdin: LiveTuiInput;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(handle: unknown): void;
  /** Current terminal height; absent or unknown means paint unwindowed. */
  rows?(): number | undefined;
  /** Subscribe to terminal resize; returns the unsubscribe function. */
  onResize?(listener: () => void): () => void;
  /** Subscribe to termination signals; returns the unsubscribe function. */
  onSignal?(listener: () => void): () => void;
};

export type LiveTuiOptions<T> = {
  /** Refresh the report. Bounded by the caller, not by this loop. */
  load(): Promise<T>;
  /** Render the current snapshot at the current terminal width. */
  render(value: T): string;
  /** Closing line pinned to the last row, given the live scroll state. */
  status?(status: ScrollStatus): string;
  intervalMillis: number;
  io: LiveTuiIo;
};

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[H\x1b[2J";

type ScrollCommand =
  | "quit"
  | "up"
  | "down"
  | "page-up"
  | "page-down"
  | "top"
  | "bottom";

/** Escape sequences, longest first so `\x1b[1~` never matches as `\x1b[1`. */
const ESCAPE_KEYS: ReadonlyArray<readonly [string, ScrollCommand]> = [
  ["\x1b[5~", "page-up"],
  ["\x1b[6~", "page-down"],
  ["\x1b[1~", "top"],
  ["\x1b[4~", "bottom"],
  ["\x1b[A", "up"],
  ["\x1bOA", "up"],
  ["\x1b[B", "down"],
  ["\x1bOB", "down"],
  ["\x1b[H", "top"],
  ["\x1bOH", "top"],
  ["\x1b[F", "bottom"],
  ["\x1bOF", "bottom"],
];

/** `q`, plus Ctrl+C and Ctrl+D, which raw mode delivers as data, not signals. */
const CHARACTER_KEYS: Readonly<Record<string, ScrollCommand>> = {
  q: "quit",
  Q: "quit",
  "\x03": "quit",
  "\x04": "quit",
  j: "down",
  k: "up",
  "\x05": "down",
  "\x19": "up",
  " ": "page-down",
  f: "page-down",
  b: "page-up",
  "\x06": "page-down",
  "\x02": "page-up",
  g: "top",
  G: "bottom",
};

type WakeReason = "tick" | "resize" | "scroll" | "quit";

/**
 * Run the live report until the operator quits, and return the last snapshot
 * that was painted so the caller can echo a final frame on the normal screen.
 */
export async function runLiveTui<T>({
  load,
  render,
  status,
  intervalMillis,
  io,
}: LiveTuiOptions<T>): Promise<T | undefined> {
  let quit = false;
  let wake: ((reason: WakeReason) => void) | undefined;
  // Resize and scroll bursts coalesce: every wake-up repaints from the current
  // terminal size and scroll offset, so an event that lands with no waiter
  // armed is already covered by the next paint rather than needing its own.
  const notify = (reason: WakeReason): void => {
    const pending = wake;
    wake = undefined;
    pending?.(reason);
  };
  const requestQuit = (): void => {
    quit = true;
    notify("quit");
  };

  // Scroll state outlives each refresh, so a repaint keeps the operator where
  // they were. Every paint reclamps it against the frame it actually produced.
  let offset = 0;
  let pageLines = 1;
  let maxOffset = 0;
  const applyScroll = (command: Exclude<ScrollCommand, "quit">): void => {
    const step = {
      up: -1,
      down: 1,
      "page-up": -pageLines,
      "page-down": pageLines,
      top: -Infinity,
      bottom: Infinity,
    }[command];
    offset = Math.min(Math.max(offset + step, 0), maxOffset);
  };
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let scrolled = false;
    for (const command of parseKeys(text)) {
      if (command === "quit") {
        requestQuit();
        return;
      }
      applyScroll(command);
      scrolled = true;
    }
    if (scrolled) notify("scroll");
  };

  const stopResize = io.onResize?.(() => {
    notify("resize");
  });
  const stopSignal = io.onSignal?.(requestQuit);
  io.stdin.on("data", onData);
  io.stdin.setRawMode?.(true);
  io.stdin.resume?.();
  io.stdout.write(ENTER_SCREEN);

  let value: T | undefined;
  try {
    while (!quit) {
      if (value === undefined) io.stdout.write(`${CLEAR_SCREEN}\n  loading…\n`);
      value = await load();
      if (quit) break;
      const snapshot = value;
      const paint = (): void => {
        const frame = scrollFrame(render(snapshot), {
          rows: io.rows?.(),
          offset,
          ...(status === undefined ? {} : { status }),
        });
        offset = frame.offset;
        maxOffset = frame.maxOffset;
        pageLines = Math.max(1, frame.pageLines);
        // No trailing newline: a frame that exactly fills the terminal would
        // otherwise push its own first row off the alternate screen.
        io.stdout.write(`${CLEAR_SCREEN}${frame.text}`);
      };
      paint();

      let ticked = false;
      const handle = io.setTimer(() => {
        ticked = true;
        notify("tick");
      }, intervalMillis);
      try {
        while (!quit && !ticked) {
          const reason = await new Promise<WakeReason>((resolve) => {
            wake = resolve;
          });
          if (reason !== "resize" && reason !== "scroll") break;
          paint();
        }
      } finally {
        wake = undefined;
        io.clearTimer(handle);
      }
    }
  } finally {
    io.stdout.write(LEAVE_SCREEN);
    io.stdin.off("data", onData);
    io.stdin.setRawMode?.(false);
    io.stdin.pause?.();
    stopResize?.();
    stopSignal?.();
  }
  return value;
}

/** Decode a raw-mode chunk into the commands it carries, in order. */
function parseKeys(text: string): ScrollCommand[] {
  const commands: ScrollCommand[] = [];
  let index = 0;
  while (index < text.length) {
    const escape = ESCAPE_KEYS.find(([sequence]) =>
      text.startsWith(sequence, index),
    );
    if (escape) {
      commands.push(escape[1]);
      index += escape[0].length;
      continue;
    }
    const command = CHARACTER_KEYS[text[index]];
    if (command) commands.push(command);
    index += 1;
  }
  return commands;
}

/** Render a whole-unit refresh interval as "45s", "5m", or "2h". */
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
