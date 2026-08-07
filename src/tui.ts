import type {
  EffectiveAvailability,
  ProviderId,
  ProviderQuota,
  QuotaAxiResponse,
  QuotaWindow,
} from "./types.js";

/**
 * Human terminal report ("Direction D'"): a two-up card grid with thin
 * headroom bars and a linear-pace marker on every bar. This surface is
 * presentation only - it renders the same redacted response the TOON and JSON
 * surfaces receive and derives nothing new from providers or the cache.
 */

export type TuiColorDepth = "none" | "16" | "256" | "truecolor";

export type TuiOptions = {
  /** Raw terminal width; clamped to [80, 120], defaults to 100. */
  columns?: number;
  colorDepth?: TuiColorDepth;
  /** Mirrors `--full`: appends account identity and source-attempt footers. */
  full?: boolean;
  /** IANA time zone for header/absolute times; defaults to the system zone. */
  timeZone?: string;
};

const CARD_WIDTH = 49;
const CARD_INTERIOR = CARD_WIDTH - 2;
const CARD_GUTTER = 2;
const TWO_COLUMN_MIN = CARD_WIDTH * 2 + CARD_GUTTER;
const EFFECTIVE_BAR_WIDTH = 41;
const WINDOW_BAR_WIDTH = 13;
const MIN_COLUMNS = 80;
const MAX_COLUMNS = 120;

type StyleName =
  | "dim"
  | "dimmer"
  | "dimBold"
  | "label"
  | "ok"
  | "okBold"
  | "warn"
  | "warnBold"
  | "crit"
  | "critBold"
  | "marker"
  | "track"
  | "border"
  | "borderDim"
  | `accent:${ProviderId}`;

type Segment = { text: string; style?: StyleName };
type Line = Segment[];

type StyleSpec = {
  rgb: [number, number, number];
  ansi16: string;
  bold?: boolean;
};

const ACCENTS: Record<ProviderId, StyleSpec> = {
  claude: { rgb: [250, 179, 135], ansi16: "93", bold: true },
  codex: { rgb: [148, 226, 213], ansi16: "96", bold: true },
  cursor: { rgb: [137, 180, 250], ansi16: "94", bold: true },
  copilot: { rgb: [116, 199, 236], ansi16: "94", bold: true },
  grok: { rgb: [180, 190, 254], ansi16: "95", bold: true },
  kimi: { rgb: [245, 194, 231], ansi16: "95", bold: true },
};

const STYLES: Record<Exclude<StyleName, `accent:${ProviderId}`>, StyleSpec> = {
  dim: { rgb: [127, 132, 156], ansi16: "90" },
  dimmer: { rgb: [88, 91, 112], ansi16: "90" },
  dimBold: { rgb: [127, 132, 156], ansi16: "90", bold: true },
  label: { rgb: [166, 173, 200], ansi16: "37" },
  ok: { rgb: [166, 227, 161], ansi16: "32" },
  okBold: { rgb: [166, 227, 161], ansi16: "32", bold: true },
  warn: { rgb: [249, 226, 175], ansi16: "33" },
  warnBold: { rgb: [249, 226, 175], ansi16: "33", bold: true },
  crit: { rgb: [243, 139, 168], ansi16: "31" },
  critBold: { rgb: [243, 139, 168], ansi16: "31", bold: true },
  marker: { rgb: [137, 220, 235], ansi16: "96" },
  track: { rgb: [69, 71, 90], ansi16: "90" },
  border: { rgb: [88, 91, 112], ansi16: "90" },
  borderDim: { rgb: [49, 50, 68], ansi16: "90" },
};

/**
 * Resolve the color depth for the TUI report from the environment. Honors
 * NO_COLOR, TERM=dumb, and non-TTY stdout (color off, glyph skeleton kept);
 * FORCE_COLOR re-enables. Truecolor requires COLORTERM=truecolor|24bit.
 */
export function detectTuiColorDepth(
  env: Record<string, string | undefined>,
  isTty: boolean,
): TuiColorDepth {
  const force = env.FORCE_COLOR;
  const forced = force !== undefined && force !== "0";
  if (!forced) {
    if (env.NO_COLOR !== undefined) return "none";
    if (env.TERM === "dumb") return "none";
    if (!isTty) return "none";
  }
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "") || force === "3") {
    return "truecolor";
  }
  if ((env.TERM ?? "").includes("256color") || force === "2") return "256";
  return "16";
}

