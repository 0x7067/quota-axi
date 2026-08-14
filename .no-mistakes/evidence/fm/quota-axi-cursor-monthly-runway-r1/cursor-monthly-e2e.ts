import { withQuotaSemantics } from "/Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KZZ43VT5A5B6CPNM4ERS04SX/src/interpretation.ts";
import { normalizeCursorUsage } from "/Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KZZ43VT5A5B6CPNM4ERS04SX/src/providers/cursor.ts";
import { redactedResponse, renderQuotaToon } from "/Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KZZ43VT5A5B6CPNM4ERS04SX/src/render.ts";
import { renderQuotaTui } from "/Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KZZ43VT5A5B6CPNM4ERS04SX/src/tui.ts";
import type { ProviderQuota, QuotaAxiResponse } from "/Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01KZZ43VT5A5B6CPNM4ERS04SX/src/types.ts";

const generatedAt = "2026-06-20T00:00:00.000Z";
const fixture = {
  billingCycleEnd: "2026-07-03T00:00:00.000Z",
  planUsage: { totalPercentUsed: 97, autoPercentUsed: 25, apiPercentUsed: 10 },
};
const usage = normalizeCursorUsage(fixture, { planInfo: { planName: "pro" } });
if (!usage) throw new Error("fixture did not normalize");
const provider = withQuotaSemantics(
  {
    provider: "cursor",
    label: "Cursor",
    source: "api",
    plan: usage.plan,
    windows: usage.windows,
    state: { status: "fresh", stale: false, refreshedAt: generatedAt, sourcesTried: ["api"] },
  } satisfies ProviderQuota,
  generatedAt,
);
const response: QuotaAxiResponse = { generatedAt, schemaVersion: 3, providers: [provider] };
const runway = provider.quotaSemantics?.effectiveAvailability[0]?.runway;
if (provider.windows[0]?.pace?.cycleBasis !== "starts_at_resets_at") throw new Error("wrong cycle basis");
if (runway?.status !== "projected_exhaustion") throw new Error("runway did not resolve");
const tui = renderQuotaTui(response, { columns: 100, colorDepth: "none", timeZone: "UTC" });
if (tui.includes("runway unknown") || !tui.includes("empty in")) throw new Error("TUI headline did not resolve");

console.log("CURSOR FIXTURE (no credentials or tokens)");
console.log(JSON.stringify(fixture, null, 2));
console.log("\nEND-USER TUI");
console.log(tui);
console.log("\nTOON");
console.log(renderQuotaToon(redactedResponse(response, false), "quota-axi", false));
console.log("\nJSON CONTRACT EXCERPT");
console.log(JSON.stringify({
  startsAt: provider.windows[0]?.startsAt,
  resetsAt: provider.windows[0]?.resetsAt,
  pace: provider.windows[0]?.pace,
  runway,
}, null, 2));
