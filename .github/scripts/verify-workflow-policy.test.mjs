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

test("requires member association before an at-claude mention invokes the model", async () => {
  const workflows = await actualWorkflows();
  const condition = workflows["claude-issue-review.yml"].jobs.mentions.if;
  assert.match(condition, /author_association/);
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
