import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const REQUIRED_WORKFLOWS = ["ack-image-cache.yml", "auto-merge.yml", "ci-runner.yml", "ci-waiver.yml", "ci.yml", "connection-github-e2e.yml", "deploy-production.yml", "mirror-images.yml", "pr-agent-review.yml", "pr-gates.yml", "publish-images.yml", "publish-signed-own-entry.yml", "qualify-runtime-file-bridge.yml", "secret-scan.yml"];

// Label events must never start a CI run: a newer run without the required CI
// check hides the passing one and leaves the PR BLOCKED (#3935). ci:skip
// changes rerun the head's latest CI run through ci-waiver.yml instead.
const CI_PULL_REQUEST_TYPES = ["opened", "synchronize", "reopened"];
const CI_NOT_WAIVED = "needs.ci-exemption.result != 'success' || needs.ci-exemption.outputs.skip != 'true'";
const CI_JOB_CONDITIONS = {
  "ci-exemption": undefined,
  "changes": "${{ always() && !cancelled() }}",
  "prepare-web-browser": "${{ !cancelled() && needs.ci-exemption.result == 'success' && needs.ci-exemption.outputs.skip != 'true' && needs.changes.result == 'success' && needs.changes.outputs.source == 'true' && needs.changes.outputs.web == 'true' && needs.ci-exemption.outputs.linux == 'ack-eci' }}",
  "web-tests": "${{ !cancelled() && needs.ci-exemption.result == 'success' && needs.ci-exemption.outputs.skip != 'true' && needs.changes.result == 'success' && needs.changes.outputs.source == 'true' && needs.changes.outputs.web == 'true' && (needs.ci-exemption.outputs.linux != 'ack-eci' || needs.prepare-web-browser.result == 'success') }}",
  "backend-tests": "${{ !cancelled() && needs.ci-exemption.result == 'success' && needs.ci-exemption.outputs.skip != 'true' && needs.changes.result == 'success' && needs.changes.outputs.source == 'true' }}",
  "backend-package-tests": "${{ !cancelled() && needs.ci-exemption.result == 'success' && needs.ci-exemption.outputs.skip != 'true' && needs.changes.result == 'success' && needs.changes.outputs.source == 'true' }}",
  "backend-contracts-tests": "${{ !cancelled() && needs.ci-exemption.result == 'success' && needs.ci-exemption.outputs.skip != 'true' && needs.changes.result == 'success' && needs.changes.outputs.source == 'true' }}",
  "ci_heavy": `\${{ always() && !cancelled() && (${CI_NOT_WAIVED}) }}`,
  "workload-kind": `\${{ !cancelled() && (${CI_NOT_WAIVED}) && (needs.changes.result != 'success' || github.event_name == 'push' || needs.changes.outputs.workload == 'true') }}`,
};

const FULL_SHA_ACTION = /^[^@]+@[0-9a-f]{40}$/;

const PR_AGENT_ACTION =
  "docker://pragent/pr-agent@sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6";

const PR_AGENT_SECRETS = [
  "PR_AGENT_API_KEY",
  "PR_AGENT_API_BASE",
  "PR_AGENT_MODEL",
];

const MIRROR_SECRETS = [
  "MIRROR_REPOSITORY_PREFIX",
  "MIRROR_REGISTRY_USERNAME",
  "MIRROR_REGISTRY_PASSWORD",
  "MIRROR_SOURCE_PREFIXES",
];

// The internal registry push credential is the only production-related Secret on GitHub (workflow Spec §10.4).
const MIRROR_COPY_STEP = {
  name: "Copy manifests to the internal registry",
  run: 'node deploy/release/image-mirror.ts copy "$RUNNER_TEMP/mirror-plan.json" "$RUNNER_TEMP/mirror-receipt.json"',
  env: {
    GHCR_TOKEN: "${{ github.token }}",
    MIRROR_REPOSITORY_PREFIX: "${{ secrets.MIRROR_REPOSITORY_PREFIX }}",
    MIRROR_REGISTRY_USERNAME: "${{ secrets.MIRROR_REGISTRY_USERNAME }}",
    MIRROR_REGISTRY_PASSWORD: "${{ secrets.MIRROR_REGISTRY_PASSWORD }}",
    MIRROR_SOURCE_PREFIXES: "${{ secrets.MIRROR_SOURCE_PREFIXES }}",
  },
};

function sameObject(actual, expected) {
  return JSON.stringify(Object.entries(actual ?? {}).sort()) ===
    JSON.stringify(Object.entries(expected).sort());
}

