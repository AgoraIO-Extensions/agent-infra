import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  validateGhAwPilotSource,
  validateMattSkillSnapshot,
  validateTrustedScriptSources,
  validateWorkflowDocuments,
} from "./verify-workflow-policy.mjs";

const workflowDirectory = path.resolve(".github/workflows");

async function actualWorkflows() {
  const names = (await fs.readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        YAML.parse(await fs.readFile(path.join(workflowDirectory, name), "utf8")),
      ]),
    ),
  );
}

async function actualTrustedScriptSources() {
  return Object.fromEntries(
    await Promise.all(
      [
        "blocker-contract.mjs",
        "blocker-reconciler.mjs",
        "check-run-contract.mjs",
        "claude-event-authorization.mjs",
        "claude-blocker-review.mjs",
        "claude-review.mjs",
        "codex-worker.mjs",
        "gh-aw-pilot.mjs",
        "pr-gates.mjs",
        "worker-contract.mjs",
        "worker-resilience.mjs",
        "workflow-outcome.mjs",
      ].map(
        async (name) => [
          name,
          await fs.readFile(path.resolve(".github/scripts", name), "utf8"),
        ],
      ),
    ),
  );
}

async function actualGhAwPilotSource() {
  return fs.readFile(
    path.join(workflowDirectory, "gh-aw-issue-to-pr-pilot.md"),
    "utf8",
  );
}

test("locks repository Matt Skills to pinned upstream trees", async () => {
  const repositoryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "agent-infra-matt-skills-"),
  );

  try {
    await fs.cp(".agents", path.join(repositoryRoot, ".agents"), {
      recursive: true,
    });
    assert.deepEqual(await validateMattSkillSnapshot(repositoryRoot), []);

    const lockPath = path.join(
      repositoryRoot,
      ".agents/skills/mattpocock.lock.json",
    );
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ ...lock, revision: "0".repeat(40) }, null, 2)}\n`,
    );
    assert.ok((await validateMattSkillSnapshot(repositoryRoot)).length > 0);
    await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    await fs.appendFile(
      path.join(repositoryRoot, ".agents/skills/tdd/SKILL.md"),
      "\n# drift\n",
    );
    assert.ok(
      (await validateMattSkillSnapshot(repositoryRoot)).some((error) =>
        error.includes("tdd"),
      ),
    );
  } finally {
    await fs.rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("accepts the complete trusted workflow set", async () => {
  assert.deepEqual(validateWorkflowDocuments(await actualWorkflows()), []);
});

test("locks the gh-aw Pilot to Copilot BYOK and bounded draft PR safe output", async () => {
  const writableAgent = await actualWorkflows();
  writableAgent["gh-aw-issue-to-pr-pilot.lock.yml"].jobs.agent.permissions.contents =
    "write";
  assert.ok(
    validateWorkflowDocuments(writableAgent).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );

  const autoMerge = await actualWorkflows();
  const safeOutputStep = autoMerge[
    "gh-aw-issue-to-pr-pilot.lock.yml"
  ].jobs.safe_outputs.steps.find((step) => step.id === "process_safe_outputs");
  safeOutputStep.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG =
    safeOutputStep.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG.replace(
      '"draft":true',
      '"draft":false',
    );
  assert.ok(
    validateWorkflowDocuments(autoMerge).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );

  const issueTrigger = await actualWorkflows();
  issueTrigger["gh-aw-issue-to-pr-pilot.lock.yml"].on.issues = {
    types: ["labeled"],
  };
  assert.ok(
    validateWorkflowDocuments(issueTrigger).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );

  const leakedKey = await actualWorkflows();
  leakedKey["gh-aw-issue-to-pr-pilot.lock.yml"].jobs.agent.steps.push({
    name: "Leak",
    run: 'echo "$LEAK"',
    env: { LEAK: "${{ secrets.CODEX_API_KEY }}" },
  });
  assert.ok(
    validateWorkflowDocuments(leakedKey).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );

  const replacedMembership = await actualWorkflows();
  const membershipJob = replacedMembership[
    "gh-aw-issue-to-pr-pilot.lock.yml"
  ].jobs.pre_activation;
  membershipJob.steps = [
    { id: "check_membership", run: 'echo "activated=true" >> "$GITHUB_OUTPUT"' },
  ];
  assert.ok(
    validateWorkflowDocuments(replacedMembership).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );

  const unknownSecrets = await actualWorkflows();
  unknownSecrets["gh-aw-issue-to-pr-pilot.lock.yml"].jobs.agent.env = {
    LEAK: "${{ secrets.UNRELATED_SECRET }}",
  };
  unknownSecrets["gh-aw-issue-to-pr-pilot.lock.yml"].jobs.agent.steps.push({
    name: "Bracket leak",
    run: 'echo "$LEAK"',
    env: { LEAK: "${{ secrets['CODEX_API_KEY'] }}" },
  });
  assert.ok(
    validateWorkflowDocuments(unknownSecrets).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );

  const literalModel = await actualWorkflows();
  const literalWorkflow = literalModel["gh-aw-issue-to-pr-pilot.lock.yml"];
  literalWorkflow.jobs.activation.steps.find(
    (step) => step.id === "generate_aw_info",
  ).env.GH_AW_INFO_MODEL = "literal-model";
  literalWorkflow.jobs.safe_outputs.env.GH_AW_ENGINE_MODEL = "literal-model";
  assert.ok(
    validateWorkflowDocuments(literalModel).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );

  const broadFiles = await actualWorkflows();
  const broadPublisher = broadFiles[
    "gh-aw-issue-to-pr-pilot.lock.yml"
  ].jobs.safe_outputs.steps.find((step) => step.id === "process_safe_outputs");
  broadPublisher.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG =
    broadPublisher.env.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG.replace(
      '["apps/**","packages/**","tests/**"]',
      '["**"]',
    );
  assert.ok(
    validateWorkflowDocuments(broadFiles).some((error) =>
      error.includes("gh-aw Pilot contract"),
    ),
  );
});

test("binds the gh-aw Pilot source to its reviewed lock workflow", async () => {
  const source = await actualGhAwPilotSource();
  assert.deepEqual(validateGhAwPilotSource(source), []);
  assert.ok(validateGhAwPilotSource(`${source}\n# drift`).length > 0);
});

test("requires trusted gh-aw Pilot authorization and publish recheck", async () => {
  const source = await actualGhAwPilotSource();
  const prompt = source.replace(/^---[\s\S]*?\n---\n/, "");
  for (const requirement of [
    "github.triggering_actor == 'LichKing-2234'",
    "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    'group: "gh-aw-pilot-${{ github.repository }}"',
    "pilot_preflight:",
    "node .github/scripts/gh-aw-pilot.mjs",
    "PILOT_PHASE: authorize",
    "PILOT_PHASE: recheck",
    "Checkout trusted pilot verifier",
    "path: .pilot-trusted",
    "node .pilot-trusted/.github/scripts/gh-aw-pilot.mjs",
    "Do not read or act on Issue comments",
    "PILOT_EXPECTED_EXECUTION_CONTENT_HASH: ${{ inputs.execution_content_sha256 }}",
    'allowed-branches: ["gh-aw/pilot-${{ inputs.item_number }}"]',
    "base-branch: ${{ github.event.repository.default_branch }}",
    "needs.pilot_preflight.outputs.target_hash",
    "needs.pilot_preflight.outputs.category",
  ]) {
    assert.ok(source.includes(requirement), requirement);
  }
  assert.equal(source.match(/ref: \$\{\{ github\.sha \}\}/g)?.length, 2);
  assert.doesNotMatch(prompt, /\$implement|needs\.pilot_preflight\.outputs/);
  for (const requirement of [
    "Apply the pinned upstream `implement` sequence directly",
    "Call the Skill tool with `tdd` where possible at pre-agreed seams",
    "Run typechecking regularly and run single test files regularly",
    "Run the full test suite once at the end",
    "Call the Skill tool with `code-review` after implementation and validation",
    "Commit the reviewed work to the current branch",
  ]) {
    assert.ok(prompt.includes(requirement), requirement);
  }

  const sources = await actualTrustedScriptSources();
  sources["gh-aw-pilot.mjs"] = sources["gh-aw-pilot.mjs"].replace(
    "targetHash !== expectedTargetHash",
    "false",
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("trusted target snapshot"),
    ),
  );

  const drifted = await actualTrustedScriptSources();
  drifted["gh-aw-pilot.mjs"] += "\n// drift\n";
  assert.ok(
    validateTrustedScriptSources(drifted).some((error) =>
      error.includes("reviewed trusted source"),
    ),
  );
});