export function renderQuotaTui(
  response: QuotaAxiResponse,
  options: TuiOptions = {},
): string {
  const columns = Math.min(
    MAX_COLUMNS,
    Math.max(MIN_COLUMNS, options.columns ?? TWO_COLUMN_MIN),
  );
  const twoColumn = columns >= TWO_COLUMN_MIN;
  const generatedAtMs = Date.parse(response.generatedAt);
  const timeZone = options.timeZone;

  const ordered = [
    ...response.providers.filter(isLive),
    ...response.providers.filter((provider) => !isLive(provider)),
  ];
  const cards = ordered.map((provider) =>
    buildCard(provider, generatedAtMs, timeZone),
  );

  const lines: Line[] = [];
  lines.push([{ text: `  ${headerText(response, timeZone)}`, style: "dim" }]);
  lines.push([]);
  lines.push(...layoutCards(cards, twoColumn));
  if (cards.some((card) => card.hasMarker)) {
    lines.push([]);
    lines.push(...legendLine(columns));
  }
  if (options.full) {
    lines.push([]);
    for (const provider of ordered) {
      lines.push([
        {
          text: `  ${fullFooterText(provider, columns - 2)}`,
          style: "dim",
        },
      ]);
    }
  }

  return lines
    .map((line) => renderLine(trimRight(line), options.colorDepth ?? "none"))
    .join("\n");
}

function isLive(provider: ProviderQuota): boolean {
  return provider.state.status === "fresh" || provider.state.status === "stale";
}

function headerText(response: QuotaAxiResponse, timeZone?: string): string {
  const live = response.providers.filter(isLive).length;
  const signedOut = response.providers.filter(
    (provider) => provider.state.status === "auth_required",
  ).length;
  const failed = response.providers.length - live - signedOut;
  const parts = [
    "quota-axi",
    formatHeaderTime(response.generatedAt, timeZone),
    `${live} live`,
    `${signedOut} signed out`,
  ];
  if (failed > 0) parts.push(`${failed} unavailable`);
  return parts.filter(Boolean).join(" · ");
}

type Card = { lines: Line[]; hasMarker: boolean };

function buildCard(
  provider: ProviderQuota,
  generatedAtMs: number,
  timeZone?: string,
): Card {
  return isLive(provider)
    ? buildLiveCard(provider, generatedAtMs, timeZone)
    : buildFailedCard(provider);
}

