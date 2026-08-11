import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
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
        "pr-agent-review.mjs",
        "pr-gates.mjs",
        "worker-contract.mjs",
        "worker-resilience.mjs",
      ].map(
        async (name) => [
          name,
          await fs.readFile(path.resolve(".github/scripts", name), "utf8"),
        ],
      ),
    ),
  );
}

test("accepts the complete trusted workflow set", async () => {
  assert.deepEqual(validateWorkflowDocuments(await actualWorkflows()), []);
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

test("locks the Worker authorization Team token to the recorder", async () => {
  const workflows = await actualWorkflows();
  const worker = workflows["codex-worker.yml"];
  const recorder = worker.jobs.authorization.steps.find(
    (step) => step.name === "Record trusted authorization transition",
  );
  assert.equal(
    recorder.env.TEAM_MEMBERSHIP_TOKEN,
    "${{ steps.team-membership-token.outputs.token }}",
  );
  recorder.run = "node untrusted.mjs";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("authorization Team token"),
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

test("rejects PR Review model configuration that bypasses validated Secrets", async () => {
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
      error.includes("Claude PR Review model configuration must use validated Secrets"),
    ),
  );
});

test("locks Claude PR Review to bounded read-only tools", async () => {
  const mutations = [
    (args) => args.replace("Read,Grep,Bash", "Read,Grep,Glob,Bash"),
    (args) => `${args}\n--allowedTools "Bash"`,
    (args) => `${args}\n--allowedTools="Bash"`,
    (args) => `${args}\n--allowed-tools=Bash`,
    (args) => `${args}\n--disallowedTools=""`,
    (args) => `${args}\n--disallowed-tools=`,
    (args) => args.replace(
      '--disallowedTools "Glob,Edit,Write,MultiEdit,WebFetch,WebSearch"',
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

test("binds Claude Review analysis and publication to the completed CI head", async () => {
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

test("rejects floating third-party Action references", async () => {
  const workflows = await actualWorkflows();
  workflows["docs-ci.yml"].jobs.docs.steps[0].uses = "actions/checkout@main";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) => error.includes("full commit SHA")),
  );
});

test("isolates pinned PR-Agent analysis from validated publication", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["pr-agent-review.yml"];
  const action = workflow.jobs.analyze.steps.find((step) => step.id === "pr-agent");
  const publish = workflow.jobs.publish.steps.find(
    (step) => step.name === "Publish validated PR-Agent review",
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
    "pull-requests": "read",
  });
  assert.match(
    workflow.jobs.analyze.if,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.equal(
    action.uses,
    "The-PR-Agent/pr-agent@f6af7d77554ff8d26adffded077e6461329e92fa",
  );
  assert.equal(action.env.OPENAI__KEY, "${{ secrets.PR_AGENT_API_KEY }}");
  assert.equal(
    action.env.OPENAI__API_BASE,
    "${{ secrets.PR_AGENT_API_BASE }}",
  );
  assert.equal(action.env["config.model"], "${{ secrets.PR_AGENT_MODEL }}");
  assert.equal(action.env["config.propagate_tool_errors"], "true");
  assert.equal(action.env["config.publish_output"], "false");
  assert.equal(action.env["github_action_config.enable_output"], "true");
  assert.deepEqual(workflow.jobs.publish.permissions, {
    contents: "read",
    "pull-requests": "write",
  });
  assert.equal(publish.run, "node .github/scripts/pr-agent-review.mjs publish");
  assert.equal(
    publish.env.STRUCTURED_OUTPUT,
    "${{ needs.analyze.outputs.structured_output }}",
  );

  action.env["config.publish_output"] = "true";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("isolate the pinned analysis"),
    ),
  );

  action.env["config.publish_output"] = "false";
  action.env["config.propagate_tool_errors"] = "false";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("isolate the pinned analysis"),
    ),
  );

  action.env["config.propagate_tool_errors"] = "true";
  workflow.jobs.publish.permissions["pull-requests"] = "read";
  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("isolate the pinned analysis"),
    ),
  );
});

test("requires same-repository PR-Agent runs and a current-head publisher", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["pr-agent-review.yml"];
  workflow.jobs.analyze.if = workflow.jobs.analyze.if.replace(
    "github.event.pull_request.head.repo.full_name == github.repository",
    "true",
  );
  workflow.jobs.publish.steps.find(
    (step) => step.name === "Publish validated PR-Agent review",
  ).env.EXPECTED_HEAD_SHA = "${{ github.sha }}";

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("isolate the pinned analysis"),
    ),
  );
});

test("keeps PR-Agent Secrets only in the pinned review Action", async () => {
  const workflows = await actualWorkflows();
  workflows["docs-ci.yml"].jobs.docs.steps[0].env = {
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

test("keeps Codex model configuration in fixed Secret inputs", async () => {
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
    'if (eventName === "workflow_run") {',
    'if (eventName === "never") {',
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
  assert.ok(reviewUpload);
  assert.ok(workerDownload);

  workerDownload.with["run-id"] = "${{ github.run_id }}";
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

test("rejects Issue Review model configuration that bypasses validated Secrets", async () => {
  const workflows = await actualWorkflows();
  const job = workflows["claude-issue-review.yml"].jobs.mentions;
  const action = job.steps.find((step) => step.uses?.startsWith("anthropics/"));
  action.with.claude_args = action.with.claude_args.replace(
    "secrets.CLAUDE_REVIEW_MODEL",
    "vars.CLAUDE_REVIEW_MODEL",
  );

  assert.ok(
    validateWorkflowDocuments(workflows).some((error) =>
      error.includes("model configuration must use validated Secrets"),
    ),
  );
});

test("guards every Issue Review model step with the trusted authorizer", async () => {
  const workflows = await actualWorkflows();
  const workflow = workflows["claude-issue-review.yml"];
  for (const job of Object.values(workflow.jobs)) {
    assert.doesNotMatch(String(job.if ?? ""), /author_association/);
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
    assert.match(
      action.with.claude_args,
      jobName === "analyze-blocker-review"
        ? /--disallowedTools "Edit,Write,MultiEdit,WebFetch,WebSearch"/
        : /--disallowedTools "Edit,Write,MultiEdit,Bash"/,
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
