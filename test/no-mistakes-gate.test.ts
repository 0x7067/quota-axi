import { execFileSync, spawnSync } from "node:child_process";
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

const signature =
  "Updates from [git push no-mistakes](https://github.com/kunchenguid/no-mistakes)";
const attestationPrefix = "<!-- no-mistakes-pipeline-attestation:v1 ";
const attestationSuffix = " -->";
const headSha = "12df13109c6ad8d64646b85ac7170b23afe6e9bf";

/** A PR body shaped like the one no-mistakes writes. */
function pipelineBody(attestationPayload?: string): string {
  const attestation =
    attestationPayload === undefined
      ? ""
      : `${attestationPrefix}${attestationPayload}${attestationSuffix}\n\n`;
  return [
    "## What Changed\n\n- something\n",
    `## Pipeline\n\n${signature}\n\n${attestation}`,
    "<details>\n<summary>Review</summary>\n\nok\n\n</details>\n",
  ].join("\n");
}

function attestationPayload(steps: Array<[string, string]>): string {
  return JSON.stringify({
    head_sha: headSha,
    steps: steps.map(([step, status]) => ({ step, status })),
  });
}

/** The step snapshot a healthy run produces when the PR body is written. */
const healthySteps: Array<[string, string]> = [
  ["intent", "completed"],
  ["rebase", "completed"],
  ["review", "completed"],
  ["test", "completed"],
  ["document", "completed"],
  ["lint", "completed"],
  ["push", "completed"],
  ["pr", "running"],
  ["ci", "pending"],
];

function withStatus(step: string, status: string): Array<[string, string]> {
  return healthySteps.map(([name, current]) =>
    name === step ? [name, status] : [name, current],
  ) as Array<[string, string]>;
}

const noMistakesBody = pipelineBody(attestationPayload(healthySteps));

/**
 * The attestation half of the gate parses JSON with jq, exactly as the
 * ubuntu-latest runner does. Never skip on CI: a silently skipped gate test is
 * worse than no test. Locally, skip when jq is absent rather than failing a
 * contributor's `pnpm test` over an unrelated missing tool.
 */
const jqAvailable = spawnSync("sh", ["-c", "command -v jq"]).status === 0;
if (process.env.CI && !jqAvailable) {
  throw new Error("CI must provide jq to exercise the no-mistakes gate");
}
const releaseBody =
  ":robot: I have created a release *beep* *boop*\n---\n\n## [0.1.30](https://example.invalid)\n\n---\n" +
  "This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).";
const repo = "kunchenguid/quota-axi";
const forkRepo = "someone-else/quota-axi";
// The live head ref of this repository's release PRs (see PR #107).
const releaseBranch = "release-please--branches--main--components--quota-axi";

describe("no-mistakes gate decisions", () => {
  const cases: Array<{
    name: string;
    event: PullRequestEvent;
    pass: boolean;
    needsJq?: boolean;
  }> = [
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
      name: "human PR carrying the signature and a complete attestation passes",
      event: {
        number: 111,
        body: noMistakesBody,
        author: "kunchenguid",
        headRef: "fm/some-work",
        headRepo: repo,
        baseRepo: repo,
      },
      pass: true,
      needsJq: true,
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
    it.runIf(jqAvailable || !testCase.needsJq)(testCase.name, () => {
      const { passed, output } = runGate(testCase.event);
      expect(passed, output).toBe(testCase.pass);
    });
  }
});