function buildLiveCard(
  provider: ProviderQuota,
  generatedAtMs: number,
  timeZone?: string,
): Card {
  const stale = provider.state.stale;
  const rightTitle = [
    provider.plan,
    provider.source,
    stale ? "stale" : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const lines: Line[] = [
    titleLine(
      {
        text: ` ● ${provider.provider} `,
        style: `accent:${provider.provider}`,
      },
      rightTitle,
      "border",
    ),
    interior([], "border"),
  ];
  let hasMarker = false;

  const headline = pickHeadlineAvailability(provider);
  const effectivePct = headline?.effectivePercentRemaining;
  const markerPct = effectiveMarkerPercent(provider, headline);
  if (markerPct !== undefined) hasMarker = true;

  const left: Line =
    effectivePct !== undefined
      ? [
          {
            text: `${Math.round(effectivePct)}%`,
            style: boldHealthStyle(effectivePct),
          },
          { text: ` ${scopeLabel(headline?.scope)}`, style: "dim" },
        ]
      : [
          {
            text: stale ? "stale · effective unknown" : "effective unknown",
            style: "dim",
          },
        ];
  const verdict = runwayVerdict(headline);
  lines.push(
    interior(
      [
        { text: "   " },
        ...padBetween(left, verdict, EFFECTIVE_BAR_WIDTH),
        { text: "   " },
      ],
      "border",
    ),
  );
  lines.push(
    interior(
      [
        { text: "   " },
        ...thinBar(effectivePct, markerPct, EFFECTIVE_BAR_WIDTH),
        { text: "   " },
      ],
      "border",
    ),
  );

  if (provider.windows.length > 0) {
    lines.push(interior([], "border"));
    for (const window of provider.windows) {
      if (window.pace?.timeRemainingPercent !== undefined) hasMarker = true;
      lines.push(interior(windowRow(window, generatedAtMs), "border"));
    }
  }

  for (const note of cardNotes(provider, headline, generatedAtMs, timeZone)) {
    lines.push(
      interior(
        [{ text: `   ${truncate(note, CARD_INTERIOR - 4)}`, style: "dimmer" }],
        "border",
      ),
    );
  }

  lines.push(interior([], "border"));
  lines.push(bottomLine("border"));
  return { lines, hasMarker };
}

function buildFailedCard(provider: ProviderQuota): Card {
  const status = provider.state.status;
  const rightTitle =
    status === "auth_required" ? "signed out" : humanize(status);
  const lines: Line[] = [
    titleLine(
      { text: ` ○ ${provider.provider} `, style: "dimBold" },
      rightTitle,
      "borderDim",
    ),
    interior([], "borderDim"),
  ];
  const message =
    humanize(provider.state.error ?? "") ||
    (status === "auth_required" ? "sign-in required" : humanize(status));
  const body: { text: string; style: StyleName }[] = [
    { text: message, style: "dim" },
  ];
  if (provider.state.retryAfter) {
    body.push({
      text: `retry after ${provider.state.retryAfter}`,
      style: "dim",
    });
  }
  if (provider.state.remedyCommand) {
    body.push({ text: `run: ${provider.state.remedyCommand}`, style: "dim" });
  }
  body.push({ text: "excluded from fleet totals", style: "dimmer" });
  for (const entry of body) {
    lines.push(
      interior(
        [
          {
            text: `   ${truncate(entry.text, CARD_INTERIOR - 4)}`,
            style: entry.style,
          },
        ],
        "borderDim",
      ),
    );
  }
  lines.push(interior([], "borderDim"));
  lines.push(bottomLine("borderDim"));
  return { lines, hasMarker: false };
}

function titleLine(
  name: Segment,
  rightText: string,
  borderStyle: StyleName,
): Line {
  let right = rightText === "" ? "" : ` ${rightText} `;
  let dashes = CARD_WIDTH - 4 - name.text.length - right.length;
  if (dashes < 1) {
    right = ` ${truncate(rightText, Math.max(0, CARD_WIDTH - 7 - name.text.length))} `;
    dashes = Math.max(1, CARD_WIDTH - 4 - name.text.length - right.length);
  }
  return [
    { text: "╭─", style: borderStyle },
    name,
    { text: "─".repeat(dashes), style: borderStyle },
    { text: right, style: "dim" },
    { text: "─╮", style: borderStyle },
  ];
}

function bottomLine(borderStyle: StyleName): Line {
  return [{ text: `╰${"─".repeat(CARD_INTERIOR)}╯`, style: borderStyle }];
}

function interior(content: Line, borderStyle: StyleName): Line {
  const used = lineWidth(content);
  const pad = Math.max(0, CARD_INTERIOR - used);
  return [
    { text: "│", style: borderStyle },
    ...content,
    { text: " ".repeat(pad) },
    { text: "│", style: borderStyle },
  ];
}

function windowRow(window: QuotaWindow, generatedAtMs: number): Line {
  const pct = window.percentRemaining;
  const marker = window.pace?.timeRemainingPercent;
  const reset = resetCountdown(window, generatedAtMs);
  return [
    { text: "   " },
    { text: shortWindowLabel(window).padEnd(8), style: "label" },
    ...thinBar(pct, marker, WINDOW_BAR_WIDTH),
    { text: " " },
    {
      text: (pct === undefined ? "?" : `${Math.round(pct)}%`).padStart(4),
      style: pct === undefined ? "dim" : healthStyle(pct),
    },
    { text: "  " },
    { text: reset.padEnd(6), style: "dim" },
    { text: "  " },
    ...burnChip(window),
    { text: " " },
  ];
}

/**
 * Quiet-Ledger thin bar with the linear-pace marker: fill is current
 * headroom at half-cell resolution, `┃` overwrites the cell at
 * `timeRemainingPercent` (the fill position of exactly linear burn), and the
 * marker is omitted when pace is unknown rather than faked.
 */
export function thinBar(
  percentRemaining: number | undefined,
  markerPercent: number | undefined,
  width: number,
): Line {
  const fillStyle: StyleName =
    percentRemaining === undefined ? "track" : healthStyle(percentRemaining);
  let halfUnits = 0;
  if (percentRemaining !== undefined) {
    const pct = Math.min(100, Math.max(0, percentRemaining));
    halfUnits = Math.round((pct / 100) * width * 2);
    if (pct > 0 && halfUnits === 0) halfUnits = 1;
    if (pct < 100 && halfUnits === width * 2) halfUnits = width * 2 - 1;
  }
  const cells: Segment[] = [];
  for (let index = 0; index < width; index++) {
    const cellHalves = Math.min(2, Math.max(0, halfUnits - index * 2));
    if (cellHalves === 2) cells.push({ text: "━", style: fillStyle });
    else if (cellHalves === 1) cells.push({ text: "╸", style: fillStyle });
    else cells.push({ text: "─", style: "track" });
  }
  if (markerPercent !== undefined && Number.isFinite(markerPercent)) {
    const cell = Math.min(
      width - 1,
      Math.max(0, Math.round((markerPercent / 100) * width)),
    );
    cells[cell] = { text: "┃", style: "marker" };
  }
  return coalesce(cells);
}

function burnChip(window: QuotaWindow): Line {
  const pace = window.pace;
  const width = 7;
  if (pace?.burnMultiple === undefined) {
    return [{ text: " ".repeat(width) }];
  }
  const value = formatBurn(pace.burnMultiple);
  if (pace.status === "behind") {
    return [{ text: `▼ ${value}×`.padStart(width), style: "ok" }];
  }
  if (pace.status === "ahead") {
    const health = healthStyle(window.percentRemaining ?? 100);
    return [
      {
        text: `▲ ${value}×`.padStart(width),
        style: health === "ok" ? "warn" : health,
      },
    ];
  }
  return [{ text: `● ${value}×`.padStart(width), style: "dim" }];
}

function formatBurn(burn: number): string {
  if (burn >= 100) return "99+";
  return burn >= 10 ? burn.toFixed(1) : burn.toFixed(2);
}

function pickHeadlineAvailability(
  provider: ProviderQuota,
): EffectiveAvailability | undefined {
  const availability = provider.quotaSemantics?.effectiveAvailability ?? [];
  return (
    availability.find(
      (entry) => entry.scope.startsWith("all_") && entry.status === "known",
    ) ??
    availability.find((entry) => entry.status === "known") ??
    availability[0]
  );
}

function effectiveMarkerPercent(
  provider: ProviderQuota,
  headline: EffectiveAvailability | undefined,
): number | undefined {
  if (!headline) return undefined;
  const limitingId =
    headline.runway?.limitingWindowId ?? headline.limitingWindowIds?.[0];
  if (limitingId === undefined) return undefined;
  const limiting = provider.windows.find((window) => window.id === limitingId);
  return limiting?.pace?.timeRemainingPercent;
}

function runwayVerdict(headline: EffectiveAvailability | undefined): Line {
  const runway = headline?.runway;
  if (!runway || runway.status === "unknown") {
    return [{ text: "runway unknown", style: "dim" }];
  }
  if (runway.status === "through_reset") {
    return [
      { text: "through reset ", style: "dim" },
      { text: "✓", style: "okBold" },
    ];
  }
  if (runway.status === "exhausted_now") {
    return [{ text: "✗ exhausted now", style: "critBold" }];
  }
  const seconds = runway.usableRunwaySeconds;
  const text =
    seconds === undefined
      ? "▲ exhaustion projected"
      : `▲ empty in ${formatCountdown(seconds)}`;
  return [{ text, style: "warnBold" }];
}

function cardNotes(
  provider: ProviderQuota,
  headline: EffectiveAvailability | undefined,
  generatedAtMs: number,
  timeZone?: string,
): string[] {
  const notes: string[] = [];
  const runway = headline?.runway;
  if (
    runway?.status === "projected_exhaustion" &&
    runway.projectedExhaustedAt
  ) {
    const absolute = formatAbsolute(
      runway.projectedExhaustedAt,
      generatedAtMs,
      timeZone,
    );
    if (absolute) notes.push(`projected empty ${absolute}`);
  }
  if (provider.state.retryAfter) {
    notes.push(`retry after ${provider.state.retryAfter}`);
  }
  if (provider.state.remedyCommand) {
    notes.push(`run: ${provider.state.remedyCommand}`);
  }
  return notes;
}

function scopeLabel(scope: string | undefined): string {
  if (scope === undefined) return "unknown scope";
  return humanize(scope.replace(/^all_/, "all "));
}

/**
 * Compress a window label into the 7-char row column: drop a trailing
 * period/unit token ("Fable week" -> "fable", "730h window" -> "730h"),
 * then fall back to the last hyphen segment and an ellipsis.
 */
export function shortWindowLabel(window: QuotaWindow): string {
  const tokens = window.label.split(/[\s_]+/).filter(Boolean);
  if (
    tokens.length > 1 &&
    /^(week|window|day|month|session|usage|quota)$/i.test(
      tokens[tokens.length - 1],
    )
  ) {
    tokens.pop();
  }
  let label = tokens.join(" ").toLowerCase();
  if (label.length > 7 && label.includes("-")) {
    label = label.slice(label.lastIndexOf("-") + 1);
  }
  if (label.length > 7) label = `${label.slice(0, 6)}…`;
  return label || window.id.slice(0, 7);
}

function resetCountdown(window: QuotaWindow, generatedAtMs: number): string {
  if (window.resetsAt !== undefined) {
    const resetMs = Date.parse(window.resetsAt);
    if (Number.isFinite(resetMs) && Number.isFinite(generatedAtMs)) {
      return formatCountdown((resetMs - generatedAtMs) / 1000);
    }
  }
  return window.resetText === undefined ? "" : truncate(window.resetText, 6);
}

/** Two-unit countdown ("4h 39m", "4d 21h") degrading to one unit at 7+ chars. */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  if (seconds <= 0) return "now";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    const both = `${days}d ${hours}h`;
    return both.length > 6 ? truncate(`${days}d`, 6) : both;
  }
  if (hours > 0) {
    const both = `${hours}h ${minutes}m`;
    return both.length > 6 ? `${hours}h` : both;
  }
  return minutes > 0 ? `${minutes}m` : "<1m";
}

