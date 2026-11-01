import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("native gates reject dispatch, extra jobs, and expanded permissions", async () => {
  for (const mutate of [
    (workflow) => { workflow.on.repository_dispatch = { types: ["pr-gates"] }; },
    (workflow) => { workflow.jobs.publisher = { steps: [] }; },
    (workflow) => { workflow.jobs.issue.permissions.checks = "write"; },
  ]) {
    const workflows = await actualWorkflows();
    mutate(workflows["pr-gates.yml"]);
    assert.ok(validateWorkflowDocuments(workflows).some((error) => error.includes("Issue Gate job only")));
  }
});

test("publishes repository validation through the CI workflow and check", async () => {
  const workflows = await actualWorkflows();
  assert.equal(workflows["ci.yml"]?.name, "CI");
  assert.deepEqual(validateWorkflowDocuments(workflows), []);
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
  assert.equal(Object.keys(workflows).length, 6);
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
  const checkout = workflows["pr-gates.yml"].jobs.issue.steps.find((step) => step.uses);
  checkout.with.ref = "${{ github.event.pull_request.head.sha }}";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("default branch")),
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
  assert.deepEqual(workflow.on.pull_request_review.types, [
    "submitted",
    "edited",
    "dismissed",
  ]);
  assert.deepEqual(workflow.on.pull_request_review_comment.types, [
    "created",
    "edited",
    "deleted",
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

test("main image publication rejects business images, ambiguous tags and invalid setup-node pins", async () => {
  for (const mutate of [
    (workflow) => { workflow.env.IMAGE_TAG = "sha-${{ github.sha }}"; },
    (workflow) => { workflow.env.IMAGE_TAG = "${{ github.ref == 'refs/heads/main' && 'latest' || github.ref_name }}"; },
    (workflow) => {
      workflow.jobs.infrastructure.steps.find((step) => step.run?.includes("--images="))
        .run = "node deploy/release/build-images.mjs receipt.json --images=platformWorker,runtimeHost";
    },
    (workflow) => {
      workflow.jobs.infrastructure.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))
        .uses = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5028";
    },
    (workflow) => { workflow.jobs.infrastructure.strategy.matrix.include[1].runner = "ubuntu-24.04"; },
  ]) {
    const workflows = await actualWorkflows();
    mutate(workflows["publish-images.yml"]);
    assert.ok(validateWorkflowDocuments(workflows).some((error) =>
      error.includes("standard templates") || error.includes("source-bound full release"),
    ));
  }
});

test("full release is one exact-source dispatch and keeps tag and smoke routes explicit", async () => {
  const workflows = await actualWorkflows();
  const publish = workflows["publish-images.yml"];
  assert.deepEqual(publish.on.push, { tags: ["v*"] });
  assert.deepEqual(publish.concurrency, {
    group: "publish-images-${{ github.event_name == 'workflow_dispatch' && inputs.full_release && inputs.source_sha || github.sha }}",
    "cancel-in-progress": false,
  });
  assert.deepEqual(publish.on.workflow_dispatch.inputs.full_release, {
    description: "Build Platform, standard and runtime images from one exact source commit",
    required: false,
    type: "boolean",
    default: false,
  });
  assert.deepEqual(publish.on.workflow_dispatch.inputs.source_sha, {
    description: "Exact 40-hex commit to publish when full_release is enabled",
    required: false,
    type: "string",
    default: "",
  });
  assert.equal(publish.on.workflow_dispatch.inputs.publish_platform, undefined);
  for (const job of Object.values(publish.jobs)) {
    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    if (checkout) {
      assert.equal(
        checkout.with.ref,
        "${{ github.event_name == 'workflow_dispatch' && inputs.full_release && inputs.source_sha || github.sha }}",
      );
    }
  }
  assert.match(publish.jobs.infrastructure.if, /inputs.full_release == true/);
  assert.match(publish.jobs.platform.if, /inputs.full_release == true/);

  const concurrencyDrift = await actualWorkflows();
  concurrencyDrift["publish-images.yml"].concurrency = {
    group: "publish-images-${{ github.ref }}",
    "cancel-in-progress": false,
  };
  assert.ok(
    validateWorkflowDocuments(concurrencyDrift).some((error) =>
      error.includes("one source-bound full release dispatch"),
    ),
  );

  const invalid = await actualWorkflows();
  invalid["publish-images.yml"].on.push.branches = ["main"];
  assert.ok(
    validateWorkflowDocuments(invalid).some((error) =>
      error.includes("one source-bound full release dispatch"),
    ),
  );
  const sourceDrift = await actualWorkflows();
  sourceDrift["publish-images.yml"].jobs.infrastructure.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  ).with.ref = "${{ github.sha }}";
  assert.ok(
    validateWorkflowDocuments(sourceDrift).some((error) =>
      error.includes("one source-bound full release dispatch"),
    ),
  );
});