test("reserves concurrency queue for the generated gh-aw workflow", async () => {
  const workflows = await actualWorkflows();
  workflows["ci.yml"].jobs.ci.concurrency = {
    group: "ci",
    queue: "max",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("concurrency.queue is reserved"),
    ),
  );
});

test("publishes repository validation through the CI workflow and check", async () => {
  const workflows = await actualWorkflows();
  assert.equal(workflows["ci.yml"]?.name, "CI");
  assert.equal(workflows["ci.yml"]?.jobs?.ci?.name, "CI");
  assert.equal(workflows["docs-ci.yml"], undefined);

  workflows["ci.yml"].jobs.ci.name = "Docs CI";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("CI workflow and required check"),
    ),
  );
});

test("starts review, recovery, and outcome handling from the CI workflow", async () => {
  const workflows = await actualWorkflows();
  assert.deepEqual(
    workflows["claude-pr-review.yml"].on.workflow_run.workflows,
    ["CI"],
  );
  assert.deepEqual(workflows["codex-worker.yml"].on.workflow_run.workflows, [
    "CI",
    "Claude PR Review",
  ]);
  assert.ok(
    workflows["workflow-outcome.yml"].on.workflow_run.workflows.includes("CI"),
  );
  assert.ok(
    !workflows["workflow-outcome.yml"].on.workflow_run.workflows.includes("Docs CI"),
  );
});

test("requires safe machine-parseable run names for every workflow", async () => {
  const workflows = await actualWorkflows();
  assert.equal(Object.keys(workflows).length, 10);
  assert.ok(
    Object.values(workflows).every(
      (workflow) =>
        typeof workflow["run-name"] === "string" &&
        workflow["run-name"].length > 0,
    ),
  );

  delete workflows["ci.yml"]["run-name"];
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("safe run-name"),
    ),
  );
});

test("requires a safe terminal Job Summary in every source workflow", async () => {
  const workflows = await actualWorkflows();
  for (const [name, workflow] of Object.entries(workflows)) {
    if (
      ["gh-aw-issue-to-pr-pilot.lock.yml", "workflow-outcome.yml"].includes(name)
    ) {
      continue;
    }
    assert.ok(workflow.jobs.outcome, name);
  }

  workflows["ci.yml"].jobs.outcome.steps[0].env.SUMMARY_TARGET =
    "${{ github.event.pull_request.title }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("terminal Job Summary"),
    ),
  );
});

test("rejects untrusted text and Secrets in workflow run names", async () => {
  for (const unsafe of [
    "${{ github.event.issue.title }}",
    "${{ github.event.issue.body }}",
    "${{ github.event.comment.body }}",
    "${{ github.event.head_commit.message }}",
    "${{ secrets.WECOM_BOT_WEBHOOK_URL }}",
  ]) {
    const workflows = await actualWorkflows();
    workflows["ci.yml"]["run-name"] = unsafe;
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("safe run-name"),
      ),
      unsafe,
    );
  }
});

test("keeps the WeCom Secret only in the trusted outcome sender", async () => {
  const workflows = await actualWorkflows();
  workflows["ci.yml"].jobs.ci.steps[0].env = {
    WECOM_BOT_WEBHOOK_URL: "${{ secrets.WECOM_BOT_WEBHOOK_URL }}",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("WECOM_BOT_WEBHOOK_URL"),
    ),
  );
});

test("requires bounded deduplicated outcome and post-merge behavior", async () => {
  const sources = await actualTrustedScriptSources();
  assert.deepEqual(validateTrustedScriptSources(sources), []);
  sources["workflow-outcome.mjs"] = sources["workflow-outcome.mjs"].replace(
    "Math.min(Math.max(Number(maxAttempts) || 1, 1), 3)",
    "Number(maxAttempts)",
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("bounded dedupe and post-merge triage"),
    ),
  );
});

test("isolates workflow outcome concurrency per source run", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["workflow-outcome.yml"];
  assert.deepEqual(workflow.concurrency, {
    group: "workflow-outcome-${{ github.event.workflow_run.id }}",
    "cancel-in-progress": false,
  });

  workflow.concurrency.group = "workflow-outcome-${{ github.repository }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("fixed trusted triggers"),
    ),
  );
});

test("rejects untrusted workflow Summary sources", async () => {
  for (const unsafe of [
    "sourceRun.title",
    "issue.body",
    "comment.body",
    "head_commit.message",
    "model_output",
  ]) {
    const sources = await actualTrustedScriptSources();
    sources["workflow-outcome.mjs"] = sources["workflow-outcome.mjs"].replace(
      "  const targetLabel = record.target.number",
      `  const unsafeSummary = ${unsafe};\n  const targetLabel = record.target.number`,
    );
    assert.ok(
      validateTrustedScriptSources(sources).some((error) =>
        error.includes("trusted Summary sources"),
      ),
      unsafe,
    );
  }
});

test("fails closed when the trusted workflow Summary window is missing", async () => {
  const sources = await actualTrustedScriptSources();
  sources["workflow-outcome.mjs"] = sources["workflow-outcome.mjs"].replace(
    "export function renderJobSummary",
    "export function renamedJobSummary",
  );

  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("trusted Summary sources"),
    ),
  );
});

test("requires the serialized Blocker Reconciler workflow", async () => {
  const workflows = await actualWorkflows();
  const reconciler = workflows["blocker-reconciler.yml"];
  assert.deepEqual(reconciler.on.schedule, [{ cron: "*/15 * * * *" }]);
  assert.deepEqual(reconciler.concurrency, {
    group: "blocker-graph-${{ github.repository }}",
    "cancel-in-progress": false,
  });
  delete workflows["blocker-reconciler.yml"];
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("blocker-reconciler.yml"),
    ),
  );
});

test("grants contents write only to trusted repository dispatch publishers", async () => {
  const workflows = await actualWorkflows();
  assert.equal(
    workflows["blocker-reconciler.yml"].jobs.reconcile.permissions.contents,
    "write",
  );
  assert.equal(
    workflows["codex-worker.yml"].jobs.publish.permissions.contents,
    "write",
  );
  assert.equal(
    workflows["codex-worker.yml"].jobs.implement.permissions.contents,
    "read",
  );
  workflows["blocker-reconciler.yml"].jobs.reconcile.permissions.contents = "read";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Blocker Reconciler"),
    ),
  );
});

test("keeps blocker publication off the Publisher PAT", async () => {
  const workflows = await actualWorkflows();
  const blocker = workflows["codex-worker.yml"].jobs.publish.steps.find(
    (step) => step.name === "Publish unprivileged blocker proposals",
  );
  assert.equal(blocker.env.GITHUB_TOKEN, "${{ github.token }}");
  blocker.env.CODEX_GITHUB_TOKEN = "${{ secrets.CODEX_GITHUB_TOKEN }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("CODEX_GITHUB_TOKEN"),
    ),
  );
});

test("keeps human handoff publication on github.token and policy-locked", async () => {
  const workflows = await actualWorkflows();
  const handoff = workflows["codex-worker.yml"].jobs.publish.steps.find(
    (step) => step.name === "Publish human handoff",
  );
  assert.ok(handoff);
  assert.equal(handoff.env.GITHUB_TOKEN, "${{ github.token }}");
  assert.equal(JSON.stringify(handoff).includes("CODEX_GITHUB_TOKEN"), false);

  handoff.env.CODEX_GITHUB_TOKEN = "${{ secrets.CODEX_GITHUB_TOKEN }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("human handoff publication"),
    ),
  );
});

test("requires bounded blocker and reconciliation sources", async () => {
  const sources = await actualTrustedScriptSources();
  sources["blocker-reconciler.mjs"] = sources["blocker-reconciler.mjs"].replace(
    'event_type: "codex-worker"',
    'event_type: "untrusted"',
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("bounded proposals and signed reconciliation"),
    ),
  );

  const bodyAuthority = await actualTrustedScriptSources();
  bodyAuthority["blocker-reconciler.mjs"] = bodyAuthority[
    "blocker-reconciler.mjs"
  ].replaceAll("readNativeDependencies({", "readBodyDependencies({");
  assert.ok(
    validateTrustedScriptSources(bodyAuthority).some((error) =>
      error.includes("bounded proposals and signed reconciliation"),
    ),
  );
});

test("requires the Codex Worker workflow", async () => {
  const workflows = await actualWorkflows();
  delete workflows["codex-worker.yml"];
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("codex-worker.yml"),
    ),
  );
});

