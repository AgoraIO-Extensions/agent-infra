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

function workflowSteps(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

export function validateWorkflowDocuments(workflows) {
  const errors = [];
  const names = Object.keys(workflows).sort();
  if (names.join("\0") !== REQUIRED_WORKFLOWS.join("\0")) {
    errors.push(`Expected workflows: ${REQUIRED_WORKFLOWS.join(", ")}`);
  }

  for (const [name, workflow] of Object.entries(workflows)) {
    if (!workflow.permissions) errors.push(`${name} must declare top-level permissions`);
    for (const step of workflowSteps(workflow)) {
      if (step.uses && !step.uses.startsWith("./") && !FULL_SHA_ACTION.test(step.uses)) {
        errors.push(`${name}: third-party Actions must use a full commit SHA`);
      }
      if (
        JSON.stringify(step).includes("secrets.") &&
        !step.uses?.startsWith(CLAUDE_ACTION)
      ) {
        errors.push(`${name}: model Secret is allowed only in an official Claude Action step`);
      }
    }
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
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
  const errors = validateWorkflowDocuments(workflows);
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(`Workflow policy: ${names.length} files valid`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
