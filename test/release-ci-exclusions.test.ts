import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

/**
 * The status check context this repository's `main` ruleset requires. The gate
 * workflow's job name must match it exactly, or the ruleset waits forever on a
 * check nothing ever reports.
 */
const requiredCheckContext = "PR must be raised via no-mistakes";

/**
 * Derive the exact release-please output set from config + workflow inputs.
 * Keep this aligned with the fleet audit rule: node -> package.json
 * (+ package-lock.json if present), changelog, extra-files, and the manifest.
 */
function expectedReleaseOutputs(): string[] {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  ) as {
    "release-type"?: string;
    "changelog-path"?: string;
    "version-file"?: string;
    "extra-files"?: Array<string | { path?: string }>;
    packages?: Record<
      string,
      {
        "release-type"?: string;
        "changelog-path"?: string;
        "version-file"?: string;
        "extra-files"?: Array<string | { path?: string }>;
      }
    >;
  };

  const pkg = config.packages?.["."] ?? {};
  const releaseType = pkg["release-type"] ?? config["release-type"] ?? "node";
  const changelog =
    pkg["changelog-path"] ?? config["changelog-path"] ?? "CHANGELOG.md";

  const expected = [changelog];
  switch (releaseType) {
    case "simple":
      expected.push(
        pkg["version-file"] ?? config["version-file"] ?? "version.txt",
      );
      break;
    case "node":
      expected.push("package.json");
      if (existsSync(join(root, "package-lock.json"))) {
        expected.push("package-lock.json");
      }
      break;
    case "go":
      break;
    default:
      throw new Error(
        `unsupported release-please release-type for ignore derivation: ${releaseType}`,
      );
  }

  const extra = pkg["extra-files"] ?? config["extra-files"] ?? [];
  for (const entry of extra) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (path) expected.push(path);
  }

  let manifest = ".release-please-manifest.json";
  const releaseWorkflow = readFileSync(
    join(workflowsDir, "release-please.yml"),
    "utf8",
  );
  const manifestMatch = releaseWorkflow.match(/manifest-file:\s*(\S+)/);
  if (manifestMatch) manifest = manifestMatch[1];
  expected.push(manifest);

  return [...new Set(expected)];
}

function loadWorkflowOn(filePath: string): Record<string, unknown> | null {
  const doc = loadYaml(readFileSync(filePath, "utf8")) as
    | Record<string | boolean, unknown>
    | null
    | undefined;
  // js-yaml may parse a bare `on:` key as boolean true.
  const on = doc?.on ?? doc?.true ?? null;
  if (on == null || typeof on !== "object" || Array.isArray(on)) return null;
  return on as Record<string, unknown>;
}

type PathFilter =
  | { kind: "unfiltered" }
  | { kind: "paths-ignore"; paths: string[] }
  | { kind: "paths"; paths: string[] };

function pullRequestFilterCoverage(pr: unknown): PathFilter {
  if (pr == null) {
    return { kind: "unfiltered" };
  }
  if (typeof pr !== "object" || Array.isArray(pr)) {
    // `pull_request:` bare form means no path filter.
    return { kind: "unfiltered" };
  }

  const record = pr as Record<string, unknown>;
  if (Array.isArray(record["paths-ignore"])) {
    return {
      kind: "paths-ignore",
      paths: record["paths-ignore"].map(String),
    };
  }

  if (Array.isArray(record.paths)) {
    return { kind: "paths", paths: record.paths.map(String) };
  }

  return { kind: "unfiltered" };
}

function globMatch(pattern: string, path: string): boolean {
  // Minimal support for the `**` / `*` patterns used in workflow path filters.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isCovered(filter: PathFilter, releasePath: string): boolean {
  if (filter.kind === "unfiltered") return false;

  if (filter.kind === "paths-ignore") {
    return filter.paths.includes(releasePath);
  }

  // paths allow-list: a release path is "covered" (will not create a run on its
  // own) when no positive pattern matches it, or a later negation excludes it.
  let matched = false;
  for (const pattern of filter.paths) {
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (
        matched &&
        (negated === releasePath || globMatch(negated, releasePath))
      ) {
        matched = false;
      }
      continue;
    }
    if (pattern === releasePath || globMatch(pattern, releasePath)) {
      matched = true;
    }
  }
  // Covered means the path does NOT cause the workflow to run.
  return !matched;
}