test("requires the isolated Worker authorization recorder before the model", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  assert.ok(worker.on.issues.types.includes("edited"));
  assert.equal(worker.jobs.prepare.needs, "authorization");
  assert.equal(
    worker.jobs.prepare.if,
    "always() && needs.authorization.result == 'success' && needs.authorization.outputs.allowed != 'false'",
  );

  delete worker.jobs.authorization;
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("authorization must be isolated before the model job"),
    ),
  );
});

test("keeps legacy Worker new Issue intake disabled", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  const tokenMint = worker.jobs.authorization.steps.find(
    (step) => step.id === "team-membership-token",
  );
  const recorder = worker.jobs.authorization.steps.find(
    (step) => step.name === "Record trusted authorization transition",
  );
  assert.equal(tokenMint, undefined);
  assert.deepEqual(recorder.env, { GITHUB_TOKEN: "${{ github.token }}" });

  recorder.env.TEAM_MEMBERSHIP_TOKEN =
    "${{ steps.team-membership-token.outputs.token }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("new Issue intake must stay disabled"),
    ),
  );

  const sources = await actualTrustedScriptSources();
  assert.doesNotMatch(sources["codex-worker.mjs"], /\bauthorizeCycle\(/);
  assert.doesNotMatch(
    sources["codex-worker.mjs"],
    /TEAM_MEMBERSHIP_TOKEN|fetchTeamMembership/,
  );
  assert.match(
    sources["codex-worker.mjs"],
    /if \(!context\.current\) return false;/,
  );
  assert.match(
    sources["codex-worker.mjs"],
    /const allowed = await recordIssueAuthorizationEvent\([\s\S]{0,200}await writeOutput\("allowed", allowed\);/,
  );
  sources["codex-worker.mjs"] = sources["codex-worker.mjs"].replace(
    'event.action === "labeled" && event.label?.name === "ready-for-agent"',
    "false",
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("new Issue intake must stay disabled"),
    ),
  );
});

test("requires Worker authorization, cycle, content hash, and AC evidence sources", async () => {
  const sources = await actualTrustedScriptSources();
  assert.deepEqual(validateTrustedScriptSources(sources), []);
  sources["worker-contract.mjs"] = sources["worker-contract.mjs"].replace(
    'createHash("sha256")',
    'createHash("sha1")',
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("bind authorization, cycle, hash, and AC evidence"),
    ),
  );
});

test("rejects PR Review model configuration that bypasses validated settings", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
    (step) => step.id === "claude",
  );
  action.with.claude_args = action.with.claude_args.replace(
    "secrets.CLAUDE_REVIEW_MODEL",
    "vars.CLAUDE_REVIEW_MODEL",
  );

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude PR Review model configuration must use validated settings"),
    ),
  );
});

test("rejects a PR Review effort Secret in place of the repository Variable", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
    (step) => step.id === "claude",
  );
  action.with.claude_args = action.with.claude_args.replace(
    "vars.CLAUDE_REVIEW_EFFORT",
    "secrets.CLAUDE_REVIEW_EFFORT",
  );

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude PR Review model configuration must use validated settings"),
    ),
  );
});

test("rejects duplicate PR Review model configuration arguments", async () => {
  const mutations = [
    (args) => `${args}\n--model unapproved`,
    (args) => `${args}\n--effort=max`,
    (args) =>
      args.replace(
        '--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"',
        '--model unapproved\nx--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"',
      ),
    (args) =>
      args.replace(
        '--effort "${{ vars.CLAUDE_REVIEW_EFFORT }}"',
        '--effort max\nx--effort "${{ vars.CLAUDE_REVIEW_EFFORT }}"',
      ),
  ];
  for (const mutate of mutations) {
    const workflows = await actualWorkflows();
    const action = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
      (step) => step.id === "claude",
    );
    action.with.claude_args = mutate(action.with.claude_args);

    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("Claude PR Review model configuration must use validated settings"),
      ),
    );
  }
});

test("locks Claude PR Review to bounded read-only tools", async () => {
  const mutations = [
    (args) => args.replace("Read,Grep,Glob", "Read,Grep"),
    (args) => `${args}\n--allowedTools "Bash"`,
    (args) => `${args}\n--allowedTools="Bash"`,
    (args) => `${args}\n--allowed-tools=Bash`,
    (args) => `${args}\n--disallowedTools=""`,
    (args) => `${args}\n--disallowed-tools=`,
    (args) => args.replace(
      '--disallowedTools "Edit,Write,MultiEdit,Bash,WebFetch,WebSearch"',
      "",
    ),
  ];

  for (const mutate of mutations) {
    const workflows = await actualWorkflows();
    const action = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
      (step) => step.id === "claude",
    );
    action.with.claude_args = mutate(action.with.claude_args);

    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("Claude PR Review model must use bounded read-only tools"),
      ),
    );
  }
});

test("requires Claude PR Review to validate and filter candidate findings", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
    (step) => step.id === "claude",
  );
  action.with.prompt = action.with.prompt.replace(
    "Discard every candidate that fails any check.",
    "Report every candidate.",
  );

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude PR Review must validate and filter candidate findings"),
    ),
  );
});

test("requires Claude PR Review to emit validated LEFT and RIGHT locations", async () => {
  for (const mutate of [
    (action) => {
      action.with.prompt = action.with.prompt.replace(" or deleted LEFT-side", "");
    },
    (action) => {
      action.with.claude_args = action.with.claude_args.replace(
        '"side":{"enum":["LEFT","RIGHT"]}',
        '"side":{"const":"RIGHT"}',
      );
    },
  ]) {
    const workflows = await actualWorkflows();
    const action = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
      (step) => step.id === "claude",
    );
    mutate(action);
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("Claude PR Review must bind findings to LEFT or RIGHT diff lines"),
      ),
    );
  }
});

test("cancels stale Claude Review runs by PR while reviewing every successful CI head", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-pr-review.yml"].concurrency.group =
    "claude-review-${{ github.run_id }}";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude PR Review trigger and concurrency must stay current-head bound"),
    ),
  );
});

test("binds staged Claude Review input to the completed CI head", async () => {
  const workflows = await actualWorkflows();
  const stage = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
    (step) => step.name === "Stage untrusted PR review data",
  );
  stage.env.EXPECTED_HEAD_SHA = "${{ github.sha }}";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude PR Review model configuration must use validated settings"),
    ),
  );
});

test("binds Claude Review publication to the completed CI head", async () => {
  const workflows = await actualWorkflows();
  const publish = workflows["claude-pr-review.yml"].jobs.publish.steps.find(
    (step) => step.name === "Publish validated Review result",
  );
  publish.env.EXPECTED_HEAD_SHA = "${{ github.sha }}";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude PR Review must publish only the completed CI head"),
    ),
  );
});

test("requires the Claude provider selector and same-run publication", async () => {
  const workflows = await actualWorkflows();
  const review = workflows["claude-pr-review.yml"];
  const publish = review.jobs.publish.steps.find(
    (step) => step.name === "Publish validated Review result",
  );
  const selector = "vars.PR_REVIEW_PROVIDER == 'claude' &&";

  review.jobs.analyze.if = review.jobs.analyze.if.replace(selector, "");
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("trigger and concurrency must stay current-head bound"),
    ),
  );

  review.jobs.analyze.if = `${selector}\n${review.jobs.analyze.if}`;
  review.jobs.publish.if = review.jobs.publish.if.replace(
    "needs.analyze.outputs.selected_provider == 'claude' &&",
    "",
  );
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("trigger and concurrency must stay current-head bound"),
    ),
  );

  review.jobs.publish.if =
    `needs.analyze.outputs.selected_provider == 'claude' &&\n${review.jobs.publish.if}`;
  const [selectedProvider] = review.jobs.analyze.steps.splice(0, 1);
  review.jobs.analyze.steps.splice(1, 0, selectedProvider);
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("publish only the completed CI head"),
    ),
  );

  review.jobs.analyze.steps.splice(1, 1);
  review.jobs.analyze.steps.unshift(selectedProvider);
  publish.env.REVIEW_ENABLED = "false";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("publish only the completed CI head"),
    ),
  );
});

test("rejects floating third-party Action references", async () => {
  const workflows = await actualWorkflows();
  workflows["ci.yml"].jobs.ci.steps[0].uses = "actions/checkout@main";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("full commit SHA")),
  );
});

