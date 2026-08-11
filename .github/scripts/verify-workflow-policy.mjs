import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const REQUIRED_WORKFLOWS = [
  "auto-merge.yml",
  "blocker-reconciler.yml",
  "claude-issue-review.yml",
  "claude-pr-review.yml",
  "codex-worker.yml",
  "docs-ci.yml",
  "pr-agent-review.yml",
  "pr-gates.yml",
];
const FULL_SHA_ACTION = /^[^@]+@[0-9a-f]{40}$/;
const CLAUDE_ACTION = "anthropics/claude-code-action@";
const CLAUDE_SECRETS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_REVIEW_MODEL",
];
const CODEX_ACTION =
  "openai/codex-action@dd78cb653811af44014baa08fe954e28d32c1bf9";
const UPLOAD_ARTIFACT_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const PR_AGENT_ACTION =
  "The-PR-Agent/pr-agent@f6af7d77554ff8d26adffded077e6461329e92fa";
const PR_AGENT_SECRETS = [
  "PR_AGENT_API_KEY",
  "PR_AGENT_API_BASE",
  "PR_AGENT_MODEL",
];
const TEAM_MEMBERSHIP_TOKEN_ACTION =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";

function workflowSteps(workflow) {
  return Object.values(workflow?.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function sameObject(actual, expected) {
  return JSON.stringify(Object.entries(actual ?? {}).sort()) ===
    JSON.stringify(Object.entries(expected).sort());
}

function referencedSecrets(value) {
  return [...JSON.stringify(value ?? {}).matchAll(/secrets\.([A-Z0-9_]+)/gi)].map(
    (match) => match[1],
  );
}

function teamMembershipTokenReferences(value) {
  return JSON.stringify(value ?? {}).match(
    /steps\.team-membership-token\.outputs\.token/g,
  ) ?? [];
}

function gatePublisherTokenReferences(value) {
  return JSON.stringify(value ?? {}).match(
    /steps\.gate-publisher-token\.outputs\.token/g,
  ) ?? [];
}

function isApprovedClaudeConfigStep(workflowName, jobName, step) {
  return (
    step.id === "validate-config" &&
    step.run === "node .github/scripts/validate-claude-review-config.mjs" &&
    ((workflowName === "claude-pr-review.yml" && jobName === "analyze") ||
      (workflowName === "claude-issue-review.yml" &&
        [
          "automatic-issue-review",
          "mentions",
          "analyze-blocker-review",
        ].includes(jobName)))
  );
}

function validateStepSecrets(errors, workflowName, jobName, step) {
  for (const secret of referencedSecrets(step)) {
    const occurrences = referencedSecrets(step).filter(
      (reference) => reference === secret,
    ).length;
    if (CLAUDE_SECRETS.includes(secret)) {
      const reference = `\${{ secrets.${secret} }}`;
      const allowedConfig =
        isApprovedClaudeConfigStep(workflowName, jobName, step) &&
        step.env?.[secret] === reference &&
        occurrences === 1;
      const allowedAction =
        step.uses?.startsWith(CLAUDE_ACTION) &&
        occurrences === 1 &&
        ((secret === "ANTHROPIC_API_KEY" &&
          step.with?.anthropic_api_key === reference) ||
          (secret === "ANTHROPIC_BASE_URL" && step.env?.ANTHROPIC_BASE_URL === reference) ||
          (secret === "CLAUDE_REVIEW_MODEL" &&
            step.with?.claude_args?.includes(`--model "${reference}"`)));
      if (!allowedConfig && !allowedAction) {
        errors.push(
          `${workflowName}/${jobName}: ${secret} is allowed only in approved Claude configuration or Action inputs`,
        );
      }
      continue;
    }
    if (secret === "CODEX_API_KEY") {
      if (
        workflowName !== "codex-worker.yml" ||
        jobName !== "implement" ||
        step.uses !== CODEX_ACTION ||
        step.with?.["openai-api-key"] !== "${{ secrets.CODEX_API_KEY }}" ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: CODEX_API_KEY is allowed only in the pinned official Codex Action`,
        );
      }
      continue;
    }
    if (
      ["CODEX_RESPONSES_API_ENDPOINT", "CODEX_MODEL", "CODEX_EFFORT"].includes(
        secret,
      )
    ) {
      const reference = `\${{ secrets.${secret} }}`;
      const actionInput = {
        CODEX_RESPONSES_API_ENDPOINT: "responses-api-endpoint",
        CODEX_MODEL: "model",
        CODEX_EFFORT: "effort",
      }[secret];
      const allowedPrepare =
        workflowName === "codex-worker.yml" &&
        jobName === "prepare" &&
        step.name === "Prepare trusted Worker plan" &&
        step.run === "node trusted/.github/scripts/codex-worker.mjs prepare" &&
        step.env?.[secret] === reference &&
        occurrences === 1;
      const allowedAction =
        workflowName === "codex-worker.yml" &&
        jobName === "implement" &&
        step.uses === CODEX_ACTION &&
        step.with?.[actionInput] === reference &&
        occurrences === 1;
      if (!allowedPrepare && !allowedAction) {
        errors.push(
          `${workflowName}/${jobName}: ${secret} is allowed only in fixed Codex Worker inputs`,
        );
      }
      continue;
    }
    if (secret === "CODEX_GITHUB_TOKEN") {
      const allowedPublication =
        workflowName === "codex-worker.yml" &&
        jobName === "publish" &&
        step.name === "Publish fixed branch and Draft PR" &&
        step.run === "node trusted/.github/scripts/codex-worker.mjs publish";
      const allowedBaseUpdate =
        workflowName === "codex-worker.yml" &&
        jobName === "base-update" &&
        step.name === "Update clean Worker PR branches" &&
        step.run === "node trusted/.github/scripts/codex-worker.mjs update-bases";
      const allowedRetryDispatch =
        workflowName === "codex-worker.yml" &&
        jobName === "publish" &&
        step.name === "Dispatch next model attempt" &&
        step.run === "node trusted/.github/scripts/codex-worker.mjs dispatch-retry";
      if (
        (!allowedPublication && !allowedBaseUpdate && !allowedRetryDispatch) ||
        step.env?.CODEX_GITHUB_TOKEN !== "${{ secrets.CODEX_GITHUB_TOKEN }}" ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: CODEX_GITHUB_TOKEN is allowed only in fixed Worker publisher steps`,
        );
      }
      continue;
    }
    if (secret === "GH_TOKEN") {
      if (
        workflowName !== "auto-merge.yml" ||
        jobName !== "enroll" ||
        step.name !== "Enable native Squash auto-merge" ||
        step.run !== "node .github/scripts/auto-merge.mjs" ||
        step.env?.GITHUB_TOKEN !== "${{ secrets.GH_TOKEN }}" ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: GH_TOKEN is allowed only in the fixed Auto-merge Enrollment step`,
        );
      }
      continue;
    }
    if (PR_AGENT_SECRETS.includes(secret)) {
      const reference = `\${{ secrets.${secret} }}`;
      const envName = {
        PR_AGENT_API_KEY: "OPENAI__KEY",
        PR_AGENT_API_BASE: "OPENAI__API_BASE",
        PR_AGENT_MODEL: "config.model",
      }[secret];
      if (
        workflowName !== "pr-agent-review.yml" ||
        jobName !== "analyze" ||
        step.uses !== PR_AGENT_ACTION ||
        step.env?.[envName] !== reference ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: ${secret} is allowed only in the pinned PR-Agent Action`,
        );
      }
      continue;
    }
    if (
      ["TEAM_MEMBERSHIP_APP_ID", "TEAM_MEMBERSHIP_APP_PRIVATE_KEY"].includes(secret)
    ) {
      const reference = `\${{ secrets.${secret} }}`;
      const input = {
        TEAM_MEMBERSHIP_APP_ID: "app-id",
        TEAM_MEMBERSHIP_APP_PRIVATE_KEY: "private-key",
      }[secret];
      const allowedMembershipLocation =
        step.id === "team-membership-token" &&
        ((workflowName === "pr-gates.yml" && jobName === "gates") ||
          (workflowName === "codex-worker.yml" && jobName === "authorization"));
      const allowedGatePublisherLocation =
        step.id === "gate-publisher-token" &&
        ((workflowName === "pr-gates.yml" && jobName === "gates") ||
          (workflowName === "claude-pr-review.yml" && jobName === "publish"));
      if (
        (!allowedMembershipLocation && !allowedGatePublisherLocation) ||
        step.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
        step.with?.[input] !== reference ||
        step.with?.owner !== "${{ github.repository_owner }}" ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: ${secret} is allowed only in fixed control App token steps`,
        );
      }
      continue;
    }
    errors.push(`${workflowName}/${jobName}: Secret ${secret} is not allowlisted`);
  }
}

export function validateTrustedScriptSources(sources) {
  const errors = [];
  const combined = Object.values(sources ?? {}).join("\n");
  if (combined.includes("/statuses/")) {
    errors.push("Gate publishers must not use legacy statuses");
  }
  const gateSource = sources?.["pr-gates.mjs"] ?? "";
  const reviewSource = sources?.["claude-review.mjs"] ?? "";
  const prAgentReviewSource = sources?.["pr-agent-review.mjs"] ?? "";
  const contractSource = sources?.["check-run-contract.mjs"] ?? "";
  const workerSource = sources?.["codex-worker.mjs"] ?? "";
  const resilienceSource = sources?.["worker-resilience.mjs"] ?? "";
  const workerContractSource = sources?.["worker-contract.mjs"] ?? "";
  const blockerContractSource = sources?.["blocker-contract.mjs"] ?? "";
  const blockerReconcilerSource = sources?.["blocker-reconciler.mjs"] ?? "";
  const claudeAuthorizationSource =
    sources?.["claude-event-authorization.mjs"] ?? "";
  const gateRequirements = [
    "/check-runs",
    'tokenEnvironment: "GATE_CHECK_TOKEN"',
    "return gateCheckRequest(`/repos/${repository}/check-runs`,",
    "await gateCheckRequest(`/repos/${repository}/check-runs/${check.id}`,",
    "headSha: pr.head.sha",
    '"Issue Gate"',
    '"Issue Readiness Gate"',
    '"Human Validation Gate"',
    '"Claude Review Gate"',
    'blockerStatus(blocker) !== "completed"',
  ];
  const reviewRequirements = [
    "/check-runs",
    'tokenEnvironment: "GATE_CHECK_TOKEN"',
    "return gateCheckRequest(`/repos/${repository}/check-runs`,",
    "await gateCheckRequest(`/repos/${repository}/check-runs/${check.id}`,",
    "head_sha: expectedHead",
    "assertCurrentReviewTarget(pr, expectedHead)",
    "reviewGateOutcome(blocking)",
  ];
  const contractRequirements = [
    "GITHUB_ACTIONS_APP_ID",
    "GATE_PUBLISHER_APP_ID = 4_503_079",
    "check.head_sha === headSha",
    "check.external_id === externalId",
  ];
  if (
    gateRequirements.some((requirement) => !gateSource.includes(requirement)) ||
    reviewRequirements.some((requirement) => !reviewSource.includes(requirement)) ||
    contractRequirements.some((requirement) => !contractSource.includes(requirement))
  ) {
    errors.push("Gate publishers must bind Check Runs to current heads");
  }
  const prAgentReviewRequirements = [
    "parsePrAgentEvent(",
    "parsePrAgentOutput(",
    "validatePrAgentLocations(",
    "assertCurrentPrAgentTarget(await githubRequest(prPath), expectedHead)",
    "sanitizeMarkdown(",
    "/issues/${prNumber}/comments",
  ];
  if (
    prAgentReviewRequirements.some(
      (requirement) => !prAgentReviewSource.includes(requirement),
    )
  ) {
    errors.push("PR-Agent Publisher must validate output and the current PR head");
  }
  const workerAuthorizationRequirements = [
    "authorizeCycle({",
    "parseAuthorizationRecords(",
    'if (command === "authorize") return authorizeCommand();',
    "codex/issue-${issueNumber}-cycle-${issueState.authorizationRecord.cycle}",
  ];
  const workerContractRequirements = [
    'EXECUTION_CONTENT_VERSION = "execution-content-v1"',
    'hash: createHash("sha256").update(preimage, "utf8").digest("hex")',
    'version: "blocked-by-v1"',
    "blockedByHash",
    "performed_via_github_app?.id === GITHUB_ACTIONS_APP_ID",
    "validateAcceptanceCriteriaEvidence",
  ];
  if (
    workerAuthorizationRequirements.some(
      (requirement) => !workerSource.includes(requirement),
    ) ||
    workerContractRequirements.some(
      (requirement) => !workerContractSource.includes(requirement),
    )
  ) {
    errors.push("Codex Worker must bind authorization, cycle, hash, and AC evidence");
  }
  if (
    !/async function authorizeCommand\(\)[\s\S]{0,1500}if \(eventName === "workflow_run"\) \{\s+await writeOutput\("allowed", true\);\s+return;\s+\}/.test(
      workerSource,
    )
  ) {
    errors.push("Codex Worker workflow recovery must pass authorization");
  }
  const claudeRecoveryRequirements = [
    "readReviewRecoveryTarget({ repository, run })",
    "target.source_run_id !== run.id",
    "target.repository !== repository",
    "reviewGateReason(checks.check_runs, sourceHeadSha)",
    "reviewComments",
  ];
  const claudeFindingRequirements = [
    "GITHUB_ACTIONS_BOT_ID = 41_898_282",
    "comment.user?.id !== GITHUB_ACTIONS_BOT_ID",
    "comment.original_commit_id !== headSha",
    "agent-infra-claude-review:${headSha}",
    'comment.user?.login !== "github-actions[bot]"',
    'comment.user?.type !== "Bot"',
    'reason: "claude_findings_unavailable"',
  ];
  if (
    claudeRecoveryRequirements.some(
      (requirement) => !workerSource.includes(requirement),
    ) ||
    claudeFindingRequirements.some(
      (requirement) => !resilienceSource.includes(requirement),
    )
  ) {
    errors.push(
      "Claude recovery context must stay source-head and GitHub-Actions-authored",
    );
  }
  if (
    !/async function retryCiCommand\(\)[\s\S]{0,2500}await publishPullRequestRecoveryRecord\(\{ record, repository, token \}\);[\s\S]{0,500}\/rerun-failed-jobs/.test(
      workerSource,
    )
  ) {
    errors.push("CI retry audit must precede rerun dispatch");
  }
  const blockerContractRequirements = [
    "validateBlockerProposals",
    "assertCanAddBlockers",
    "latestBlockerStateRecord",
    "isTrustedBlockerReviewComment",
  ];
  const blockerReconcilerRequirements = [
    "reconciliationIssueNumbers(graph)",
    "classifyDependentBlockers(graph, issueNumber)",
    'event_type: "codex-worker"',
    "blocker_state_signature: state.signature",
  ];
  const blockerWorkerRequirements = [
    "workerResultOperation(validated.result)",
    'if (command === "blockers") return blockersCommand();',
    'if (command === "handoffs") return handoffsCommand();',
    "publishHumanHandoffs({ plan, result, token })",
  ];
  if (
    blockerContractRequirements.some(
      (requirement) => !blockerContractSource.includes(requirement),
    ) ||
    blockerReconcilerRequirements.some(
      (requirement) => !blockerReconcilerSource.includes(requirement),
    ) ||
    blockerWorkerRequirements.some(
      (requirement) => !workerSource.includes(requirement),
    ) ||
    !claudeAuthorizationSource.includes("authorizeBlockerReviewDispatch") ||
    !claudeAuthorizationSource.includes("hasTrustedBlockerReviewAck")
  ) {
    errors.push("Blocker automation must preserve bounded proposals and signed reconciliation");
  }
  const reviewHeadRechecks =
    reviewSource.match(/await requireCurrentReviewTarget\(\{/g) ?? [];
  if (
    reviewHeadRechecks.length < 4 ||
    !reviewSource.includes("reviewSummaryMarker(result.head_sha)") ||
    !reviewSource.includes("reviewSummaryMarker(expectedHead)")
  ) {
    errors.push("Claude publisher must isolate and recheck each Review head");
  }
  if (
    /affected\.map\(async \(pr\) => \{[\s\S]{0,500}setPendingChecks\(repository, pr\)[\s\S]{0,500}\/dispatches/.test(
      gateSource,
    )
  ) {
    errors.push("Issue dispatch must not orphan pending Check Runs");
  }
  if (
    !/const checks = await setPendingChecks\(repository, pr\);\s+try\s*\{\s+await evaluatePullRequestWithChecks/.test(
      gateSource,
    ) ||
    !/evaluatePullRequestWithChecks\([\s\S]{0,200}requiredEnvironment\("TEAM_MEMBERSHIP_TOKEN"\);/.test(
      gateSource,
    ) ||
    !gateSource.includes('"PR Gate evaluation failed closed"')
  ) {
    errors.push("PR Gates must fail closed when Team membership is unavailable");
  }
  return errors;
}

export function validateWorkflowDocuments(workflows) {
  const errors = [];
  const names = Object.keys(workflows).sort();
  if (names.join("\0") !== REQUIRED_WORKFLOWS.join("\0")) {
    errors.push(`Expected workflows: ${REQUIRED_WORKFLOWS.join(", ")}`);
  }

  for (const [name, workflow] of Object.entries(workflows)) {
    if (!workflow.permissions) errors.push(`${name} must declare top-level permissions`);
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      for (const secret of referencedSecrets(job.env)) {
        errors.push(`${name}/${jobName}: ${secret} is not allowed in job environment`);
      }
      if (teamMembershipTokenReferences(job.env).length > 0) {
        errors.push(
          `${name}/${jobName}: Team membership token is allowed only in fixed Gate steps`,
        );
      }
      if (gatePublisherTokenReferences(job.env).length > 0) {
        errors.push(
          `${name}/${jobName}: Gate publisher token is allowed only in fixed Check Run steps`,
        );
      }
      for (const step of job.steps ?? []) {
        if (step.uses && !step.uses.startsWith("./") && !FULL_SHA_ACTION.test(step.uses)) {
          errors.push(`${name}: third-party Actions must use a full commit SHA`);
        }
        validateStepSecrets(errors, name, jobName, step);
        const tokenReferences = teamMembershipTokenReferences(step);
        const allowedTeamMembershipToken =
          tokenReferences.length === 1 &&
          step.env?.TEAM_MEMBERSHIP_TOKEN ===
            "${{ steps.team-membership-token.outputs.token }}" &&
          ((name === "pr-gates.yml" &&
            jobName === "gates" &&
            step.name === "Evaluate Issue, readiness, and human validation gates" &&
            step.run === "node .github/scripts/pr-gates.mjs") ||
            (name === "codex-worker.yml" &&
              jobName === "authorization" &&
              step.name === "Record trusted authorization transition" &&
              step.run === "node trusted/.github/scripts/codex-worker.mjs authorize"));
        if (tokenReferences.length > 0 && !allowedTeamMembershipToken) {
          errors.push(
            `${name}/${jobName}: Team membership token is allowed only in fixed Gate steps`,
          );
        }
        const gateTokenReferences = gatePublisherTokenReferences(step);
        const allowedGatePublisherToken =
          gateTokenReferences.length === 1 &&
          step.env?.GATE_CHECK_TOKEN ===
            "${{ steps.gate-publisher-token.outputs.token }}" &&
          ((name === "pr-gates.yml" &&
            jobName === "gates" &&
            step.name === "Evaluate Issue, readiness, and human validation gates" &&
            step.run === "node .github/scripts/pr-gates.mjs") ||
            (name === "claude-pr-review.yml" &&
              jobName === "publish" &&
              step.name === "Publish validated Review result" &&
              step.run === "node .github/scripts/claude-review.mjs"));
        if (gateTokenReferences.length > 0 && !allowedGatePublisherToken) {
          errors.push(
            `${name}/${jobName}: Gate publisher token is allowed only in fixed Check Run steps`,
          );
        }
      }
    }
    for (const secret of referencedSecrets(workflow.env)) {
      errors.push(`${name}: ${secret} is not allowed in workflow environment`);
    }
    if (teamMembershipTokenReferences(workflow.env).length > 0) {
      errors.push(`${name}: Team membership token is allowed only in fixed Gate steps`);
    }
    if (gatePublisherTokenReferences(workflow.env).length > 0) {
      errors.push(`${name}: Gate publisher token is allowed only in fixed Check Run steps`);
    }
  }

  for (const [name, workflow] of Object.entries(workflows)) {
    if (!workflow.on?.pull_request_target) continue;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (/pull_request\.head\.(?:ref|sha)/.test(JSON.stringify(job))) {
        errors.push(`${name}/${jobName}: pull_request_target jobs must not execute PR head`);
      }
      for (const checkout of (job.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      )) {
        const workerRecordedCheckout =
          name === "codex-worker.yml" &&
          checkout.name === "Checkout recorded start commit" &&
          checkout.with?.path === "workspace" &&
          checkout.with?.["persist-credentials"] === false &&
          [
            "${{ needs.prepare.outputs.start_sha }}",
          ].includes(checkout.with?.ref);
        if (
          !workerRecordedCheckout &&
          (checkout.with?.ref !== "${{ github.event.repository.default_branch }}" ||
            checkout.with?.["persist-credentials"] !== false)
        ) {
          errors.push(
            `${name}/${jobName}: pull_request_target checkout must use the trusted default branch`,
          );
        }
      }
    }
  }

  const prGates = workflows["pr-gates.yml"];
  if (
    JSON.stringify(prGates?.on?.issue_comment?.types) !==
      JSON.stringify(["created", "edited", "deleted"])
  ) {
    errors.push("PR Gates must reevaluate created, edited, and deleted audit commands");
  }
  const dispatchGates = prGates?.jobs?.["dispatch-issue-update"];
  if (
    JSON.stringify(prGates?.on?.issues?.types) !==
      JSON.stringify(["closed", "edited", "reopened", "labeled", "unlabeled"]) ||
    !String(dispatchGates?.if ?? "").includes("github.event_name == 'issue_comment'") ||
    !String(dispatchGates?.if ?? "").includes("!github.event.issue.pull_request")
  ) {
    errors.push("PR Gates must immediately reevaluate Issue content and authorization records");
  }
  if (
    JSON.stringify(prGates?.on?.schedule) !==
      JSON.stringify([{ cron: "*/15 * * * *" }]) ||
    !String(dispatchGates?.if ?? "").includes("github.event_name == 'schedule'")
  ) {
    errors.push("PR Gates must reconcile live Team membership every 15 minutes");
  }
  const expectedGatePermissions = {
    "dispatch-issue-update": {
      contents: "write",
      "pull-requests": "read",
    },
    gates: {
      checks: "read",
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    },
  };
  for (const [jobName, permissions] of Object.entries(expectedGatePermissions)) {
    if (!sameObject(prGates?.jobs?.[jobName]?.permissions, permissions)) {
      errors.push("PR Gates must use minimal Check Run permissions");
    }
  }
  const gates = prGates?.jobs?.gates;
  const gateSteps = gates?.steps ?? [];
  const membershipTokenStep = gateSteps.find(
    (step) => step.id === "team-membership-token",
  );
  const gatePublisherTokenStep = gateSteps.find(
    (step) => step.id === "gate-publisher-token",
  );
  const evaluateGatesStep = gateSteps.find(
    (step) => step.name === "Evaluate Issue, readiness, and human validation gates",
  );
  const gatesCondition = String(gates?.if ?? "");
  if (
    !gatesCondition.includes("github.event_name != 'issues'") ||
    !gatesCondition.includes("github.event_name != 'schedule'") ||
    !gatesCondition.includes("github.event_name != 'issue_comment'") ||
    !gatesCondition.includes("github.event.issue.pull_request") ||
    membershipTokenStep?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
    membershipTokenStep?.["continue-on-error"] !== true ||
    !sameObject(membershipTokenStep?.with, {
      "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
      "permission-members": "read",
      "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
    }) ||
    gatePublisherTokenStep?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
    !sameObject(gatePublisherTokenStep?.with, {
      "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
      "permission-checks": "write",
      "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
    }) ||
    evaluateGatesStep?.run !== "node .github/scripts/pr-gates.mjs" ||
    evaluateGatesStep?.if !== "always()" ||
    !sameObject(evaluateGatesStep?.env, {
      GATE_CHECK_TOKEN: "${{ steps.gate-publisher-token.outputs.token }}",
      GITHUB_TOKEN: "${{ github.token }}",
      TEAM_MEMBERSHIP_TOKEN: "${{ steps.team-membership-token.outputs.token }}",
    }) ||
    teamMembershipTokenReferences(prGates).length !== 1 ||
    gatePublisherTokenReferences(prGates).length !== 1
  ) {
    errors.push("PR Gates must mint and isolate a Team membership token");
  }
  if (gatePublisherTokenStep?.["continue-on-error"] === true) {
    errors.push("Gate publisher token mint must fail the workflow");
  }

  const worker = workflows["codex-worker.yml"];
  const authorization = worker?.jobs?.authorization;
  const prepare = worker?.jobs?.prepare;
  const implement = worker?.jobs?.implement;
  const publish = worker?.jobs?.publish;
  const workerGroup = String(worker?.concurrency?.group ?? "");
  const workerCancellation = String(worker?.concurrency?.["cancel-in-progress"] ?? "");
  const workerText = JSON.stringify(worker ?? {});
  if (
    /git\s+push[^"\n]*(?:--force(?:-with-lease)?|\s-f(?:\s|$))/i.test(workerText) ||
    /\bgh\s+pr\s+merge\b|\bmergePullRequest\b|\/merges\b/i.test(workerText)
  ) {
    errors.push("Codex Worker must not force-push or directly merge");
  }
  if (
    JSON.stringify(worker?.on?.issues?.types) !==
      JSON.stringify(["closed", "edited", "reopened", "labeled", "unlabeled"])
  ) {
    errors.push("Codex Worker must record authorization-invalidating Issue edits");
  }
  if (
    JSON.stringify(worker?.on?.repository_dispatch?.types) !==
      JSON.stringify(["codex-worker"])
  ) {
    errors.push("Codex Worker must accept only the fixed Reconciler dispatch event");
  }
  if (
    !sameObject(authorization?.permissions, {
      contents: "read",
      issues: "write",
    }) ||
    !sameObject(authorization?.concurrency, {
      group: "worker-authorization-${{ github.repository }}",
      "cancel-in-progress": false,
    }) ||
    prepare?.needs !== "authorization" ||
    prepare?.if !==
      "always() && needs.authorization.result == 'success' && needs.authorization.outputs.allowed != 'false'" ||
    authorization?.outputs?.allowed !== "${{ steps.authorize.outputs.allowed }}"
  ) {
    errors.push("Codex Worker authorization must be isolated before the model job");
  }
  const authorizationSteps = authorization?.steps ?? [];
  const authorizationToken = authorizationSteps.find(
    (step) => step.id === "team-membership-token",
  );
  const authorizationRecorder = authorizationSteps.find(
    (step) => step.name === "Record trusted authorization transition",
  );
  const authorizationTokenCondition = String(authorizationToken?.if ?? "");
  if (
    authorizationToken?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
    authorizationToken?.["continue-on-error"] !== true ||
    !authorizationTokenCondition.includes("github.event_name == 'issues'") ||
    !authorizationTokenCondition.includes("github.event.action == 'labeled'") ||
    !authorizationTokenCondition.includes("github.event.label.name == 'ready-for-agent'") ||
    !sameObject(authorizationToken?.with, {
      "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
      "permission-members": "read",
      "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
    }) ||
    authorizationRecorder?.run !==
      "node trusted/.github/scripts/codex-worker.mjs authorize" ||
    !sameObject(authorizationRecorder?.env, {
      GITHUB_TOKEN: "${{ github.token }}",
      TEAM_MEMBERSHIP_TOKEN: "${{ steps.team-membership-token.outputs.token }}",
    }) ||
    teamMembershipTokenReferences(worker).length !== 1
  ) {
    errors.push("Codex Worker must mint and isolate the authorization Team token");
  }
  if (
    !workerGroup.includes("github.event.pull_request.head.repo.full_name != github.repository") ||
    !workerGroup.includes("github.event.pull_request.number") ||
    !workerGroup.includes("github.event.pull_request.head.ref") ||
    !workerGroup.includes("github.event.issue.number") ||
    !workerGroup.includes("github.event.client_payload.issue_number")
  ) {
    errors.push("Codex Worker concurrency must isolate external fork PRs");
  }
  if (
    !workerGroup.includes("codex-worker-review-recovery") ||
    workerCancellation.includes("github.event_name == 'workflow_run'")
  ) {
    errors.push("Claude recovery concurrency must not cancel another PR");
  }
  if (
    !workerCancellation.includes("github.event.pull_request.head.repo.full_name") ||
    !workerCancellation.includes("github.repository") ||
    !workerCancellation.includes("github.event.client_payload.operation")
  ) {
    errors.push("Codex Worker cancellation must require a same-repository PR");
  }
  if (
    !sameObject(implement?.concurrency, {
      group: "codex-worker-model-slot-${{ needs.prepare.outputs.model_slot }}",
      "cancel-in-progress": false,
    })
  ) {
    errors.push("Codex Worker model concurrency must use one of two fixed slots");
  }
  const prAgent = workflows["pr-agent-review.yml"];
  const prAgentAnalyze = prAgent?.jobs?.analyze;
  const prAgentPublish = prAgent?.jobs?.publish;
  const prAgentAction = prAgentAnalyze?.steps?.find((step) => step.id === "pr-agent");
  const prAgentAnalyzeCheckout = prAgentAnalyze?.steps?.find(
    (step) => step.name === "Checkout trusted default branch",
  );
  const prAgentTarget = prAgentAnalyze?.steps?.find((step) => step.id === "target");
  const prAgentPublishSteps = prAgentPublish?.steps ?? [];
  const prAgentCheckout = prAgentPublishSteps.find(
    (step) => step.name === "Checkout trusted default branch",
  );
  const prAgentSetup = prAgentPublishSteps.find(
    (step) => step.name === "Set up Node.js",
  );
  const prAgentPublishStep = prAgentPublishSteps.find(
    (step) => step.name === "Publish validated PR-Agent review",
  );
  const prAgentConditions = [prAgentAnalyze?.if, prAgentPublish?.if].map(
    (condition) => String(condition ?? ""),
  );
  if (
    JSON.stringify(prAgent?.on?.pull_request_target?.types) !==
      JSON.stringify([
        "opened",
        "reopened",
        "synchronize",
        "ready_for_review",
        "review_requested",
      ]) ||
    !sameObject(prAgent?.permissions, {}) ||
    !sameObject(prAgent?.concurrency, {
      group: "pr-agent-review-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    }) ||
    prAgentConditions.some(
      (condition) =>
        !condition.includes("vars.PR_AGENT_ENABLED == 'true'") ||
        !condition.includes(
          "github.event.pull_request.head.repo.full_name == github.repository",
        ),
    ) ||
    !String(prAgentAnalyze?.if ?? "").includes("github.event.sender.type != 'Bot'") ||
    !String(prAgentAnalyze?.if ?? "").includes(
      "github.event.pull_request.draft == false",
    ) ||
    !String(prAgentPublish?.if ?? "").includes(
      "needs.analyze.result == 'success'",
    ) ||
    !sameObject(prAgentAnalyze?.permissions, {
      contents: "read",
      "pull-requests": "read",
    }) ||
    prAgentAnalyze?.outputs?.structured_output !==
      "${{ steps.pr-agent.outputs.review }}" ||
    prAgentAnalyze?.outputs?.expected_head !==
      "${{ steps.target.outputs.head_sha }}" ||
    prAgentAnalyze?.steps?.length !== 3 ||
    prAgentAnalyzeCheckout?.uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !sameObject(prAgentAnalyzeCheckout?.with, {
      ref: "${{ github.event.repository.default_branch }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    }) ||
    prAgentTarget?.run !== "node .github/scripts/pr-agent-review.mjs record" ||
    prAgentAction?.uses !== PR_AGENT_ACTION ||
    !sameObject(prAgentAction?.env, {
      GITHUB_TOKEN: "${{ github.token }}",
      OPENAI__KEY: "${{ secrets.PR_AGENT_API_KEY }}",
      OPENAI__API_BASE: "${{ secrets.PR_AGENT_API_BASE }}",
      "config.model": "${{ secrets.PR_AGENT_MODEL }}",
      "config.propagate_tool_errors": "true",
      "config.publish_output": "false",
      "config.publish_output_progress": "false",
      "config.use_repo_settings_file": "false",
      "config.use_wiki_settings_file": "false",
      "config.fallback_models": "[]",
      "config.custom_model_max_tokens":
        "${{ vars.PR_AGENT_MODEL_MAX_TOKENS || '128000' }}",
      "pr_reviewer.enable_review_labels_effort": "false",
      "pr_reviewer.enable_review_labels_security": "false",
      "pr_reviewer.num_max_findings": "10",
      "pr_reviewer.require_can_be_split_review": "false",
      "pr_reviewer.require_estimate_contribution_time_cost": "false",
      "pr_reviewer.require_estimate_effort_to_review": "false",
      "pr_reviewer.require_score_review": "false",
      "pr_reviewer.require_security_review": "false",
      "pr_reviewer.require_tests_review": "false",
      "pr_reviewer.require_ticket_analysis_review": "false",
      "pr_reviewer.require_todo_scan": "false",
      "github_action_config.auto_review": "true",
      "github_action_config.auto_describe": "false",
      "github_action_config.auto_improve": "false",
      "github_action_config.enable_output": "true",
      "github_action_config.pr_actions":
        '["opened", "reopened", "synchronize", "ready_for_review", "review_requested"]',
    }) ||
    prAgentPublish?.needs !== "analyze" ||
    !sameObject(prAgentPublish?.permissions, {
      contents: "read",
      issues: "write",
      "pull-requests": "read",
    }) ||
    prAgentCheckout?.uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !sameObject(prAgentCheckout?.with, {
      ref: "${{ github.event.repository.default_branch }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    }) ||
    prAgentSetup?.uses !==
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" ||
    prAgentSetup?.with?.["node-version"] !== 24 ||
    prAgentPublishStep?.run !== "node .github/scripts/pr-agent-review.mjs publish" ||
    !sameObject(prAgentPublishStep?.env, {
      EXPECTED_HEAD_SHA: "${{ needs.analyze.outputs.expected_head }}",
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      STRUCTURED_OUTPUT: "${{ needs.analyze.outputs.structured_output }}",
    })
  ) {
    errors.push(
      "PR-Agent Review must isolate the pinned analysis from validated publication",
    );
  }
  const implementText = JSON.stringify(implement ?? {});
  if (
    !sameObject(implement?.permissions, { actions: "read", contents: "read" }) ||
    /(?:CODEX_GITHUB_TOKEN|GATE_CHECK_TOKEN|TEAM_MEMBERSHIP_TOKEN|GH_TOKEN)/.test(
      implementText,
    )
  ) {
    errors.push("Codex Worker model job must stay read-only and isolated");
  }
  const baseUpdate = worker?.jobs?.["base-update"];
  if (
    JSON.stringify(worker?.on?.push?.branches) !== JSON.stringify(["main"]) ||
    JSON.stringify(worker?.on?.workflow_run?.workflows) !==
      JSON.stringify(["Docs CI", "Claude PR Review"]) ||
    JSON.stringify(worker?.on?.workflow_run?.types) !== JSON.stringify(["completed"]) ||
    baseUpdate?.if !== "github.event_name == 'push'" ||
    !sameObject(prepare?.permissions, {
      actions: "read",
      checks: "read",
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    }) ||
    !sameObject(baseUpdate?.permissions, {
      contents: "read",
      issues: "write",
      "pull-requests": "read",
    }) ||
    !sameObject(publish?.permissions, {
      actions: "write",
      checks: "read",
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    })
  ) {
    errors.push("Codex Worker recovery triggers and permissions must stay fixed");
  }
  if (implementText.includes("CODEX_GITHUB_TOKEN")) {
    errors.push("Codex Worker model job must not contain CODEX_GITHUB_TOKEN");
  }
  if (JSON.stringify(publish ?? {}).includes("CODEX_API_KEY")) {
    errors.push("Codex Worker publisher must not contain CODEX_API_KEY");
  }
  if (
    prepare?.outputs?.default_branch !==
    "${{ steps.prepare.outputs.default_branch }}"
  ) {
    errors.push("Codex Worker must expose a trusted default branch output");
  }

  const publishSteps = publish?.steps ?? [];
  const retryStep = publishSteps.find(
    (step) => step.name === "Dispatch next model attempt",
  );
  if (
    implement?.needs !== "prepare" ||
    retryStep?.run !== "node trusted/.github/scripts/codex-worker.mjs dispatch-retry" ||
    retryStep?.if !== "steps.preflight.outputs.operation == 'retry'" ||
    retryStep?.env?.CODEX_GITHUB_TOKEN !==
      "${{ secrets.CODEX_GITHUB_TOKEN }}" ||
    retryStep?.env?.GITHUB_TOKEN !== undefined
  ) {
    errors.push("Codex Worker retries must dispatch a fresh workflow run");
  }
  for (const stepName of [
    "Validate Artifact before publisher credential exposure",
    "Publish fixed branch and Draft PR",
  ]) {
    const step = publishSteps.find((candidate) => candidate.name === stepName);
    if (
      step?.env?.WORKER_DEFAULT_BRANCH !==
      "${{ needs.prepare.outputs.default_branch }}"
    ) {
      errors.push(`${stepName} must receive the trusted default branch input`);
    }
  }
  const publishStep = publishSteps.find(
    (step) => step.name === "Publish fixed branch and Draft PR",
  );
  const blockerStep = publishSteps.find(
    (step) => step.name === "Publish unprivileged blocker proposals",
  );
  const handoffStep = publishSteps.find(
    (step) => step.name === "Publish human handoff",
  );
  const escalationStep = publishSteps.find(
    (step) => step.name === "Escalate publisher failure",
  );
  if (
    !sameObject(publish?.concurrency, {
      group: "blocker-graph-${{ github.repository }}",
      "cancel-in-progress": false,
    }) ||
    !String(publishStep?.if ?? "").includes(
      "steps.preflight.outputs.operation == 'publish'",
    ) ||
    blockerStep?.run !== "node trusted/.github/scripts/codex-worker.mjs blockers" ||
    !String(blockerStep?.if ?? "").includes(
      "steps.preflight.outputs.operation == 'block'",
    ) ||
    blockerStep?.env?.GITHUB_TOKEN !== "${{ github.token }}" ||
    JSON.stringify(blockerStep ?? {}).includes("CODEX_GITHUB_TOKEN") ||
    !String(escalationStep?.if ?? "").includes("steps.blockers.outcome == 'failure'")
  ) {
    errors.push("Codex Worker blocker publication must stay unprivileged and serialized");
  }
  if (
    handoffStep?.run !== "node trusted/.github/scripts/codex-worker.mjs handoffs" ||
    !String(handoffStep?.if ?? "").includes(
      "steps.preflight.outputs.operation == 'handoff'",
    ) ||
    handoffStep?.env?.GITHUB_TOKEN !== "${{ github.token }}" ||
    JSON.stringify(handoffStep ?? {}).includes("CODEX_GITHUB_TOKEN") ||
    !String(escalationStep?.if ?? "").includes("steps.handoff.outcome == 'failure'")
  ) {
    errors.push(
      "Codex Worker human handoff publication must stay unprivileged and policy-locked",
    );
  }

  const planUpload = (prepare?.steps ?? []).find(
    (step) => step.name === "Upload trusted Worker plan",
  );
  if (
    planUpload?.uses !== UPLOAD_ARTIFACT_ACTION ||
    planUpload?.if !== "steps.prepare.outputs.operation == 'implement'" ||
    !sameObject(planUpload?.with, {
      name: "codex-worker-plan-${{ steps.prepare.outputs.worker_run_id }}-attempt-${{ steps.prepare.outputs.attempt }}",
      path:
        "${{ runner.temp }}/codex-worker-prepare/plan.json\n" +
        "${{ runner.temp }}/codex-worker-prepare/prompt.md\n" +
        "${{ runner.temp }}/codex-worker-prepare/result.schema.json\n",
      "if-no-files-found": "error",
      "include-hidden-files": true,
      "retention-days": 1,
    })
  ) {
    errors.push("Codex Worker Artifact allowlist must stay fixed");
  }

  const checkpointUpload = publishSteps.find(
    (step) => step.name === "Upload trusted Patch checkpoint",
  );
  if (
    checkpointUpload?.uses !== UPLOAD_ARTIFACT_ACTION ||
    checkpointUpload?.if !== "steps.preflight.outputs.checkpoint_created == 'true'" ||
    !sameObject(checkpointUpload?.with, {
      name: "codex-worker-checkpoint-${{ needs.prepare.outputs.worker_run_id }}-attempt-${{ needs.prepare.outputs.attempt }}",
      path:
        "${{ runner.temp }}/trusted-checkpoint/change.patch\n" +
        "${{ runner.temp }}/trusted-checkpoint/checkpoint.json\n",
      "if-no-files-found": "error",
      "include-hidden-files": true,
      "retention-days": 1,
    })
  ) {
    errors.push("Codex Worker Artifact allowlist must stay fixed");
  }
  const artifactPaths = workflowSteps(worker)
    .filter((step) => step.uses === UPLOAD_ARTIFACT_ACTION)
    .flatMap((step) => String(step.with?.path ?? "").split("\n"))
    .map((artifactPath) => artifactPath.trim())
    .filter(Boolean);
  if (
    artifactPaths.some(
      (artifactPath) =>
        /^\$\{\{ github\.workspace \}\}\/workspace\/?$/.test(artifactPath) ||
        /(?:codex[-_]?home|transcript|goal.*(?:db|sqlite)|session.*(?:db|sqlite)|git[-_]?credentials?)/i.test(
          artifactPath,
        ),
    )
  ) {
    errors.push("Codex Worker Artifacts must not persist session or workspace state");
  }

  const implementSteps = implement?.steps ?? [];
  const checkpointDownload = implementSteps.find(
    (step) => step.name === "Download previous trusted checkpoint",
  );
  if (
    checkpointDownload?.uses !== DOWNLOAD_ARTIFACT_ACTION ||
    checkpointDownload?.if !== "needs.prepare.outputs.checkpoint_run_id != ''" ||
    !sameObject(checkpointDownload?.with, {
      name: "${{ needs.prepare.outputs.checkpoint_artifact_name }}",
      path: "${{ runner.temp }}/codex-worker-checkpoint",
      "github-token": "${{ github.token }}",
      repository: "${{ github.repository }}",
      "run-id": "${{ needs.prepare.outputs.checkpoint_run_id }}",
    })
  ) {
    errors.push(
      "Codex Worker checkpoint download must bind the trusted source run and name",
    );
  }
  const reviewRecoverySteps =
    workflows["claude-pr-review.yml"]?.jobs?.publish?.steps ?? [];
  const reviewTargetStage = reviewRecoverySteps.find(
    (step) => step.name === "Stage trusted Review recovery target",
  );
  const reviewTargetUpload = reviewRecoverySteps.find(
    (step) => step.name === "Upload trusted Review recovery target",
  );
  const reviewTargetDownload = (prepare?.steps ?? []).find(
    (step) => step.name === "Download trusted Review recovery target",
  );
  const reviewTargetCondition = "steps.publish-review.outcome == 'success'";
  if (
    reviewTargetStage?.if !== reviewTargetCondition ||
    !String(reviewTargetStage?.run ?? "").includes(
      '> "$RUNNER_TEMP/claude-review-recovery.json"',
    ) ||
    reviewTargetUpload?.if !== reviewTargetCondition ||
    reviewTargetUpload?.uses !== UPLOAD_ARTIFACT_ACTION ||
    !sameObject(reviewTargetUpload?.with, {
      name: "claude-review-recovery-${{ github.run_id }}",
      path: "${{ runner.temp }}/claude-review-recovery.json",
      "if-no-files-found": "error",
      "retention-days": 1,
    }) ||
    reviewTargetDownload?.uses !== DOWNLOAD_ARTIFACT_ACTION ||
    !String(reviewTargetDownload?.if ?? "").includes(
      "github.event.workflow_run.name == 'Claude PR Review'",
    ) ||
    !String(reviewTargetDownload?.if ?? "").includes(
      "github.event.workflow_run.conclusion == 'success'",
    ) ||
    !sameObject(reviewTargetDownload?.with, {
      name: "claude-review-recovery-${{ github.event.workflow_run.id }}",
      path: "${{ runner.temp }}/claude-review-recovery",
      "github-token": "${{ github.token }}",
      repository: "${{ github.repository }}",
      "run-id": "${{ github.event.workflow_run.id }}",
    })
  ) {
    errors.push("Claude recovery target Artifact must stay source-run bound");
  }
  const codexIndex = implementSteps.findIndex((step) =>
    step.uses?.startsWith("openai/codex-action@"),
  );
  if (codexIndex < 0 || implementSteps[codexIndex].uses !== CODEX_ACTION) {
    errors.push("Codex Worker must use the pinned official Codex Action");
  } else {
    const codexInputs = implementSteps[codexIndex].with;
    if (
      !sameObject(codexInputs, {
        "openai-api-key": "${{ secrets.CODEX_API_KEY }}",
        "responses-api-endpoint": "${{ secrets.CODEX_RESPONSES_API_ENDPOINT }}",
        "prompt-file":
          "${{ github.workspace }}/workspace/.codex-worker-artifact/prompt.md",
        "output-file":
          "${{ github.workspace }}/workspace/.codex-worker-artifact/output/result.json",
        "output-schema-file":
          "${{ github.workspace }}/workspace/.codex-worker-artifact/result.schema.json",
        "working-directory": "${{ github.workspace }}/workspace",
        "codex-home": "${{ runner.temp }}/codex-home",
        "permission-profile": "github-worker",
        "codex-version": "0.146.0",
        model: "${{ secrets.CODEX_MODEL }}",
        effort: "${{ secrets.CODEX_EFFORT }}",
        "safety-strategy": "drop-sudo",
      })
    ) {
      errors.push("Codex Worker Codex Action inputs must stay fixed");
    }
    const afterCodex = implementSteps.slice(codexIndex + 1);
    if (
      afterCodex.length !== 1 ||
      afterCodex[0].uses !== UPLOAD_ARTIFACT_ACTION ||
      afterCodex[0].name !== "Upload fixed Worker Artifact"
    ) {
      errors.push("Codex Worker may only upload the fixed Artifact after Codex");
    }
    const upload = afterCodex[0];
    if (
      !sameObject(upload?.with, {
        name: "codex-worker-output-${{ needs.prepare.outputs.worker_run_id }}-attempt-${{ needs.prepare.outputs.attempt }}",
        path:
          "${{ github.workspace }}/workspace/.codex-worker-artifact/output/change.patch\n" +
          "${{ github.workspace }}/workspace/.codex-worker-artifact/output/result.json\n",
        "if-no-files-found": "error",
        "include-hidden-files": true,
        "retention-days": 1,
      })
    ) {
      errors.push("Codex Worker Artifact allowlist must stay fixed");
    }
  }
  const download = (publish?.steps ?? []).find(
    (step) => step.name === "Download fixed Worker Artifact",
  );
  if (download?.uses !== DOWNLOAD_ARTIFACT_ACTION) {
    errors.push("Codex Worker must use the pinned Artifact download Action");
  }
  if (
    !sameObject(download?.with, {
      name: "codex-worker-output-${{ needs.prepare.outputs.worker_run_id }}-attempt-${{ needs.prepare.outputs.attempt }}",
      path: "${{ runner.temp }}/codex-worker-output",
    })
  ) {
    errors.push("Codex Worker Artifact download contract must stay fixed");
  }

  for (const [jobName, job, expectedRef] of [
    ["base-update", baseUpdate, null],
    ["authorization", authorization, null],
    ["prepare", prepare, null],
    ["implement", implement, "${{ needs.prepare.outputs.start_sha }}"],
    ["publish", publish, "${{ needs.prepare.outputs.start_sha }}"],
  ]) {
    const trustedCheckout = (job?.steps ?? []).find(
      (step) => step.name === "Checkout trusted default branch",
    );
    if (
      trustedCheckout?.with?.ref !== "${{ github.event.repository.default_branch }}" ||
      trustedCheckout?.with?.path !== "trusted" ||
      trustedCheckout?.with?.["persist-credentials"] !== false
    ) {
      errors.push(`Codex Worker ${jobName} trusted checkout is invalid`);
    }
    const recordedCheckout = (job?.steps ?? []).find(
      (step) => step.name === "Checkout recorded start commit",
    );
    if (
      expectedRef !== null &&
      recordedCheckout?.with?.ref !== expectedRef ||
      (expectedRef !== null && recordedCheckout?.with?.path !== "workspace") ||
      (expectedRef !== null &&
        recordedCheckout?.with?.["persist-credentials"] !== false)
    ) {
      errors.push(`Codex Worker ${jobName} recorded checkout must use workspace`);
    }
  }

  const blockerReconciler = workflows["blocker-reconciler.yml"];
  const reconcileJob = blockerReconciler?.jobs?.reconcile;
  const reconcileSteps = reconcileJob?.steps ?? [];
  const reconcileCheckout = reconcileSteps.find(
    (step) => step.name === "Checkout trusted default branch",
  );
  const reconcileStep = reconcileSteps.find(
    (step) => step.name === "Reconcile trusted blocker state",
  );
  if (
    JSON.stringify(blockerReconciler?.on?.issues?.types) !==
      JSON.stringify(["opened", "edited", "closed", "reopened", "labeled", "unlabeled"]) ||
    JSON.stringify(blockerReconciler?.on?.schedule) !==
      JSON.stringify([{ cron: "*/15 * * * *" }]) ||
    !Object.hasOwn(blockerReconciler?.on ?? {}, "workflow_dispatch") ||
    !sameObject(blockerReconciler?.concurrency, {
      group: "blocker-graph-${{ github.repository }}",
      "cancel-in-progress": false,
    }) ||
    !sameObject(reconcileJob?.permissions, {
      contents: "write",
      issues: "write",
    }) ||
    reconcileCheckout?.with?.ref !== "${{ github.event.repository.default_branch }}" ||
    reconcileCheckout?.with?.["persist-credentials"] !== false ||
    reconcileStep?.run !== "node .github/scripts/blocker-reconciler.mjs" ||
    !sameObject(reconcileStep?.env, { GITHUB_TOKEN: "${{ github.token }}" })
  ) {
    errors.push("Blocker Reconciler must use fixed events, permissions, and serialization");
  }

  const review = workflows["claude-pr-review.yml"];
  const reviewTrigger = review?.on?.workflow_run;
  const reviewConcurrency = review?.concurrency;
  const reviewJobConditions = [review?.jobs?.analyze?.if, review?.jobs?.publish?.if].map(
    (condition) => String(condition ?? ""),
  );
  if (
    JSON.stringify(reviewTrigger?.workflows) !== JSON.stringify(["Docs CI"]) ||
    JSON.stringify(reviewTrigger?.types) !== JSON.stringify(["completed"]) ||
    reviewConcurrency?.group !==
      "claude-review-${{ github.event.workflow_run.pull_requests[0].number || github.run_id }}" ||
    reviewConcurrency?.["cancel-in-progress"] !== true ||
    reviewJobConditions.some(
      (condition) =>
        !condition.includes("github.event.workflow_run.conclusion == 'success'") ||
        !condition.includes("github.event.workflow_run.event == 'pull_request'") ||
        !condition.includes("github.event.workflow_run.pull_requests[0]"),
    )
  ) {
    errors.push("Claude PR Review trigger and concurrency must stay current-head bound");
  }
  const analyzeSteps = review?.jobs?.analyze?.steps ?? [];
  const reviewActionIndex = analyzeSteps.findIndex((step) => step.id === "claude");
  const reviewAction = analyzeSteps[reviewActionIndex];
  const reviewDataCheckout = analyzeSteps.find(
    (step) => step.name === "Checkout untrusted PR head as review data",
  );
  const reviewPublishSteps = review?.jobs?.publish?.steps ?? [];
  const reviewPublish = reviewPublishSteps.find(
    (step) => step.name === "Publish validated Review result",
  );
  const reviewGatePublisherToken = reviewPublishSteps.find(
    (step) => step.id === "gate-publisher-token",
  );
  if (
    reviewDataCheckout?.with?.ref !== "${{ github.event.workflow_run.head_sha }}" ||
    reviewDataCheckout?.with?.path !== "pr-head" ||
    reviewDataCheckout?.with?.["persist-credentials"] !== false ||
    reviewPublish?.run !== "node .github/scripts/claude-review.mjs" ||
    reviewGatePublisherToken?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
    !sameObject(reviewGatePublisherToken?.with, {
      "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
      "permission-checks": "write",
      "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
    }) ||
    !sameObject(reviewPublish?.env, {
      ANALYSIS_RESULT: "${{ needs.analyze.result }}",
      EXPECTED_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
      GATE_CHECK_TOKEN: "${{ steps.gate-publisher-token.outputs.token }}",
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ github.event.workflow_run.pull_requests[0].number }}",
      STRUCTURED_OUTPUT: "${{ needs.analyze.outputs.structured_output }}",
    }) ||
    !sameObject(review?.jobs?.publish?.permissions, {
      checks: "read",
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    }) ||
    gatePublisherTokenReferences(review).length !== 1
  ) {
    errors.push("Claude PR Review must publish only the completed CI head");
  }
  if (reviewGatePublisherToken?.["continue-on-error"] === true) {
    errors.push("Gate publisher token mint must fail the workflow");
  }
  const reviewConfigIndex = analyzeSteps.findIndex((step) => step.id === "validate-config");
  const reviewConfig = analyzeSteps[reviewConfigIndex];
  const reviewConfigEnv = reviewConfig?.env ?? {};
  if (
    reviewConfig?.run !== "node .github/scripts/validate-claude-review-config.mjs" ||
    Object.keys(reviewConfigEnv).sort().join("\0") !==
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_REVIEW_MODEL"]
        .sort()
        .join("\0") ||
    reviewConfigEnv.ANTHROPIC_API_KEY !== "${{ secrets.ANTHROPIC_API_KEY }}" ||
    reviewConfigEnv.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
    reviewConfigEnv.CLAUDE_REVIEW_MODEL !== "${{ secrets.CLAUDE_REVIEW_MODEL }}" ||
    reviewActionIndex !== reviewConfigIndex + 1 ||
    reviewAction?.env?.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
    reviewAction?.with?.show_full_output !==
      "${{ vars.CLAUDE_REVIEW_VERBOSE == 'true' }}" ||
    !reviewAction?.with?.claude_args?.includes(
      '--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"',
    )
  ) {
    errors.push("Claude PR Review model configuration must use validated Secrets");
  }
  const reviewPublisherSecrets = referencedSecrets(review?.jobs?.publish).sort();
  if (
    JSON.stringify(reviewPublisherSecrets) !==
    JSON.stringify([
      "TEAM_MEMBERSHIP_APP_ID",
      "TEAM_MEMBERSHIP_APP_PRIVATE_KEY",
    ])
  ) {
    errors.push(
      "Claude Review publisher may receive Secrets only in the fixed control App token step",
    );
  }
  const reviewPrompt = reviewAction?.with?.prompt ?? "";
  const reviewPromptRequirements = [
    "Before returning each finding, verify that it:",
    "is introduced by this PR on an added RIGHT-side or deleted LEFT-side diff line;",
    "does not depend on an unverified assumption.",
    "Do not report pre-existing issues, style or nitpicks, issues fully",
    "Discard every candidate that fails any check.",
  ];
  if (reviewPromptRequirements.some((requirement) => !reviewPrompt.includes(requirement))) {
    errors.push("Claude PR Review must validate and filter candidate findings");
  }
  const reviewArgs = reviewAction?.with?.claude_args ?? "";
  if (
    !reviewPrompt.includes("added RIGHT-side or deleted LEFT-side diff line") ||
    !reviewArgs.includes('"side":{"enum":["LEFT","RIGHT"]}') ||
    !reviewArgs.includes('"required":["severity","title","body","path","line","side"]')
  ) {
    errors.push("Claude PR Review must bind findings to LEFT or RIGHT diff lines");
  }
  const allowedToolFlags = reviewArgs.match(/--allowedTools\s+"[^"]*"/g) ?? [];
  const allowedToolOptions =
    reviewArgs.match(/--(?:allowedTools|allowed-tools)(?=\s|=|$)/g) ?? [];
  const disallowedToolFlags = reviewArgs.match(/--disallowedTools\s+"[^"]*"/g) ?? [];
  const disallowedToolOptions =
    reviewArgs.match(/--(?:disallowedTools|disallowed-tools)(?=\s|=|$)/g) ?? [];
  if (
    JSON.stringify(allowedToolFlags) !==
      JSON.stringify([
        '--allowedTools "Read,Grep,Bash(gh pr diff:*),Bash(gh pr view:*)"',
      ]) ||
    JSON.stringify(allowedToolOptions) !== JSON.stringify(["--allowedTools"]) ||
    JSON.stringify(disallowedToolFlags) !==
      JSON.stringify([
        '--disallowedTools "Glob,Edit,Write,MultiEdit,WebFetch,WebSearch"',
      ]) ||
    JSON.stringify(disallowedToolOptions) !== JSON.stringify(["--disallowedTools"])
  ) {
    errors.push("Claude PR Review model must use bounded read-only tools");
  }

  const autoMerge = workflows["auto-merge.yml"];
  const enrollment = autoMerge?.jobs?.enroll;
  if (
    JSON.stringify(autoMerge?.on?.pull_request_target?.types) !==
      JSON.stringify(["opened", "reopened", "ready_for_review"]) ||
    autoMerge?.concurrency?.group !==
      "auto-merge-${{ github.event.pull_request.number }}" ||
    autoMerge?.concurrency?.["cancel-in-progress"] !== true
  ) {
    errors.push("Auto-merge Enrollment events and concurrency must stay fixed");
  }
  const enrollmentPermissions = Object.entries(enrollment?.permissions ?? {}).sort();
  if (
    JSON.stringify(enrollmentPermissions) !==
    JSON.stringify([
      ["contents", "read"],
    ])
  ) {
    errors.push("Auto-merge Enrollment permissions must stay minimal");
  }
  const enrollmentText = JSON.stringify(enrollment ?? {});
  if (/\bgh pr merge\b|\bmergePullRequest\b|--admin/.test(enrollmentText)) {
    errors.push("Auto-merge Enrollment must only enroll native auto-merge");
  }
  if (
    !enrollmentText.includes("head.repo.full_name") ||
    !enrollmentText.includes("repository.default_branch") ||
    !enrollmentText.includes("node .github/scripts/auto-merge.mjs")
  ) {
    errors.push("Auto-merge Enrollment must restrict eligibility and use the fixed script");
  }
  const enrollmentStep = (enrollment?.steps ?? []).find(
    (step) => step.name === "Enable native Squash auto-merge",
  );
  if (
    enrollmentStep?.run !== "node .github/scripts/auto-merge.mjs" ||
    !sameObject(enrollmentStep?.env, {
      GITHUB_TOKEN: "${{ secrets.GH_TOKEN }}",
    })
  ) {
    errors.push("Auto-merge Enrollment must use the fixed repository Secret");
  }

  const issueReview = workflows["claude-issue-review.yml"];
  const blockerAuthorize = issueReview?.jobs?.["authorize-blocker-review"];
  const blockerAnalyze = issueReview?.jobs?.["analyze-blocker-review"];
  const blockerPublish = issueReview?.jobs?.["publish-blocker-review"];
  const blockerReviewAction = (blockerAnalyze?.steps ?? []).find((step) =>
    step.uses?.startsWith(CLAUDE_ACTION),
  );
  const blockerPublisher = (blockerPublish?.steps ?? []).find(
    (step) => step.name === "Publish validated blocker Review",
  );
  if (
    JSON.stringify(issueReview?.on?.repository_dispatch?.types) !==
      JSON.stringify(["claude-blocker-review"]) ||
    !String(issueReview?.concurrency?.group ?? "").includes(
      "github.event.client_payload.issue_number",
    ) ||
    issueReview?.concurrency?.["cancel-in-progress"] !== false ||
    !sameObject(blockerAuthorize?.permissions, {
      contents: "read",
      issues: "write",
    }) ||
    blockerAnalyze?.needs !== "authorize-blocker-review" ||
    blockerAnalyze?.if !==
      "needs.authorize-blocker-review.outputs.allowed == 'true'" ||
    !sameObject(blockerAnalyze?.permissions, {
      contents: "read",
      issues: "read",
    }) ||
    blockerReviewAction?.with?.track_progress !== "false" ||
    JSON.stringify(blockerPublish?.needs) !==
      JSON.stringify(["authorize-blocker-review", "analyze-blocker-review"]) ||
    !sameObject(blockerPublish?.permissions, {
      contents: "read",
      issues: "write",
    }) ||
    blockerPublisher?.run !== "node .github/scripts/claude-blocker-review.mjs" ||
    !sameObject(blockerPublisher?.env, {
      ANALYSIS_RESULT: "${{ needs.analyze-blocker-review.result }}",
      BLOCKER_ISSUE_NUMBER: "${{ github.event.client_payload.issue_number }}",
      GITHUB_TOKEN: "${{ github.token }}",
      STRUCTURED_OUTPUT:
        "${{ needs.analyze-blocker-review.outputs.structured_output }}",
    })
  ) {
    errors.push("Claude blocker Review must isolate authorization, analysis, and publication");
  }
  if (blockerReviewAction?.with?.allowed_bots !== "github-actions") {
    errors.push("Claude blocker Review must allow only the trusted github-actions dispatch actor");
  }
  for (const [jobName, job] of Object.entries(issueReview?.jobs ?? {})) {
    if (jobName === "mentions" && String(job.if ?? "").includes("endsWith")) {
      errors.push(
        "claude-issue-review.yml/mentions: App blocker review must reach the trusted authorizer",
      );
    }
    if (/contains\s*\(\s*fromJSON\([\s\S]*?author_association\s*\)/.test(job.if ?? "")) {
      errors.push(
        `claude-issue-review.yml/${jobName}: use explicit actor association comparisons`,
      );
    }
    if ((job.if ?? "").includes("author_association")) {
      errors.push(
        `claude-issue-review.yml/${jobName}: must authorize identity in a trusted step`,
      );
    }
    const authorizeIndex = (job.steps ?? []).findIndex(
      (step) =>
        step.id === "authorize" &&
        step.run === "node .github/scripts/claude-event-authorization.mjs",
    );
    const modelIndex = (job.steps ?? []).findIndex((step) =>
      step.uses?.startsWith(CLAUDE_ACTION),
    );
    const configIndex = (job.steps ?? []).findIndex((step) => step.id === "validate-config");
    const configStep = job.steps?.[configIndex];
    const modelStep = job.steps?.[modelIndex];
    const configEnv = configStep?.env ?? {};
    const splitBlockerReview = jobName === "analyze-blocker-review";
    if (
      modelIndex >= 0 &&
      !splitBlockerReview &&
      (authorizeIndex < 0 || authorizeIndex >= modelIndex)
    ) {
      errors.push(
        `claude-issue-review.yml/${jobName}: trusted authorization must run before model`,
      );
    }
    if (
      modelIndex >= 0 &&
      !splitBlockerReview &&
      modelStep.if !== "steps.authorize.outputs.allowed == 'true'"
    ) {
      errors.push(
        `claude-issue-review.yml/${jobName}: model step must use trusted authorization output`,
      );
    }
    if (
      modelIndex >= 0 &&
      (modelIndex !== configIndex + 1 ||
        (!splitBlockerReview && configIndex !== authorizeIndex + 1) ||
        (!splitBlockerReview &&
          configStep?.if !== "steps.authorize.outputs.allowed == 'true'") ||
        configStep?.run !== "node .github/scripts/validate-claude-review-config.mjs" ||
        Object.keys(configEnv).sort().join("\0") !==
          ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_REVIEW_MODEL"]
            .sort()
            .join("\0") ||
        configEnv.ANTHROPIC_API_KEY !== "${{ secrets.ANTHROPIC_API_KEY }}" ||
        configEnv.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
        configEnv.CLAUDE_REVIEW_MODEL !== "${{ secrets.CLAUDE_REVIEW_MODEL }}" ||
        modelStep?.env?.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
        !modelStep?.with?.claude_args?.includes(
          '--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"',
        ))
    ) {
      errors.push(
        `claude-issue-review.yml/${jobName}: model configuration must use validated Secrets`,
      );
    }
  }

  for (const [name, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const claudeSteps = (job.steps ?? []).filter((step) =>
        step.uses?.startsWith(CLAUDE_ACTION),
      );
      const scrubbingEnabled =
        job.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === "1" ||
        claudeSteps.some(
          (step) => step.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === "1",
        );
      if (claudeSteps.length && scrubbingEnabled) {
        errors.push(`${name}/${jobName}: must not enable subprocess env scrubbing`);
      }
      if (
        (name !== "claude-issue-review.yml" ||
          jobName !== "analyze-blocker-review") &&
        claudeSteps.some((step) => step.with?.allowed_bots !== undefined)
      ) {
        errors.push(
          `${name}/${jobName}: Bot allowlists are restricted to blocker Review dispatch`,
        );
      }
    }
  }

  for (const [jobName, job] of Object.entries(issueReview?.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith(CLAUDE_ACTION)) continue;
      const args = step.with?.claude_args ?? "";
      const expectedAllowed =
        jobName === "analyze-blocker-review"
          ? '--allowedTools "Read,Grep,Glob,Bash(gh issue view:*)"'
          : '--allowedTools "Read,Grep,Glob"';
      const expectedDisallowed =
        jobName === "analyze-blocker-review"
          ? '--disallowedTools "Edit,Write,MultiEdit,WebFetch,WebSearch"'
          : '--disallowedTools "Edit,Write,MultiEdit,Bash"';
      const unsafeBash =
        jobName === "analyze-blocker-review"
          ? /--allowedTools\s+"[^"]*\bBash(?!\(gh issue view:\*\))/.test(args)
          : /--allowedTools\s+"[^"]*\bBash\b/.test(args);
      if (
        !args.includes(expectedAllowed) ||
        !args.includes(expectedDisallowed) ||
        unsafeBash ||
        /--allowedTools\s+"[^"]*\b(?:Edit|Write)\b/.test(args)
      ) {
        errors.push("Issue Review model must stay read-only");
      }
    }
  }
  return errors;
}

async function main() {
  const directory = path.resolve(".github/workflows");
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".yml"));
  const workflows = Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        YAML.parse(await fs.readFile(path.join(directory, name), "utf8")),
      ]),
    ),
  );
  const scriptDirectory = path.resolve(".github/scripts");
  const scriptSources = Object.fromEntries(
    await Promise.all(
      [
        "blocker-contract.mjs",
        "blocker-reconciler.mjs",
        "check-run-contract.mjs",
        "claude-event-authorization.mjs",
        "claude-review.mjs",
        "codex-worker.mjs",
        "pr-agent-review.mjs",
        "pr-gates.mjs",
        "worker-contract.mjs",
        "worker-resilience.mjs",
      ].map(async (name) => [
        name,
        await fs.readFile(path.join(scriptDirectory, name), "utf8"),
      ]),
    ),
  );
  const errors = [
    ...validateWorkflowDocuments(workflows),
    ...validateTrustedScriptSources(scriptSources),
  ];
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Workflow policy: ${names.length} files valid`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
