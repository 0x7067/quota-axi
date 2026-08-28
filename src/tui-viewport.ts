/**
 * Viewport for the live human report. `renderQuotaTui` is height-independent by
 * design: it lays the cards out for the terminal's width and returns however
 * many lines that takes. The live loop paints into the alternate screen, which
 * has no scrollback, so a frame taller than the terminal scrolls its own header
 * and first cards into nothing. This module windows that frame onto the rows
 * actually available and reports what is off-screen, so every line stays
 * reachable. Pure string math - no ANSI, no terminal I/O, no derivation.
 */

/** Rows below which the report header stops being pinned to make room. */
const STICKY_HEADER_MIN_ROWS = 5;

export type ScrollStatus = {
  /** True when the report is taller than the viewport and is being windowed. */
  scrollable: boolean;
  /** Report lines hidden above the window. */
  offset: number;
  /** Largest offset that still fills the window; the bottom of the report. */
  maxOffset: number;
};

export type ScrolledFrame = {
  /** The lines to paint, already limited to the viewport height. */
  text: string;
  /** `offset` clamped to the report's real bounds. */
  offset: number;
  maxOffset: number;
  scrollable: boolean;
  /** Report lines inside the scrolling region; the page-key step. */
  pageLines: number;
  status: ScrollStatus;
};

export type ScrollFrameOptions = {
  /** Terminal height. Unknown or non-positive means no windowing at all. */
  rows?: number;
  offset?: number;
  /**
   * Closing line, rendered by the caller so it can carry the report's styling.
   * Omitted entirely when absent, which is what the plain loop tests exercise.
   */
  status?: (status: ScrollStatus) => string;
};

/**
 * Window `body` onto `rows` terminal rows. When the whole report plus its
 * closing line already fits, the frame is the report exactly as it renders at
 * full height. When it does not, the first line stays pinned (it is the report
 * header), the last row carries the closing line, and the rest scrolls.
 */
export function scrollFrame(
  body: string,
  options: ScrollFrameOptions = {},
): ScrolledFrame {
  const bodyLines = body === "" ? [] : body.split("\n");
  const rows = options.rows;
  const resting = restingFrame(bodyLines, options.status);
  if (rows === undefined || !Number.isFinite(rows) || rows <= 0) return resting;
  if (bodyLines.length + (options.status ? 2 : 0) <= rows) return resting;

  let headerRows =
    rows >= STICKY_HEADER_MIN_ROWS && bodyLines.length > 0 ? 1 : 0;
  let statusRows = options.status ? 1 : 0;
  // Content wins the last rows: drop the closing line, then the pinned header,
  // rather than ever painting a frame taller than the terminal.
  if (rows - headerRows - statusRows < 1) statusRows = 0;
  if (rows - headerRows - statusRows < 1) headerRows = 0;
  const pageLines = rows - headerRows - statusRows;

  const scrolling = bodyLines.slice(headerRows);
  const maxOffset = Math.max(0, scrolling.length - pageLines);
  const offset = clamp(Math.trunc(options.offset ?? 0), 0, maxOffset);
  const status: ScrollStatus = { scrollable: true, offset, maxOffset };

  const lines = [
    ...bodyLines.slice(0, headerRows),
    ...scrolling.slice(offset, offset + pageLines),
  ];
  if (statusRows === 1 && options.status) lines.push(options.status(status));
  return {
    text: lines.join("\n"),
    offset,
    maxOffset,
    scrollable: true,
    pageLines,
    status,
  };
}

function restingFrame(
  bodyLines: string[],
  status?: (status: ScrollStatus) => string,
): ScrolledFrame {
  const resting: ScrollStatus = { scrollable: false, offset: 0, maxOffset: 0 };
  const lines = [...bodyLines];
  if (status) lines.push("", status(resting));
  return {
    text: lines.join("\n"),
    offset: 0,
    maxOffset: 0,
    scrollable: false,
    pageLines: Math.max(1, bodyLines.length),
    status: resting,
  };
}

/**
 * Closing-line text: the caller's resting hint while everything fits, and the
 * scroll affordance - how much is off-screen in each direction, plus the keys
 * that move it - once the report is being windowed.
 */
export function scrollHint(status: ScrollStatus, restingHint: string): string {
  if (!status.scrollable) return restingHint;
  const above = status.offset;
  const below = status.maxOffset - status.offset;
  const parts: string[] = [];
  if (above > 0) parts.push(`↑ ${above} more`);
  if (below > 0) parts.push(`↓ ${below} more`);
  parts.push("j/k PgUp/PgDn g/G scroll", "q quit");
  return parts.join(" · ");
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