test("uses pinned PR-Agent official inline publishing", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["pr-agent-review.yml"];
  const reviewAction = workflow.jobs.analyze.steps.find(
    (step) => step.id === "pr-agent",
  );
  const suggestionsAction = workflow.jobs.suggestions.steps.find(
    (step) => step.id === "pr-agent-suggestions",
  );

  assert.deepEqual(workflow.on.pull_request_target.types, [
    "opened",
    "reopened",
    "synchronize",
    "ready_for_review",
    "review_requested",
  ]);
  assert.deepEqual(workflow.jobs.analyze.permissions, {
    contents: "read",
    issues: "write",
    "pull-requests": "write",
  });
  assert.deepEqual(workflow.jobs.suggestions.permissions, {
    contents: "read",
    issues: "write",
    "pull-requests": "write",
  });
  assert.match(
    workflow.jobs.analyze.if,
    /vars\.PR_REVIEW_PROVIDER != 'claude'/,
  );
  assert.match(
    workflow.jobs.analyze.if,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.equal(suggestionsAction["continue-on-error"], true);
  assert.equal(
    reviewAction.uses,
    "The-PR-Agent/pr-agent@f6af7d77554ff8d26adffded077e6461329e92fa",
  );
  assert.equal(suggestionsAction.uses, reviewAction.uses);
  assert.equal(reviewAction.env.OPENAI__KEY, "${{ secrets.PR_AGENT_API_KEY }}");
  assert.equal(
    reviewAction.env.OPENAI__API_BASE,
    "${{ secrets.PR_AGENT_API_BASE }}",
  );
  assert.equal(reviewAction.env["config.model"], "${{ secrets.PR_AGENT_MODEL }}");
  assert.equal(reviewAction.env["config.propagate_tool_errors"], "true");
  assert.equal(reviewAction.env["config.publish_output"], "true");
  assert.equal(reviewAction.env["config.restricted_mode"], "true");
  assert.equal(
    suggestionsAction.env["pr_code_suggestions.commitable_code_suggestions"],
    "true",
  );
  assert.equal(reviewAction.env["github_action_config.auto_review"], "true");
  assert.equal(reviewAction.env["github_action_config.auto_improve"], "false");
  assert.equal(suggestionsAction.env["github_action_config.auto_review"], "false");
  assert.equal(suggestionsAction.env["github_action_config.auto_improve"], "true");

  reviewAction.env["config.publish_output"] = "false";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );

  reviewAction.env["config.publish_output"] = "true";
  reviewAction.env["config.propagate_tool_errors"] = "false";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );

  reviewAction.env["config.propagate_tool_errors"] = "true";
  suggestionsAction.env["pr_code_suggestions.commitable_code_suggestions"] =
    "false";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );

  suggestionsAction.env["pr_code_suggestions.commitable_code_suggestions"] =
    "true";
  suggestionsAction.env["github_action_config.auto_improve"] = "false";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );

  suggestionsAction.env["github_action_config.auto_improve"] = "true";
  workflow.jobs.analyze.permissions["pull-requests"] = "read";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );

  workflow.jobs.analyze.permissions["pull-requests"] = "write";
  suggestionsAction["continue-on-error"] = false;
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );

  suggestionsAction["continue-on-error"] = true;
  suggestionsAction.env["github_action_config.auto_review"] = "true";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );
});

test("requires same-repository PR-Agent runs", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["pr-agent-review.yml"];
  workflow.jobs.analyze.if = workflow.jobs.analyze.if.replace(
    "github.event.pull_request.head.repo.full_name == github.repository",
    "true",
  );

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("official inline publishing"),
    ),
  );
});

test("keeps PR-Agent Secrets only in the pinned review Action", async () => {
  const workflows = await actualWorkflows();
  workflows["ci.yml"].jobs.ci.steps[0].env = {
    BAD: "${{ secrets.PR_AGENT_API_KEY }}",
  };

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("PR_AGENT_API_KEY is allowed only in the pinned PR-Agent Action"),
    ),
  );
});

test("rejects an untrusted PR checkout in PR Gates", async () => {
  const workflows = await actualWorkflows();
  const checkout = workflows["pr-gates.yml"].jobs.gates.steps.find((step) => step.uses);
  checkout.with.ref = "${{ github.event.pull_request.head.sha }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("default branch")),
  );
});

test("rejects model Secrets outside an approved Claude execution step", async () => {
  const workflows = await actualWorkflows();
  workflows["pr-gates.yml"].jobs.gates.env = {
    BAD: "${{ secrets.ANTHROPIC_API_KEY }}",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("ANTHROPIC_API_KEY"),
    ),
  );
});

test("keeps the Codex API key only in the official model Action", async () => {
  const workflows = await actualWorkflows();
  workflows["codex-worker.yml"].jobs.publish.steps[0].env = {
    BAD: "${{ secrets.CODEX_API_KEY }}",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("CODEX_API_KEY"),
    ),
  );

  const duplicatedSecret = await actualWorkflows();
  const action = duplicatedSecret["codex-worker.yml"].jobs.implement.steps.find(
    (step) => step.uses?.startsWith("openai/codex-action@"),
  );
  action.env = { BAD: "${{ secrets.CODEX_API_KEY }}" };
  assert.ok(
    validateWorkflowDocuments(duplicatedSecret).some((error) =>
      error.includes("CODEX_API_KEY"),
    ),
  );
});

test("keeps Codex model configuration in fixed repository settings", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  const prepare = worker.jobs.prepare.steps.find(
    (step) => step.name === "Prepare trusted Worker plan",
  );
  const action = worker.jobs.implement.steps.find((step) =>
    step.uses?.startsWith("openai/codex-action@"),
  );
  for (const [name, reference] of [
    [
      "CODEX_RESPONSES_API_ENDPOINT",
      "${{ secrets.CODEX_RESPONSES_API_ENDPOINT }}",
    ],
    ["CODEX_MODEL", "${{ secrets.CODEX_MODEL }}"],
    ["CODEX_EFFORT", "${{ vars.CODEX_EFFORT }}"],
  ]) {
    assert.equal(prepare.env[name], reference);
  }
  assert.equal(
    action.with["responses-api-endpoint"],
    "${{ secrets.CODEX_RESPONSES_API_ENDPOINT }}",
  );
  assert.equal(action.with.model, "${{ secrets.CODEX_MODEL }}");
  assert.equal(action.with.effort, "${{ vars.CODEX_EFFORT }}");
});

test("rejects a Codex Worker prepare effort Secret with the dedicated error", async () => {
  const workflows = await actualWorkflows();
  workflows["codex-worker.yml"].jobs.prepare.steps.find(
    (step) => step.name === "Prepare trusted Worker plan",
  ).env.CODEX_EFFORT = "${{ secrets.CODEX_EFFORT }}";

  const errors = validateWorkflowDocuments(workflows);
  assert.ok(
    errors.includes("Codex Worker effort must use the fixed repository Variable"),
  );
  assert.equal(
    errors.includes("Codex Worker Codex Action inputs must stay fixed"),
    false,
  );
});

test("rejects a Codex Action effort Secret with the dedicated error", async () => {
  const workflows = await actualWorkflows();
  workflows["codex-worker.yml"].jobs.implement.steps.find((step) =>
    step.uses?.startsWith("openai/codex-action@"),
  ).with.effort = "${{ secrets.CODEX_EFFORT }}";

  const errors = validateWorkflowDocuments(workflows);
  assert.ok(errors.includes("Codex Worker Codex Action inputs must stay fixed"));
  assert.equal(
    errors.includes("Codex Worker effort must use the fixed repository Variable"),
    false,
  );
});

test("rejects a CODEX_EFFORT Secret through default-deny", async () => {
  const workflows = await actualWorkflows();
  workflows["pr-gates.yml"].jobs.gates.steps.find(
    (step) => step.name === "Checkout trusted default branch",
  ).env = { CODEX_EFFORT: "${{ secrets.CODEX_EFFORT }}" };

  assert.ok(
    validateWorkflowDocuments(workflows).includes(
      "pr-gates.yml/gates: Secret CODEX_EFFORT is not allowlisted",
    ),
  );
});

test("keeps the publisher PAT out of the model job", async () => {
  const workflows = await actualWorkflows();
  workflows["codex-worker.yml"].jobs.implement.env = {
    BAD: "${{ secrets.CODEX_GITHUB_TOKEN }}",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("CODEX_GITHUB_TOKEN"),
    ),
  );
});

test("allows the publisher PAT only in fixed publication, retry, and base-update steps", async () => {
  const workflows = await actualWorkflows();
  const step = workflows["codex-worker.yml"].jobs.publish.steps.find(
    (candidate) => candidate.name === "Handle Worker control event",
  );
  step.env.CODEX_GITHUB_TOKEN = "${{ secrets.CODEX_GITHUB_TOKEN }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("fixed Worker publisher steps"),
    ),
  );
});

test("requires the pinned official Codex and Artifact Actions", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["codex-worker.yml"].jobs.implement.steps.find(
    (step) => step.uses?.startsWith("openai/codex-action@"),
  );
  action.uses = `attacker/example@${"a".repeat(40)}`;
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("pinned official Codex Action"),
    ),
  );
});