function formatHeaderTime(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(timeZone ? { timeZone } : {}),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).formatToParts(new Date(ms));
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")} ${get("timeZoneName")}`.trim();
}

function formatAbsolute(
  iso: string,
  generatedAtMs: number,
  timeZone?: string,
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const zone = timeZone ? { timeZone } : {};
  const dayKey = (value: Date): string =>
    new Intl.DateTimeFormat("en-CA", { ...zone, dateStyle: "short" }).format(
      value,
    );
  const time = new Intl.DateTimeFormat("en-GB", {
    ...zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (
    Number.isFinite(generatedAtMs) &&
    dayKey(date) === dayKey(new Date(generatedAtMs))
  ) {
    return time;
  }
  if (Number.isFinite(generatedAtMs) && ms - generatedAtMs < 6 * 86400 * 1000) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      ...zone,
      weekday: "short",
    }).format(date);
    return `${weekday} ${time}`;
  }
  return new Intl.DateTimeFormat("en-US", {
    ...zone,
    month: "short",
    day: "numeric",
  }).format(date);
}

function fullFooterText(provider: ProviderQuota, width: number): string {
  const parts: string[] = [provider.provider];
  if (provider.account?.email) parts.push(provider.account.email);
  if (provider.account?.organization) parts.push(provider.account.organization);
  if (provider.account?.accountId) parts.push(`id ${provider.account.accountId}`);
  if (provider.account?.identityStatus) {
    parts.push(`identity ${provider.account.identityStatus}`);
  }
  const attempts = (provider.attempts ?? []).map(
    (attempt) =>
      `${attempt.source}${
        attempt.status === "success"
          ? ""
          : ` (${attempt.status}${attempt.error ? `: ${attempt.error}` : ""})`
      }`,
  );
  const tried = attempts.length > 0 ? attempts : provider.state.sourcesTried;
  if (tried.length > 0) parts.push(`tried ${tried.join(" → ")}`);
  return fitFooterParts(parts, width);
}

