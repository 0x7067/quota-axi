import { main } from "../../../../src/cli.js";
import { PROVIDERS } from "../../../../src/providers/index.js";
import type { ProviderQuota } from "../../../../src/types.js";

process.env.XDG_CACHE_HOME = new URL("./.transient-cache", import.meta.url)
  .pathname;

function acceptanceQuota(): ProviderQuota {
  const now = Date.now();
  return {
    provider: "claude",
    label: "Claude",
    source: "oauth",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 80,
        percentRemaining: 20,
        startsAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        resetsAt: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "seven_day",
        label: "week",
        kind: "weekly",
        percentUsed: 20,
        percentRemaining: 80,
        startsAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
        resetsAt: new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "extra_usage",
        label: "extra usage",
        kind: "monthly",
        percentUsed: 25,
        percentRemaining: 75,
        resetsAt: new Date(now + 14 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      sourcesTried: ["oauth"],
    },
  };
}

PROVIDERS.claude = {
  id: "claude",
  label: "Claude",
  async fetchQuota() {
    return acceptanceQuota();
  },
  async inspectAuth() {
    return { provider: "claude", sources: [] };
  },
};

async function capture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath: "quota-axi",
    stdout: {
      write(chunk) {
        chunks.push(String(chunk));
        return true;
      },
    },
  });
  return chunks.join("");
}

console.log("=== DEFAULT TOON ===");
console.log(await capture(["--provider", "claude"]));
console.log("\n=== JSON ===");
console.log(await capture(["--provider", "claude", "--json"]));
