import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const gateWorkflowPath = join(
  root,
  ".github",
  "workflows",
  "no-mistakes-required.yml",
);

/** The status check context this repository's `main` ruleset requires. */
const requiredCheckContext = "PR must be raised via no-mistakes";

type WorkflowStep = {
  name?: string;
  run?: string;
  env?: Record<string, string>;
};
type WorkflowJob = { name?: string; if?: unknown; steps?: WorkflowStep[] };

/**
 * The pull_request event fields the gate step reads through its `env:` block.
 * Only these paths may appear in the step's expressions.
 */
type PullRequestEvent = {
  number: number;
  body: string;
  author: string;
  headRef: string;
  headRepo: string;
  baseRepo: string;
};

function lookup(event: PullRequestEvent, path: string): string {
  switch (path) {
    case "github.event.pull_request.number":
      return String(event.number);
    case "github.event.pull_request.body":
      return event.body;
    case "github.event.pull_request.user.login":
      return event.author;
    case "github.event.pull_request.head.ref":
      return event.headRef;
    case "github.event.pull_request.head.repo.full_name":
      return event.headRepo;
    case "github.event.pull_request.base.repo.full_name":
      return event.baseRepo;
    default:
      throw new Error(`gate step references unsupported expression: ${path}`);
  }
}

/**
 * Read the one step that decides the required check out of the real shipped
 * workflow, so these cases drive the deployed configuration rather than a copy.
 */
function loadGateStep(): Required<Pick<WorkflowStep, "run" | "env">> {
  const doc = loadYaml(readFileSync(gateWorkflowPath, "utf8")) as {
    jobs?: Record<string, WorkflowJob>;
  };
  const jobs = Object.entries(doc.jobs ?? {}).filter(
    ([, job]) => job?.name === requiredCheckContext,
  );
  if (jobs.length !== 1) {
    throw new Error(
      `expected exactly one job named ${requiredCheckContext}, found ${jobs.length}`,
    );
  }
  const [jobId, job] = jobs[0]!;
  // Every exemption must live in the script, not a job-level `if:`, so the gate
  // keeps a single executable decision surface.
  if (job.if !== undefined) {
    throw new Error(
      `job ${jobId} must not carry a job-level if:; it decides exemptions in the gate script`,
    );
  }
  const step = (job.steps ?? []).find((s) => (s.run ?? "").trim() !== "");
  if (!step?.run) throw new Error(`job ${jobId} has no run: step`);
  if (!step.env || Object.keys(step.env).length === 0) {
    throw new Error("gate step declares no env:, so it can never see the PR");
  }
  return { run: step.run, env: step.env };
}

const expressionPattern = /\$\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Expand the step's `${{ ... }}` expressions against the event, the same
 * substitution the Actions runner performs before running the step.
 */
function resolveEnv(
  env: Record<string, string>,
  event: PullRequestEvent,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(env)) {
    out[name] = String(raw).replace(expressionPattern, (_match, path: string) =>
      lookup(event, path.trim()),
    );
  }
  return out;
}

/**
 * Run the workflow step's shell exactly as the runner would. `cwd` defaults to
 * the repo root, where the gate script is present; pointing it at an empty
 * directory reproduces the bootstrap case where the PR's base branch predates
 * the script and the checkout yields nothing.
 */