function fitFooterParts(parts: string[], width: number): string {
  const separator = " · ";
  const complete = parts.join(separator);
  if (complete.length <= width) return complete;

  const available = Math.max(0, width - separator.length * (parts.length - 1));
  const widths = new Array<number>(parts.length).fill(0);
  widths[0] = Math.min(parts[0].length, available);
  let remaining = available - widths[0];
  let pending = parts.slice(1).map((_, index) => index + 1);

  while (pending.length > 0) {
    const share = Math.floor(remaining / pending.length);
    const fitting = pending.filter((index) => parts[index].length <= share);
    if (fitting.length === 0) {
      for (const [position, index] of pending.entries()) {
        widths[index] = share + (position < remaining % pending.length ? 1 : 0);
      }
      break;
    }
    for (const index of fitting) {
      widths[index] = parts[index].length;
      remaining -= widths[index];
    }
    pending = pending.filter((index) => !fitting.includes(index));
  }

  return parts
    .map((part, index) => truncate(part, widths[index]))
    .join(separator);
}

function legendLine(columns: number): Line[] {
  const long: Line = [
    { text: "  " },
    { text: "┃", style: "marker" },
    { text: " marks linear pace - fill ending left of ", style: "dim" },
    { text: "┃", style: "marker" },
    { text: " is burning faster than the reset clock", style: "dim" },
  ];
  const short: Line = [
    { text: "  " },
    { text: "┃", style: "marker" },
    { text: " = linear pace (fill left of ", style: "dim" },
    { text: "┃", style: "marker" },
    { text: " = burning hot)", style: "dim" },
  ];
  return [lineWidth(long) <= columns ? long : short];
}