/**
 * A workflow "backs the required check" when one of its jobs publishes the
 * required context, i.e. its job `name` is exactly that context. Such a
 * workflow is the one place a `paths`/`paths-ignore` filter is forbidden
 * rather than mandatory: a filtered required check never reports, which would
 * block the pull request on a status that can never arrive.
 */
function publishesRequiredCheck(filePath: string): boolean {
  const doc = loadYaml(readFileSync(filePath, "utf8")) as
    | { jobs?: Record<string, { name?: unknown }> }
    | null
    | undefined;
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return false;
  return Object.values(jobs).some((job) => job?.name === requiredCheckContext);
}

type PullRequestWorkflow = {
  name: string;
  filter: PathFilter;
  backsRequiredCheck: boolean;
};

function pullRequestWorkflows(): PullRequestWorkflow[] {
  const out: PullRequestWorkflow[] = [];
  for (const name of readdirSync(workflowsDir).filter((n) =>
    n.endsWith(".yml"),
  )) {
    const filePath = join(workflowsDir, name);
    const on = loadWorkflowOn(filePath);
    if (!on || !("pull_request" in on)) continue;
    out.push({
      name,
      filter: pullRequestFilterCoverage(on.pull_request),
      backsRequiredCheck: publishesRequiredCheck(filePath),
    });
  }
  return out;
}

describe("release-please CI exclusions", () => {
  const expected = expectedReleaseOutputs();

  it("derives the node release-output set for this repository", () => {
    expect(expected).toEqual([
      "CHANGELOG.md",
      "package.json",
      ".release-please-manifest.json",
    ]);
  });

  it("splits pull_request workflows into the required gate and the rest", () => {
    const prWorkflows = pullRequestWorkflows();

    // The gate is the single intentional exception to the paths-ignore rule.
    expect(
      prWorkflows.filter((w) => w.backsRequiredCheck).map((w) => w.name),
    ).toEqual(["no-mistakes-required.yml"]);

    // Everything else still owes the release-output exclusion.
    expect(
      prWorkflows
        .filter((w) => !w.backsRequiredCheck)
        .map((w) => w.name)
        .sort(),
    ).toEqual(["ci.yml", "guard-generated-files.yml"]);
  });

  it("every non-gate pull_request workflow ignores the full release-output set", () => {
    const others = pullRequestWorkflows().filter((w) => !w.backsRequiredCheck);
    expect(others.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const { name, filter } of others) {
      const missing = expected.filter((path) => !isCovered(filter, path));
      if (missing.length > 0) {
        failures.push(`${name} missing coverage for: ${missing.join(", ")}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("the workflow backing the required check carries no path filter", () => {
    // A required check that is path-filtered never reports on the PRs it
    // filters out, so the ruleset blocks them on a status that never arrives.
    // That is exactly what would happen to a release-please PR.
    const gates = pullRequestWorkflows().filter((w) => w.backsRequiredCheck);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.filter).toEqual({ kind: "unfiltered" });
  });

  it("the gate decides exemptions in its script, not a job-level if:", () => {
    // One executable decision surface, so test/no-mistakes-gate.test.ts and the
    // release workflow's status-stamping job both exercise the same rules.
    const doc = loadYaml(
      readFileSync(join(workflowsDir, "no-mistakes-required.yml"), "utf8"),
    ) as { jobs?: Record<string, { name?: unknown; if?: unknown }> };
    const gateJobs = Object.values(doc.jobs ?? {}).filter(
      (job) => job?.name === requiredCheckContext,
    );
    expect(gateJobs).toHaveLength(1);
    expect(gateJobs[0]!.if).toBeUndefined();
  });

  it("does not attach path filters to non-pull_request triggers on ci.yml", () => {
    const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
    expect(on).not.toBeNull();
    expect(on!.push).toEqual({ branches: ["main"] });
    const pr = on!.pull_request as Record<string, unknown>;
    expect(pr.branches).toEqual(["main"]);
    expect(pr["paths-ignore"]).toEqual([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ]);
    expect(on!.release).toBeUndefined();
    expect(on!.workflow_dispatch).toBeUndefined();
  });
});
