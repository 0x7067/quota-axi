import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(): Promise<void> {
const sandbox = mkdtempSync(join(tmpdir(), "quota-axi-refresh-evidence-"));
try {
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  process.env.HOME = sandbox;
  process.env.XDG_CACHE_HOME = join(sandbox, "cache");
  process.env.PATH = join(sandbox, "bin");
  process.env.CLAUDE_CONFIG_DIR = join(sandbox, ".claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  mkdirSync(process.env.PATH, { recursive: true });

  const credentialFile = join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: {
    accessToken: "expired-access-fixture",
    refreshToken: "refresh-presence-fixture",
    expiresAt: Date.parse("2020-01-01T00:00:00.000Z"),
    subscriptionType: "max",
  }}));

  const invocationLog = join(sandbox, "claude-invocations.log");
  const rotatedStore = JSON.stringify({ claudeAiOauth: {
    accessToken: "rotated-access-fixture",
    refreshToken: "rotated-refresh-fixture",
    expiresAt: Date.parse("2035-01-01T00:00:00.000Z"),
    subscriptionType: "max",
  }});
  const stub = join(process.env.PATH, "claude");
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${invocationLog}'\necho '${rotatedStore}' > '${credentialFile}'\nexit 0\n`);
  chmodSync(stub, 0o755);

  const requests: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    const headers = init?.headers as Record<string, string>;
    if (headers.authorization !== "Bearer rotated-access-fixture") {
      return new Response(null, { status: 401 });
    }
    if (url.endsWith("/profile")) {
      return Response.json({ account: { uuid: "fixture-account", email: "reviewer@example.test" } });
    }
    return Response.json({
      five_hour: { utilization: 40, resets_at: "2035-01-01T00:00:00.000Z" },
      seven_day: { utilization: 10, resets_at: "2035-01-05T00:00:00.000Z" },
    });
  }) as typeof fetch;

  const { main } = await import("/Users/kunchen/.no-mistakes/worktrees/6eca570dbcdb/01M0XAV82TQP7A67EDHQ0Z91WZ/src/cli.ts");
  const chunks: string[] = [];
  await main({
    argv: ["--provider", "claude", "--json", "--full"],
    binPath: "quota-axi",
    stdout: { write: (chunk: string) => { chunks.push(String(chunk)); return true; } },
  });
  const output = chunks.join("").trim();
  const parsed = JSON.parse(output);
  const serialized = JSON.stringify(parsed);
  const forbidden = ["expired-access-fixture", "refresh-presence-fixture", "rotated-access-fixture", "rotated-refresh-fixture"];

  console.log("$ quota-axi --provider claude --json --full");
  console.log(output);
  console.log("\nE2E verification:");
  console.log(`- delegated command invocation: claude ${readFileSync(invocationLog, "utf8").trim()}`);
  console.log(`- HTTP requests: ${requests.map((r) => `${r.method} ${r.url}`).join(", ")}`);
  console.log(`- token/refresh fixture values exposed in CLI output: ${forbidden.some((value) => serialized.includes(value)) ? "YES" : "NO"}`);
  console.log(`- final provider state: ${parsed.providers[0].state.status}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