test("locks the Codex permission profile and safety strategy", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["codex-worker.yml"].jobs.implement.steps.find(
    (step) => step.uses?.startsWith("openai/codex-action@"),
  );
  action.with["permission-profile"] = ":workspace";
  action.with["safety-strategy"] = "unsafe";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Codex Action inputs"),
    ),
  );
});

test("locks the Worker Artifact paths and name", async () => {
  const workflows = await actualWorkflows();
  const upload = workflows["codex-worker.yml"].jobs.implement.steps.find(
    (step) => step.name === "Upload fixed Worker Artifact",
  );
  upload.with.path += "\n${{ github.workspace }}/workspace/secrets.txt";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Artifact allowlist"),
    ),
  );
});

test("allows only the fixed Artifact upload after Codex", async () => {
  const workflows = await actualWorkflows();
  workflows["codex-worker.yml"].jobs.implement.steps.push({
    name: "Run generated script",
    run: "./generated.sh",
  });
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("only upload the fixed Artifact after Codex"),
    ),
  );
});

test("keeps trusted and recorded Worker checkouts separate", async () => {
  const workflows = await actualWorkflows();
  const checkout = workflows["codex-worker.yml"].jobs.publish.steps.find(
    (step) =>
      step.name === "Checkout recorded start commit",
  );
  checkout.with.path = "trusted";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("recorded checkout must use workspace"),
    ),
  );
});

test("pins the Worker default branch outside the model Artifact", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  delete worker.jobs.prepare.outputs.default_branch;
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("trusted default branch output"),
    ),
  );

  const invalidPreflight = await actualWorkflows();
  const preflight = invalidPreflight["codex-worker.yml"].jobs.publish.steps.find(
    (step) => step.name === "Validate Artifact before publisher credential exposure",
  );
  delete preflight.env.WORKER_DEFAULT_BRANCH;
  assert.ok(
    validateWorkflowDocuments(invalidPreflight).some((error) =>
      error.includes("trusted default branch input"),
    ),
  );
});

test("does not let an external fork cancel a Worker run", async () => {
  const workflows = await actualWorkflows();
  workflows["codex-worker.yml"].concurrency["cancel-in-progress"] =
    "${{ github.event_name == 'pull_request_target' }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("same-repository PR"),
    ),
  );

  const vulnerableWorkflows = await actualWorkflows();
  vulnerableWorkflows["codex-worker.yml"].concurrency.group =
    "codex-worker-${{ github.event.pull_request.head.ref || github.event.issue.number }}";
  assert.ok(
    validateWorkflowDocuments(vulnerableWorkflows).some((error) =>
      error.includes("isolate external fork PRs"),
    ),
  );
});

test("limits model execution to two fixed repository-wide slots", async () => {
  const workflows = await actualWorkflows();
  const implement = workflows["codex-worker.yml"].jobs.implement;
  assert.deepEqual(implement.concurrency, {
    group: "codex-worker-model-slot-${{ needs.prepare.outputs.model_slot }}",
    "cancel-in-progress": false,
  });

  implement.concurrency.group = "codex-worker-model-slot-${{ github.run_id }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("model concurrency must use one of two fixed slots"),
    ),
  );
});

test("dispatches every model retry to a fresh workflow run", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  const retry = worker.jobs.publish.steps.find(
    (step) => step.name === "Dispatch next model attempt",
  );
  assert.equal(worker.jobs.implement.needs, "prepare");
  assert.equal(retry.run, "node trusted/.github/scripts/codex-worker.mjs dispatch-retry");
  assert.equal(
    retry.env.CODEX_GITHUB_TOKEN,
    "${{ secrets.CODEX_GITHUB_TOKEN }}",
  );
  assert.equal(retry.env.GITHUB_TOKEN, undefined);

  retry.run = "node trusted/.github/scripts/codex-worker.mjs prepare";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("retries must dispatch a fresh workflow run"),
    ),
  );
});

test("locks every Worker Artifact to an explicit file allowlist", async () => {
  const mutations = [
    ["prepare", "Upload trusted Worker plan", "${{ runner.temp }}/unexpected.txt"],
    [
      "implement",
      "Upload fixed Worker Artifact",
      "${{ github.workspace }}/workspace/unexpected.txt",
    ],
    ["publish", "Upload trusted Patch checkpoint", "${{ runner.temp }}/unexpected.txt"],
  ];

  for (const [jobName, stepName, extraPath] of mutations) {
    const workflows = await actualWorkflows();
    const upload = workflows["codex-worker.yml"].jobs[jobName].steps.find(
      (step) => step.name === stepName,
    );
    upload.with.path = `${upload.with.path}\n${extraPath}`;
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("Artifact allowlist must stay fixed"),
      ),
    );
  }
});

test("rejects session, credential, and workspace persistence in Worker Artifacts", async () => {
  for (const forbiddenPath of [
    "${{ runner.temp }}/codex-home/",
    "${{ github.workspace }}/workspace/",
    "${{ runner.temp }}/transcript.jsonl",
    "${{ runner.temp }}/goal-session.sqlite",
    "${{ runner.temp }}/git-credentials",
  ]) {
    const workflows = await actualWorkflows();
    const upload = workflows["codex-worker.yml"].jobs.publish.steps.find(
      (step) => step.name === "Upload trusted Patch checkpoint",
    );
    upload.with.path = forbiddenPath;
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("must not persist session or workspace state"),
      ),
    );
  }
});

test("binds checkpoint recovery to the trusted source run and Artifact name", async () => {
  for (const mutate of [
    (download) => {
      download.with["run-id"] = "${{ github.run_id }}";
    },
    (download) => {
      download.with.name = "checkpoint";
    },
    (download) => {
      delete download.with.repository;
    },
  ]) {
    const workflows = await actualWorkflows();
    const download = workflows["codex-worker.yml"].jobs.implement.steps.find(
      (step) => step.name === "Download previous trusted checkpoint",
    );
    mutate(download);
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("checkpoint download must bind the trusted source run and name"),
      ),
    );
  }
});

test("applies a trusted checkpoint before staging model-only files", async () => {
  const workflows = await actualWorkflows();
  const steps = workflows["codex-worker.yml"].jobs.implement.steps;
  const applyIndex = steps.findIndex(
    (step) => step.name === "Apply previous trusted checkpoint",
  );
  const stageIndex = steps.findIndex(
    (step) => step.name === "Stage trusted Worker inputs",
  );

  assert.ok(applyIndex >= 0 && applyIndex < stageIndex);
});

test("keeps the model job read-only and isolated from publisher credentials", async () => {
  for (const mutate of [
    (implement) => {
      implement.permissions.contents = "write";
    },
    (implement) => {
      implement.permissions.issues = "write";
    },
    (implement) => {
      implement.env = { CODEX_GITHUB_TOKEN: "${{ secrets.CODEX_GITHUB_TOKEN }}" };
    },
  ]) {
    const workflows = await actualWorkflows();
    mutate(workflows["codex-worker.yml"].jobs.implement);
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("model job must stay read-only and isolated"),
      ),
    );
  }
});

test("locks CI repair, Review repair, and base-update triggers and permissions", async () => {
  const mutations = [
    (worker) => {
      worker.on.workflow_run.workflows = ["Docs CI"];
    },
    (worker) => {
      worker.on.push.branches = ["release"];
    },
    (worker) => {
      worker.jobs["base-update"].permissions.contents = "write";
    },
    (worker) => {
      worker.jobs.prepare.permissions["pull-requests"] = "read";
    },
    (worker) => {
      delete worker.jobs.prepare.permissions["pull-requests"];
    },
    (worker) => {
      worker.jobs.publish.permissions.actions = "read";
    },
  ];

  for (const mutate of mutations) {
    const workflows = await actualWorkflows();
    mutate(workflows["codex-worker.yml"]);
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("recovery triggers and permissions must stay fixed"),
      ),
    );
  }
});

test("allows trusted completed-workflow recovery to reach preparation", async () => {
  const sources = await actualTrustedScriptSources();
  assert.deepEqual(validateTrustedScriptSources(sources), []);
  sources["codex-worker.mjs"] = sources["codex-worker.mjs"].replace(
    'isTrustedWorkflowRunSource({ repository, run: event.workflow_run })',
    'true',
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("workflow recovery must pass authorization"),
    ),
  );
});