function referencedSecrets(value) {
  return [...JSON.stringify(value ?? {}).matchAll(/secrets\.([A-Z0-9_]+)/gi)].map(
    (match) => match[1],
  );
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
    if (MIRROR_SECRETS.includes(secret)) {
      if (
        workflowName !== "mirror-images.yml" ||
        jobName !== "mirror" ||
        step.name !== MIRROR_COPY_STEP.name ||
        step.run !== MIRROR_COPY_STEP.run ||
        !sameObject(step.env, MIRROR_COPY_STEP.env) ||
        occurrences !== 1
      ) {
        errors.push(
          `${workflowName}/${jobName}: ${secret} is allowed only in the fixed registry copy step`,
        );
      }
      continue;
    }
    errors.push(`${workflowName}/${jobName}: Secret ${secret} is not allowlisted`);
  }
}

// The production deploy executor (workflow Spec §10.3): only main, credential-free in-cluster
// runners, GitHub OIDC as the only cluster identity, and a separate approval Environment.
const DEPLOY_RUNNER = "agent-infra-deploy";
const DEPLOY_JOB_PERMISSIONS = {contents: "read", "id-token": "write"};
const DEPLOY_ADMISSION = "github.repository == 'AgoraIO-Extensions/agent-infra' && github.ref == 'refs/heads/main'";
const DEPLOY_APPLY_ADMISSION = "!cancelled() && needs.plan.result == 'success' && needs.plan.outputs.apply == 'true' && (needs.approve.result == 'success' || (needs.approve.result == 'skipped' && needs.plan.outputs.approval_required == 'false'))";
const DEPLOY_INPUT_ENV = {
  DEPLOY_COMMAND: "${{ inputs.command }}",
  DEPLOY_HELM_COMMIT: "${{ inputs.helm_commit }}",
  DEPLOY_REVISION: "${{ inputs.revision }}",
  KUBERNETES_OIDC_AUDIENCE: "${{ vars.KUBERNETES_OIDC_AUDIENCE }}",
};
const deploySetupSteps = [
  {name: "Checkout trusted executor code", uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", with: {ref: "${{ github.sha }}", "persist-credentials": false}},
  {name: "Set up Node.js", uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020", with: {"node-version": 24}},
  {name: "Install deploy tools", run: "bash deploy/ack/install-deploy-tools.sh"},
];
const deployReceiptStep = (phase) => ({
  name: `Upload ${phase} receipt`,
  if: "${{ always() }}",
  uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  with: {name: `deploy-${phase}-receipt-\${{ github.run_attempt }}`, path: "${{ runner.temp }}/deploy-receipt.json", "if-no-files-found": "ignore"},
});
const DEPLOY_STEPS = {
  plan: [...deploySetupSteps, {name: "Plan", id: "plan", env: DEPLOY_INPUT_ENV, run: "node deploy/ack/production-deploy.ts plan"}, deployReceiptStep("plan")],
  apply: [...deploySetupSteps, {
    name: "Apply",
    env: {
      ...DEPLOY_INPUT_ENV,
      PLANNED_HELM_COMMIT: "${{ needs.plan.outputs.helm_commit }}",
      PLANNED_REASONS: "${{ needs.plan.outputs.approval_reasons }}",
      APPROVAL_RESULT: "${{ needs.approve.result }}",
    },
    run: "node deploy/ack/production-deploy.ts apply",
  }, deployReceiptStep("apply")],
};

function validateDeployProduction(errors, workflows) {
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      const onDeployRunner = JSON.stringify(job["runs-on"] ?? "").includes(DEPLOY_RUNNER);
      const deployJob = name === "deploy-production.yml" && (jobName === "plan" || jobName === "apply");
      if (onDeployRunner && !deployJob)
        errors.push(`${name}/${jobName}: only the deploy-production plan and apply jobs may use the ${DEPLOY_RUNNER} runner`);
      if (job.environment === "production" && !deployJob)
        errors.push(`${name}/${jobName}: only the deploy-production plan and apply jobs may use the production Environment`);
    }
  }
  const deploy = workflows["deploy-production.yml"];
  const jobs = deploy?.jobs ?? {};
  const inputs = deploy?.on?.workflow_dispatch?.inputs ?? {};
  const deployJobValid = (job, phase) =>
    job?.["runs-on"] === DEPLOY_RUNNER &&
    job?.environment === "production" &&
    sameObject(job?.permissions, DEPLOY_JOB_PERMISSIONS) &&
    JSON.stringify(job?.steps ?? []) === JSON.stringify(DEPLOY_STEPS[phase]);
  if (deploy?.name !== "Deploy production" ||
      Object.keys(deploy?.on ?? {}).join() !== "workflow_dispatch" ||
      Object.keys(inputs).sort().join() !== "command,helm_commit,revision" ||
      JSON.stringify(inputs.command?.options) !== JSON.stringify(["status", "diff", "deploy", "verify", "accept", "rollback"]) ||
      !sameObject(deploy?.permissions, {}) ||
      !sameObject(deploy?.concurrency, {group: "deploy-production", "cancel-in-progress": false}) ||
      Object.keys(jobs).sort().join() !== "apply,approve,plan" ||
      jobs.plan?.if !== DEPLOY_ADMISSION ||
      !deployJobValid(jobs.plan, "plan") ||
      jobs.approve?.needs !== "plan" ||
      jobs.approve?.if !== "needs.plan.outputs.approval_required == 'true'" ||
      jobs.approve?.["runs-on"] !== "ubuntu-24.04" ||
      jobs.approve?.environment !== "production-approval" ||
      !sameObject(jobs.approve?.permissions, {}) ||
      (jobs.approve?.steps ?? []).some((step) => step.uses) ||
      JSON.stringify(jobs.apply?.needs) !== JSON.stringify(["plan", "approve"]) ||
      jobs.apply?.if?.replace(/\s+/gu, " ").trim() !== DEPLOY_APPLY_ADMISSION ||
      !deployJobValid(jobs.apply, "apply"))
    errors.push("Deploy production must run only trusted main code on the credential-free deploy runner with OIDC and separate approval");
}

