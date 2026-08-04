import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const REQUIRED_WORKFLOWS = [
  "auto-merge.yml",
  "claude-issue-review.yml",
  "claude-pr-review.yml",
  "docs-ci.yml",
  "pr-gates.yml",
];
const FULL_SHA_ACTION = /^[^@]+@[0-9a-f]{40}$/;
const CLAUDE_ACTION = "anthropics/claude-code-action@";
const TRUSTED_SCRIPT_SHA256 = {
  ".github/scripts/run-claude-direct-canary.sh":
    "81e33211d28b021ae55911c6481eac31c25c4d804bb9518d66047becebc5813b",
  ".github/scripts/summarize-claude-review.mjs":
    "20cfbcc942d07635214af6d3c9fd241686b4a12665650647c2ffd9e565c7317b",
  ".github/scripts/validate-claude-review-config.mjs":
    "cb94aa2507fa6d3cbe8b873fe941a5eb95f3634bbefdfb1c299b98bff642387f",
};

function workflowSteps(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

export function validateTrustedScriptDocuments(scripts) {
  const errors = [];
  for (const [name, expectedHash] of Object.entries(TRUSTED_SCRIPT_SHA256)) {
    const content = scripts[name];
    const actualHash =
      typeof content === "string"
        ? createHash("sha256").update(content).digest("hex")
        : "missing";
    if (actualHash !== expectedHash) {
      errors.push(`${name}: trusted Claude Review script hash changed`);
    }
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
      for (const step of job.steps ?? []) {
        if (step.uses && !step.uses.startsWith("./") && !FULL_SHA_ACTION.test(step.uses)) {
          errors.push(`${name}: third-party Actions must use a full commit SHA`);
        }
        const isApprovedSecretStep =
          name === "claude-pr-review.yml" &&
          ((jobName === "direct-cli-canary" && step.id === "direct") ||
            (jobName === "analyze" && step.id === "validate-config"));
        if (
          JSON.stringify(step).includes("secrets.") &&
          !step.uses?.startsWith(CLAUDE_ACTION) &&
          !isApprovedSecretStep
        ) {
          errors.push(
            `${name}: model Secret is allowed only in an approved Claude execution step`,
          );
        }
      }
      if (JSON.stringify(job.env ?? {}).includes("secrets.")) {
        errors.push(`${name}/${jobName}: model Secret is not allowed in job environment`);
      }
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
        if (
          checkout.with?.ref !== "${{ github.event.repository.default_branch }}" ||
          checkout.with?.["persist-credentials"] !== false
        ) {
          errors.push(
            `${name}/${jobName}: pull_request_target checkout must use the trusted default branch`,
          );
        }
      }
    }
  }

  const gates = workflows["pr-gates.yml"]?.jobs?.gates;

  const review = workflows["claude-pr-review.yml"];
  if (!review?.on?.workflow_run?.workflows?.includes("Docs CI")) {
    errors.push("Claude PR Review must run only after Docs CI");
  }
  const directCanary = review?.jobs?.["direct-cli-canary"];
  const directCanaryPermissions = directCanary?.permissions ?? {};
  if (
    typeof directCanary?.if !== "string" ||
    !directCanary.if.includes("vars.CLAUDE_DIRECT_CLI_CANARY == 'true'") ||
    directCanary["continue-on-error"] !== true ||
    directCanary["timeout-minutes"] !==
      "${{ fromJSON(vars.CLAUDE_REVIEW_TIMEOUT_MINUTES || '30') }}" ||
    Object.keys(directCanaryPermissions).sort().join("\0") !==
      ["contents", "pull-requests"].sort().join("\0") ||
    directCanaryPermissions.contents !== "read" ||
    directCanaryPermissions["pull-requests"] !== "read"
  ) {
    errors.push("Direct CLI canary must stay opt-in, non-blocking, and read-only");
  }
  const directCanaryInstall = directCanary?.steps?.find(
    (step) => step.name === "Install pinned Claude CLI",
  );
  const directCanaryStep = directCanary?.steps?.find((step) => step.id === "direct");
  const directCanaryRun = directCanaryStep?.run ?? "";
  const directCanaryEnv = directCanaryStep?.env ?? {};
  const analyzeSteps = review?.jobs?.analyze?.steps ?? [];
  const directCanarySteps = directCanary?.steps ?? [];
  const reviewActionIndex = analyzeSteps.findIndex((step) => step.id === "claude");
  const reviewAction = analyzeSteps[reviewActionIndex];
  const reviewTimerIndex = analyzeSteps.findIndex(
    (step) => step.name === "Start Claude Action timer",
  );
  const reviewTimer = analyzeSteps[reviewTimerIndex];
  const reviewConfigIndex = analyzeSteps.findIndex((step) => step.id === "validate-config");
  const reviewConfig = analyzeSteps[reviewConfigIndex];
  const reviewMetrics = analyzeSteps[reviewActionIndex + 1];
  const directCanaryStepIndex = directCanarySteps.findIndex((step) => step.id === "direct");
  const directCanaryTimerIndex = directCanarySteps.findIndex(
    (step) => step.name === "Start direct CLI timer",
  );
  const directCanaryTimer = directCanarySteps[directCanaryTimerIndex];
  const reviewSchema = reviewAction?.with?.claude_args?.match(
    /--json-schema '(.+)'/s,
  )?.[1];
  const directCanaryEnvKeys = Object.keys(directCanaryEnv).sort();
  const reviewConfigEnv = reviewConfig?.env ?? {};
  const reviewMetricsEnv = reviewMetrics?.env ?? {};
  if (
    directCanaryInstall?.run !==
      "npm install --global @anthropic-ai/claude-code@2.1.220" ||
    directCanaryStep?.uses ||
    directCanaryRun !== "bash .github/scripts/run-claude-direct-canary.sh" ||
    directCanaryEnvKeys.join("\0") !==
      [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_REVIEW_MAX_TURNS",
        "CLAUDE_REVIEW_MODEL",
        "CLAUDE_REVIEW_PROMPT",
        "CLAUDE_REVIEW_SCHEMA",
        "EXPECTED_HEAD_SHA",
        "GH_TOKEN",
      ]
        .sort()
        .join("\0") ||
    directCanaryEnv.ANTHROPIC_API_KEY !== "${{ secrets.ANTHROPIC_API_KEY }}" ||
    directCanaryEnv.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
    directCanaryEnv.CLAUDE_REVIEW_MAX_TURNS !==
      "${{ fromJSON(vars.CLAUDE_REVIEW_MAX_TURNS || '30') }}" ||
    directCanaryEnv.CLAUDE_REVIEW_PROMPT !== reviewAction?.with?.prompt ||
    directCanaryEnv.CLAUDE_REVIEW_SCHEMA !== reviewSchema ||
    directCanaryEnv.CLAUDE_REVIEW_MODEL !== "${{ secrets.CLAUDE_REVIEW_MODEL }}" ||
    directCanaryEnv.EXPECTED_HEAD_SHA !==
      "${{ github.event.workflow_run.head_sha }}" ||
    directCanaryEnv.GH_TOKEN !== "${{ github.token }}" ||
    reviewConfig?.run !== "node .github/scripts/validate-claude-review-config.mjs" ||
    Object.keys(reviewConfigEnv).sort().join("\0") !==
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_REVIEW_MODEL"]
        .sort()
        .join("\0") ||
    reviewConfigEnv.ANTHROPIC_API_KEY !== "${{ secrets.ANTHROPIC_API_KEY }}" ||
    reviewConfigEnv.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
    reviewConfigEnv.CLAUDE_REVIEW_MODEL !== "${{ secrets.CLAUDE_REVIEW_MODEL }}" ||
    reviewTimerIndex < 0 ||
    reviewTimerIndex >= reviewConfigIndex ||
    reviewConfigIndex >= reviewActionIndex ||
    reviewAction?.env?.ANTHROPIC_BASE_URL !== "${{ secrets.ANTHROPIC_BASE_URL }}" ||
    reviewAction?.with?.show_full_output !==
      "${{ vars.CLAUDE_DIRECT_CLI_CANARY != 'true' && vars.CLAUDE_REVIEW_VERBOSE == 'true' }}" ||
    !reviewAction?.with?.claude_args?.includes(
      '--model "${{ secrets.CLAUDE_REVIEW_MODEL }}"',
    ) ||
    reviewTimer?.run !==
      'echo "CLAUDE_ACTION_STARTED_MS=$(date +%s%3N)" >> "$GITHUB_ENV"' ||
    reviewMetrics?.name !== "Record Claude Action metrics" ||
    reviewMetrics?.if !== "always()" ||
    reviewMetrics?.["continue-on-error"] !== true ||
    reviewMetrics?.run !== "node .github/scripts/summarize-claude-review.mjs" ||
    Object.keys(reviewMetricsEnv).sort().join("\0") !==
      [
        "CLAUDE_METRICS_FORMAT",
        "CLAUDE_METRICS_RESULT_FILE",
        "CLAUDE_METRICS_STARTED_MS",
        "CLAUDE_METRICS_STATUS",
        "EXPECTED_HEAD_SHA",
      ]
        .sort()
        .join("\0") ||
    reviewMetricsEnv.CLAUDE_METRICS_FORMAT !== "action" ||
    reviewMetricsEnv.CLAUDE_METRICS_RESULT_FILE !==
      "${{ steps.claude.outputs.execution_file }}" ||
    reviewMetricsEnv.CLAUDE_METRICS_STARTED_MS !==
      "${{ env.CLAUDE_ACTION_STARTED_MS }}" ||
    reviewMetricsEnv.CLAUDE_METRICS_STATUS !== "${{ steps.claude.outcome }}" ||
    reviewMetricsEnv.EXPECTED_HEAD_SHA !==
      "${{ github.event.workflow_run.head_sha }}" ||
    directCanaryTimer?.run !==
      'echo "CLAUDE_DIRECT_STARTED_MS=$(date +%s%3N)" >> "$GITHUB_ENV"' ||
    directCanaryTimerIndex < 0 ||
    directCanaryTimerIndex >= directCanaryStepIndex
  ) {
    errors.push("Direct CLI canary execution is not approved");
  }
  if (JSON.stringify(review?.jobs?.publish ?? {}).includes("secrets.")) {
    errors.push("Claude Review publisher must not receive a model Secret");
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
      ["contents", "write"],
      ["pull-requests", "write"],
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

  const issueReview = workflows["claude-issue-review.yml"];
  for (const [jobName, job] of Object.entries(issueReview?.jobs ?? {})) {
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
    if (modelIndex >= 0 && (authorizeIndex < 0 || authorizeIndex >= modelIndex)) {
      errors.push(
        `claude-issue-review.yml/${jobName}: trusted authorization must run before model`,
      );
    }
    if (
      modelIndex >= 0 &&
      job.steps[modelIndex].if !== "steps.authorize.outputs.allowed == 'true'"
    ) {
      errors.push(
        `claude-issue-review.yml/${jobName}: model step must use trusted authorization output`,
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
    }
  }

  for (const step of workflowSteps(issueReview ?? {})) {
    if (!step.uses?.startsWith(CLAUDE_ACTION)) continue;
    const args = step.with?.claude_args ?? "";
    if (
      !args.includes('--allowedTools "Read,Grep,Glob"') ||
      !args.includes('--disallowedTools "Edit,Write,MultiEdit,Bash"') ||
      /--allowedTools\s+"[^"]*\b(?:Bash|Edit|Write)\b/.test(args)
    ) {
      errors.push("Issue Review model must stay read-only");
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
  const scripts = Object.fromEntries(
    await Promise.all(
      Object.keys(TRUSTED_SCRIPT_SHA256).map(async (name) => [
        name,
        await fs.readFile(path.resolve(name), "utf8"),
      ]),
    ),
  );
  const errors = [
    ...validateWorkflowDocuments(workflows),
    ...validateTrustedScriptDocuments(scripts),
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