test("binds Claude repair recovery to a trusted source-run target Artifact", async () => {
  const workflows = await actualWorkflows();
  const reviewUpload = workflows["claude-pr-review.yml"].jobs.publish.steps.find(
    (step) => step.name === "Upload trusted Review recovery target",
  );
  const workerDownload = workflows["codex-worker.yml"].jobs.prepare.steps.find(
    (step) => step.name === "Download trusted Review recovery target",
  );
  const workerResolve = workflows["codex-worker.yml"].jobs.prepare.steps.find(
    (step) => step.name === "Resolve trusted Review recovery target",
  );
  assert.ok(reviewUpload);
  assert.ok(workerResolve);
  assert.ok(workerDownload);

  workerDownload.with["run-id"] = "${{ github.run_id }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude recovery target Artifact must stay source-run bound"),
    ),
  );

  workerDownload.with["run-id"] = "${{ github.event.workflow_run.id }}";
  workerResolve.run = "true";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude recovery target Artifact must stay source-run bound"),
    ),
  );
});

test("serializes Claude recovery runs without cross-PR cancellation", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  assert.ok(
    String(worker.concurrency.group).includes("codex-worker-review-recovery"),
  );
  assert.doesNotMatch(
    String(worker.concurrency["cancel-in-progress"]),
    /github\.event_name == 'workflow_run'/,
  );

  worker.concurrency["cancel-in-progress"] = "${{ github.event_name == 'workflow_run' }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Claude recovery concurrency must not cancel another PR"),
    ),
  );
});

test("requires source-head GitHub Actions Claude findings for repair context", async () => {
  const sources = await actualTrustedScriptSources();
  assert.deepEqual(validateTrustedScriptSources(sources), []);
  for (const requirement of [
    "comment.user?.id !== GITHUB_ACTIONS_BOT_ID",
    "comment.original_commit_id !== headSha",
  ]) {
    const changed = {
      ...sources,
      "worker-resilience.mjs": sources["worker-resilience.mjs"].replace(
        requirement,
        "false",
      ),
    };
    assert.ok(
      validateTrustedScriptSources(changed).some((error) =>
        error.includes(
          "Claude recovery context must stay source-head and GitHub-Actions-authored",
        ),
      ),
    );
  }
});

test("persists the CI retry audit before dispatching the rerun", async () => {
  const sources = await actualTrustedScriptSources();
  sources["codex-worker.mjs"] = sources["codex-worker.mjs"].replace(
    "await publishPullRequestRecoveryRecord({ record, repository, token });",
    "await Promise.resolve(record);",
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("CI retry audit must precede rerun dispatch"),
    ),
  );
});

test("rejects force-push and direct merge operations in the Worker workflow", async () => {
  for (const command of ["git push --force origin HEAD", "gh pr merge --admin"]) {
    const workflows = await actualWorkflows();
    workflows["codex-worker.yml"].jobs.publish.steps.push({
      name: "Unsafe recovery",
      run: command,
    });
    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("must not force-push or directly merge"),
      ),
    );
  }
});

test("keeps model Secrets out of the trusted Claude publisher", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-pr-review.yml"].jobs.publish.env = {
    BAD: "${{ secrets.ANTHROPIC_API_KEY }}",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("publisher")),
  );
});

test("keeps unapproved job-level Secrets out of the trusted Claude publisher", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-pr-review.yml"].jobs.publish.container = {
    image: "node:24",
    credentials: {
      password: "${{ secrets.PUBLISHER_PASSWORD }}",
    },
  };

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("publisher")),
  );
});

test("keeps lowercase Secret references out of the trusted Claude publisher", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-pr-review.yml"].jobs.publish.env = {
    BAD: "${{ secrets.anthropic_api_key }}",
  };

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("publisher")),
  );
});

test("configures every Claude model job through validated repository settings", async () => {
  const workflows = await actualWorkflows();
  const maxTurns = "${{ fromJSON(vars.CLAUDE_REVIEW_MAX_TURNS || '30') }}";
  const timeout = "${{ fromJSON(vars.CLAUDE_REVIEW_TIMEOUT_MINUTES || '30') }}";
  const verbose = "${{ vars.CLAUDE_REVIEW_VERBOSE == 'true' }}";
  const modelJobs = [
    ["claude-issue-review.yml", "automatic-issue-review"],
    ["claude-issue-review.yml", "mentions"],
    ["claude-issue-review.yml", "analyze-blocker-review"],
    ["claude-pr-review.yml", "analyze"],
  ];

  for (const [workflowName, jobName] of modelJobs) {
    const job = workflows[workflowName].jobs[jobName];
    const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));
    const actionIndex = job.steps.indexOf(action);
    const config = job.steps[actionIndex - 1];

    assert.equal(job["timeout-minutes"], timeout);
    assert.equal(job.env, undefined);
    assert.equal(config.id, "validate-config");
    assert.equal(config.run, "node .github/scripts/validate-claude-review-config.mjs");
    assert.equal(config.env.ANTHROPIC_BASE_URL, "${{ secrets.ANTHROPIC_BASE_URL }}");
    assert.equal(action.env.ANTHROPIC_BASE_URL, config.env.ANTHROPIC_BASE_URL);
    assert.ok(action.with.claude_args.includes('--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"'));
    assert.equal(config.env.CLAUDE_REVIEW_EFFORT, "${{ vars.CLAUDE_REVIEW_EFFORT }}");
    assert.ok(
      action.with.claude_args.includes(
        '--effort "${{ vars.CLAUDE_REVIEW_EFFORT }}"',
      ),
    );
    assert.ok(action.with.claude_args.includes(`--max-turns "${maxTurns}"`));
    assert.equal(action.with.show_full_output, verbose);
  }
});

test("allows only the trusted github-actions actor for blocker Review dispatch", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["claude-issue-review.yml"].jobs[
    "analyze-blocker-review"
  ].steps.find((step) => step.uses?.startsWith("anthropics/"));

  assert.equal(action.with.allowed_bots, "github-actions");

  for (const invalidAllowedBots of [undefined, "*", "github-actions,dependabot"]) {
    const invalidWorkflows = await actualWorkflows();
    const invalidAction = invalidWorkflows["claude-issue-review.yml"].jobs[
      "analyze-blocker-review"
    ].steps.find((step) => step.uses?.startsWith("anthropics/"));
    if (invalidAllowedBots === undefined) {
      delete invalidAction.with.allowed_bots;
    } else {
      invalidAction.with.allowed_bots = invalidAllowedBots;
    }

    assert.ok(
      validateWorkflowDocuments(invalidWorkflows).some((error) =>
        error.includes("trusted github-actions dispatch actor"),
      ),
    );
  }
});

test("rejects Bot allowlists outside the trusted blocker Review dispatch", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["claude-issue-review.yml"].jobs[
    "automatic-issue-review"
  ].steps.find((step) => step.uses?.startsWith("anthropics/"));
  action.with.allowed_bots = "github-actions";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Bot allowlists are restricted to blocker Review dispatch"),
    ),
  );
});

test("rejects Issue Review model configuration that bypasses validated settings", async () => {
  const workflows = await actualWorkflows();
  const job = workflows["claude-issue-review.yml"].jobs.mentions;
  const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));
  action.with.claude_args = action.with.claude_args.replace(
    "secrets.CLAUDE_REVIEW_MODEL",
    "vars.CLAUDE_REVIEW_MODEL",
  );

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("model configuration must use validated settings"),
    ),
  );
});

test("rejects an Issue Review effort Secret in place of the repository Variable", async () => {
  const workflows = await actualWorkflows();
  const job = workflows["claude-issue-review.yml"].jobs.mentions;
  const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));
  action.with.claude_args = action.with.claude_args.replace(
    "vars.CLAUDE_REVIEW_EFFORT",
    "secrets.CLAUDE_REVIEW_EFFORT",
  );

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("model configuration must use validated settings"),
    ),
  );
});

test("rejects duplicate Issue Review model configuration arguments", async () => {
  const mutations = [
    (args) => `${args}\n--model=unapproved`,
    (args) => `${args}\n--effort max`,
    (args) =>
      args.replace(
        '--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"',
        '--model unapproved\nx--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"',
      ),
    (args) =>
      args.replace(
        '--effort "${{ vars.CLAUDE_REVIEW_EFFORT }}"',
        '--effort max\nx--effort "${{ vars.CLAUDE_REVIEW_EFFORT }}"',
      ),
  ];
  for (const mutate of mutations) {
    const workflows = await actualWorkflows();
    const job = workflows["claude-issue-review.yml"].jobs.mentions;
    const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));
    action.with.claude_args = mutate(action.with.claude_args);

    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("model configuration must use validated settings"),
      ),
    );
  }
});

