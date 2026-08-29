import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";

const REQUIRED_WORKFLOWS = [
  "auto-merge.yml",
  "blocker-reconciler.yml",
  "ci.yml",
  "claude-issue-review.yml",
  "claude-pr-review.yml",
  "codex-worker.yml",
  "gh-aw-issue-to-pr-pilot.lock.yml",
  "pr-agent-review.yml",
  "pr-gates.yml",
  "workflow-outcome.yml",
];
const RUN_NAME_CONTRACTS = {
  "auto-merge.yml": {
    operation: "auto-merge",
    references: ["github.event.action", "github.event.pull_request.number"],
  },
  "blocker-reconciler.yml": {
    operation: "blocker-reconcile",
    references: [
      "github.event.action",
      "github.event.issue.number",
      "github.event_name",
    ],
  },
  "claude-issue-review.yml": {
    operation: "claude-issue-review",
    references: [
      "github.event.action",
      "github.event.client_payload.issue_number",
      "github.event.issue.number",
      "github.event.issue.pull_request",
      "github.event.pull_request.number",
      "github.event_name",
    ],
  },
  "claude-pr-review.yml": {
    operation: "claude-pr-review",
    references: [
      "github.event.workflow_run.id",
      "github.event.workflow_run.pull_requests[0].number",
    ],
  },
  "codex-worker.yml": {
    operation: "codex-worker",
    references: [
      "github.event.action",
      "github.event.client_payload.issue_number",
      "github.event.issue.number",
      "github.event.pull_request.number",
      "github.event.workflow_run.id",
      "github.event.workflow_run.pull_requests[0].number",
      "github.event_name",
    ],
  },
  "ci.yml": {
    operation: "ci",
    references: ["github.event.pull_request.number", "github.event_name"],
  },
  "pr-agent-review.yml": {
    operation: "pr-agent-review",
    references: ["github.event.action", "github.event.pull_request.number"],
  },
  "pr-gates.yml": {
    operation: "pr-gates",
    references: [
      "github.event.action",
      "github.event.client_payload.pr_number",
      "github.event.issue.number",
      "github.event.issue.pull_request",
      "github.event.pull_request.number",
      "github.event_name",
    ],
  },
  "workflow-outcome.yml": {
    operation: "workflow-outcome",
    references: [
      "github.event.workflow_run.id",
      "github.event.workflow_run.pull_requests[0].number",
    ],
  },
};
const SOURCE_OUTCOME_CONTRACTS = {
  "auto-merge.yml": {
    needs: ["enroll"],
    operation: "auto-merge",
  },
  "blocker-reconciler.yml": {
    needs: ["reconcile"],
    operation: "blocker-reconcile",
  },
  "claude-issue-review.yml": {
    needs: [
      "automatic-issue-review",
      "authorize-blocker-review",
      "analyze-blocker-review",
      "publish-blocker-review",
      "mentions",
    ],
    operation: "claude-issue-review",
  },
  "claude-pr-review.yml": {
    needs: ["analyze", "publish"],
    operation: "claude-pr-review",
  },
  "codex-worker.yml": {
    needs: ["base-update", "authorization", "prepare", "implement", "publish"],
    operation: "codex-worker",
  },
  "ci.yml": {
    needs: ["ci"],
    operation: "ci",
  },
  "pr-agent-review.yml": {
    needs: ["analyze", "suggestions"],
    operation: "pr-agent-review",
  },
  "pr-gates.yml": {
    needs: ["dispatch-issue-update", "gates"],
    operation: "pr-gates",
  },
};
const SOURCE_OUTCOME_ENV_KEYS = [
  "SUMMARY_ACTION",
  "SUMMARY_ATTEMPT",
  "SUMMARY_CYCLE",
  "SUMMARY_EVENT",
  "SUMMARY_HEAD_SHA",
  "SUMMARY_NEXT_OWNER",
  "SUMMARY_OPERATION",
  "SUMMARY_OUTCOME",
  "SUMMARY_TARGET",
  "SUMMARY_TARGET_URL",
];
const SOURCE_OUTCOME_NEXT_OWNER =
  "${{ (contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')) && 'repository-maintainer' || 'none' }}";
const SOURCE_OUTCOME_RESULT =
  "${{ contains(needs.*.result, 'failure') && 'failure' || contains(needs.*.result, 'cancelled') && 'cancelled' || contains(needs.*.result, 'success') && 'success' || 'skipped' }}";
const SOURCE_OUTCOME_SUMMARY = [
  "{",
  '  echo "## Workflow terminal outcome"',
  "  echo",
  '  echo "- Target: [$SUMMARY_TARGET]($SUMMARY_TARGET_URL)"',
  '  echo "- Run: [$GITHUB_RUN_ID]($GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID)"',
  '  echo "- Operation: \\`$SUMMARY_OPERATION\\`"',
  '  echo "- Event/action: \\`$SUMMARY_EVENT\\` / \\`$SUMMARY_ACTION\\`"',
  '  echo "- Head SHA: \\`$SUMMARY_HEAD_SHA\\`"',
  '  echo "- Cycle: ${SUMMARY_CYCLE:-N/A}"',
  '  echo "- Attempt: ${SUMMARY_ATTEMPT:-N/A}"',
  '  echo "- Terminal outcome: \\`$SUMMARY_OUTCOME\\`"',
  '  echo "- Next owner: \\`$SUMMARY_NEXT_OWNER\\`"',
  '} >> "$GITHUB_STEP_SUMMARY"',
  "",
].join("\n");
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
const CHECKOUT_ACTION =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const GH_AW_PILOT_SEMANTIC_SHA256 =
  "bfc18176cfe8ecb754df9d22a9fa45c83711b1c4e3179311e0c28a93df552cd1";
const GH_AW_PILOT_SOURCE_SHA256 =
  "2d71c379cc4fab3bb95b37242732bfc2590d3868959e8704545b333f19d7409a";
const GH_AW_PILOT_SCRIPT_SHA256 =
  "077817dad358bcc3c7e4877c3edcf37ce6e5ec8dade12e2f9cb6cebc60a943ac";
const MATT_SKILL_LOCK_PATH = ".agents/skills/mattpocock.lock.json";
const MATT_SKILL_SOURCE = "https://github.com/mattpocock/skills.git";
const MATT_SKILLS = ["code-review", "implement", "tdd"];
const MATT_SKILL_REVISION = "6654f6b60cd9d5be8b54c6fafe44346dabeb3b76";
const MATT_SKILL_TREES = {
  "code-review": "d8e341cee7980127dddda05159bedf25dc853615",
  implement: "f07d230f645fc9ac390cf13a450bbff12ad791a3",
  tdd: "79288be15c67b849f22b6572056601090fd20913",
};

function gitObjectSha(type, content) {
  return createHash("sha1")
    .update(`${type} ${content.length}\0`)
    .update(content)
    .digest();
}

