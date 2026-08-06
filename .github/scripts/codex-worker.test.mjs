import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import * as worker from "./codex-worker.mjs";
import {
  buildWorkerPullRequestBody,
  buildWorkerPrompt,
  classifyWorkerEvent,
  createWorkerPlan,
  evaluateFrontierIssue,
  evaluatePublicationState,
  humanValidationLabelAction,
  parseBlockedBy,
  sanitizeWorkerMarkdown,
  validateWorkerConfiguration,
  validateWorkerPlan,
  validateWorkerResult,
} from "./codex-worker.mjs";
import { extractPrimaryIssueNumbers } from "./pr-gates.mjs";

test("parses deterministic Blocked by declarations", () => {
  assert.deepEqual(parseBlockedBy("## Blocked by\n\nNone\n"), []);
  assert.deepEqual(
    parseBlockedBy("## Blocked by\n\n- #12\n- #34\n\n## Notes\nLater"),
    [12, 34],
  );
});

test("rejects missing, duplicated, self-referential, or free-form blockers", () => {
  assert.throws(() => parseBlockedBy("## Scope\nNone"), /Blocked by/);
  assert.throws(() => parseBlockedBy("## Blocked by\nNone\n\n## Blocked by\nNone"));
  assert.throws(() => parseBlockedBy("## Blocked by\nWaiting for #12"));
  assert.throws(() => parseBlockedBy("## Blocked by\n- #12\n- #12"));
  assert.throws(() => parseBlockedBy("## Blocked by\n- #16", { issueNumber: 16 }));
});

test("classifies only explicit Worker control and execution events", () => {
  assert.equal(
    classifyWorkerEvent({ eventName: "issues", action: "labeled", label: "bug" }),
    "noop",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "issues",
      action: "labeled",
      label: "ready-for-agent",
    }),
    "evaluate",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "issues",
      action: "unlabeled",
      label: "needs-triage",
    }),
    "evaluate",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "issues",
      action: "unlabeled",
      label: "ready-for-agent",
    }),
    "pause",
  );
  assert.equal(
    classifyWorkerEvent({ eventName: "issues", action: "labeled", label: "wontfix" }),
    "close",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "pull_request_target",
      action: "closed",
      headRef: "codex/issue-42",
      merged: false,
      sameRepository: true,
    }),
    "closed-pr",
  );
  assert.equal(
    classifyWorkerEvent({
      eventName: "pull_request_target",
      action: "closed",
      headRef: "codex/issue-42",
      merged: false,
      sameRepository: false,
    }),
    "noop",
  );
});

test("Worker Publisher can add but never remove ready-for-human", () => {
  assert.equal(humanValidationLabelAction(true, []), "add");
  assert.equal(humanValidationLabelAction(true, ["ready-for-human"]), "noop");
  assert.equal(humanValidationLabelAction(false, ["ready-for-human"]), "noop");
  assert.equal(humanValidationLabelAction(false, []), "noop");
});

function frontier(overrides = {}) {
  return evaluateFrontierIssue({
    issue: {
      number: 42,
      state: "open",
      labels: [{ name: "ready-for-agent" }],
    },
    blockers: [],
    workerPullRequests: [],
    branchSha: null,
    defaultSha: "a".repeat(40),
    ...overrides,
  });
}

test("starts from default branch or resumes the fixed branch and Draft PR", () => {
  assert.deepEqual(frontier(), {
    operation: "implement",
    reason: "frontier",
    startSha: "a".repeat(40),
    branch: "codex/issue-42",
    pullRequestNumber: null,
  });
  assert.deepEqual(
    frontier({
      branchSha: "b".repeat(40),
      workerPullRequests: [
        {
          number: 9,
          state: "open",
          draft: true,
          merged_at: null,
          head: {
            ref: "codex/issue-42",
            repo: { full_name: "AgoraIO-Extensions/agent-infra" },
          },
          base: { ref: "main" },
        },
      ],
    }),
    {
      operation: "implement",
      reason: "frontier",
      startSha: "b".repeat(40),
      branch: "codex/issue-42",
      pullRequestNumber: 9,
    },
  );
});