test("guards every Issue Review model step with the trusted authorizer", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["claude-issue-review.yml"];
  for (const job of Object.values(workflow.jobs)) {
    if (job !== workflow.jobs["automatic-issue-review"]) {
      assert.doesNotMatch(String(job.if ?? ""), /author_association/);
    }
    const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));
    if (!action) continue;
    if (job === workflow.jobs["analyze-blocker-review"]) {
      assert.equal(job.needs, "authorize-blocker-review");
      assert.equal(
        job.if,
        "needs.authorize-blocker-review.outputs.allowed == 'true'",
      );
      continue;
    }
    const authorize = job.steps.find((step) => step.id === "authorize");
    assert.equal(authorize.run, "node .github/scripts/claude-event-authorization.mjs");
    assert.equal(action.if, "steps.authorize.outputs.allowed == 'true'");
  }
});

test("gives the trusted Issue authorizer only the workflow token", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["claude-issue-review.yml"];
  const steps = workflow.jobs["automatic-issue-review"].steps;
  const authorize = steps.find((step) => step.name === "Authorize Claude event");

  assert.equal(authorize.env?.GITHUB_TOKEN, "${{ github.token }}");
  assert.doesNotMatch(JSON.stringify(authorize), /secrets\./);
});

test("rejects collection membership checks for trusted actor associations", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-issue-review.yml"].jobs["automatic-issue-review"].if = `
    github.event.action == 'opened' &&
    contains(fromJSON('["MEMBER","OWNER","COLLABORATOR"]'),
      github.event.issue.author_association)
  `;
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("explicit actor association comparisons"),
    ),
  );
});

test("rejects identity authorization in job-level expressions", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-issue-review.yml"].jobs.mentions.if +=
    " && github.event.issue.author_association == 'MEMBER'";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("must authorize identity in a trusted step"),
    ),
  );
});

test("rejects an unguarded Issue Review model step", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["claude-issue-review.yml"].jobs.mentions.steps.find(
    (step) => step.uses?.startsWith("anthropics/"),
  );
  delete action.if;
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("model step must use trusted authorization output"),
    ),
  );
});

test("rejects subprocess env scrubbing when Claude isolation is not installed", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-pr-review.yml"].jobs.analyze.env = {
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("must not enable subprocess env scrubbing"),
    ),
  );
});

test("serializes every PR Gate event by authoritative PR number", async () => {
  const workflows = await actualWorkflows();
  assert.deepEqual(workflows["pr-gates.yml"].concurrency, {
    group:
      "pr-gates-${{ github.event.pull_request.number || github.event.client_payload.pr_number || (github.event_name == 'issue_comment' && github.event.issue.pull_request && github.event.issue.number) || (github.event_name == 'schedule' && 'membership-reconcile') || format('issue-{0}', github.event.issue.number) }}",
    "cancel-in-progress": true,
  });
});

test("reconciles live Team membership for every open PR", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["pr-gates.yml"];
  assert.deepEqual(workflow.on.schedule, [{ cron: "*/15 * * * *" }]);
  assert.match(
    workflow.jobs["dispatch-issue-update"].if,
    /github\.event_name == 'schedule'/,
  );
  assert.match(workflow.jobs.gates.if, /github\.event_name != 'schedule'/);
});

test("reevaluates PR Gates when an audit command changes", async () => {
  const workflows = await actualWorkflows();
  assert.deepEqual(workflows["pr-gates.yml"].on.issue_comment.types, [
    "created",
    "edited",
    "deleted",
  ]);
  assert.deepEqual(workflows["pr-gates.yml"].on.issues.types, [
    "closed",
    "edited",
    "reopened",
    "labeled",
    "unlabeled",
  ]);
  assert.match(
    workflows["pr-gates.yml"].jobs["dispatch-issue-update"].if,
    /github\.event_name == 'issue_comment'/,
  );
  assert.match(
    workflows["pr-gates.yml"].jobs["dispatch-issue-update"].if,
    /!github\.event\.issue\.pull_request/,
  );
});

test("ignores non-PR Issue comments before minting a Team token", async () => {
  const workflows = await actualWorkflows();
  const condition = workflows["pr-gates.yml"].jobs.gates.if;
  assert.match(condition, /github\.event_name != 'issue_comment'/);
  assert.match(condition, /github\.event\.issue\.pull_request/);
});

test("writes PR Gate results through Check Runs instead of legacy statuses", async () => {
  const workflows = await actualWorkflows();
  const gateJobs = workflows["pr-gates.yml"].jobs;
  assert.deepEqual(gateJobs["dispatch-issue-update"].permissions, {
    contents: "write",
    "pull-requests": "read",
  });
  assert.deepEqual(gateJobs.gates.permissions, {
    contents: "read",
    issues: "write",
    "pull-requests": "write",
    checks: "read",
  });
  assert.doesNotMatch(JSON.stringify(workflows["pr-gates.yml"]), /statuses/);
});

test("rejects legacy status publication in trusted Gate scripts", async () => {
  const sources = await actualTrustedScriptSources();
  sources["pr-gates.mjs"] += '\nconst legacy = "/statuses/";\n';

  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("Gate publishers must not use legacy statuses"),
    ),
  );
});

test("requires all Gate Check Runs to stay bound to current PR heads", async () => {
  const sources = await actualTrustedScriptSources();
  sources["pr-gates.mjs"] = sources["pr-gates.mjs"].replace(
    "headSha: pr.head.sha",
    "headSha: pr.base.sha",
  );

  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("Gate publishers must bind Check Runs to current heads"),
    ),
  );
});

test("requires stale Claude runs to recheck heads and isolate summaries", async () => {
  const sources = await actualTrustedScriptSources();
  sources["claude-review.mjs"] = sources["claude-review.mjs"].replace(
    "await requireCurrentReviewTarget({",
    "await Promise.resolve({",
  );

  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("Claude publisher must isolate and recheck each Review head"),
    ),
  );
});

test("fails closed when Team membership configuration is unavailable", async () => {
  const sources = await actualTrustedScriptSources();
  sources["pr-gates.mjs"] = sources["pr-gates.mjs"].replace(
    'requiredEnvironment("TEAM_MEMBERSHIP_TOKEN");',
    "",
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("fail closed when Team membership is unavailable"),
    ),
  );

  const workflows = await actualWorkflows();
  const steps = workflows["pr-gates.yml"].jobs.gates.steps;
  const mint = steps.find((step) => step.id === "team-membership-token");
  const evaluate = steps.find(
    (step) => step.name === "Evaluate Issue, readiness, and human validation gates",
  );
  assert.equal(mint["continue-on-error"], true);
  assert.equal(evaluate.if, "always()");
});

test("rejects orphaned pending checks in Issue dispatch", async () => {
  const sources = await actualTrustedScriptSources();
  sources["pr-gates.mjs"] = sources["pr-gates.mjs"].replace(
    "affected.map(async (pr) => {",
    "affected.map(async (pr) => {\n        await setPendingChecks(repository, pr);",
  );

  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("Issue dispatch must not orphan pending Check Runs"),
    ),
  );
});

test("exposes a short-lived Team membership token only to Gate evaluation", async () => {
  const workflows = await actualWorkflows();
  const steps = workflows["pr-gates.yml"].jobs.gates.steps;
  const mint = steps.find((step) => step.id === "team-membership-token");
  const evaluate = steps.find(
    (step) => step.name === "Evaluate Issue, readiness, and human validation gates",
  );

  assert.equal(
    mint.uses,
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
  );
  assert.deepEqual(mint.with, {
    "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
    "permission-members": "read",
    "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
    owner: "${{ github.repository_owner }}",
  });
  assert.equal(
    evaluate.env.TEAM_MEMBERSHIP_TOKEN,
    "${{ steps.team-membership-token.outputs.token }}",
  );
  assert.equal(
    JSON.stringify(workflows["pr-gates.yml"]).match(
      /steps\.team-membership-token\.outputs\.token/g,
    )?.length,
    1,
  );
});

test("mints isolated check-only Gate publisher tokens", async () => {
  const workflows = await actualWorkflows();
  const tokenAction =
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
  const expectedInputs = {
    "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
    "permission-checks": "write",
    "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
    owner: "${{ github.repository_owner }}",
    repositories: "${{ github.event.repository.name }}",
  };

  const gateSteps = workflows["pr-gates.yml"].jobs.gates.steps;
  const gateToken = gateSteps.find((step) => step.id === "gate-publisher-token");
  const evaluate = gateSteps.find(
    (step) => step.name === "Evaluate Issue, readiness, and human validation gates",
  );
  assert.equal(gateToken?.uses, tokenAction);
  assert.deepEqual(gateToken?.with, expectedInputs);
  assert.equal(
    evaluate.env.GATE_CHECK_TOKEN,
    "${{ steps.gate-publisher-token.outputs.token }}",
  );

  const reviewSteps = workflows["claude-pr-review.yml"].jobs.publish.steps;
  const reviewToken = reviewSteps.find((step) => step.id === "gate-publisher-token");
  const publish = reviewSteps.find((step) => step.name === "Publish validated Review result");
  assert.equal(reviewToken?.uses, tokenAction);
  assert.deepEqual(reviewToken?.with, expectedInputs);
  assert.equal(
    publish.env.GATE_CHECK_TOKEN,
    "${{ steps.gate-publisher-token.outputs.token }}",
  );

  assert.equal(workflows["pr-gates.yml"].jobs.gates.permissions.checks, "read");
  assert.equal(workflows["claude-pr-review.yml"].jobs.publish.permissions.checks, "read");
});

test("fails the workflow when a Gate publisher token cannot be minted", async () => {
  const workflows = await actualWorkflows();
  const publisherSteps = [
    workflows["pr-gates.yml"].jobs.gates.steps,
    workflows["claude-pr-review.yml"].jobs.publish.steps,
  ];

  for (const steps of publisherSteps) {
    const gateToken = steps.find((step) => step.id === "gate-publisher-token");
    gateToken["continue-on-error"] = true;
  }

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Gate publisher token mint must fail the workflow"),
    ),
  );
});

test("scopes Gate publisher tokens to the current repository", async () => {
  const workflows = await actualWorkflows();
  const publisherSteps = [
    workflows["pr-gates.yml"].jobs.gates.steps,
    workflows["claude-pr-review.yml"].jobs.publish.steps,
  ];

  for (const steps of publisherSteps) {
    const gateToken = steps.find((step) => step.id === "gate-publisher-token");
    assert.equal(gateToken.with.repositories, "${{ github.event.repository.name }}");
  }
});

test("rejects workflow-token Gate publication and the wrong publisher App", async () => {
  for (const scriptName of ["pr-gates.mjs", "claude-review.mjs"]) {
    const sources = await actualTrustedScriptSources();
    sources[scriptName] = sources[scriptName].replace(
      "return gateCheckRequest(`/repos/${repository}/check-runs`,",
      "return githubRequest(`/repos/${repository}/check-runs`,",
    );
    assert.ok(
      validateTrustedScriptSources(sources).some((error) =>
        error.includes("Gate publishers must bind Check Runs to current heads"),
      ),
    );
  }

  const sources = await actualTrustedScriptSources();
  sources["check-run-contract.mjs"] = sources["check-run-contract.mjs"].replace(
    "GATE_PUBLISHER_APP_ID = 4_503_079",
    "GATE_PUBLISHER_APP_ID = 15_368",
  );
  assert.ok(
    validateTrustedScriptSources(sources).some((error) =>
      error.includes("Gate publishers must bind Check Runs to current heads"),
    ),
  );
});

test("rejects the Gate publisher token in a model step", async () => {
  const workflows = await actualWorkflows();
  const model = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
    (step) => step.id === "claude",
  );
  model.env.GATE_CHECK_TOKEN = "${{ steps.gate-publisher-token.outputs.token }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Gate publisher token is allowed only in fixed Check Run steps"),
    ),
  );
});

test("rejects the Team membership token outside fixed Gate steps", async () => {
  const workflows = await actualWorkflows();
  const setup = workflows["pr-gates.yml"].jobs.gates.steps.find(
    (step) => step.name === "Set up Node.js",
  );
  setup.env = {
    LEAK: "${{ steps.team-membership-token.outputs.token }}",
  };

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Team membership token is allowed only in fixed Gate steps"),
    ),
  );
});

test("policy requires PR Gate audit-command reevaluation", async () => {
  const workflows = await actualWorkflows();
  delete workflows["pr-gates.yml"].on.issue_comment;

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("PR Gates must reevaluate created, edited, and deleted audit commands"),
    ),
  );
});

test("policy requires immediate source Issue and authorization-record reevaluation", async () => {
  const workflows = await actualWorkflows();
  workflows["pr-gates.yml"].on.issues.types = ["closed"];

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Issue content and authorization records"),
    ),
  );
});

test("policy rejects legacy PR Gate status permissions", async () => {
  for (const jobName of ["dispatch-issue-update", "gates"]) {
    const workflows = await actualWorkflows();
    const permissions = workflows["pr-gates.yml"].jobs[jobName].permissions;
    delete permissions.checks;
    permissions.statuses = "write";

    assert.ok(
      validateWorkflowDocuments(workflows).some((error) =>
        error.includes("PR Gates must use minimal Check Run permissions"),
      ),
    );
  }
});

test("policy requires the fixed Team membership token chain", async () => {
  const workflows = await actualWorkflows();
  const evaluate = workflows["pr-gates.yml"].jobs.gates.steps.find(
    (step) => step.name === "Evaluate Issue, readiness, and human validation gates",
  );
  delete evaluate.env.TEAM_MEMBERSHIP_TOKEN;

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("PR Gates must mint and isolate a Team membership token"),
    ),
  );
});

test("defines the minimal native auto-merge enrollment workflow", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["auto-merge.yml"];
  assert.deepEqual(workflow.on.pull_request_target.types, [
    "opened",
    "reopened",
    "ready_for_review",
  ]);
  assert.deepEqual(workflow.concurrency, {
    group: "auto-merge-${{ github.event.pull_request.number }}",
    "cancel-in-progress": true,
  });
  assert.deepEqual(workflow.jobs.enroll.permissions, {
    contents: "read",
  });
  const enrollment = workflow.jobs.enroll.steps.find(
    (step) => step.name === "Enable native Squash auto-merge",
  );
  assert.equal(enrollment.env.GITHUB_TOKEN, "${{ secrets.GH_TOKEN }}");
  assert.match(workflow.jobs.enroll.if, /head\.repo\.full_name/);
  assert.match(workflow.jobs.enroll.if, /repository\.default_branch/);
});

test("allows the organization token only in auto-merge enrollment", async () => {
  const workflows = await actualWorkflows();
  const setup = workflows["auto-merge.yml"].jobs.enroll.steps.find(
    (step) => step.name === "Set up Node.js",
  );
  setup.env = { GH_TOKEN: "${{ secrets.GH_TOKEN }}" };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("fixed Auto-merge Enrollment step"),
    ),
  );
});

test("rejects the default workflow token for auto-merge enrollment", async () => {
  const workflows = await actualWorkflows();
  const enrollment = workflows["auto-merge.yml"].jobs.enroll.steps.find(
    (step) => step.name === "Enable native Squash auto-merge",
  );
  enrollment.env.GITHUB_TOKEN = "${{ github.token }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("must use the fixed repository Secret"),
    ),
  );
});

test("rejects PR-head execution in every pull-request-target workflow", async () => {
  const workflows = await actualWorkflows();
  const checkout = workflows["auto-merge.yml"].jobs.enroll.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  checkout.with.ref = "${{ github.event.pull_request.head.sha }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("pull_request_target jobs must not execute PR head"),
    ),
  );
});

test("rejects expanded auto-merge permissions", async () => {
  const workflows = await actualWorkflows();
  workflows["auto-merge.yml"].jobs.enroll.permissions.checks = "write";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Auto-merge Enrollment permissions"),
    ),
  );
});

test("rejects direct merge or administrative bypass commands", async () => {
  const workflows = await actualWorkflows();
  const run = workflows["auto-merge.yml"].jobs.enroll.steps.find((step) => step.run);
  run.run = "gh pr merge --admin";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("must only enroll native auto-merge"),
    ),
  );
});

test("grants PR write permission before restoring human validation labels", async () => {
  const workflows = await actualWorkflows();
  assert.equal(
    workflows["pr-gates.yml"].jobs.gates.permissions["pull-requests"],
    "write",
  );
});

test("keeps the official Issue Review model on read-only tools", async () => {
  const workflows = await actualWorkflows();
  const issueWorkflow = workflows["claude-issue-review.yml"];
  for (const [jobName, job] of Object.entries(issueWorkflow.jobs)) {
    const action = job.steps.find((candidate) =>
      candidate.uses?.startsWith("anthropics/"),
    );
    if (!action) continue;
    assert.match(action.with.claude_args, /--disallowedTools "Edit,Write,MultiEdit,Bash,WebFetch,WebSearch"/);
  }
  const step = issueWorkflow.jobs["automatic-issue-review"].steps.find((candidate) =>
    candidate.uses?.startsWith("anthropics/"),
  );
  step.with.claude_args += '\n--allowedTools "Bash"';
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Issue Review model must stay read-only"),
    ),
  );
});