test("requires an isolated release smoke input and index receipt artifact", async () => {
  const workflows = await actualWorkflows();
  const publish = workflows["publish-images.yml"];
  publish.on.workflow_dispatch.inputs.smoke = { type: "string", default: false };
  assert.ok(validateWorkflowDocuments(workflows).some((error) => error.includes("standard templates")));
  const restored = await actualWorkflows();
  restored["publish-images.yml"].jobs["infrastructure-index"].steps =
    restored["publish-images.yml"].jobs["infrastructure-index"].steps.filter(
      (step) => !step.run?.includes("published-indexes.jsonl"),
    );
  assert.ok(validateWorkflowDocuments(restored).some((error) => error.includes("standard templates")));
});

test("release jobs reject invalid raw source input before checkout and accept a separately pinned source", async () => {
  const publish = (await actualWorkflows())["publish-images.yml"];
  const dispatchSha = "a".repeat(40);
  const selectedSha = "b".repeat(40);
  for (const jobName of ["infrastructure", "platform"]) {
    const steps = publish.jobs[jobName].steps;
    const validation = steps.find((step) => step.name === "Validate release source");
    assert.ok(validation, `${jobName} has no source validation before checkout`);
    assert.equal(steps[0], validation);
    assert.deepEqual(validation.env, {
      FULL_RELEASE: "${{ inputs.full_release }}",
      INPUT_SOURCE_SHA: "${{ inputs.source_sha }}",
    });
    for (const raw of ["", "main", "b".repeat(7), "b".repeat(40) + "\n", "x\n" + selectedSha]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", validation.run], {
        encoding: "utf8",
        env: { ...process.env, FULL_RELEASE: "true", INPUT_SOURCE_SHA: raw,
          GITHUB_SHA: dispatchSha, RELEASE_SOURCE_SHA: raw || dispatchSha },
      });
      assert.notEqual(result.status, 0, `${jobName} accepted invalid raw input`);
      assert.doesNotMatch(result.stderr, /x\n/);
    }
    for (const [fullRelease, raw, resolved] of [
      ["true", dispatchSha, dispatchSha],
      ["true", selectedSha, selectedSha],
      ["false", "", dispatchSha],
    ]) {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", validation.run], {
        encoding: "utf8",
        env: { ...process.env, FULL_RELEASE: fullRelease, INPUT_SOURCE_SHA: raw,
          GITHUB_SHA: dispatchSha, RELEASE_SOURCE_SHA: resolved },
      });
      assert.equal(result.status, 0, result.stderr);
    }
  }
});