function runGate(
  event: PullRequestEvent,
  cwd: string = root,
): { passed: boolean; output: string } {
  const step = loadGateStep();
  try {
    const output = execFileSync("bash", ["-e", "-c", step.run], {
      cwd,
      env: { ...process.env, ...resolveEnv(step.env, event) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { passed: true, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    if (typeof err.status !== "number") throw error;
    return { passed: false, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

const noMistakesBody =
  "## Pipeline\n\nUpdates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)\n";
const releaseBody =
  ":robot: I have created a release *beep* *boop*\n---\n\n## [0.1.30](https://example.invalid)\n\n---\n" +
  "This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).";
const repo = "kunchenguid/quota-axi";
const forkRepo = "someone-else/quota-axi";
// The live head ref of this repository's release PRs (see PR #107).
const releaseBranch = "release-please--branches--main--components--quota-axi";

describe("no-mistakes gate decisions", () => {
  const cases: Array<{ name: string; event: PullRequestEvent; pass: boolean }> =
    [
      {
        name: "release-please release PR is exempt",
        event: {
          number: 107,
          body: releaseBody,
          author: "github-actions[bot]",
          headRef: releaseBranch,
          headRepo: repo,
          baseRepo: repo,
        },
        pass: true,
      },
      {
        // Structural, not identity: the same PR under a PAT identity, which is
        // what release-please would become if it ever used one.
        name: "release PR authored by a human identity is exempt",
        event: {
          number: 108,
          body: releaseBody,
          author: "kunchenguid",
          headRef: releaseBranch,
          headRepo: repo,
          baseRepo: repo,
        },
        pass: true,
      },
      {
        name: "legacy release-please branch prefix is exempt",
        event: {
          number: 109,
          body: releaseBody,
          author: "kunchenguid",
          headRef: "release-please/branches/main",
          headRepo: repo,
          baseRepo: repo,
        },
        pass: true,
      },
      {
        name: "dependabot is exempt",
        event: {
          number: 110,
          body: "Bumps a dependency.",
          author: "dependabot[bot]",
          headRef: "dependabot/npm_and_yarn/example-1.2.3",
          headRepo: repo,
          baseRepo: repo,
        },
        pass: true,
      },
      {
        name: "human PR carrying the no-mistakes signature passes",
        event: {
          number: 111,
          body: noMistakesBody,
          author: "kunchenguid",
          headRef: "fm/some-work",
          headRepo: repo,
          baseRepo: repo,
        },
        pass: true,
      },
      {
        // quota-axi exempts no bot identity except dependabot: a workflow-opened
        // PR that is not structurally a release PR still owes the signature.
        name: "github-actions bot on an ordinary branch fails",
        event: {
          number: 112,
          body: "chore: routine bot update",
          author: "github-actions[bot]",
          headRef: "chore/bot",
          headRepo: repo,
          baseRepo: repo,
        },
        pass: false,
      },
      {
        name: "human PR without the signature fails",
        event: {
          number: 113,
          body: "## Summary\n\nA hand-written pull request.",
          author: "kunchenguid",
          headRef: "fix/something",
          headRepo: repo,
          baseRepo: repo,
        },
        pass: false,
      },
      {
        name: "empty body fails",
        event: {
          number: 114,
          body: "",
          author: "kunchenguid",
          headRef: "fix/something",
          headRepo: repo,
          baseRepo: repo,
        },
        pass: false,
      },
      {
        name: "borrowed release branch name alone fails",
        event: {
          number: 115,
          body: "## Summary\n\nNot a release PR.",
          author: "kunchenguid",
          headRef: releaseBranch,
          headRepo: repo,
          baseRepo: repo,
        },
        pass: false,
      },
      {
        name: "fork copying the release body fails",
        event: {
          number: 116,
          body: releaseBody,
          author: "outside-contributor",
          headRef: releaseBranch,
          headRepo: forkRepo,
          baseRepo: repo,
        },
        pass: false,
      },
      {
        name: "release body on an ordinary same-repo branch fails",
        event: {
          number: 117,
          body: releaseBody,
          author: "kunchenguid",
          headRef: "feat/pretend",
          headRepo: repo,
          baseRepo: repo,
        },
        pass: false,
      },
    ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const { passed, output } = runGate(testCase.event);
      expect(passed, output).toBe(testCase.pass);
    });
  }
});

describe("no-mistakes gate bootstrap fallback", () => {
  // A base branch that predates .github/scripts/no-mistakes-gate.sh leaves the
  // sparse checkout empty. The step must still decide, and must decide strictly:
  // the signature alone, with none of the script's exemptions.
  const emptyBase = () => mkdtempSync(join(tmpdir(), "quota-axi-gate-"));

  it("passes a PR carrying the no-mistakes signature", () => {
    const { passed, output } = runGate(
      {
        number: 118,
        body: noMistakesBody,
        author: "kunchenguid",
        headRef: "fm/bootstrap",
        headRepo: repo,
        baseRepo: repo,
      },
      emptyBase(),
    );
    expect(passed, output).toBe(true);
    expect(output).toContain("Base branch predates");
  });

  it("fails a PR without the signature", () => {
    const { passed } = runGate(
      {
        number: 119,
        body: "## Summary\n\nA hand-written pull request.",
        author: "kunchenguid",
        headRef: "fix/something",
        headRepo: repo,
        baseRepo: repo,
      },
      emptyBase(),
    );
    expect(passed).toBe(false);
  });

  it("grants no exemption, not even to a structural release PR", () => {
    const { passed } = runGate(
      {
        number: 120,
        body: releaseBody,
        author: "github-actions[bot]",
        headRef: releaseBranch,
        headRepo: repo,
        baseRepo: repo,
      },
      emptyBase(),
    );
    expect(passed).toBe(false);
  });

  it("grants no exemption to dependabot", () => {
    const { passed } = runGate(
      {
        number: 121,
        body: "Bumps a dependency.",
        author: "dependabot[bot]",
        headRef: "dependabot/npm_and_yarn/example-1.2.3",
        headRepo: repo,
        baseRepo: repo,
      },
      emptyBase(),
    );
    expect(passed).toBe(false);
  });
});