test("does not execute blocked or Ready-for-review Issues", () => {
  assert.equal(
    frontier({ blockers: [{ number: 12, state: "open" }] }).operation,
    "noop",
  );
  assert.deepEqual(
    frontier({
      branchSha: "b".repeat(40),
      workerPullRequests: [
        { number: 9, state: "open", draft: false, merged_at: null },
      ],
    }),
    {
      operation: "noop",
      reason: "ready-pr-exists",
      pullRequestNumber: 9,
    },
  );
});

test("routes inconsistent branch and PR state to triage without duplication", () => {
  assert.equal(
    frontier({
      branchSha: "b".repeat(40),
      workerPullRequests: [
        { number: 9, state: "closed", draft: false, merged_at: null },
      ],
    }).reason,
    "closed-worker-pr",
  );
  assert.equal(
    frontier({
      workerPullRequests: [
        { number: 9, state: "open", draft: true, merged_at: null },
        { number: 10, state: "open", draft: true, merged_at: null },
      ],
    }).operation,
    "triage",
  );
  assert.equal(
    frontier({
      branchSha: null,
      workerPullRequests: [
        { number: 9, state: "open", draft: true, merged_at: null },
      ],
    }).reason,
    "worker-branch-missing",
  );
});

test("creates one immutable plan from a frontier Issue", () => {
  assert.deepEqual(
    createWorkerPlan({
      repository: "AgoraIO-Extensions/agent-infra",
      defaultBranch: "main",
      issue: {
        number: 42,
        state: "open",
        labels: [{ name: "ready-for-agent" }],
      },
      blockers: [],
      workerPullRequests: [],
      branchSha: null,
      defaultSha: "a".repeat(40),
    }),
    {
      operation: "implement",
      reason: "frontier",
      plan: workerPlan,
    },
  );
});

test("publication requires the recorded branch and Draft PR state", () => {
  const issue = {
    number: 42,
    state: "open",
    labels: [{ name: "ready-for-agent" }],
  };
  assert.deepEqual(
    evaluatePublicationState({
      plan: workerPlan,
      issue,
      blockers: [],
      workerPullRequests: [],
      branchSha: null,
    }),
    { operation: "publish", reason: "authorized" },
  );
  assert.deepEqual(
    evaluatePublicationState({
      plan: workerPlan,
      issue,
      blockers: [],
      workerPullRequests: [],
      branchSha: "b".repeat(40),
    }),
    { operation: "triage", reason: "stale-worker-branch" },
  );
  assert.equal(
    evaluatePublicationState({
      plan: { ...workerPlan, branchExisted: true, pullRequestNumber: 9 },
      issue,
      blockers: [],
      workerPullRequests: [
        {
          number: 9,
          state: "open",
          draft: true,
          merged_at: null,
          head: {
            ref: "codex/issue-42",
            repo: { full_name: "AgoraIO-Extensions/agent-infra" },
          },
          base: { ref: "main" },
        },
      ],
      branchSha: "a".repeat(40),
    }).operation,
    "publish",
  );
  assert.deepEqual(
    evaluatePublicationState({
      plan: { ...workerPlan, branchExisted: true, pullRequestNumber: 9 },
      issue,
      blockers: [],
      workerPullRequests: [
        {
          number: 9,
          state: "open",
          draft: true,
          merged_at: null,
          head: {
            ref: "codex/issue-42",
            repo: { full_name: "someone/fork" },
          },
          base: { ref: "main" },
        },
      ],
      branchSha: "a".repeat(40),
    }),
    { operation: "triage", reason: "foreign-worker-pr" },
  );
  assert.equal(
    evaluatePublicationState({
      plan: workerPlan,
      issue: { ...issue, labels: [] },
      blockers: [],
      workerPullRequests: [],
      branchSha: null,
    }).operation,
    "pause",
  );
});

test("accepts only official checkout HTTPS remotes for Worker publication", () => {
  const repository = "AgoraIO-Extensions/agent-infra";

  assert.equal(
    worker.isExpectedPublicationRemote(
      "https://github.com/AgoraIO-Extensions/agent-infra",
      repository,
    ),
    true,
  );
  assert.equal(
    worker.isExpectedPublicationRemote(
      "https://github.com/AgoraIO-Extensions/agent-infra.git",
      repository,
    ),
    true,
  );
  for (const remote of [
    "https://github.com/AgoraIO-Extensions/agent-infra/",
    "https://github.com/AgoraIO-Extensions/agent-infra-other",
    "https://user@github.com/AgoraIO-Extensions/agent-infra",
    "git@github.com:AgoraIO-Extensions/agent-infra.git",
    "https://example.com/AgoraIO-Extensions/agent-infra",
  ]) {
    assert.equal(worker.isExpectedPublicationRemote(remote, repository), false);
  }
});