test("Platform index publication retains JSONL and propagates publisher failure through tee", async () => {
  const publish = (await actualWorkflows())["publish-images.yml"];
  const steps = publish.jobs["platform-index"].steps;
  const publication = steps.find((step) => step.name === "Publish multi-architecture Platform indexes");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "platform-index-workflow-"));
  try {
    const source = "b".repeat(40);
    const receipt = JSON.stringify({ commitSha: source, digest: `sha256:${"c".repeat(64)}` });
    await fs.writeFile(path.join(temp, "node"), '#!/bin/bash\ntest "$GITHUB_SHA" = "$EXPECTED_SOURCE" || exit 92\nprintf "%s\\n" "$PUBLISHER_RECEIPT"\nexit "$PUBLISHER_EXIT"\n', { mode: 0o700 });
    for (const status of [0, 23]) {
      const result = spawnSync("bash", ["-e", "-c", publication.run], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, RUNNER_TEMP: temp,
          GITHUB_SHA: "a".repeat(40), RELEASE_SOURCE_SHA: source, IMAGE_TAG: `release-${source}`,
          EXPECTED_SOURCE: source, PUBLISHER_EXIT: String(status), PUBLISHER_RECEIPT: receipt },
      });
      assert.equal(result.status, status, result.stderr);
      assert.equal(await fs.readFile(path.join(temp, "published-platform-indexes.jsonl"), "utf8"), `${receipt}\n`);
    }
    const upload = steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.ok(steps.indexOf(upload) > steps.indexOf(publication));
    assert.equal(upload.if, undefined, "failed index publication must not upload a success artifact");
    assert.equal(upload.with["if-no-files-found"], "error");
    assert.equal(upload.with.path, "${{ runner.temp }}/published-platform-indexes.jsonl");
    assert.equal(upload.with.name, "published-platform-indexes-${{ env.RELEASE_SOURCE_SHA }}-${{ github.run_attempt }}");
    const architectureUpload = publish.jobs.platform.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
    assert.equal(architectureUpload.with.name, "platform-images-${{ matrix.architecture }}-${{ env.RELEASE_SOURCE_SHA }}-${{ github.run_attempt }}");
    assert.equal(download.with.pattern, "platform-images-*-${{ env.RELEASE_SOURCE_SHA }}-${{ github.run_attempt }}");
    assert.equal(download.with["run-id"], undefined, "receipts must come from this run");
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("release policy rejects missing input validation and unbound Platform artifacts", async () => {
  for (const mutate of [
    (workflow) => { workflow.jobs.infrastructure.steps.shift(); },
    (workflow) => { workflow.jobs.platform.steps[0].env.INPUT_SOURCE_SHA = "${{ env.RELEASE_SOURCE_SHA }}"; },
    (workflow) => {
      workflow.jobs.platform.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"))
        .with.name = "platform-images-${{ matrix.architecture }}-${{ env.RELEASE_SOURCE_SHA }}";
    },
    (workflow) => {
      workflow.jobs["platform-index"].steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))
        .with.pattern = "platform-images-*-${{ env.RELEASE_SOURCE_SHA }}";
    },
    (workflow) => { workflow.jobs["platform-index"].steps.pop(); },
  ]) {
    const workflows = await actualWorkflows();
    mutate(workflows["publish-images.yml"]);
    assert.ok(validateWorkflowDocuments(workflows).some((error) => error.includes("raw source validation and attempt-bound")));
  }
});

test("CI policy rejects weakened metadata routing and same-name skipped checks", async () => {
  for (const mutate of [
    (workflow) => { workflow.jobs.ci.name = "CI"; },
    (workflow) => { workflow.jobs.ci.name = "${{ github.event.label.name != 'ci:skip' && 'CI metadata event ignored' || 'CI' }}"; },
    (workflow) => { workflow.concurrency.group = "ci-${{ github.event.pull_request.number || github.ref }}"; },
    (workflow) => { workflow.concurrency["cancel-in-progress"] = false; },
    (workflow) => { workflow.jobs["ci-exemption"].if = "${{ true }}"; },
    (workflow) => { workflow.jobs.changes.if = "${{ always() && !cancelled() }}"; },
    (workflow) => { workflow.jobs.ci_heavy.if = workflow.jobs["ci-exemption"].if; },
    (workflow) => { workflow.jobs.ci.if = "${{ false }}"; },
    (workflow) => { workflow.jobs.ci.name = workflow.jobs.ci.name.replace("github.event.label.name != '' && ", ""); },
  ]) {
    const workflows = await actualWorkflows();
    mutate(workflows["ci.yml"]);
    assert(validateWorkflowDocuments(workflows).some((error) => error.startsWith("CI")));
  }
});