describe.runIf(jqAvailable)("no-mistakes gate pipeline attestation", () => {
  // Every case here is a same-repo human PR on an ordinary branch, so the
  // signature-plus-attestation path is the only one that can pass it.
  function gate(body: string): { passed: boolean; output: string } {
    return runGate({
      number: 130,
      body,
      author: "kunchenguid",
      headRef: "fm/some-work",
      headRepo: repo,
      baseRepo: repo,
    });
  }

  it("accepts a body whose attestation completes review, test, and document", () => {
    const { passed, output } = gate(
      pipelineBody(attestationPayload(healthySteps)),
    );
    expect(passed, output).toBe(true);
    expect(output).toContain("review, test, and document all completed");
  });

  it("still rejects a body with no no-mistakes signature", () => {
    const { passed, output } = gate("## Intent\n\nhand-written body\n");
    expect(passed).toBe(false);
    expect(output).toContain("was not raised through no-mistakes");
    expect(output).toContain("git push no-mistakes");
  });

  it("rejects a signed body with no attestation and names the required version", () => {
    const { passed, output } = gate(pipelineBody());
    expect(passed).toBe(false);
    expect(output).toContain("no pipeline attestation");
    expect(output).toContain("no-mistakes >= 1.46.0 is required (PR 670)");
  });

  // Every skip route no-mistakes has - `--skip`, a user skip at a gate, an
  // automatic pipeline skip, or a run that ran out of agent quota - lands on
  // the raw `skipped` status, and an unavailable agent surfaces as `failed`.
  for (const status of ["skipped", "failed", "running", "pending"]) {
    it(`rejects an attestation whose test step is ${status}`, () => {
      const { passed, output } = gate(
        pipelineBody(attestationPayload(withStatus("test", status))),
      );
      expect(passed).toBe(false);
      expect(output).toContain(`records 'test' as '${status}'`);
    });
  }

  it("rejects an attestation that omits a required step entirely", () => {
    const steps = healthySteps.filter(([name]) => name !== "document");
    const { passed, output } = gate(pipelineBody(attestationPayload(steps)));
    expect(passed).toBe(false);
    expect(output).toContain("no 'document' step record");
  });

  it("rejects a required step recorded twice unless every record completed", () => {
    const steps: Array<[string, string]> = [
      ...healthySteps,
      ["review", "skipped"],
    ];
    const { passed, output } = gate(pipelineBody(attestationPayload(steps)));
    expect(passed).toBe(false);
    expect(output).toContain("records 'review' as 'completed,skipped'");
  });

  // v1 carries no skip sibling field, so `status` is the only skip channel
  // today. Fail closed if a later schema ever hangs a skip reason off an
  // otherwise-completed step instead of widening the gate silently.
  for (const marker of [
    { skip_reason: "quota exhausted" },
    { skipped: true },
    { agent_unavailable: true },
    { quota_exhausted: true },
  ]) {
    const key = Object.keys(marker)[0];
    it(`rejects a completed step carrying a ${key} marker`, () => {
      const payload = JSON.stringify({
        head_sha: headSha,
        steps: healthySteps.map(([step, status]) =>
          step === "review" ? { step, status, ...marker } : { step, status },
        ),
      });
      const { passed, output } = gate(pipelineBody(payload));
      expect(passed).toBe(false);
      expect(output).toContain(`skip indicator(s) [${key}]`);
    });
  }

  it("fails closed on an attestation payload that is not valid JSON", () => {
    const { passed, output } = gate(
      pipelineBody('{"head_sha":"abc","steps":[{"step":"review",'),
    );
    expect(passed).toBe(false);
    expect(output).toContain("could not be parsed as JSON");
  });

  it("fails closed when the payload has no steps array", () => {
    const { passed, output } = gate(pipelineBody('{"head_sha":"abc"}'));
    expect(passed).toBe(false);
    expect(output).toContain("could not be parsed as JSON");
  });

  it("fails closed when the attestation comment is never closed", () => {
    const body = `## Pipeline\n\n${signature}\n\n${attestationPrefix}{"head_sha":"abc","steps":[]}\n`;
    const { passed, output } = gate(body);
    expect(passed).toBe(false);
    expect(output).toContain("no JSON payload could be extracted");
  });

  it("accepts a CRLF body", () => {
    const body = pipelineBody(attestationPayload(healthySteps)).replace(
      /\n/g,
      "\r\n",
    );
    const { passed, output } = gate(body);
    expect(passed, output).toBe(true);
  });

  it("leaves the structural release-please exemption unaffected", () => {
    // A release PR carries no signature and no attestation; the structural
    // exemption must still pass it.
    const { passed, output } = runGate({
      number: 131,
      body: releaseBody,
      author: "github-actions[bot]",
      headRef: releaseBranch,
      headRepo: repo,
      baseRepo: repo,
    });
    expect(passed, output).toBe(true);
    expect(output).toContain("release-please release PR");
  });
});

describe("no-mistakes gate bootstrap fallback", () => {
  // A base branch that predates .github/scripts/no-mistakes-gate.sh leaves the
  // sparse checkout empty. The step must still decide, and must decide strictly:
  // the signature alone, with none of the script's exemptions.
  const emptyBase = () => mkdtempSync(join(tmpdir(), "quota-axi-gate-"));

  it("passes a PR carrying the no-mistakes signature, attestation or not", () => {
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

  it("passes a signed PR whose body carries no attestation", () => {
    // The fallback is deliberately signature-only: a base branch that predates
    // the gate script has no trusted attestation parser to run.
    const { passed, output } = runGate(
      {
        number: 122,
        body: pipelineBody(),
        author: "kunchenguid",
        headRef: "fm/bootstrap",
        headRepo: repo,
        baseRepo: repo,
      },
      emptyBase(),
    );
    expect(passed, output).toBe(true);
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
