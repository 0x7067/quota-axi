import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const sandbox = join(evidenceDir, ".sandbox");
const securityLog = join(sandbox, "security.log");
const artifact = join(evidenceDir, "live-cli-current-user-selection.json");
const account = "fixture-user";

rmSync(sandbox, { recursive: true, force: true });
mkdirSync(join(sandbox, "cache", "quota-axi"), {
  recursive: true,
  mode: 0o700,
});
mkdirSync(join(sandbox, "claude"), { recursive: true, mode: 0o700 });
chmodSync(join(evidenceDir, "security"), 0o755);

process.env.USER = account;
process.env.CLAUDE_CONFIG_DIR = join(sandbox, "claude");
process.env.XDG_CACHE_HOME = join(sandbox, "cache");
process.env.QUOTA_AXI_EVIDENCE_SECURITY_LOG = securityLog;
process.env.PATH = `${evidenceDir}:${process.env.PATH ?? ""}`;

const profileHash = createHash("sha256")
  .update(process.env.CLAUDE_CONFIG_DIR)
  .digest("hex")
  .slice(0, 8);
const accountHash = createHash("sha256")
  .update(account)
  .digest("hex")
  .slice(0, 16);
const marker = join(
  process.env.XDG_CACHE_HOME,
  "quota-axi",
  `claude-keychain-access-granted-${profileHash}-account-${accountHash}`,
);
writeFileSync(marker, "granted\n", { mode: 0o600 });

const requests: Array<{ url: string; authorization: string | null }> = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  const headers = new Headers(init?.headers);
  requests.push({ url, authorization: headers.get("authorization") });
  if (url.endsWith("/api/oauth/profile")) {
    return new Response(
      JSON.stringify({
        account: { uuid: "11111111-2222-4333-8444-555555555555" },
      }),
      { status: 200 },
    );
  }
  return new Response(
    JSON.stringify({
      five_hour: { utilization: 12, resets_at: "2035-01-01T01:00:00Z" },
      seven_day: { utilization: 34, resets_at: "2035-01-07T00:00:00Z" },
    }),
    { status: 200 },
  );
};

const chunks: string[] = [];
const { main } = await import("../../../../src/cli.ts");
await main({
  argv: ["--provider", "claude", "--json", "--full"],
  binPath: "quota-axi",
  stdout: {
    write(chunk: string | Uint8Array) {
      chunks.push(String(chunk));
      return true;
    },
  },
});

const cliOutput = JSON.parse(chunks.join(""));
const keychainCommands = readFileSync(securityLog, "utf8")
  .trim()
  .split("\n");
assert.equal(keychainCommands.length, 1);
assert.match(
  keychainCommands[0],
  /find-generic-password -a fixture-user -w -s Claude Code-credentials-/,
);
assert.equal(
  requests.find(({ url }) => url.endsWith("/api/oauth/usage"))
    ?.authorization,
  "Bearer synthetic-current-user-token",
);
assert.equal(cliOutput.providers[0].state.status, "fresh");
assert.deepEqual(cliOutput.providers[0].state.sourcesTried, [
  "oauth-file",
  "keychain",
  "oauth-profile",
]);
assert.equal(
  JSON.stringify(cliOutput).includes("fixture-user"),
  false,
  "full CLI diagnostics must not expose the selected account",
);

writeFileSync(
  artifact,
  `${JSON.stringify(
    {
      scenario:
        "A stale duplicate service-only record exists, while the current-user Keychain record returns fresh quota.",
      observedKeychainCommands: keychainCommands,
      serviceOnlyFallbackUsed: keychainCommands.some(
        (command) => !command.includes(" -a "),
      ),
      usageRequestUsedCurrentUserCredential: true,
      cliOutput,
      cliDiagnosticsExposeKeychainAccountIdentity: false,
    },
    null,
    2,
  )}\n`,
);

rmSync(sandbox, { recursive: true, force: true });
console.log(artifact);
