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

test("accepts the complete Stage 2 workflow set", async () => {
  assert.deepEqual(validateWorkflowDocuments(await actualWorkflows()), []);
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

test("keeps Codex model configuration in fixed Secret inputs", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  const prepare = worker.jobs.implement.steps.find(
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
    ["CODEX_EFFORT", "${{ secrets.CODEX_EFFORT }}"],
  ]) {
    assert.equal(prepare.env[name], reference);
  }
  assert.equal(
    action.with["responses-api-endpoint"],
    "${{ secrets.CODEX_RESPONSES_API_ENDPOINT }}",
  );
  assert.equal(action.with.model, "${{ secrets.CODEX_MODEL }}");
  assert.equal(action.with.effort, "${{ secrets.CODEX_EFFORT }}");
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

test("allows the publisher PAT only in the fixed publication step", async () => {
  const workflows = await actualWorkflows();
  const step = workflows["codex-worker.yml"].jobs.publish.steps.find(
    (candidate) => candidate.name === "Handle rejected publication",
  );
  step.env.CODEX_GITHUB_TOKEN = "${{ secrets.CODEX_GITHUB_TOKEN }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("fixed Worker publication step"),
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
      error.includes("Artifact upload contract"),
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
  delete worker.jobs.implement.outputs.default_branch;
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
    assert.equal(action.with.show_full_output, verbose);
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