export function validateWorkflowDocuments(workflows) {
  const errors = [];
  if (Object.keys(workflows).sort().join("\0") !== REQUIRED_WORKFLOWS.join("\0")) {
    errors.push(`Expected workflows: ${REQUIRED_WORKFLOWS.join(", ")}`);
  }
  const ci = workflows["ci.yml"];
  if (ci?.name !== "CI" || ci.jobs?.ci?.name !== "CI") {
    errors.push("CI workflow and required check must keep the fixed CI name");
  }
  if (Object.keys(ci?.on ?? {}).sort().join() !== "pull_request,push" ||
      JSON.stringify(ci?.on?.pull_request?.types) !== JSON.stringify(CI_PULL_REQUEST_TYPES) ||
      JSON.stringify(ci?.on?.push?.branches) !== JSON.stringify(["main"])) {
    errors.push("CI must run only for PR source events and main pushes, never label events");
  }
  if (!sameObject(ci?.concurrency, {
    group: "ci-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  })) errors.push("CI must keep one validation concurrency group per PR or ref");
  if (Object.keys(ci?.jobs ?? {}).sort().join() !== [...Object.keys(CI_JOB_CONDITIONS), "ci"].sort().join())
    errors.push("CI jobs must retain the guarded validation lanes");
  for (const [name, condition] of Object.entries(CI_JOB_CONDITIONS)) {
    if (ci?.jobs?.[name]?.if !== condition)
      errors.push(`CI/${name}: job admission must retain the exact validation condition`);
  }
  if (ci?.jobs?.ci?.if !== "${{ always() && !cancelled() }}")
    errors.push("CI aggregate must always run to report waivers and failed lanes");
  const aggregateConditions = {
    "Require CI lanes": `\${{ (${CI_NOT_WAIVED}) && (needs.ci-exemption.result != 'success' || needs.changes.result != 'success' || needs.ci_heavy.result != 'success' || (needs.changes.outputs.source == 'true' && ((needs.changes.outputs.web == 'true' && needs.web-tests.result != 'success') || needs.backend-tests.result != 'success' || needs.backend-package-tests.result != 'success' || needs.backend-contracts-tests.result != 'success'))) }}`,
    "Report completed CI lanes": `\${{ ${CI_NOT_WAIVED} }}`,
    "Report CI waiver": "${{ needs.ci-exemption.result == 'success' && needs.ci-exemption.outputs.skip == 'true' }}",
  };
  const aggregateSteps = ci?.jobs?.ci?.steps ?? [];
  if (aggregateSteps.map((step) => step.name).sort().join() !== Object.keys(aggregateConditions).sort().join() ||
      aggregateSteps.some((step) => !Object.hasOwn(aggregateConditions, step.name) || step.if !== aggregateConditions[step.name]))
    errors.push("CI aggregate must separate validation and live-waiver reporting");
  const waiver = workflows["ci-waiver.yml"];
  const waiverJob = waiver?.jobs?.rerun;
  const waiverStep = waiverJob?.steps?.find((step) => step.name === "Rerun the latest CI run of the current head");
  if (waiver?.name !== "CI waiver" ||
      Object.keys(waiver?.on ?? {}).join() !== "pull_request_target" ||
      JSON.stringify(waiver?.on?.pull_request_target?.types) !== JSON.stringify(["labeled", "unlabeled"]) ||
      JSON.stringify(waiver?.permissions) !== "{}" ||
      !sameObject(waiver?.concurrency, {group: "ci-waiver-${{ (github.event.label.name == 'ci:skip' || github.event.label.name == 'ci:self-hosted') && github.event.pull_request.number || github.run_id }}", "cancel-in-progress": true}) ||
      Object.keys(waiver?.jobs ?? {}).join() !== "rerun" ||
      waiverJob?.name !== "Re-evaluate CI exemption" ||
      waiverJob?.if !== "(github.event.label.name == 'ci:skip' || github.event.label.name == 'ci:self-hosted') && github.event.pull_request.head.repo.full_name == github.repository" ||
      !sameObject(waiverJob?.permissions, {actions: "write", contents: "read"}) ||
      waiverStep?.run !== "node .github/scripts/ci-waiver.mjs" ||
      !sameObject(waiverStep?.env, {GITHUB_TOKEN: "${{ github.token }}"})) {
    errors.push("CI waiver must only rerun CI for ci:skip changes with minimal permissions");
  }
  for (const [name, workflow] of Object.entries(workflows)) {
    const runName = workflow["run-name"];
    if (typeof runName !== "string" || !runName.includes(" | ") ||
        /\b(?:title|body|comment|message|prompt|transcript|model_output)\b/i.test(runName) ||
        referencedSecrets(runName).length) {
      errors.push(`${name} must use a fixed safe run-name`);
    }
    if (referencedSecrets(workflow.env).length) {
      errors.push(`${name}: Secrets require step scope`);
    }
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      if (referencedSecrets(job.env).length) {
        errors.push(`${name}/${jobName}: Secrets require step scope`);
      }
      if (workflow.on?.pull_request_target && /pull_request\.head\.(?:ref|sha)/.test(JSON.stringify(job))) {
        errors.push(`${name}/${jobName}: pull_request_target jobs must not execute PR head`);
      }
      for (const step of job.steps ?? []) {
        if (step.uses && !FULL_SHA_ACTION.test(step.uses) && step.uses !== PR_AGENT_ACTION) {
          errors.push(`${name}: third-party Actions must use a full commit SHA`);
        }
        validateStepSecrets(errors, name, jobName, step);
        if (workflow.on?.pull_request_target && step.uses?.startsWith("actions/checkout@") &&
            (step.with?.ref !== "${{ github.event.repository.default_branch }}" || step.with?.["persist-credentials"] !== false)) {
          errors.push(`${name}/${jobName}: checkout must use the trusted default branch without credentials`);
        }
      }
    }
  }
  const gates = workflows["pr-gates.yml"];
  const issue = gates?.jobs?.issue;
  if (Object.keys(gates?.jobs ?? {}).join() !== "issue" ||
      Object.keys(gates?.on ?? {}).join() !== "pull_request_target" ||
      JSON.stringify(gates?.on?.pull_request_target?.types) !== JSON.stringify([
        "opened", "reopened", "synchronize", "edited", "ready_for_review",
      ]) ||
      !sameObject(gates?.concurrency, {group: "pr-gates-${{ github.event.pull_request.number }}", "cancel-in-progress": true}) ||
      issue?.name !== "Issue Gate" ||
      !sameObject(issue?.permissions, {contents: "read", issues: "read", "pull-requests": "read"}) ||
      !issue?.steps?.some((step) => step.run === "node .github/scripts/pr-gates.mjs issue" &&
        sameObject(step.env, {GITHUB_TOKEN: "${{ github.token }}"}))) {
    errors.push("PR Gates must use the Issue Gate job only");
  }
  const autoMerge = workflows["auto-merge.yml"];
  const enrollment = autoMerge?.jobs?.enroll;
  if (Object.keys(autoMerge?.jobs ?? {}).join() !== "enroll" ||
      JSON.stringify(autoMerge?.on?.pull_request_target?.types) !== JSON.stringify(["opened", "reopened", "ready_for_review"]) ||
      JSON.stringify(autoMerge?.on?.pull_request_review?.types) !== JSON.stringify(["submitted", "edited", "dismissed"]) ||
      JSON.stringify(autoMerge?.on?.pull_request_review_comment?.types) !== JSON.stringify(["created", "edited", "deleted"]) ||
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
  const cacheAdmission = "github.repository == 'AgoraIO-Extensions/agent-infra' && github.ref == 'refs/heads/main' && (github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_repository.full_name == github.repository))";
  const cache = workflows["ack-image-cache.yml"];
  const cacheJobs = cache?.jobs ?? {};
  if (cache?.name !== "ACK image cache plan" ||
      Object.keys(cache.on ?? {}).sort().join() !== "workflow_dispatch,workflow_run" ||
      JSON.stringify(cache.on?.workflow_run) !== JSON.stringify({workflows: ["Publish images"], types: ["completed"]}) ||
      !sameObject(cache.permissions, {contents: "read"}) ||
      Object.keys(cacheJobs).join() !== "prepare" ||
      cacheJobs.prepare?.if !== cacheAdmission ||
      cacheJobs.prepare?.environment !== "ack-image-cache" ||
      Object.keys(cache.on?.workflow_dispatch?.inputs ?? {}).sort().join() !== "publish_attempt,publish_run_id" ||
      !sameObject(cacheJobs.prepare?.permissions, {contents: "read", actions: "read"}) ||
      !sameObject(cache.concurrency, {group: "ack-image-cache-cn-hangzhou", "cancel-in-progress": false}))
    errors.push("ACK cache plan must use trusted publication validation without cloud identity");
  for (const job of Object.values(cacheJobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith("actions/checkout@") &&
          (step.with?.ref !== "${{ github.sha }}" || step.with?.["persist-credentials"] !== false))
        errors.push("ACK cache must execute only the trusted default-branch workflow SHA");
      if (step.uses?.startsWith("aliyun/configure-aliyun-credentials-action@"))
        errors.push("ACK cache plan workflow must not acquire cloud identity");
    }
  }
  const planSteps = cacheJobs.prepare?.steps ?? [];
  const planRun = planSteps.find(step => step.run);
  const planUpload = planSteps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  if (planSteps.length !== 4 || planSteps.filter(step => step.run).length !== 1 ||
      planRun?.run !== 'node deploy/ack/image-cache-release.ts "$PUBLISH_RUN_ID" "$PUBLISH_ATTEMPT" "$RUNNER_TEMP/cache-plan.json"' ||
      !sameObject(planRun?.env, {GH_TOKEN: "${{ github.token }}", PUBLISH_RUN_ID: "${{ github.event.workflow_run.id || inputs.publish_run_id }}", PUBLISH_ATTEMPT: "${{ github.event.workflow_run.run_attempt || inputs.publish_attempt }}"}) ||
      !sameObject(planUpload?.with, {name: "ack-cache-plan-${{ github.run_attempt }}", path: "${{ runner.temp }}/cache-plan.json", "if-no-files-found": "error"}))
    errors.push("ACK cache plan must validate the publication and upload only the immutable plan");
  const mirror = workflows["mirror-images.yml"];
  const mirrorJobs = mirror?.jobs ?? {};
  const mirrorSteps = mirrorJobs.mirror?.steps ?? [];
  const mirrorPlan = mirrorSteps.find((step) => step.name === "Plan manifests from the exact publication");
  const mirrorCopy = mirrorSteps.find((step) => step.name === MIRROR_COPY_STEP.name);
  if (mirror?.name !== "Mirror images" ||
      Object.keys(mirror.on ?? {}).sort().join() !== "workflow_dispatch,workflow_run" ||
      JSON.stringify(mirror.on?.workflow_run) !== JSON.stringify({workflows: ["Publish images"], types: ["completed"]}) ||
      Object.keys(mirror.on?.workflow_dispatch?.inputs ?? {}).sort().join() !== "publish_attempt,publish_run_id,references" ||
      !sameObject(mirror.permissions, {contents: "read"}) ||
      !sameObject(mirror.concurrency, {group: "mirror-images", "cancel-in-progress": false}) ||
      Object.keys(mirrorJobs).join() !== "mirror" ||
      mirrorJobs.mirror?.if !== cacheAdmission ||
      mirrorJobs.mirror?.["runs-on"] !== "agent-infra-mirror" ||
      mirrorJobs.mirror?.environment !== "internal-registry-mirror" ||
      !sameObject(mirrorJobs.mirror?.permissions, {contents: "read", actions: "read", packages: "read"}) ||
      mirrorPlan?.run !== 'node deploy/release/image-mirror.ts plan "$RUNNER_TEMP/mirror-plan.json"' ||
      referencedSecrets(mirrorPlan).length ||
      mirrorCopy?.run !== MIRROR_COPY_STEP.run ||
      mirrorSteps.filter((step) => referencedSecrets(step).length).length !== 1)
    errors.push("Mirror images must copy only trusted publications with step-scoped registry credentials");
  for (const step of mirrorSteps) {
    if (step.uses?.startsWith("actions/checkout@") &&
        (step.with?.ref !== "${{ github.sha }}" || step.with?.["persist-credentials"] !== false))
      errors.push("Mirror images must execute only the trusted default-branch workflow SHA");
    if (/kubeconfig|aliyun|kubectl/iu.test(JSON.stringify(step)))
      errors.push("Mirror images must not acquire cluster or cloud identity");
  }
  validateDeployProduction(errors, workflows);
  const publish = workflows["publish-images.yml"];
  if (publish?.name !== "Publish images" ||
      !sameObject(publish?.permissions, { contents: "read", packages: "write" }) ||
      !publish?.jobs?.infrastructure || !publish?.jobs?.["infrastructure-index"] ||
      !publish?.jobs?.platform || !publish?.jobs?.["platform-index"]) {
    errors.push("Publish images must keep the GHCR jobs and minimal package permissions");
  }
  const templates = publish?.jobs?.infrastructure;
  const templateBuild = templates?.steps?.find((step) => step.run?.includes("--images="));
  const templateMatrix = templates?.strategy?.matrix?.include;
  const dispatchInputs = publish?.on?.workflow_dispatch?.inputs;
  const smokeInput = dispatchInputs?.smoke;
  const fullReleaseInput = dispatchInputs?.full_release;
  const sourceShaInput = dispatchInputs?.source_sha;
  const sourceRef = "${{ github.event_name == 'workflow_dispatch' && inputs.full_release && inputs.source_sha || github.sha }}";
  const sourceSha = "${{ github.event_name == 'workflow_dispatch' && inputs.full_release && inputs.source_sha || github.sha }}";
  const sourceCheckouts = Object.values(publish?.jobs ?? {})
    .flatMap((job) => (job.steps ?? []).filter((step) => step.uses?.startsWith("actions/checkout@")));
  if (publish?.on?.push?.branches ||
      publish?.env?.RELEASE_SOURCE_SHA !== sourceSha ||
      publish?.env?.IMAGE_TAG !== "${{ github.event_name == 'workflow_dispatch' && inputs.smoke && format('smoke-{0}-{1}', github.run_id, github.run_attempt) || github.event_name == 'workflow_dispatch' && inputs.full_release && format('release-{0}', inputs.source_sha) || github.ref_name }}" ||
      fullReleaseInput?.type !== "boolean" ||
      fullReleaseInput?.default !== false ||
      sourceShaInput?.type !== "string" ||
      sourceShaInput?.default !== "" ||
      Object.hasOwn(dispatchInputs ?? {}, "publish_platform") ||
      !String(templates?.if ?? "").includes("inputs.full_release == true") ||
      !String(publish?.jobs?.platform?.if ?? "").includes("inputs.full_release == true") ||
      !sameObject(publish?.concurrency, {group: "publish-images-${{ github.event_name == 'workflow_dispatch' && inputs.full_release && inputs.source_sha || github.sha }}", "cancel-in-progress": false}) ||
      sourceCheckouts.some((step) => step.with?.ref !== sourceRef) ||
      !JSON.stringify(publish?.jobs?.["infrastructure-index"] ?? {}).includes("$RELEASE_SOURCE_SHA") ||
      !JSON.stringify(publish?.jobs?.["platform-index"] ?? {}).includes("$RELEASE_SOURCE_SHA")) {
    errors.push("Publish images must use one source-bound full release dispatch");
  }
  if (!templateBuild?.run?.includes("--images=codex,claude,opencode,pi") ||
      !templateBuild?.run?.includes("--custom-base-image") ||
      smokeInput?.type !== "boolean" ||
      smokeInput?.default !== false ||
      !publish?.jobs?.["infrastructure-index"]?.steps?.some((step) => step.run?.includes("published-indexes.jsonl")) ||
      templates?.["runs-on"] !== "${{ matrix.runner }}" ||
      JSON.stringify(templateMatrix) !== JSON.stringify([
        {platform: "linux/amd64", architecture: "amd64", runner: "ubuntu-24.04"},
        {platform: "linux/arm64", architecture: "arm64", runner: "ubuntu-24.04-arm"},
      ]) ||
      Object.values(publish?.jobs ?? {}).some((job) => (job.steps ?? []).some((step) =>
        step.uses?.startsWith("actions/setup-node@") &&
        step.uses !== "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020"))) {
    errors.push("Publish images must publish standard templates with stable main tags and valid native build setup");
  }
  const platformUpload = publish?.jobs?.platform?.steps?.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const platformIndexSteps = publish?.jobs?.["platform-index"]?.steps ?? [];
  const platformDownload = platformIndexSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  const platformIndexUpload = platformIndexSteps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  if ([templates, publish?.jobs?.platform].some((job) =>
      job?.steps?.[0]?.name !== "Validate release source" ||
      !sameObject(job?.steps?.[0]?.env, {
        FULL_RELEASE: "${{ inputs.full_release }}", INPUT_SOURCE_SHA: "${{ inputs.source_sha }}",
      })) ||
      platformUpload?.with?.name !== "platform-images-${{ matrix.architecture }}-${{ env.RELEASE_SOURCE_SHA }}-${{ github.run_attempt }}" ||
      platformDownload?.with?.pattern !== "platform-images-*-${{ env.RELEASE_SOURCE_SHA }}-${{ github.run_attempt }}" ||
      platformDownload?.with?.["run-id"] !== undefined ||
      platformIndexUpload?.with?.name !== "published-platform-indexes-${{ env.RELEASE_SOURCE_SHA }}-${{ github.run_attempt }}" ||
      platformIndexUpload?.with?.path !== "${{ runner.temp }}/published-platform-indexes.jsonl" ||
      platformIndexUpload?.with?.["if-no-files-found"] !== "error" ||
      platformIndexUpload?.if !== undefined) {
    errors.push("Publish images must retain raw source validation and attempt-bound Platform receipts");
  }
  // This dispatch grants package write authority to exactly one source-bound producer.
  const signedEntry = workflows["publish-signed-own-entry.yml"];
  const signedJob = signedEntry?.jobs?.["own-entry-fixture"];
  const promotionJob = signedEntry?.jobs?.["promote-existing"];
  const promotionSteps = promotionJob?.steps ?? [];
  const promotionStepNames = promotionSteps.map((step) => step.name).join(",");
  const promotionRunText = JSON.stringify(promotionJob ?? {});
  const promotionCheckout = promotionSteps[1];
  const promotionSourceGuard = promotionSteps[2];
  const promotionOriginEvidence = promotionSteps[5];
  const promotionJobValid =
    promotionJob?.if === "github.ref == 'refs/heads/main' && inputs.promote_existing" &&
    promotionJob?.name === "Promote verified signed entry (linux/amd64)" &&
    promotionJob?.["runs-on"] === "ubuntu-24.04" &&
    promotionJob?.["timeout-minutes"] === 15 &&
    sameObject(promotionJob?.permissions, {contents: "read", packages: "write", actions: "read"}) &&
    promotionCheckout?.with?.ref === "${{ github.sha }}" &&
    String(promotionSourceGuard?.run ?? "").includes('git merge-base --is-ancestor "$RELEASE_SOURCE_SHA" origin/main') &&
    String(promotionOriginEvidence?.run ?? "").includes("gh run view") &&
    String(promotionOriginEvidence?.run ?? "").includes("validateOriginRun(metadata, process.env.ORIGIN_RUN_ID, attempt)") &&
    String(promotionOriginEvidence?.run ?? "").includes("gh run download") &&
    promotionStepNames === "Validate promotion inputs,Checkout workflow source,Verify merged workflow and fixture sources,Set up Node.js,Verify promotion guards,Read official origin evidence,Set up Buildx,Log in to GHCR,Promote unchanged artifact,Preserve promotion receipt or unknown-copy intent" &&
    promotionRunText.includes("origin_run_id") &&
    promotionRunText.includes("signed-own-entry-amd64-${RELEASE_SOURCE_SHA}-${ORIGIN_ATTEMPT}") &&
    promotionRunText.includes("PROMOTION_ORIGIN_RUN_ID") &&
    promotionRunText.includes("PROMOTION_ORIGIN_ATTEMPT_FILE");
  const signedSteps = [
    {"name":"Validate release source","env":{"INPUT_SOURCE_SHA":"${{ inputs.source_sha }}"},"run":"if [[ ! \"$INPUT_SOURCE_SHA\" =~ ^[0-9a-f]{40}$ ]]; then\n  echo \"own-entry fixture requires a 40-hex source_sha\" >&2\n  exit 1\nfi\n"},
    {"name":"Checkout source","uses":"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1","with":{"fetch-depth":0,"persist-credentials":false,"ref":"${{ inputs.source_sha }}"}},
    {"name":"Verify merged source","run":"test \"$(git rev-parse HEAD)\" = \"$RELEASE_SOURCE_SHA\"\ngit merge-base --is-ancestor \"$RELEASE_SOURCE_SHA\" origin/main\n"},
    {"name":"Set up Node.js","uses":"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020","with":{"node-version":24}},
    {"name":"Set up fixture package manager","uses":"pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda","with":{"version":"11.20.0"}},
    {"name":"Install fixture build and test dependencies","run":"pnpm install --filter agent-infra... --frozen-lockfile --ignore-scripts"},
    {"name":"Verify snapshot business fixture","run":"node --test tests/signed-own-entry.test.mjs tests/signed-own-entry-protocols.test.mjs tests/snapshot-business.test.mjs"},
    {"name":"Set up Docker OCI image store","uses":"docker/setup-docker-action@7ec28a010822b4626af4874f9448a4b05ac6f3e5","with":{"daemon-config":"{\"features\":{\"containerd-snapshotter\":true,\"cdi\":false}}\n"}},
    {"name":"Set up Buildx","uses":"docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f","with":{"driver":"docker"}},
    {"name":"Log in to GHCR","env":{"GHCR_TOKEN":"${{ github.token }}"},"run":"echo \"$GHCR_TOKEN\" | docker login ghcr.io --username github-actions --password-stdin"},
    {"name":"Build and publish the signed entry","env":{"PLATFORM":"linux/amd64"},"run":"test \"$(git rev-parse HEAD)\" = \"$RELEASE_SOURCE_SHA\"\nnode deploy/release/build-images.mjs \"$RUNNER_TEMP/signed-own-entry.json\" --images=signedOwnEntry\n"},
    {"name":"Upload signed entry receipt","uses":"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a","with":{"if-no-files-found":"error","name":"signed-own-entry-amd64-${{ env.RELEASE_SOURCE_SHA }}-${{ github.run_attempt }}","path":"${{ runner.temp }}/signed-own-entry.json"}},
  ];
  if (Object.keys(signedEntry ?? {}).sort().join() !== "concurrency,env,jobs,name,on,permissions,run-name" ||
      signedEntry?.name !== "Publish signed own entry" ||
      signedEntry?.["run-name"] !== "${{ github.event_name }} | publish-signed-own-entry | ${{ inputs.source_sha }}" ||
      Object.keys(signedEntry?.on ?? {}).join() !== "workflow_dispatch" ||
      Object.keys(signedEntry?.on?.workflow_dispatch ?? {}).join() !== "inputs" ||
      Object.keys(signedEntry?.on?.workflow_dispatch?.inputs ?? {}).sort().join() !== "origin_run_id,promote_existing,source_sha" ||
      !sameObject(signedEntry?.on?.workflow_dispatch?.inputs?.source_sha, {
        description: "Exact merged 40-hex commit to publish", required: true, type: "string",
      }) ||
      !sameObject(signedEntry?.on?.workflow_dispatch?.inputs?.promote_existing, {description: "Promote the verified fixture from this workflow to the admitted repository", required: false, type: "boolean", default: false}) ||
      !promotionJobValid ||
      !sameObject(signedEntry?.permissions, {contents: "read", packages: "write"}) ||
      !sameObject(signedEntry?.concurrency, {group: "publish-images-${{ inputs.source_sha }}", "cancel-in-progress": false}) ||
      !sameObject(signedEntry?.env, {
        IMAGE_REPOSITORY_PREFIX: "ghcr.io/agoraio-extensions/agent-infra",
        RELEASE_SOURCE_SHA: "${{ inputs.source_sha }}",
        IMAGE_TAG: "${{ format('release-{0}', inputs.source_sha) }}",
      }) ||
      Object.keys(signedEntry?.jobs ?? {}).sort().join() !== "own-entry-fixture,promote-existing" ||
      !sameObject(signedJob, {
        name: "Signed own-entry fixture (linux/amd64)",
        if: "github.ref == 'refs/heads/main' && !inputs.promote_existing",
        "runs-on": "ubuntu-24.04", "timeout-minutes": 30, steps: signedSteps,
      })) {
    errors.push("Signed own entry must retain the single-image source-guarded dispatch and minimal permissions");
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