async function gitTreeSha(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.name}${left.isDirectory() ? "/" : ""}`),
      Buffer.from(`${right.name}${right.isDirectory() ? "/" : ""}`),
    ),
  );
  const treeEntries = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    let mode;
    let sha;
    if (entry.isDirectory()) {
      mode = "40000";
      sha = await gitTreeSha(entryPath);
    } else if (entry.isFile()) {
      const [content, metadata] = await Promise.all([
        fs.readFile(entryPath),
        fs.stat(entryPath),
      ]);
      mode = metadata.mode & 0o111 ? "100755" : "100644";
      sha = gitObjectSha("blob", content);
    } else if (entry.isSymbolicLink()) {
      mode = "120000";
      sha = gitObjectSha("blob", Buffer.from(await fs.readlink(entryPath)));
    } else {
      throw new Error(`unsupported file type: ${entryPath}`);
    }
    treeEntries.push(
      Buffer.concat([
        Buffer.from(`${mode} ${entry.name}\0`),
        sha,
      ]),
    );
  }

  return gitObjectSha("tree", Buffer.concat(treeEntries));
}

export async function validateMattSkillSnapshot(repositoryRoot = process.cwd()) {
  const errors = [];
  let lock;
  try {
    lock = JSON.parse(
      await fs.readFile(path.join(repositoryRoot, MATT_SKILL_LOCK_PATH), "utf8"),
    );
  } catch (error) {
    return [
      `Matt Skill snapshot lock is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }

  if (
    lock?.version !== 1 ||
    lock?.source !== MATT_SKILL_SOURCE ||
    lock?.revision !== MATT_SKILL_REVISION ||
    JSON.stringify(Object.keys(lock?.skills ?? {}).sort()) !==
      JSON.stringify(MATT_SKILLS)
  ) {
    return ["Matt Skill snapshot lock has an invalid source contract"];
  }

  for (const skill of MATT_SKILLS) {
    const record = lock.skills[skill];
    if (
      record?.sourcePath !== `skills/engineering/${skill}` ||
      record?.treeSha !== MATT_SKILL_TREES[skill]
    ) {
      errors.push(`${skill}: invalid Matt Skill provenance`);
      continue;
    }
    try {
      const actual = (
        await gitTreeSha(path.join(repositoryRoot, ".agents/skills", skill))
      ).toString("hex");
      if (actual !== MATT_SKILL_TREES[skill]) {
        errors.push(
          `${skill}: snapshot tree ${actual} does not match ${MATT_SKILL_TREES[skill]}`,
        );
      }
    } catch (error) {
      errors.push(
        `${skill}: snapshot is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return errors;
}

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

function hasSingleFixedClaudeArgument(args, option, value) {
  if (typeof args !== "string") {
    return false;
  }
  const escapeRegExp = (input) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const optionPattern = `(?:^|\\s)${escapeRegExp(option)}`;
  const optionOccurrences = args.match(
    new RegExp(`${optionPattern}(?=\\s|=|$)`, "g"),
  ) ?? [];
  const fixedOccurrences = args.match(
    new RegExp(
      `${optionPattern}\\s+"${escapeRegExp(value)}"(?=\\s|$)`,
      "g",
    ),
  ) ?? [];
  return optionOccurrences.length === 1 && fixedOccurrences.length === 1;
}

function validateGhAwPilotWorkflow(workflow) {
  const errors = [];
  const semanticHash = createHash("sha256")
    .update(JSON.stringify(workflow))
    .digest("hex");
  const membership = workflow?.jobs?.pre_activation?.steps?.find(
    (step) => step.id === "check_membership",
  );
  const agent = workflow?.jobs?.agent;
  const pilotPreflight = workflow?.jobs?.pilot_preflight;
  const pilotPreflightSteps = pilotPreflight?.steps ?? [];
  const pilotAuthorizationCheckout = pilotPreflightSteps.find(
    (step) => step.name === "Checkout authorized pilot verifier",
  );
  const pilotToken = pilotPreflightSteps.find(
    (step) => step.id === "team-membership-token",
  );
  const pilotAuthorize = pilotPreflightSteps.find(
    (step) => step.name === "Authorize trusted pilot target",
  );
  const execution = agent?.steps?.find((step) => step.id === "agentic_execution");
  const redaction = agent?.steps?.find(
    (step) => step.name === "Redact secrets in logs",
  );
  const safeOutputs = workflow?.jobs?.safe_outputs;
  const pilotTrustedCheckout = safeOutputs?.steps?.find(
    (step) => step.name === "Checkout trusted pilot verifier",
  );
  const pilotRecheckToken = safeOutputs?.steps?.find(
    (step) => step.id === "pilot-recheck-team-token",
  );
  const pilotRecheck = safeOutputs?.steps?.find(
    (step) => step.name === "Recheck trusted pilot target",
  );
  const publisher = safeOutputs?.steps?.find(
    (step) => step.id === "process_safe_outputs",
  );
  let handlers;
  try {
    handlers = JSON.parse(publisher?.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG ?? "");
  } catch {
    handlers = null;
  }
  const pullRequest = handlers?.create_pull_request;
  const generateInfo = workflow?.jobs?.activation?.steps?.find(
    (step) => step.id === "generate_aw_info",
  );
  const secretReferences = [
    ...JSON.stringify(workflow ?? {}).matchAll(
      /\$\{\{\s*secrets(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g,
    ),
  ].map((match) => match[1] ?? match[2]);
  const expectedSecrets = [
    "CODEX_API_KEY",
    "CODEX_GITHUB_TOKEN",
    "CODEX_RESPONSES_API_ENDPOINT",
    "COPILOT_GITHUB_TOKEN",
    "GH_AW_GITHUB_MCP_SERVER_TOKEN",
    "GH_AW_GITHUB_TOKEN",
    "GITHUB_TOKEN",
    "TEAM_MEMBERSHIP_APP_ID",
    "TEAM_MEMBERSHIP_APP_PRIVATE_KEY",
  ];
  const secretCount = (value, secret) =>
    [
      ...JSON.stringify(value ?? {}).matchAll(
        new RegExp(
          `\\$\\{\\{\\s*secrets(?:\\.${secret}|\\[['\"]${secret}['\"]\\])\\s*\\}\\}`,
          "g",
        ),
      ),
    ].length;
  const allActionsPinned = workflowSteps(workflow).every(
    (step) =>
      !step.uses || step.uses.startsWith("./") || FULL_SHA_ACTION.test(step.uses),
  );
  const pilotActivationCondition =
    "github.actor == 'LichKing-2234' && github.triggering_actor == 'LichKing-2234' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";
  if (
    workflow?.name !== "gh-aw Copilot BYOK Issue-to-PR Pilot" ||
    workflow?.on?.issues !== undefined ||
    workflow?.on?.workflow_dispatch?.inputs?.item_number?.required !== true ||
    workflow?.on?.workflow_dispatch?.inputs?.item_number?.type !== "string" ||
    workflow?.on?.workflow_dispatch?.inputs?.execution_content_sha256?.required !==
      true ||
    workflow?.on?.workflow_dispatch?.inputs?.execution_content_sha256?.type !==
      "string" ||
    String(workflow?.jobs?.pre_activation?.if ?? "").trim() !==
      pilotActivationCondition ||
    !String(workflow?.jobs?.activation?.if ?? "").includes(
      pilotActivationCondition,
    ) ||
    workflow?.["run-name"] !==
      "Issue #${{ inputs.item_number }} | gh-aw-pilot | dispatch" ||
    !sameObject(workflow?.permissions, {}) ||
    workflow?.concurrency?.group !==
      "gh-aw-pilot-${{ github.repository }}" ||
    workflow?.concurrency?.["cancel-in-progress"] !== false ||
    membership?.env?.GH_AW_REQUIRED_ROLES !== "admin" ||
    [...new Set(secretReferences)].sort().join("\0") !==
      expectedSecrets.sort().join("\0") ||
    !sameObject(agent?.permissions, {
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    }) ||
    JSON.stringify(agent?.needs) !==
      JSON.stringify(["activation", "pilot_preflight"]) ||
    pilotPreflight?.needs !== "activation" ||
    pilotPreflight?.if !== undefined ||
    !sameObject(pilotPreflight?.permissions, {
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    }) ||
    !sameObject(pilotPreflight?.outputs, {
      category: "${{ steps.authorize.outputs.category }}",
      target_hash: "${{ steps.authorize.outputs.target_hash }}",
    }) ||
    pilotAuthorizationCheckout?.uses !== CHECKOUT_ACTION ||
    !sameObject(pilotAuthorizationCheckout?.with, {
      "fetch-depth": 1,
      "persist-credentials": false,
      ref: "${{ github.sha }}",
    }) ||
    pilotToken?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
    !sameObject(pilotToken?.with, {
      "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
      owner: "${{ github.repository_owner }}",
      "permission-members": "read",
      "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
    }) ||
    pilotAuthorize?.run !== "node .github/scripts/gh-aw-pilot.mjs" ||
    !sameObject(pilotAuthorize?.env, {
      GITHUB_TOKEN: "${{ github.token }}",
      PILOT_EXPECTED_ACTOR: "LichKing-2234",
      PILOT_EXPECTED_EXECUTION_CONTENT_HASH:
        "${{ inputs.execution_content_sha256 }}",
      PILOT_ISSUE_NUMBER: "${{ inputs.item_number }}",
      PILOT_PHASE: "authorize",
      TEAM_MEMBERSHIP_TOKEN: "${{ steps.team-membership-token.outputs.token }}",
    }) ||
    execution?.env?.COPILOT_PROVIDER_BASE_URL !==
      "${{ secrets.CODEX_RESPONSES_API_ENDPOINT }}" ||
    execution?.env?.COPILOT_PROVIDER_API_KEY !==
      "${{ secrets.CODEX_API_KEY }}" ||
    execution?.env?.COPILOT_PROVIDER_TYPE !== "openai" ||
    execution?.env?.COPILOT_PROVIDER_WIRE_API !== "responses" ||
    secretCount(workflow, "CODEX_API_KEY") !== 2 ||
    secretCount(execution, "CODEX_API_KEY") !== 1 ||
    secretCount(redaction, "CODEX_API_KEY") !== 1 ||
    secretCount(workflow, "CODEX_RESPONSES_API_ENDPOINT") !== 2 ||
    secretCount(execution, "CODEX_RESPONSES_API_ENDPOINT") !== 1 ||
    secretCount(redaction, "CODEX_RESPONSES_API_ENDPOINT") !== 1 ||
    secretCount(workflow, "TEAM_MEMBERSHIP_APP_ID") !== 2 ||
    secretCount(workflow, "TEAM_MEMBERSHIP_APP_PRIVATE_KEY") !== 2 ||
    secretCount(workflow, "CODEX_MODEL") !== 0 ||
    generateInfo?.env?.GH_AW_INFO_MODEL !==
      "${{ vars.GH_AW_MODEL_AGENT_COPILOT }}" ||
    execution?.env?.COPILOT_MODEL !==
      "${{ vars.GH_AW_MODEL_AGENT_COPILOT }}" ||
    safeOutputs?.env?.GH_AW_ENGINE_MODEL !==
      "${{ vars.GH_AW_MODEL_AGENT_COPILOT }}" ||
    secretCount(workflow, "CODEX_GITHUB_TOKEN") !== 1 ||
    secretCount(publisher, "CODEX_GITHUB_TOKEN") !== 1 ||
    !String(execution?.run ?? "").includes(
      "--exclude-env COPILOT_PROVIDER_API_KEY --exclude-env COPILOT_PROVIDER_BASE_URL",
    ) ||
    redaction?.uses !==
      "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3" ||
    !String(redaction?.with?.script ?? "").includes("redact_secrets.cjs") ||
    !sameObject(safeOutputs?.permissions, {
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    }) ||
    JSON.stringify(safeOutputs?.needs) !==
      JSON.stringify(["activation", "agent", "pilot_preflight"]) ||
    pilotTrustedCheckout?.uses !== CHECKOUT_ACTION ||
    !sameObject(pilotTrustedCheckout?.with, {
      clean: true,
      "fetch-depth": 1,
      path: ".pilot-trusted",
      "persist-credentials": false,
      ref: "${{ github.sha }}",
    }) ||
    pilotRecheckToken?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
    !sameObject(pilotRecheckToken?.with, {
      "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
      owner: "${{ github.repository_owner }}",
      "permission-members": "read",
      "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
    }) ||
    pilotRecheck?.run !==
      "node .pilot-trusted/.github/scripts/gh-aw-pilot.mjs" ||
    !sameObject(pilotRecheck?.env, {
      GITHUB_TOKEN: "${{ github.token }}",
      PILOT_EXPECTED_ACTOR: "LichKing-2234",
      PILOT_EXPECTED_TARGET_HASH:
        "${{ needs.pilot_preflight.outputs.target_hash }}",
      PILOT_ISSUE_NUMBER: "${{ inputs.item_number }}",
      PILOT_PHASE: "recheck",
      TEAM_MEMBERSHIP_TOKEN:
        "${{ steps.pilot-recheck-team-token.outputs.token }}",
    }) ||
    publisher?.env?.GH_AW_CI_TRIGGER_TOKEN !==
      "${{ secrets.CODEX_GITHUB_TOKEN }}" ||
    pullRequest?.draft !== true ||
    pullRequest?.max !== 1 ||
    pullRequest?.base_branch !==
      "${{ github.event.repository.default_branch }}" ||
    JSON.stringify(pullRequest?.allowed_branches) !==
      JSON.stringify(["gh-aw/pilot-${{ inputs.item_number }}"]) ||
    JSON.stringify(pullRequest?.allowed_files) !==
      JSON.stringify(["apps/**", "packages/**", "tests/**"]) ||
    JSON.stringify(pullRequest?.labels) !==
      JSON.stringify([
        "gh-aw-pilot",
        "ready-for-human",
        "${{ needs.pilot_preflight.outputs.category }}",
      ]) ||
    pullRequest?.preserve_branch_name !== true ||
    pullRequest?.title_prefix !== "[gh-aw Pilot] " ||
    pullRequest?.fallback_as_issue !== false ||
    pullRequest?.auto_close_issue !== false ||
    pullRequest?.if_no_changes !== "error" ||
    pullRequest?.protected_files_policy !== "blocked" ||
    handlers?.merge_pull_request !== undefined ||
    workflow?.jobs?.threat_detection !== undefined ||
    !allActionsPinned ||
    semanticHash !== GH_AW_PILOT_SEMANTIC_SHA256
  ) {
    errors.push(
      "gh-aw Pilot contract must preserve manual activation, isolated Copilot BYOK, and one bounded draft PR safe output",
    );
  }
  return errors;
}

export function validateGhAwPilotSource(source) {
  const hash = createHash("sha256").update(source).digest("hex");
  return hash === GH_AW_PILOT_SOURCE_SHA256
    ? []
    : ["gh-aw Pilot source must match the reviewed generated workflow source"];
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
      ["CODEX_RESPONSES_API_ENDPOINT", "CODEX_MODEL"].includes(secret)
    ) {
      const reference = `\${{ secrets.${secret} }}`;
      const actionInput = {
        CODEX_RESPONSES_API_ENDPOINT: "responses-api-endpoint",
        CODEX_MODEL: "model",
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
    if (secret === "WECOM_BOT_WEBHOOK_URL") {
      if (
        workflowName !== "workflow-outcome.yml" ||
        jobName !== "observe" ||
        step.name !== "Record workflow outcome and notify" ||
        step.run !== "node .github/scripts/workflow-outcome.mjs" ||
        step.env?.WECOM_BOT_WEBHOOK_URL !==
          "${{ secrets.WECOM_BOT_WEBHOOK_URL }}" ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: WECOM_BOT_WEBHOOK_URL is allowed only in the fixed outcome notification step`,
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
        !["analyze", "suggestions"].includes(jobName) ||
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
        workflowName === "pr-gates.yml" &&
        jobName === "gates";
      const allowedGatePublisherLocation =
        step.id === "gate-publisher-token" &&
        ((workflowName === "pr-gates.yml" && jobName === "gates") ||
          (workflowName === "claude-pr-review.yml" && jobName === "publish") ||
          (workflowName === "pr-agent-review.yml" && jobName === "coverage"));
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
  const coverageSource = sources?.["review-coverage.mjs"] ?? "";
  const contractSource = sources?.["check-run-contract.mjs"] ?? "";
  const workerSource = sources?.["codex-worker.mjs"] ?? "";
  const pilotSource = sources?.["gh-aw-pilot.mjs"] ?? "";
  const resilienceSource = sources?.["worker-resilience.mjs"] ?? "";
  const workerContractSource = sources?.["worker-contract.mjs"] ?? "";
  const blockerContractSource = sources?.["blocker-contract.mjs"] ?? "";
  const blockerReconcilerSource = sources?.["blocker-reconciler.mjs"] ?? "";
  const outcomeSource = sources?.["workflow-outcome.mjs"] ?? "";
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
  const coverageRequirements = [
    'COVERAGE_CHECK_NAME = "Automated Review Coverage"',
    "gateCheckRequest,",
    "requireCurrentReviewTarget({",
    'job.name === "PR-Agent Analysis"',
    "/actions/jobs/${jobs[0].id}/logs",
    "selectReviewGateCheck(",
    "review-coverage-incomplete",
    "await checkRequest(`/repos/${repository}/check-runs/${check.id}`",
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
    coverageRequirements.some(
      (requirement) => !coverageSource.includes(requirement),
    ) ||
    contractRequirements.some((requirement) => !contractSource.includes(requirement))
  ) {
    errors.push("Gate publishers must bind Check Runs to current heads");
  }
  const workerAuthorizationRequirements = [
    "parseAuthorizationRecords(",
    "transitionAuthorization({",
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
    !workerSource.includes("isTrustedWorkflowRunSource({ repository, run: event.workflow_run })") ||
    !workerSource.includes("run.head_repository.full_name.toLowerCase() === repository.toLowerCase()")
  ) {
    errors.push("Codex Worker workflow recovery must pass authorization");
  }
  if (
    !/if \(eventName === "issues"\) \{\s+if \(event\.action === "labeled" && event\.label\?\.name === "ready-for-agent"\) \{\s+await writeOutput\("allowed", false\);\s+return;/.test(
      workerSource,
    ) ||
    workerSource.includes(
      '(action === "labeled" && label === "ready-for-agent")',
    ) ||
    /\bauthorizeCycle\(|TEAM_MEMBERSHIP_TOKEN|fetchTeamMembership/.test(
      workerSource,
    ) ||
    !workerSource.includes("if (!context.current) return false;") ||
    !/const allowed = await recordIssueAuthorizationEvent\([\s\S]{0,200}await writeOutput\("allowed", allowed\);/.test(
      workerSource,
    )
  ) {
    errors.push("Codex Worker new Issue intake must stay disabled");
  }
  const pilotRequirements = [
    'TARGET_VERSION = "gh-aw-pilot-target-v1"',
    "parsePilotIssueNumber",
    "validatePilotSnapshot",
    "normalizeGitHubApiUrl",
    'requiredEnvironment("GITHUB_API_URL")',
    "executionContent(issue,",
    "WORKER_OWNERS_TEAM_SLUG",
    "extractPrimaryIssueNumbers(pullRequest.body)",
    "pullRequest.head?.repo?.full_name === repository",
    'actorAccount?.type !== "User"',
    'membership?.state !== "active"',
    'blocker.state_reason !== "completed"',
    "activePullRequests.length > 0 || branchExists",
    "contract.hash !== expectedExecutionContentHash",
    "targetHash !== expectedTargetHash",
  ];
  if (
    pilotRequirements.some((requirement) => !pilotSource.includes(requirement)) ||
    pilotSource.includes("https://api.github.com")
  ) {
    errors.push("gh-aw Pilot must authorize and recheck one trusted target snapshot");
  }
  const pilotSourceHash = createHash("sha256")
    .update(pilotSource)
    .digest("hex");
  if (pilotSourceHash !== GH_AW_PILOT_SCRIPT_SHA256) {
    errors.push("gh-aw Pilot authorization script must match the reviewed trusted source");
  }
  const claudeRecoveryRequirements = [
    "reviewRecoveryArtifactAvailable({",
    'if (command === "resolve-review-recovery") return resolveReviewRecoveryCommand();',
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
    "workItemKind",
    "hydrateNativeDependencies",
    "native_blockers",
  ];
  const blockerReconcilerRequirements = [
    "reconciliationIssueNumbers(graph)",
    "classifyDependentBlockers(graph, issueNumber)",
    "readNativeDependencies({",
    "reconcileBodyProjections({",
    'event_type: "codex-worker"',
    "blocker_state_signature: state.signature",
  ];
  const blockerWorkerRequirements = [
    "workerResultOperation(validated.result)",
    'if (command === "blockers") return blockersCommand();',
    'if (command === "handoffs") return handoffsCommand();',
    "publishHumanHandoffs({ plan, result, token })",
    "publishBlockerEdges({",
    "/dependencies/blocked_by",
    "validatedExecutionIssue(",
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
    !gateSource.includes("validatedExecutionIssue(") ||
    !claudeAuthorizationSource.includes("authorizeBlockerReviewDispatch") ||
    !claudeAuthorizationSource.includes("hasTrustedBlockerReviewAck")
  ) {
    errors.push("Blocker automation must preserve bounded proposals and signed reconciliation");
  }
  const outcomeRequirements = [
    "Math.min(Math.max(Number(maxAttempts) || 1, 1), 3)",
    "agent-infra:workflow-outcome:",
    "agent-infra-post-merge-failure",
    'body: JSON.stringify({ state: "open" })',
    'body: JSON.stringify({ labels: ["needs-triage"] })',
    "is incomplete and requires recovery",
    "Response text is intentionally discarded.",
    "Source run operation does not match trusted workflow",
    "Source pull request target does not match workflow_run metadata",
    "workflowNotRun: true",
    "allowNotFound: allowMissing",
    "GATE_PUBLISHER_APP_ID = 4_503_079",
    "Pull request Check Run pagination limit exceeded",
    "canonicalClaim.id !== created.id",
    "duplicateClaim",
    "check_name=Workflow%20Outcome&filter=all&per_page=100&page=",
    "Workflow outcome Check Run pagination limit exceeded",
    "WECOM_BOT_WEBHOOK_URL",
  ];
  const coverageOutcomeRequirements = [
    "REVIEW_PROVIDER_BY_WORKFLOW",
    "selectCoverageCheck(",
    'outcome("review_coverage_failed", "repository-maintainer", true)',
    "review-coverage-check-${reviewCoverage.checkId}",
    "Review provider:",
    "Coverage reason:",
  ];
  const summaryStart = outcomeSource.indexOf("export function renderJobSummary");
  const summaryEnd = outcomeSource.indexOf("function wait(milliseconds)");
  const hasTrustedSummaryWindow =
    summaryStart >= 0 && summaryEnd > summaryStart;
  const summarySource = hasTrustedSummaryWindow
    ? outcomeSource.slice(summaryStart, summaryEnd)
    : "";
  if (
    outcomeRequirements.some(
      (requirement) => !outcomeSource.includes(requirement),
    ) ||
    /\/reverts?(?:\?|`|\")|\/merges(?:\?|`|\")/.test(outcomeSource)
  ) {
    errors.push(
      "Workflow Outcome must preserve bounded dedupe and post-merge triage without auto-revert",
    );
  }
  if (
    coverageOutcomeRequirements.some(
      (requirement) => !outcomeSource.includes(requirement),
    )
  ) {
    errors.push(
      "Workflow Outcome must preserve the required Review Coverage notification",
    );
  }
  if (
    !hasTrustedSummaryWindow ||
    /\b(?:sourceRun|issue|comment|head_commit)\.(?:title|body|message)\b|\bmodel_output\b/.test(
      summarySource,
    )
  ) {
    errors.push("Workflow Outcome must use only trusted Summary sources");
  }
  const reviewHeadRechecks =
    reviewSource.match(/await requireCurrentReviewTarget\(\{/g) ?? [];
  if (
    reviewHeadRechecks.length < 5 ||
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
  if (
    workflows["ci.yml"]?.name !== "CI" ||
    workflows["ci.yml"]?.jobs?.ci?.name !== "CI"
  ) {
    errors.push("CI workflow and required check must both use the CI name");
  }

  for (const [name, contract] of Object.entries(RUN_NAME_CONTRACTS)) {
    const runName = workflows[name]?.["run-name"];
    const references = typeof runName === "string"
      ? [...new Set(
          [...runName.matchAll(/github(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[[0-9]+\])+/g)]
            .map((match) => match[0]),
        )].sort()
      : [];
    if (
      typeof runName !== "string" ||
      !runName.includes(`| ${contract.operation} |`) ||
      references.join("\0") !== [...contract.references].sort().join("\0") ||
      referencedSecrets(runName).length > 0 ||
      /\b(?:title|body|comment|message|prompt|transcript|model_output)\b/i.test(
        runName,
      )
    ) {
      errors.push(`${name} must use its fixed safe run-name contract`);
    }
  }

  for (const [name, contract] of Object.entries(SOURCE_OUTCOME_CONTRACTS)) {
    const outcomeJob = workflows[name]?.jobs?.outcome;
    const outcomeStep = outcomeJob?.steps?.[0];
    const needs = Array.isArray(outcomeJob?.needs)
      ? outcomeJob.needs
      : [outcomeJob?.needs].filter(Boolean);
    const envKeys = Object.keys(outcomeStep?.env ?? {}).sort();
    const jobKeys = Object.keys(outcomeJob ?? {}).sort();
    const stepKeys = Object.keys(outcomeStep ?? {}).sort();
    const summarySources = JSON.stringify(outcomeStep?.env ?? {});
    const unsafeSummarySource =
      /(?:github|needs|steps|vars)(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[[0-9]+\])*\.(?:title|body|comment|message|prompt|transcript|model(?:_output)?|structured_output)(?:\b|\.)/i;
    if (
      jobKeys.join("\0") !==
        ["if", "name", "needs", "permissions", "runs-on", "steps", "timeout-minutes"]
          .sort()
          .join("\0") ||
      outcomeJob?.name !== "Publish terminal outcome" ||
      needs.join("\0") !== contract.needs.join("\0") ||
      outcomeJob?.if !== "always()" ||
      outcomeJob?.["runs-on"] !== "ubuntu-24.04" ||
      outcomeJob?.["timeout-minutes"] !== 1 ||
      !sameObject(outcomeJob?.permissions, {}) ||
      outcomeJob?.steps?.length !== 1 ||
      stepKeys.join("\0") !== ["env", "name", "run", "shell"].sort().join("\0") ||
      outcomeStep?.name !== "Publish terminal Job Summary" ||
      outcomeStep?.shell !== "bash" ||
      outcomeStep?.run !== SOURCE_OUTCOME_SUMMARY ||
      envKeys.join("\0") !== [...SOURCE_OUTCOME_ENV_KEYS].sort().join("\0") ||
      outcomeStep?.env?.SUMMARY_OPERATION !== contract.operation ||
      outcomeStep?.env?.SUMMARY_NEXT_OWNER !== SOURCE_OUTCOME_NEXT_OWNER ||
      outcomeStep?.env?.SUMMARY_OUTCOME !== SOURCE_OUTCOME_RESULT ||
      referencedSecrets(outcomeStep?.env).length > 0 ||
      unsafeSummarySource.test(summarySources)
    ) {
      errors.push(`${name} must use its fixed safe terminal Job Summary`);
    }
  }

  for (const [name, workflow] of Object.entries(workflows)) {
    if (
      name !== "gh-aw-issue-to-pr-pilot.lock.yml" &&
      (workflow?.concurrency?.queue !== undefined ||
        Object.values(workflow?.jobs ?? {}).some(
          (job) => job?.concurrency?.queue !== undefined,
        ))
    ) {
      errors.push(`${name}: concurrency.queue is reserved for the generated gh-aw Pilot`);
    }
    if (name === "gh-aw-issue-to-pr-pilot.lock.yml") {
      errors.push(...validateGhAwPilotWorkflow(workflow));
      continue;
    }
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
          name === "pr-gates.yml" &&
          jobName === "gates" &&
          step.name === "Evaluate Issue, readiness, and human validation gates" &&
          step.run === "node .github/scripts/pr-gates.mjs";
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
              ((step.name === "Publish validated Review result" &&
                step.run === "node .github/scripts/claude-review.mjs") ||
                (step.name === "Publish Automated Review Coverage" &&
                  step.run === "node .github/scripts/review-coverage.mjs"))) ||
            (name === "pr-agent-review.yml" &&
              jobName === "coverage" &&
              step.name === "Publish Automated Review Coverage" &&
              step.run === "node .github/scripts/review-coverage.mjs"));
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

  const outcomeWorkflow = workflows["workflow-outcome.yml"];
  const outcomeJob = outcomeWorkflow?.jobs?.observe;
  const outcomeSteps = outcomeJob?.steps ?? [];
  const outcomeCheckout = outcomeSteps.find(
    (step) => step.name === "Checkout trusted default branch",
  );
  const outcomeStep = outcomeSteps.find(
    (step) => step.name === "Record workflow outcome and notify",
  );
  if (
    JSON.stringify(outcomeWorkflow?.on?.workflow_run?.workflows) !==
      JSON.stringify([
        "Auto-merge Enrollment",
        "Blocker Reconciler",
        "Claude Issue Review",
        "Claude PR Review",
        "Codex Worker",
        "CI",
        "PR-Agent Review",
        "PR Gates",
      ]) ||
    JSON.stringify(outcomeWorkflow?.on?.workflow_run?.types) !==
      JSON.stringify(["completed"]) ||
    !sameObject(outcomeWorkflow?.concurrency, {
      group: "workflow-outcome-${{ github.event.workflow_run.id }}",
      "cancel-in-progress": false,
    }) ||
    !sameObject(outcomeJob?.permissions, {
      actions: "read",
      checks: "write",
      contents: "read",
      issues: "write",
      "pull-requests": "read",
    }) ||
    outcomeCheckout?.with?.ref !==
      "${{ github.event.repository.default_branch }}" ||
    outcomeCheckout?.with?.["persist-credentials"] !== false ||
    outcomeStep?.run !== "node .github/scripts/workflow-outcome.mjs" ||
    !sameObject(outcomeStep?.env, {
      GITHUB_TOKEN: "${{ github.token }}",
      WECOM_BOT_WEBHOOK_URL: "${{ secrets.WECOM_BOT_WEBHOOK_URL }}",
    })
  ) {
    errors.push(
      "Workflow Outcome must use fixed trusted triggers, permissions, checkout, and notification step",
    );
  }

  for (const [name, workflow] of Object.entries(workflows)) {
    if (!workflow.on?.pull_request_target) continue;
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (
        jobName !== "outcome" &&
        /pull_request\.head\.(?:ref|sha)/.test(JSON.stringify(job))
      ) {
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
  if (authorization?.if !== undefined) {
    errors.push("Codex Worker authorization recorder must observe every source event");
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
  if (
    authorizationToken !== undefined ||
    authorizationRecorder?.run !==
      "node trusted/.github/scripts/codex-worker.mjs authorize" ||
    !sameObject(authorizationRecorder?.env, {
      GITHUB_TOKEN: "${{ github.token }}",
    }) ||
    teamMembershipTokenReferences(worker).length !== 0
  ) {
    errors.push("Codex Worker new Issue intake must stay disabled");
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
    !workerGroup.includes("github.event.workflow_run.head_repository.full_name == github.repository")
  ) {
    errors.push("Codex Worker Review recovery must require a same-repository source");
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
  const prAgentCoverage = prAgent?.jobs?.coverage;
  const prAgentSuggestions = prAgent?.jobs?.suggestions;
  const prAgentAction = prAgentAnalyze?.steps?.find((step) => step.id === "pr-agent");
  const prAgentSuggestionsAction = prAgentSuggestions?.steps?.find(
    (step) => step.id === "pr-agent-suggestions",
  );
  const prAgentAnalyzeCheckout = prAgentAnalyze?.steps?.find(
    (step) => step.name === "Checkout trusted default branch",
  );
  const prAgentCoverageSteps = prAgentCoverage?.steps ?? [];
  const prAgentCoverageCheckout = prAgentCoverageSteps.find(
    (step) => step.name === "Checkout trusted default branch",
  );
  const prAgentCoverageSetup = prAgentCoverageSteps.find(
    (step) => step.name === "Set up Node.js",
  );
  const prAgentCoverageToken = prAgentCoverageSteps.find(
    (step) => step.id === "gate-publisher-token",
  );
  const prAgentCoveragePublish = prAgentCoverageSteps.find(
    (step) => step.name === "Publish Automated Review Coverage",
  );
  const prAgentCondition = String(prAgentAnalyze?.if ?? "");
  const prAgentCoverageCondition = String(prAgentCoverage?.if ?? "");
  const prAgentSuggestionsCondition = String(prAgentSuggestions?.if ?? "");
  const prAgentPermissions = {
    contents: "read",
    issues: "write",
    "pull-requests": "write",
  };
  const prAgentCommonEnv = {
    GITHUB_TOKEN: "${{ github.token }}",
    OPENAI__KEY: "${{ secrets.PR_AGENT_API_KEY }}",
    OPENAI__API_BASE: "${{ secrets.PR_AGENT_API_BASE }}",
    "config.model": "${{ secrets.PR_AGENT_MODEL }}",
    "config.propagate_tool_errors": "true",
    "config.publish_output": "true",
    "config.publish_output_progress": "false",
    "config.restricted_mode": "true",
    "config.use_repo_settings_file": "false",
    "config.use_wiki_settings_file": "false",
    "config.fallback_models": "[]",
    "config.custom_model_max_tokens":
      "${{ vars.PR_AGENT_MODEL_MAX_TOKENS || '128000' }}",
    "config.max_model_tokens":
      "${{ vars.PR_AGENT_MODEL_MAX_TOKENS || '128000' }}",
    "github_action_config.auto_describe": "false",
    "github_action_config.pr_actions":
      '["opened", "reopened", "synchronize", "ready_for_review", "review_requested"]',
  };
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
    !prAgentCondition.includes("vars.PR_REVIEW_PROVIDER != 'claude'") ||
    !prAgentCondition.includes(
      "github.event.pull_request.head.repo.full_name == github.repository",
    ) ||
    !prAgentCondition.includes("github.event.sender.type != 'Bot'") ||
    !prAgentCondition.includes("github.event.pull_request.draft == false") ||
    prAgentSuggestionsCondition !== prAgentCondition ||
    !prAgentCoverageCondition.includes("always()") ||
    !prAgentCoverageCondition.includes("vars.PR_REVIEW_PROVIDER != 'claude'") ||
    !prAgentCoverageCondition.includes(
      "github.event.pull_request.head.repo.full_name == github.repository",
    ) ||
    !prAgentCoverageCondition.includes("github.event.sender.type != 'Bot'") ||
    !prAgentCoverageCondition.includes("github.event.pull_request.draft == false") ||
    !sameObject(prAgentAnalyze?.permissions, prAgentPermissions) ||
    !sameObject(prAgentSuggestions?.permissions, prAgentPermissions) ||
    !sameObject(prAgentCoverage?.permissions, {
      actions: "read",
      checks: "read",
      contents: "read",
      "pull-requests": "read",
    }) ||
    prAgentCoverage?.name !== "Publish Automated Review Coverage" ||
    prAgentCoverage?.needs !== "analyze" ||
    prAgentCoverage?.["continue-on-error"] !== true ||
    Object.keys(prAgent?.jobs ?? {}).sort().join("\0") !==
      ["analyze", "coverage", "outcome", "suggestions"].join("\0") ||
    prAgentAnalyze?.steps?.length !== 2 ||
    prAgentCoverageSteps.length !== 4 ||
    prAgentSuggestions?.steps?.length !== 1 ||
    prAgentAnalyzeCheckout?.uses !==
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" ||
    !sameObject(prAgentAnalyzeCheckout?.with, {
      ref: "${{ github.event.repository.default_branch }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    }) ||
    prAgentCoverageCheckout?.uses !== CHECKOUT_ACTION ||
    !sameObject(prAgentCoverageCheckout?.with, {
      ref: "${{ github.event.repository.default_branch }}",
      "fetch-depth": 1,
      "persist-credentials": false,
    }) ||
    prAgentCoverageSetup?.uses !==
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" ||
    !sameObject(prAgentCoverageSetup?.with, { "node-version": 24 }) ||
    prAgentCoverageToken?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION ||
    !sameObject(prAgentCoverageToken?.with, {
      "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}",
      "permission-checks": "write",
      "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}",
      repositories: "${{ github.event.repository.name }}",
    }) ||
    prAgentCoveragePublish?.if !== "always()" ||
    prAgentCoveragePublish?.run !== "node .github/scripts/review-coverage.mjs" ||
    !sameObject(prAgentCoveragePublish?.env, {
      GATE_CHECK_TOKEN: "${{ steps.gate-publisher-token.outputs.token }}",
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      REVIEW_PROVIDER: "pr-agent",
      REVIEW_RUN_RESULT: "${{ needs.analyze.result }}",
    }) ||
    JSON.stringify(prAgent?.jobs?.outcome?.needs) !==
      JSON.stringify(["analyze", "suggestions"]) ||
    gatePublisherTokenReferences(prAgent).length !== 1 ||
    prAgentAction?.uses !== PR_AGENT_ACTION ||
    prAgentSuggestionsAction?.uses !== PR_AGENT_ACTION ||
    prAgentSuggestionsAction?.["continue-on-error"] !== true ||
    !sameObject(prAgentAction?.env, {
      ...prAgentCommonEnv,
      "pr_code_suggestions.commitable_code_suggestions": "true",
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
      "github_action_config.auto_improve": "false",
    }) ||
    !sameObject(prAgentSuggestionsAction?.env, {
      ...prAgentCommonEnv,
      "pr_code_suggestions.commitable_code_suggestions": "true",
      "github_action_config.auto_review": "false",
      "github_action_config.auto_improve": "true",
    })
  ) {
    errors.push(
      "PR-Agent Review must use the pinned Action with official inline publishing settings",
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
      JSON.stringify(["CI", "Claude PR Review"]) ||
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
  const reviewTargetResolve = (prepare?.steps ?? []).find(
    (step) => step.name === "Resolve trusted Review recovery target",
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
    reviewTargetResolve?.id !== "resolve-review-recovery" ||
    reviewTargetResolve?.run !==
      "node trusted/.github/scripts/codex-worker.mjs resolve-review-recovery" ||
    reviewTargetResolve?.env?.GITHUB_TOKEN !== "${{ github.token }}" ||
    !String(reviewTargetResolve?.if ?? "").includes(
      "github.event.workflow_run.name == 'Claude PR Review'",
    ) ||
    !String(reviewTargetResolve?.if ?? "").includes(
      "github.event.workflow_run.conclusion == 'success'",
    ) ||
    reviewTargetDownload?.uses !== DOWNLOAD_ARTIFACT_ACTION ||
    reviewTargetDownload?.if !==
      "steps.resolve-review-recovery.outputs.available == 'true'" ||
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
  const prepareConfig = (prepare?.steps ?? []).find(
    (step) => step.name === "Prepare trusted Worker plan",
  );
  if (prepareConfig?.env?.CODEX_EFFORT !== "${{ vars.CODEX_EFFORT }}") {
    errors.push("Codex Worker effort must use the fixed repository Variable");
  }
  if (
    prepareConfig?.env?.WORKER_REVIEW_RECOVERY_AVAILABLE !==
    "${{ steps.resolve-review-recovery.outputs.available }}"
  ) {
    errors.push("Claude recovery Artifact availability must reach trusted preparation");
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
        effort: "${{ vars.CODEX_EFFORT }}",
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
  const reviewAnalyzeCondition = String(review?.jobs?.analyze?.if ?? "");
  const reviewPublishCondition = String(review?.jobs?.publish?.if ?? "");
  const reviewJobConditions = [review?.jobs?.analyze?.if, review?.jobs?.publish?.if].map(
    (condition) => String(condition ?? ""),
  );
  if (
    JSON.stringify(reviewTrigger?.workflows) !== JSON.stringify(["CI"]) ||
    JSON.stringify(reviewTrigger?.types) !== JSON.stringify(["completed"]) ||
    reviewConcurrency?.group !==
      "claude-review-${{ github.event.workflow_run.pull_requests[0].number || github.run_id }}" ||
    reviewConcurrency?.["cancel-in-progress"] !== true ||
    reviewJobConditions.some(
      (condition) =>
        !condition.includes("github.event.workflow_run.conclusion == 'success'") ||
        !condition.includes("github.event.workflow_run.event == 'pull_request'") ||
        !condition.includes("github.event.workflow_run.pull_requests[0]") ||
        !condition.includes(
          "github.event.workflow_run.head_repository.full_name == github.repository",
        ),
    ) ||
    !reviewAnalyzeCondition.includes("vars.PR_REVIEW_PROVIDER == 'claude'") ||
    !reviewPublishCondition.includes(
      "needs.analyze.outputs.selected_provider == 'claude'",
    )
  ) {
    errors.push("Claude PR Review trigger and concurrency must stay current-head bound");
  }
  const analyzeSteps = review?.jobs?.analyze?.steps ?? [];
  const reviewActionIndex = analyzeSteps.findIndex((step) => step.id === "claude");
  const reviewAction = analyzeSteps[reviewActionIndex];
  const selectedReviewProvider = analyzeSteps.find(
    (step) => step.id === "selected-provider",
  );
  const reviewDataCheckout = analyzeSteps.find(
    (step) => step.name === "Checkout untrusted PR head as review data",
  );
  const reviewPublishSteps = review?.jobs?.publish?.steps ?? [];
  const reviewPublish = reviewPublishSteps.find(
    (step) => step.name === "Publish validated Review result",
  );
  const reviewCoveragePublish = reviewPublishSteps.find(
    (step) => step.name === "Publish Automated Review Coverage",
  );
  const reviewGatePublisherToken = reviewPublishSteps.find(
    (step) => step.id === "gate-publisher-token",
  );
  if (
    review?.jobs?.analyze?.outputs?.selected_provider !==
      "${{ steps.selected-provider.outputs.selected_provider }}" ||
    analyzeSteps[0] !== selectedReviewProvider ||
    selectedReviewProvider?.run !==
      'echo "selected_provider=claude" >> "$GITHUB_OUTPUT"' ||
    reviewDataCheckout?.with?.ref !== "${{ github.event.workflow_run.head_sha }}" ||
    reviewDataCheckout?.with?.path !== "pr-head" ||
    reviewDataCheckout?.with?.["persist-credentials"] !== false ||
    reviewPublish?.run !== "node .github/scripts/claude-review.mjs" ||
    reviewCoveragePublish?.if !== "always()" ||
    reviewCoveragePublish?.["continue-on-error"] !== true ||
    reviewCoveragePublish?.run !== "node .github/scripts/review-coverage.mjs" ||
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
      REVIEW_ENABLED: "true",
      STRUCTURED_OUTPUT: "${{ needs.analyze.outputs.structured_output }}",
    }) ||
    !sameObject(reviewCoveragePublish?.env, {
      EXPECTED_HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
      GATE_CHECK_TOKEN: "${{ steps.gate-publisher-token.outputs.token }}",
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ github.event.workflow_run.pull_requests[0].number }}",
      REVIEW_PROVIDER: "claude",
      REVIEW_RUN_RESULT: "${{ steps.publish-review.outcome }}",
    }) ||
    !sameObject(review?.jobs?.publish?.permissions, {
      checks: "read",
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    }) ||
    gatePublisherTokenReferences(review).length !== 2
  ) {
    errors.push("Claude PR Review must publish only the completed CI head");
  }
  if (reviewGatePublisherToken?.["continue-on-error"] === true) {
    errors.push("Gate publisher token mint must fail the workflow");
  }
  const reviewConfigIndex = analyzeSteps.findIndex((step) => step.id === "validate-config");
  const reviewConfig = analyzeSteps[reviewConfigIndex];
  const reviewInputStage = analyzeSteps.find(
    (step) => step.name === "Stage untrusted PR review data",
  );
  const reviewConfigEnv = reviewConfig?.env ?? {};
  if (
    reviewConfig?.run !== "node .github/scripts/validate-claude-review-config.mjs" ||
    Object.keys(reviewConfigEnv).sort().join("\0") !==
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_REVIEW_EFFORT",
        "CLAUDE_REVIEW_MODEL",
      ]
        .sort()
        .join("\0") ||
    reviewConfigEnv.ANTHROPIC_API_KEY !== "${{ secrets.ANTHROPIC_API_KEY }}" ||
    reviewConfigEnv.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
    reviewConfigEnv.CLAUDE_REVIEW_EFFORT !== "${{ vars.CLAUDE_REVIEW_EFFORT }}" ||
    reviewConfigEnv.CLAUDE_REVIEW_MODEL !== "${{ secrets.CLAUDE_REVIEW_MODEL }}" ||
    reviewActionIndex !== reviewConfigIndex + 1 ||
    reviewInputStage?.env?.GH_TOKEN !== "${{ github.token }}" ||
    reviewInputStage?.env?.EXPECTED_HEAD_SHA !==
      "${{ github.event.workflow_run.head_sha }}" ||
    reviewInputStage?.env?.PR_NUMBER !==
      "${{ github.event.workflow_run.pull_requests[0].number }}" ||
    reviewInputStage?.shell !== "bash" ||
    !String(reviewInputStage?.run ?? "").includes('gh pr view "$PR_NUMBER"') ||
    !String(reviewInputStage?.run ?? "").includes("> .review-input/pr.json") ||
    !String(reviewInputStage?.run ?? "").includes(
      'gh pr diff "$PR_NUMBER" > .review-input/pr.diff',
    ) ||
    (String(reviewInputStage?.run ?? "").match(/= "\$EXPECTED_HEAD_SHA"/g) ?? [])
      .length !== 2 ||
    reviewAction?.env?.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
    reviewAction?.with?.show_full_output !==
      "${{ vars.CLAUDE_REVIEW_VERBOSE == 'true' }}" ||
    !hasSingleFixedClaudeArgument(
      reviewAction?.with?.claude_args,
      "--model",
      "${{ secrets.CLAUDE_REVIEW_MODEL }}",
    ) ||
    !hasSingleFixedClaudeArgument(
      reviewAction?.with?.claude_args,
      "--effort",
      "${{ vars.CLAUDE_REVIEW_EFFORT }}",
    )
  ) {
    errors.push("Claude PR Review model configuration must use validated settings");
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
      JSON.stringify(['--allowedTools "Read,Grep,Glob"']) ||
    JSON.stringify(allowedToolOptions) !== JSON.stringify(["--allowedTools"]) ||
    JSON.stringify(disallowedToolFlags) !==
      JSON.stringify([
        '--disallowedTools "Edit,Write,MultiEdit,Bash,WebFetch,WebSearch"',
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
    if ((job.if ?? "").includes("author_association") && jobName !== "automatic-issue-review") {
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
    const reviewInputStage = (job.steps ?? []).find((step) =>
      step.name?.startsWith("Stage untrusted "),
    );
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
        (!splitBlockerReview && configIndex <= authorizeIndex) ||
        (!splitBlockerReview &&
          configStep?.if !== "steps.authorize.outputs.allowed == 'true'") ||
        configStep?.run !== "node .github/scripts/validate-claude-review-config.mjs" ||
        (["automatic-issue-review", "analyze-blocker-review"].includes(jobName) &&
          (reviewInputStage?.env?.GH_TOKEN !== "${{ github.token }}" ||
            reviewInputStage?.shell !== "bash" ||
            !String(reviewInputStage?.run ?? "").includes("gh issue view \"$ISSUE_NUMBER\"") ||
            !String(reviewInputStage?.run ?? "").includes("> .review-input/issue.json"))) ||
        Object.keys(configEnv).sort().join("\0") !==
          [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_REVIEW_EFFORT",
            "CLAUDE_REVIEW_MODEL",
          ]
            .sort()
            .join("\0") ||
        configEnv.ANTHROPIC_API_KEY !== "${{ secrets.ANTHROPIC_API_KEY }}" ||
        configEnv.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
        configEnv.CLAUDE_REVIEW_EFFORT !== "${{ vars.CLAUDE_REVIEW_EFFORT }}" ||
        configEnv.CLAUDE_REVIEW_MODEL !== "${{ secrets.CLAUDE_REVIEW_MODEL }}" ||
        modelStep?.env?.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
        !hasSingleFixedClaudeArgument(
          modelStep?.with?.claude_args,
          "--model",
          "${{ secrets.CLAUDE_REVIEW_MODEL }}",
        ) ||
        !hasSingleFixedClaudeArgument(
          modelStep?.with?.claude_args,
          "--effort",
          "${{ vars.CLAUDE_REVIEW_EFFORT }}",
        ))
    ) {
      errors.push(
        `claude-issue-review.yml/${jobName}: model configuration must use validated settings`,
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
      const expectedAllowed = '--allowedTools "Read,Grep,Glob"';
      const expectedDisallowed =
        '--disallowedTools "Edit,Write,MultiEdit,Bash,WebFetch,WebSearch"';
      const unsafeBash = /--allowedTools\s+"[^"]*\bBash\b/.test(args);
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
  const ghAwPilotSource = await fs.readFile(
    path.join(directory, "gh-aw-issue-to-pr-pilot.md"),
    "utf8",
  );
  const scriptSources = Object.fromEntries(
    await Promise.all(
      [
        "blocker-contract.mjs",
        "blocker-reconciler.mjs",
        "check-run-contract.mjs",
        "claude-event-authorization.mjs",
        "claude-review.mjs",
        "codex-worker.mjs",
        "gh-aw-pilot.mjs",
        "pr-gates.mjs",
        "review-coverage.mjs",
        "worker-contract.mjs",
        "worker-resilience.mjs",
        "workflow-outcome.mjs",
      ].map(async (name) => [
        name,
        await fs.readFile(path.join(scriptDirectory, name), "utf8"),
      ]),
    ),
  );
  const errors = [
    ...(await validateMattSkillSnapshot()),
    ...validateWorkflowDocuments(workflows),
    ...validateGhAwPilotSource(ghAwPilotSource),
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
