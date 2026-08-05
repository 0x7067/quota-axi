import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { PROVIDERS } from "../src/providers/index.js";
import type { ProviderAdapter, ProviderQuota } from "../src/types.js";

const originalClaude = PROVIDERS.claude;

afterEach(() => {
  PROVIDERS.claude = originalClaude;
  process.exitCode = undefined;
});

describe("models command", () => {
  it("emits filtered JSON model evidence and compact TOON", async () => {
    PROVIDERS.claude = adapter({
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "model:fable",
          label: "Fable week",
          kind: "model",
          percentUsed: 20,
          percentRemaining: 80,
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });

    const json = JSON.parse(
      await capture([
        "models",
        "--provider",
        "claude",
        "--intelligence",
        "high",
        "--json",
      ]),
    );
    expect(json).toMatchObject({
      schemaVersion: 1,
      catalog: { version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
    expect(json.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          id: "claude-opus-4-5",
          intelligence: "high",
          quotaScopes: ["model:fable"],
          state: { status: "fresh", stale: false },
        }),
      ]),
    );
    expect(json.models).toHaveLength(2);

    const sorted = JSON.parse(
      await capture([
        "models",
        "--provider",
        "claude",
        "--sort",
        "runway",
        "--json",
      ]),
    );
    expect(sorted.sort).toMatchObject({ key: "runway" });
    expect(sorted.sort.tieGroups).toContainEqual([
      { provider: "claude", id: "claude-haiku-4-5" },
      { provider: "claude", id: "claude-opus-4-5" },
      { provider: "claude", id: "claude-sonnet-4-5" },
    ]);

    const toon = await capture(["models", "--provider", "claude"]);
    expect(toon).toContain("models[");
    expect(toon).toContain("claude-opus-4-5");
    expect(toon).toContain(
      "Default model order is deterministic and non-preferential",
    );
  });

  it("rejects unsupported model filters and comparators as usage errors", async () => {
    const intelligence = await capture([
      "models",
      "--intelligence",
      "frontier",
    ]);
    expect(intelligence).toContain(
      "--intelligence requires high, medium, or low",
    );
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    const sort = await capture(["models", "--sort", "cost"]);
    expect(sort).toContain("Supported sort keys: runway");
    expect(process.exitCode).toBe(2);
  });
});

async function capture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath: "quota-axi",
    stdout: { write: (chunk) => chunks.push(String(chunk)) },
  });
  return chunks.join("");
}

function adapter(quota: ProviderQuota): ProviderAdapter {
  return {
    id: quota.provider,
    label: quota.label,
    async fetchQuota() {
      return quota;
    },
    async inspectAuth() {
      return { provider: quota.provider, sources: [] };
    },
  };
}
