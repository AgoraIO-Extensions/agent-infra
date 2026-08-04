import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import { validateWorkflowDocuments } from "./verify-workflow-policy.mjs";

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

test("accepts the complete Stage 1 workflow set", async () => {
  assert.deepEqual(validateWorkflowDocuments(await actualWorkflows()), []);
});

test("keeps the direct CLI canary opt-in, read-only, and non-publishing", async () => {
  const workflows = await actualWorkflows();
  const review = workflows["claude-pr-review.yml"];
  const canary = review.jobs["direct-cli-canary"];

  assert.ok(canary, "direct CLI canary job is required");
  assert.match(canary.if, /vars\.CLAUDE_DIRECT_CLI_CANARY == 'true'/);
  assert.equal(canary["continue-on-error"], true);
  assert.deepEqual(canary.permissions, {
    contents: "read",
    "pull-requests": "read",
  });
  assert.equal(review.jobs.publish.needs, "analyze");

  const action = review.jobs.analyze.steps.find((step) => step.id === "claude");
  const run = canary.steps.find((step) => step.id === "direct");
  assert.ok(run, "direct Claude CLI step is required");
  const actionSchema = action.with.claude_args.match(/--json-schema '(.+)'/s)?.[1];
  assert.equal(run.env.CLAUDE_REVIEW_PROMPT, action.with.prompt);
  assert.equal(run.env.CLAUDE_REVIEW_SCHEMA, actionSchema);
  assert.equal(run.env.ANTHROPIC_BASE_URL, action.env.ANTHROPIC_BASE_URL);
  assert.ok(action.with.claude_args.includes(`--model "${run.env.CLAUDE_REVIEW_MODEL}"`));
  assert.equal(run.run, "bash .github/scripts/run-claude-direct-canary.sh");

  const actionIndex = review.jobs.analyze.steps.indexOf(action);
  assert.equal(review.jobs.analyze.steps[actionIndex - 1].name, "Start Claude Action timer");
  assert.equal(review.jobs.analyze.steps[actionIndex + 1].name, "Record Claude Action metrics");
  assert.ok(
    canary.steps.findIndex((step) => step.name === "Start direct CLI timer") <
      canary.steps.indexOf(run),
  );
});

test("rejects a privileged or always-on direct CLI canary", async () => {
  const workflows = await actualWorkflows();
  const canary = workflows["claude-pr-review.yml"].jobs["direct-cli-canary"];
  canary.if = "github.event.workflow_run.conclusion == 'success'";
  canary["continue-on-error"] = false;
  canary.permissions["pull-requests"] = "write";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Direct CLI canary must stay opt-in, non-blocking, and read-only"),
    ),
  );
});

test("rejects a direct CLI canary step that does not run the bounded review", async () => {
  const workflows = await actualWorkflows();
  const canary = workflows["claude-pr-review.yml"].jobs["direct-cli-canary"];
  canary.steps.find((step) => step.id === "direct").run = "env";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Direct CLI canary execution is not approved"),
    ),
  );
});

test("rejects shell appended to the direct CLI Secret-bearing step", async () => {
  const workflows = await actualWorkflows();
  const canary = workflows["claude-pr-review.yml"].jobs["direct-cli-canary"];
  const direct = canary.steps.find((step) => step.id === "direct");
  direct.run += '\necho "$ANTHROPIC_API_KEY"';

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Direct CLI canary execution is not approved"),
    ),
  );
});

test("rejects divergent Action and direct CLI model configuration", async () => {
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
      error.includes("Direct CLI canary execution is not approved"),
    ),
  );
});

test("forces full model output off while the direct CLI canary is enabled", async () => {
  const workflows = await actualWorkflows();
  const action = workflows["claude-pr-review.yml"].jobs.analyze.steps.find(
    (step) => step.id === "claude",
  );
  action.with.show_full_output = "${{ vars.CLAUDE_REVIEW_VERBOSE == 'true' }}";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Direct CLI canary execution is not approved"),
    ),
  );
});

test("rejects floating third-party Action references", async () => {
  const workflows = await actualWorkflows();
  workflows["docs-ci.yml"].jobs.docs.steps[0].uses = "actions/checkout@main";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("full commit SHA")),
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

test("rejects model Secrets outside an official Claude Action step", async () => {
  const workflows = await actualWorkflows();
  workflows["pr-gates.yml"].jobs.gates.env = {
    BAD: "${{ secrets.ANTHROPIC_API_KEY }}",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("model Secret")),
  );
});

test("requires the trusted Claude publisher to stay credential-free", async () => {
  const workflows = await actualWorkflows();
  workflows["claude-pr-review.yml"].jobs.publish.env = {
    BAD: "${{ secrets.ANTHROPIC_API_KEY }}",
  };
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("publisher")),
  );
});

test("configures every Claude model job through repository variables", async () => {
  const workflows = await actualWorkflows();
  const maxTurns = "${{ fromJSON(vars.CLAUDE_REVIEW_MAX_TURNS || '30') }}";
  const timeout = "${{ fromJSON(vars.CLAUDE_REVIEW_TIMEOUT_MINUTES || '30') }}";
  const verbose = "${{ vars.CLAUDE_REVIEW_VERBOSE == 'true' }}";
  const modelJobs = [
    ["claude-issue-review.yml", "automatic-issue-review"],
    ["claude-issue-review.yml", "mentions"],
    ["claude-pr-review.yml", "analyze"],
  ];

  for (const [workflowName, jobName] of modelJobs) {
    const job = workflows[workflowName].jobs[jobName];
    const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));

    assert.equal(job["timeout-minutes"], timeout);
    assert.ok(action.with.claude_args.includes(`--max-turns "${maxTurns}"`));
    assert.equal(
      action.with.show_full_output,
      jobName === "analyze"
        ? "${{ vars.CLAUDE_DIRECT_CLI_CANARY != 'true' && vars.CLAUDE_REVIEW_VERBOSE == 'true' }}"
        : verbose,
    );
  }
});

test("guards every Issue Review model step with the trusted authorizer", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["claude-issue-review.yml"];
  for (const job of Object.values(workflow.jobs)) {
    assert.doesNotMatch(job.if, /author_association/);
    const authorize = job.steps.find((step) => step.id === "authorize");
    assert.equal(authorize.run, "node .github/scripts/claude-event-authorization.mjs");
    const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));
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
  workflows["claude-issue-review.yml"].jobs["automatic-issue-review"].if =
    "github.event.issue.author_association == 'MEMBER'";
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
      "pr-gates-${{ github.event.pull_request.number || github.event.client_payload.pr_number || format('issue-{0}', github.event.issue.number) }}",
    "cancel-in-progress": true,
  });
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
    contents: "write",
    "pull-requests": "write",
  });
  assert.match(workflow.jobs.enroll.if, /head\.repo\.full_name/);
  assert.match(workflow.jobs.enroll.if, /repository\.default_branch/);
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
  workflows["auto-merge.yml"].jobs.enroll.permissions.issues = "write";
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
  for (const job of Object.values(issueWorkflow.jobs)) {
    const action = job.steps.find((candidate) =>
      candidate.uses?.startsWith("anthropics/"),
    );
    assert.match(
      action.with.claude_args,
      /--disallowedTools "Edit,Write,MultiEdit,Bash"/,
    );
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
