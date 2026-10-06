import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const REQUIRED_WORKFLOWS = ["auto-merge.yml", "ci.yml", "connection-github-e2e.yml", "pr-agent-review.yml", "pr-gates.yml", "publish-images.yml"];

const FULL_SHA_ACTION = /^[^@]+@[0-9a-f]{40}$/;

const PR_AGENT_ACTION =
  "docker://pragent/pr-agent@sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6";

const PR_AGENT_SECRETS = [
  "PR_AGENT_API_KEY",
  "PR_AGENT_API_BASE",
  "PR_AGENT_MODEL",
];

const TEAM_MEMBERSHIP_TOKEN_ACTION =
  "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";

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

function validateStepSecrets(errors, workflowName, jobName, step) {
  for (const secret of referencedSecrets(step)) {
    const occurrences = referencedSecrets(step).filter(
      (reference) => reference === secret,
    ).length;
    if (secret === "CONNECTION_E2E_TOKEN") {
      if (
        workflowName !== "connection-github-e2e.yml" ||
        jobName !== "conformance" ||
        step.name !== "Run deterministic Connection GitHub conformance" ||
        step.run !==
          'set -o pipefail\nnode tests/github-connection-e2e.mjs \\\n  "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" 2>&1 | tee connection-github-e2e-result.json\n' ||
        step.env?.CONNECTION_E2E_TOKEN !==
          "${{ secrets.CONNECTION_E2E_TOKEN }}" ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: CONNECTION_E2E_TOKEN is allowed only in the fixed GitHub conformance step`,
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
        PR_AGENT_API_KEY: "OPENAI_KEY",
        PR_AGENT_API_BASE: "OPENAI__API_BASE",
        PR_AGENT_MODEL: "CONFIG__MODEL",
      }[secret];
      if (
        workflowName !== "pr-agent-review.yml" ||
        jobName !== "review" ||
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
        jobName === "human";
      if (
        !allowedMembershipLocation ||
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

export function validateWorkflowDocuments(workflows) {
  const errors = [];
  if (Object.keys(workflows).sort().join("\0") !== REQUIRED_WORKFLOWS.join("\0")) {
    errors.push(`Expected workflows: ${REQUIRED_WORKFLOWS.join(", ")}`);
  }
  if (workflows["ci.yml"]?.name !== "CI" || workflows["ci.yml"]?.jobs?.ci?.name !== "CI") {
    errors.push("CI workflow and required check must both use the CI name");
  }
  for (const [name, workflow] of Object.entries(workflows)) {
    const runName = workflow["run-name"];
    if (typeof runName !== "string" || !runName.includes(" | ") ||
        /\b(?:title|body|comment|message|prompt|transcript|model_output)\b/i.test(runName) ||
        referencedSecrets(runName).length) {
      errors.push(`${name} must use a fixed safe run-name`);
    }
    if (referencedSecrets(workflow.env).length || teamMembershipTokenReferences(workflow.env).length) {
      errors.push(`${name}: Secrets and membership tokens require step scope`);
    }
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (referencedSecrets(job.env).length || teamMembershipTokenReferences(job.env).length) {
        errors.push(`${name}/${jobName}: Secrets and membership tokens require step scope`);
      }
      if (workflow.on?.pull_request_target && /pull_request\.head\.(?:ref|sha)/.test(JSON.stringify(job))) {
        errors.push(`${name}/${jobName}: pull_request_target jobs must not execute PR head`);
      }
      for (const step of job.steps ?? []) {
        if (step.uses && !FULL_SHA_ACTION.test(step.uses) && step.uses !== PR_AGENT_ACTION) {
          errors.push(`${name}: third-party Actions must use a full commit SHA`);
        }
        validateStepSecrets(errors, name, jobName, step);
        const refs = teamMembershipTokenReferences(step);
        if (refs.length && !(refs.length === 1 && name === "pr-gates.yml" && jobName === "human" &&
            step.run === "node .github/scripts/pr-gates.mjs human" &&
            step.env?.TEAM_MEMBERSHIP_TOKEN === "${{ steps.team-membership-token.outputs.token }}")) {
          errors.push(`${name}/${jobName}: Team membership token is allowed only in human validation`);
        }
        if (workflow.on?.pull_request_target && step.uses?.startsWith("actions/checkout@") &&
            (step.with?.ref !== "${{ github.event.repository.default_branch }}" || step.with?.["persist-credentials"] !== false)) {
          errors.push(`${name}/${jobName}: checkout must use the trusted default branch without credentials`);
        }
      }
    }
  }
  const gates = workflows["pr-gates.yml"];
  const issue = gates?.jobs?.issue;
  const human = gates?.jobs?.human;
  const memberStep = human?.steps?.find((step) => step.id === "team-membership-token");
  const humanStep = human?.steps?.find((step) => step.run === "node .github/scripts/pr-gates.mjs human");
  if (Object.keys(gates?.jobs ?? {}).sort().join() !== "human,issue" ||
      Object.keys(gates?.on ?? {}).join() !== "pull_request_target" ||
      JSON.stringify(gates?.on?.pull_request_target?.types) !== JSON.stringify([
        "opened", "reopened", "synchronize", "edited", "labeled", "unlabeled", "ready_for_review",
      ]) ||
      !sameObject(gates?.concurrency, {group: "pr-gates-${{ github.event.pull_request.number }}", "cancel-in-progress": true}) ||
      issue?.name !== "Issue Gate" || human?.name !== "Human Validation Gate" ||
      !sameObject(issue?.permissions, {contents: "read", issues: "read", "pull-requests": "read"}) ||
      !sameObject(human?.permissions, {contents: "read", issues: "read", "pull-requests": "write"}) ||
      !issue?.steps?.some((step) => step.run === "node .github/scripts/pr-gates.mjs issue" &&
        sameObject(step.env, {GITHUB_TOKEN: "${{ github.token }}"})) ||
      humanStep?.if !== "always()" || !sameObject(humanStep?.env, {
        GITHUB_TOKEN: "${{ github.token }}", TEAM_MEMBERSHIP_TOKEN: "${{ steps.team-membership-token.outputs.token }}",
      }) ||
      memberStep?.uses !== TEAM_MEMBERSHIP_TOKEN_ACTION || !sameObject(memberStep?.with, {
        "app-id": "${{ secrets.TEAM_MEMBERSHIP_APP_ID }}", "private-key": "${{ secrets.TEAM_MEMBERSHIP_APP_PRIVATE_KEY }}",
        owner: "${{ github.repository_owner }}", "permission-members": "read",
      }) || /GATE_CHECK_TOKEN|permission-checks|check-runs/.test(JSON.stringify(gates))) {
    errors.push("PR Gates must use two native jobs and a read-only Team membership token");
  }
  const autoMerge = workflows["auto-merge.yml"];
  const enrollment = autoMerge?.jobs?.enroll;
  if (Object.keys(autoMerge?.jobs ?? {}).join() !== "enroll" ||
      JSON.stringify(autoMerge?.on?.pull_request_target?.types) !== JSON.stringify(["opened", "reopened", "ready_for_review"]) ||
      !sameObject(autoMerge?.concurrency, {group: "auto-merge-${{ github.event.pull_request.number }}", "cancel-in-progress": true})) {
    errors.push("Auto-merge Enrollment events and concurrency must stay fixed");
  }
  if (!sameObject(enrollment?.permissions, {contents: "read"})) {
    errors.push("Auto-merge Enrollment permissions must stay minimal");
  }
  const enrollmentText = JSON.stringify(enrollment ?? {});
  if (/\bgh pr merge\b|\bmergePullRequest\b|--admin/.test(enrollmentText)) {
    errors.push("Auto-merge Enrollment must only enroll native auto-merge");
  }
  if (!enrollmentText.includes("head.repo.full_name") || !enrollmentText.includes("repository.default_branch")) {
    errors.push("Auto-merge Enrollment must restrict eligibility");
  }
  const enrollmentStep = enrollment?.steps?.find((step) => step.name === "Enable native Squash auto-merge");
  if (enrollmentStep?.run !== "node .github/scripts/auto-merge.mjs" ||
      !sameObject(enrollmentStep?.env, {GITHUB_TOKEN: "${{ secrets.GH_TOKEN }}"})) {
    errors.push("Auto-merge Enrollment must use the fixed repository Secret");
  }
  const publish = workflows["publish-images.yml"];
  if (publish?.name !== "Publish images" ||
      !sameObject(publish?.permissions, { contents: "read", packages: "write" }) ||
      !publish?.jobs?.infrastructure || !publish?.jobs?.["infrastructure-index"] ||
      !publish?.jobs?.platform || !publish?.jobs?.["platform-index"]) {
    errors.push("Publish images must keep the GHCR jobs and minimal package permissions");
  }
  return errors;
}

async function main() {
  const directory = path.resolve(".github/workflows");
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".yml"));
  const workflows = Object.fromEntries(await Promise.all(names.map(async (name) => [
    name, YAML.parse(await fs.readFile(path.join(directory, name), "utf8")),
  ])));
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
