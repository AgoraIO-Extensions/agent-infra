import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
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

test("accepts the complete trusted workflow set", async () => {
  assert.deepEqual(validateWorkflowDocuments(await actualWorkflows()), []);
});

test("native gates reject dispatch, extra jobs, and Check Publisher permissions", async () => {
  for (const mutate of [
    (workflow) => { workflow.on.repository_dispatch = { types: ["pr-gates"] }; },
    (workflow) => { workflow.jobs.publisher = { steps: [] }; },
    (workflow) => { workflow.jobs.human.permissions.checks = "write"; },
    (workflow) => {
      workflow.jobs.human.steps.find((step) => step.id === "team-membership-token")
        .with["permission-checks"] = "write";
    },
  ]) {
    const workflows = await actualWorkflows();
    mutate(workflows["pr-gates.yml"]);
    assert.ok(validateWorkflowDocuments(workflows).some((error) => error.includes("two native jobs")));
  }
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

test("requires safe machine-parseable run names for every workflow", async () => {
  const workflows = await actualWorkflows();
  assert.equal(Object.keys(workflows).length, 5);
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

test("keeps the Connection E2E token only in its fixed conformance step", async () => {
	const workflows = await actualWorkflows();
	workflows["ci.yml"].jobs.ci.steps[0].env = {
		CONNECTION_E2E_TOKEN: "${{ secrets.CONNECTION_E2E_TOKEN }}",
	};
	assert.ok(
		validateWorkflowDocuments(workflows).some((error) =>
			error.includes("CONNECTION_E2E_TOKEN"),
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
  const checkout = workflows["pr-gates.yml"].jobs.human.steps.find((step) => step.uses);
  checkout.with.ref = "${{ github.event.pull_request.head.sha }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("default branch")),
  );
});

test("rejects the Team membership token outside fixed Gate steps", async () => {
  const workflows = await actualWorkflows();
  const setup = workflows["pr-gates.yml"].jobs.human.steps.find(
    (step) => step.name === "Set up Node.js",
  );
  setup.env = {
    LEAK: "${{ steps.team-membership-token.outputs.token }}",
  };

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("Team membership token is allowed only in human validation"),
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
    workflows["pr-gates.yml"].jobs.human.permissions["pull-requests"],
    "write",
  );
});
