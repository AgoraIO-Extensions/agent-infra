import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const REQUIRED_WORKFLOWS = [
  "auto-merge.yml",
  "claude-issue-review.yml",
  "claude-pr-review.yml",
  "codex-worker.yml",
  "docs-ci.yml",
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

function workflowSteps(workflow) {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

function sameObject(actual, expected) {
  return JSON.stringify(Object.entries(actual ?? {}).sort()) ===
    JSON.stringify(Object.entries(expected).sort());
}

function referencedSecrets(value) {
  return [...JSON.stringify(value ?? {}).matchAll(/secrets\.([A-Z0-9_]+)/g)].map(
    (match) => match[1],
  );
}

function isApprovedClaudeConfigStep(workflowName, jobName, step) {
  return (
    step.id === "validate-config" &&
    step.run === "node .github/scripts/validate-claude-review-config.mjs" &&
    ((workflowName === "claude-pr-review.yml" && jobName === "analyze") ||
      (workflowName === "claude-issue-review.yml" &&
        ["automatic-issue-review", "mentions"].includes(jobName)))
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
        jobName === "implement" &&
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
      if (
        workflowName !== "codex-worker.yml" ||
        jobName !== "publish" ||
        step.name !== "Publish fixed branch and Draft PR" ||
        step.run !== "node trusted/.github/scripts/codex-worker.mjs publish" ||
        step.env?.CODEX_GITHUB_TOKEN !== "${{ secrets.CODEX_GITHUB_TOKEN }}" ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: CODEX_GITHUB_TOKEN is allowed only in the fixed Worker publication step`,
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
    errors.push(`${workflowName}/${jobName}: Secret ${secret} is not allowlisted`);
  }
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
      for (const step of job.steps ?? []) {
        if (step.uses && !step.uses.startsWith("./") && !FULL_SHA_ACTION.test(step.uses)) {
          errors.push(`${name}: third-party Actions must use a full commit SHA`);
        }
        validateStepSecrets(errors, name, jobName, step);
      }
    }
    for (const secret of referencedSecrets(workflow.env)) {
      errors.push(`${name}: ${secret} is not allowed in workflow environment`);
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
            "${{ steps.prepare.outputs.start_sha }}",
            "${{ needs.implement.outputs.start_sha }}",
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

  const gates = workflows["pr-gates.yml"]?.jobs?.gates;

  const worker = workflows["codex-worker.yml"];
  const implement = worker?.jobs?.implement;
  const publish = worker?.jobs?.publish;
  const workerGroup = String(worker?.concurrency?.group ?? "");
  const workerCancellation = String(worker?.concurrency?.["cancel-in-progress"] ?? "");
  if (
    !workerGroup.includes("github.event.pull_request.head.repo.full_name != github.repository") ||
    !workerGroup.includes("github.event.pull_request.number") ||
    !workerGroup.includes("github.event.pull_request.head.ref") ||
    !workerGroup.includes("github.event.issue.number")
  ) {
    errors.push("Codex Worker concurrency must isolate external fork PRs");
  }
  if (
    !workerCancellation.includes("github.event.pull_request.head.repo.full_name") ||
    !workerCancellation.includes("github.repository")
  ) {
    errors.push("Codex Worker cancellation must require a same-repository PR");
  }
  if (
    JSON.stringify(implement?.permissions) !== JSON.stringify({ contents: "read" })
  ) {
    errors.push("Codex Worker implement job permissions must stay contents: read");
  }
  if (
    JSON.stringify(publish?.permissions) !==
    JSON.stringify({
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    })
  ) {
    errors.push("Codex Worker publish job permissions must stay minimal");
  }
  if (JSON.stringify(implement ?? {}).includes("CODEX_GITHUB_TOKEN")) {
    errors.push("Codex Worker model job must not contain CODEX_GITHUB_TOKEN");
  }
  if (JSON.stringify(publish ?? {}).includes("CODEX_API_KEY")) {
    errors.push("Codex Worker publisher must not contain CODEX_API_KEY");
  }
  if (
    implement?.outputs?.default_branch !==
    "${{ steps.prepare.outputs.default_branch }}"
  ) {
    errors.push("Codex Worker must expose a trusted default branch output");
  }

  const publishSteps = publish?.steps ?? [];
  for (const stepName of [
    "Validate Artifact before publisher credential exposure",
    "Publish fixed branch and Draft PR",
  ]) {
    const step = publishSteps.find((candidate) => candidate.name === stepName);
    if (
      step?.env?.WORKER_DEFAULT_BRANCH !==
      "${{ needs.implement.outputs.default_branch }}"
    ) {
      errors.push(`${stepName} must receive the trusted default branch input`);
    }
  }

  const implementSteps = implement?.steps ?? [];
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
        name: "codex-worker-output",
        path:
          "${{ github.workspace }}/workspace/.codex-worker-artifact/plan.json\n" +
          "${{ github.workspace }}/workspace/.codex-worker-artifact/output/change.patch\n" +
          "${{ github.workspace }}/workspace/.codex-worker-artifact/output/result.json\n",
        "if-no-files-found": "error",
        "include-hidden-files": true,
        "retention-days": 1,
      })
    ) {
      errors.push("Codex Worker Artifact upload contract must stay fixed");
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
      name: "codex-worker-output",
      path: "${{ runner.temp }}/codex-worker-artifact",
    })
  ) {
    errors.push("Codex Worker Artifact download contract must stay fixed");
  }

  for (const [jobName, job, expectedRef] of [
    ["implement", implement, "${{ steps.prepare.outputs.start_sha }}"],
    ["publish", publish, "${{ needs.implement.outputs.start_sha }}"],
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
      recordedCheckout?.with?.ref !== expectedRef ||
      recordedCheckout?.with?.path !== "workspace" ||
      recordedCheckout?.with?.["persist-credentials"] !== false
    ) {
      errors.push(`Codex Worker ${jobName} recorded checkout must use workspace`);
    }
  }

  const review = workflows["claude-pr-review.yml"];
  if (!review?.on?.workflow_run?.workflows?.includes("Docs CI")) {
    errors.push("Claude PR Review must run only after Docs CI");
  }
  const analyzeSteps = review?.jobs?.analyze?.steps ?? [];
  const reviewActionIndex = analyzeSteps.findIndex((step) => step.id === "claude");
  const reviewAction = analyzeSteps[reviewActionIndex];
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
  if (JSON.stringify(review?.jobs?.publish ?? {}).includes("secrets.")) {
    errors.push("Claude Review publisher must not receive a model Secret");
  }
  const reviewArgs = reviewAction?.with?.claude_args ?? "";
  const allowedToolFlags = reviewArgs.match(/--allowedTools\s+"[^"]*"/g) ?? [];
  const disallowedToolFlags = reviewArgs.match(/--disallowedTools\s+"[^"]*"/g) ?? [];
  if (
    JSON.stringify(allowedToolFlags) !==
      JSON.stringify([
        '--allowedTools "Read,Grep,Bash(gh pr diff:*),Bash(gh pr view:*)"',
      ]) ||
    JSON.stringify(disallowedToolFlags) !==
      JSON.stringify([
        '--disallowedTools "Glob,Edit,Write,MultiEdit,WebFetch,WebSearch"',
      ])
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
    const configIndex = (job.steps ?? []).findIndex((step) => step.id === "validate-config");
    const configStep = job.steps?.[configIndex];
    const modelStep = job.steps?.[modelIndex];
    const configEnv = configStep?.env ?? {};
    if (modelIndex >= 0 && (authorizeIndex < 0 || authorizeIndex >= modelIndex)) {
      errors.push(
        `claude-issue-review.yml/${jobName}: trusted authorization must run before model`,
      );
    }
    if (
      modelIndex >= 0 &&
      modelStep.if !== "steps.authorize.outputs.allowed == 'true'"
    ) {
      errors.push(
        `claude-issue-review.yml/${jobName}: model step must use trusted authorization output`,
      );
    }
    if (
      modelIndex >= 0 &&
      (configIndex !== authorizeIndex + 1 ||
        modelIndex !== configIndex + 1 ||
        configStep?.if !== "steps.authorize.outputs.allowed == 'true'" ||
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