test("marks the Worker PR ready through the fixed GraphQL mutation", async () => {
  const calls = [];
  const result = await worker.markPullRequestReadyForReview({
    pullRequest: { number: 41, node_id: "PR_node_id" },
    token: "test-token",
    request: async (apiPath, options) => {
      calls.push({ apiPath, options });
      return {
        data: {
          markPullRequestReadyForReview: {
            pullRequest: { number: 41, isDraft: false },
          },
        },
      };
    },
  });

  assert.equal(result, "ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiPath, "/graphql");
  assert.equal(calls[0].options.token, "test-token");
  const payload = JSON.parse(calls[0].options.body);
  assert.match(payload.query, /markPullRequestReadyForReview/);
  assert.doesNotMatch(payload.query, /\bmergePullRequest\b/);
  assert.deepEqual(payload.variables, { pullRequestId: "PR_node_id" });
  await assert.rejects(
    () =>
      worker.markPullRequestReadyForReview({
        pullRequest: { number: 41 },
        token: "test-token",
        request: async () => ({}),
      }),
    /node_id/,
  );
});

const workerPlan = {
  version: 1,
  repository: "AgoraIO-Extensions/agent-infra",
  defaultBranch: "main",
  issueNumber: 42,
  startSha: "a".repeat(40),
  branch: "codex/issue-42",
  branchExisted: false,
  pullRequestNumber: null,
};

test("validates bounded repository configuration before invoking Codex", () => {
  assert.deepEqual(
    validateWorkerConfiguration({
      endpoint: "https://api.example.com/v1/responses",
      model: "gpt-5.4",
      effort: "high",
      timeout: "60",
    }),
    {
      endpoint: "https://api.example.com/v1/responses",
      model: "gpt-5.4",
      effort: "high",
      timeout: 60,
    },
  );
  assert.throws(() =>
    validateWorkerConfiguration({
      endpoint: "http://127.0.0.1/v1/responses",
      model: "gpt-5.4",
      effort: "high",
      timeout: "60",
    }),
  );
  assert.throws(() =>
    validateWorkerConfiguration({
      endpoint: "https://api.example.com/v1/responses",
      model: "$(bad)",
      effort: "extreme",
      timeout: "0",
    }),
  );
});

test("binds a Worker plan and file-based prompt to one fixed Issue branch", () => {
  assert.deepEqual(
    validateWorkerPlan(workerPlan, {
      repository: "AgoraIO-Extensions/agent-infra",
      issueNumber: 42,
      startSha: "a".repeat(40),
    }),
    workerPlan,
  );
  assert.throws(() =>
    validateWorkerPlan({ ...workerPlan, branch: "codex/issue-7" }),
  );
  assert.throws(() =>
    validateWorkerPlan({ ...workerPlan, unexpected: true }),
  );

  const prompt = buildWorkerPrompt({
    issue: { number: 42, title: "Implement worker", body: "## Scope\nShip it" },
    plan: workerPlan,
  });
  assert.match(prompt, /\$implement/);
  assert.match(prompt, /\.codex-worker-artifact\/output\/change\.patch/);
  assert.match(prompt, /Issue #42/);
  assert.match(prompt, /## Scope\nShip it/);
  assert.doesNotMatch(prompt, /Closes #42/);
});

function workerResult(overrides = {}) {
  return JSON.stringify({
    completed: true,
    issue_number: 42,
    start_sha: "a".repeat(40),
    branch: "codex/issue-42",
    summary: "Implemented the requested behavior.",
    acceptance_criteria: ["The behavior is covered."],
    tests: ["node --test"],
    not_run: [],
    human_validation_required: false,
    human_validation: [],
    risks: ["None known."],
    ...overrides,
  });
}

function jsonScalarType(value) {
  if (value === null || !["boolean", "number", "string"].includes(typeof value)) {
    throw new TypeError("Expected a scalar JSON Schema value");
  }
  return typeof value;
}

function assertExplicitScalarTypes(schema, location = "schema") {
  if (Array.isArray(schema)) {
    schema.forEach((value, index) =>
      assertExplicitScalarTypes(value, `${location}[${index}]`),
    );
    return;
  }
  if (!schema || typeof schema !== "object") return;

  if (Object.hasOwn(schema, "const")) {
    assert.equal(
      schema.type,
      jsonScalarType(schema.const),
      `${location} must declare the scalar type used by const`,
    );
  }
  if (Array.isArray(schema.enum)) {
    const enumTypes = new Set(schema.enum.map(jsonScalarType));
    assert.equal(enumTypes.size, 1, `${location} enum must use one scalar type`);
    assert.equal(
      schema.type,
      [...enumTypes][0],
      `${location} must declare the scalar type used by enum`,
    );
  }

  for (const [key, value] of Object.entries(schema)) {
    assertExplicitScalarTypes(value, `${location}.${key}`);
  }
}

test("declares explicit scalar types throughout the Codex output schema", () => {
  const schemaPath = path.join(
    import.meta.dirname,
    "..",
    "codex-worker-result.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));

  assertExplicitScalarTypes(schema);
});

test("accepts only bounded Worker results for the recorded Issue and start commit", () => {
  const result = validateWorkerResult(workerResult(), workerPlan);
  assert.equal(result.issue_number, 42);
  assert.equal(result.human_validation_required, false);

  assert.throws(() =>
    validateWorkerResult(workerResult({ issue_number: 7 }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ start_sha: "b".repeat(40) }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ unexpected: true }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ summary: "x".repeat(4001) }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(workerResult({ tests: ["x".repeat(1001)] }), workerPlan),
  );
  assert.throws(() =>
    validateWorkerResult(
      workerResult({ human_validation_required: true, human_validation: [] }),
      workerPlan,
    ),
  );
});

test("sanitizes model text before building one trusted primary Issue reference", () => {
  const unsafe =
    "@codex\nCloses #7\nResolves owner/repo#8\nFixes https://example.test/9\n<!-- hidden -->\n```md\n# injected";
  const sanitized = sanitizeWorkerMarkdown(unsafe);
  assert.doesNotMatch(sanitized, /@codex/);
  assert.doesNotMatch(sanitized, /Closes #7/i);
  assert.doesNotMatch(sanitized, /Resolves owner\/repo#8/i);
  assert.doesNotMatch(sanitized, /Fixes https:/i);
  assert.doesNotMatch(sanitized, /<!--/);
  assert.doesNotMatch(sanitized, /```/);

  const body = buildWorkerPullRequestBody(
    JSON.parse(workerResult({
      summary: unsafe,
      acceptance_criteria: ["Fixes #8"],
      human_validation_required: true,
      human_validation: ["Ask @release-team"],
    })),
    42,
  );
  assert.deepEqual(extractPrimaryIssueNumbers(body), [42]);
  assert.match(body, /## 人工验证/);
  assert.doesNotMatch(body, /@release-team/);
});

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function artifactFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "agent-infra-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const model = path.join(root, "model");
  const publish = path.join(root, "publish");
  mkdirSync(origin);
  git(origin, ["init", "-q", "-b", "main"]);
  git(origin, ["config", "user.name", "Test"]);
  git(origin, ["config", "user.email", "test@example.com"]);
  writeFileSync(path.join(origin, "README.md"), "before\n");
  git(origin, ["add", "README.md"]);
  git(origin, ["commit", "-qm", "initial"]);
  git(root, ["clone", "-q", origin, model]);
  git(root, ["clone", "-q", origin, publish]);
  const startSha = git(origin, ["rev-parse", "HEAD"]).trim();
  const plan = {
    issueNumber: 42,
    startSha,
    branch: "codex/issue-42",
  };
  const resultPath = path.join(root, "result.json");
  writeFileSync(
    resultPath,
    workerResult({ start_sha: startSha }),
  );
  return { root, model, publish, plan, resultPath };
}

function writePatch(fixture) {
  git(fixture.model, ["add", "-N", "."]);
  const patchText = git(fixture.model, [
    "diff",
    "--full-index",
    "--no-renames",
    "HEAD",
    "--",
  ]);
  const patchPath = path.join(fixture.root, "change.patch");
  writeFileSync(patchPath, patchText);
  return patchPath;
}

test("validates and applies a bounded text Patch in a clean checkout", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "after\n");
  writeFileSync(path.join(fixture.model, "feature.txt"), "new file\n");
  const patchPath = writePatch(fixture);

  const validated = await worker.validateAndApplyWorkerArtifact({
    workspace: fixture.publish,
    patchPath,
    resultPath: fixture.resultPath,
    plan: fixture.plan,
  });

  assert.deepEqual(validated.changedPaths, ["README.md", "feature.txt"]);
  assert.equal(readFileSync(path.join(fixture.publish, "README.md"), "utf8"), "after\n");
  assert.equal(readFileSync(path.join(fixture.publish, "feature.txt"), "utf8"), "new file\n");
});

test("allows an empty Patch only when resuming an existing fixed branch", async (t) => {
  const resumed = artifactFixture(t);
  const emptyPatch = path.join(resumed.root, "empty.patch");
  writeFileSync(emptyPatch, "");
  const validated = await worker.validateAndApplyWorkerArtifact({
    workspace: resumed.publish,
    patchPath: emptyPatch,
    resultPath: resumed.resultPath,
    plan: { ...resumed.plan, branchExisted: true },
  });
  assert.deepEqual(validated.changedPaths, []);

  const firstRun = artifactFixture(t);
  writeFileSync(path.join(firstRun.root, "empty.patch"), "");
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: firstRun.publish,
      patchPath: path.join(firstRun.root, "empty.patch"),
      resultPath: firstRun.resultPath,
      plan: { ...firstRun.plan, branchExisted: false },
    }),
    /first publication Patch is empty/,
  );
});

test("rejects protected paths before applying a Worker Patch", async (t) => {
  const fixture = artifactFixture(t);
  mkdirSync(path.join(fixture.model, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(fixture.model, ".github", "workflows", "owned.yml"), "on: push\n");
  const patchPath = writePatch(fixture);

  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: fixture.publish,
      patchPath,
      resultPath: fixture.resultPath,
      plan: fixture.plan,
    }),
    /protected path/,
  );
  assert.equal(readFileSync(path.join(fixture.publish, "README.md"), "utf8"), "before\n");
  assert.equal(worker.isProtectedWorkerPath(".git/config"), true);
  assert.equal(worker.isProtectedWorkerPath(".gitmodules"), true);
});

test("rejects binary, executable, and oversized Worker Patches", async (t) => {
  const binary = artifactFixture(t);
  writeFileSync(path.join(binary.model, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: binary.publish,
      patchPath: writePatch(binary),
      resultPath: binary.resultPath,
      plan: binary.plan,
    }),
    /binary/,
  );

  const executable = artifactFixture(t);
  writeFileSync(path.join(executable.model, "run.sh"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(executable.model, "run.sh"), 0o755);
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: executable.publish,
      patchPath: writePatch(executable),
      resultPath: executable.resultPath,
      plan: executable.plan,
    }),
    /file mode/,
  );

  const oversized = artifactFixture(t);
  writeFileSync(path.join(oversized.root, "change.patch"), "x".repeat(400 * 1024 + 1));
  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: oversized.publish,
      patchPath: path.join(oversized.root, "change.patch"),
      resultPath: oversized.resultPath,
      plan: oversized.plan,
    }),
    /400 KiB/,
  );
});

test("rejects symlinked Artifact files", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "after\n");
  const realPatch = writePatch(fixture);
  const linkedPatch = path.join(fixture.root, "linked.patch");
  symlinkSync(realPatch, linkedPatch);

  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: fixture.publish,
      patchPath: linkedPatch,
      resultPath: fixture.resultPath,
      plan: fixture.plan,
    }),
    /regular files/,
  );
});

test("rejects an oversized result before reading it", async (t) => {
  const fixture = artifactFixture(t);
  writeFileSync(path.join(fixture.model, "README.md"), "after\n");
  writeFileSync(fixture.resultPath, "x".repeat(256 * 1024 + 1));

  await assert.rejects(
    worker.validateAndApplyWorkerArtifact({
      workspace: fixture.publish,
      patchPath: writePatch(fixture),
      resultPath: fixture.resultPath,
      plan: fixture.plan,
    }),
    /256 KiB/,
  );
});