function layoutCards(cards: Card[], twoColumn: boolean): Line[] {
  const lines: Line[] = [];
  if (!twoColumn) {
    cards.forEach((card, index) => {
      if (index > 0) lines.push([]);
      lines.push(...card.lines);
    });
    return lines;
  }
  for (let index = 0; index < cards.length; index += 2) {
    if (index > 0) lines.push([]);
    const left = cards[index].lines;
    const right = cards[index + 1]?.lines ?? [];
    const height = Math.max(left.length, right.length);
    for (let row = 0; row < height; row++) {
      const leftLine = left[row] ?? [{ text: " ".repeat(CARD_WIDTH) }];
      const rightLine = right[row] ?? [];
      lines.push([
        ...leftLine,
        { text: " ".repeat(CARD_GUTTER) },
        ...rightLine,
      ]);
    }
  }
  return lines;
}

function healthStyle(pct: number): "ok" | "warn" | "crit" {
  if (pct >= 50) return "ok";
  if (pct >= 20) return "warn";
  return "crit";
}

function boldHealthStyle(pct: number): "okBold" | "warnBold" | "critBold" {
  return `${healthStyle(pct)}Bold`;
}

function humanize(text: string): string {
  return text.replace(/_/g, " ");
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function padBetween(left: Line, right: Line, width: number): Line {
  const pad = Math.max(1, width - lineWidth(left) - lineWidth(right));
  return [...left, { text: " ".repeat(pad) }, ...right];
}

function lineWidth(line: Line): number {
  return line.reduce((sum, segment) => sum + segment.text.length, 0);
}

function coalesce(segments: Segment[]): Line {
  const out: Segment[] = [];
  for (const segment of segments) {
    const last = out[out.length - 1];
    if (last && last.style === segment.style) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

function trimRight(line: Line): Line {
  const out = line.map((segment) => ({ ...segment }));
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last.style === undefined) last.text = last.text.replace(/ +$/, "");
    if (last.text === "") out.pop();
    else break;
  }
  return out;
}

function renderLine(line: Line, depth: TuiColorDepth): string {
  if (depth === "none") {
    return line.map((segment) => segment.text).join("");
  }
  return line
    .map((segment) => {
      if (segment.style === undefined) return segment.text;
      const sgr = styleSgr(segment.style, depth);
      return sgr === "" ? segment.text : `\x1b[${sgr}m${segment.text}\x1b[0m`;
    })
    .join("");
}

function styleSgr(style: StyleName, depth: TuiColorDepth): string {
  const spec = style.startsWith("accent:")
    ? ACCENTS[style.slice("accent:".length) as ProviderId]
    : STYLES[style as Exclude<StyleName, `accent:${ProviderId}`>];
  const codes: string[] = [];
  if (spec.bold) codes.push("1");
  if (depth === "truecolor") {
    codes.push(`38;2;${spec.rgb[0]};${spec.rgb[1]};${spec.rgb[2]}`);
  } else if (depth === "256") {
    codes.push(`38;5;${rgbToAnsi256(spec.rgb)}`);
  } else {
    codes.push(spec.ansi16);
  }
  return codes.join(";");
}

function rgbToAnsi256([r, g, b]: [number, number, number]): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const level = (value: number): number =>
    value < 48
      ? 0
      : value < 115
        ? 1
        : Math.min(5, Math.round((value - 35) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}
