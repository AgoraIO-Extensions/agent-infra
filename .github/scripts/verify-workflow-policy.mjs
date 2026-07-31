import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseDocument } from "yaml";

const REQUEST_PATH = ".github/workflows/claude-review-request.yml";
const REVIEW_PATH = ".github/workflows/claude-pr-review.yml";
const ASSISTANT_PATH = ".github/workflows/claude-assistant.yml";
const DOCS_PATH = ".github/workflows/docs-ci.yml";
const REQUIRED_WORKFLOWS = [REQUEST_PATH, REVIEW_PATH, ASSISTANT_PATH, DOCS_PATH];

const CHECKOUT_ACTION =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const CLAUDE_ACTION =
  "anthropics/claude-code-action@be7b93b1907a4abad570368f3c74b6fe3807510b";
const DEFAULT_BRANCH_REF = "${{ github.event.repository.default_branch }}";
const DOCS_CHECKOUT_REF = "${{ github.event.pull_request.head.sha || github.sha }}";
const ELIGIBILITY_IF = "steps.eligibility.outputs.eligible == 'true'";
const ALWAYS_IF = "${{ always() }}";
const CHECK_NAME = "Claude Review";
const CONFIG_COMMAND = "node .github/scripts/validate-claude-config.mjs";
const GITHUB_TOKEN = "${{ github.token }}";
const TRUSTED_RUNNER = "ubuntu-24.04";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseWorkflow(source, path) {
  if (typeof source !== "string") {
    throw new Error(`${path}: workflow source must be a string`);
  }
  const document = parseDocument(source, {
    prettyErrors: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${path}: duplicate or invalid YAML: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
  let value;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid YAML value";
    throw new Error(`${path}: YAML aliases are not allowed: ${message}`);
  }
  if (!isRecord(value)) {
    throw new Error(`${path}: workflow must be a YAML mapping`);
  }
  return value;
}

function sameItems(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().join("\u0000") === [...expected].sort().join("\u0000")
  );
}

function exactKeys(violations, path, label, value, expected) {
  if (!isRecord(value)) {
    violations.push(`${path}: ${label} must be a mapping`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\u0000") !== wanted.join("\u0000")) {
    violations.push(`${path}: ${label} must contain exactly ${wanted.join(", ")}`);
    return false;
  }
  return true;
}

function allowedKeys(violations, path, label, value, allowed) {
  if (!isRecord(value)) {
    violations.push(`${path}: ${label} must be a mapping`);
    return false;
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    violations.push(`${path}: ${label} contains unexpected keys ${unexpected.join(", ")}`);
    return false;
  }
  return true;
}

function exactPermissions(violations, path, label, value, expected) {
  if (!exactKeys(violations, path, `${label} permissions`, value, Object.keys(expected))) {
    return;
  }
  for (const [permission, access] of Object.entries(expected)) {
    if (value[permission] !== access) {
      violations.push(
        `${path}: ${label} permissions ${permission} must be ${access}, got ${String(value[permission])}`,
      );
    }
  }
}

function exactValues(violations, path, label, value, expected) {
  if (!exactKeys(violations, path, label, value, Object.keys(expected))) {
    return false;
  }
  for (const [name, wanted] of Object.entries(expected)) {
    if (value[name] !== wanted) {
      violations.push(`${path}: ${label} ${name} is not trusted`);
    }
  }
  return true;
}

function validateRunner(violations, path, jobName, job) {
  if (job?.["runs-on"] !== TRUSTED_RUNNER) {
    violations.push(`${path}: jobs.${jobName} runner must be ${TRUSTED_RUNNER}`);
  }
}

function collectEntries(value, prefix = "") {
  const result = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      result.push(...collectEntries(item, `${prefix}[${index}]`));
    });
    return result;
  }
  if (!isRecord(value)) {
    result.push([prefix, value]);
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = prefix ? `${prefix}.${key}` : key;
    result.push([childPath, key]);
    result.push(...collectEntries(child, childPath));
  }
  return result;
}

function includesCredentialReference(value) {
  return collectEntries(value).some(([, item]) =>
    typeof item === "string"
      ? /ANTHROPIC_|CLAUDE_REVIEW_MODEL|\bsecrets\b/.test(item)
      : false,
  );
}

function validateClaudeSecretBoundary(violations, path, workflow) {
  const secretValues = collectEntries(workflow).filter(
    ([, value]) => typeof value === "string" && /\bsecrets\b/.test(value),
  );
  if (
    secretValues.length !== 1 ||
    secretValues[0][1] !== "${{ secrets.ANTHROPIC_API_KEY }}"
  ) {
    violations.push(
      `${path}: workflow may expose the API key only to the pinned Claude Action`,
    );
  }
}

function jobsOf(workflow) {
  return isRecord(workflow.jobs) ? workflow.jobs : {};
}

function stepsOf(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function checkoutSteps(job) {
  return stepsOf(job).filter(
    (step) => isRecord(step) && typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
  );
}

function validateCheckout(violations, path, jobName, step, { trustedDefault }) {
  exactKeys(violations, path, `jobs.${jobName} checkout step fields`, step, [
    "name",
    "uses",
    "with",
  ]);
  if (step.uses !== CHECKOUT_ACTION) {
    violations.push(`${path}: jobs.${jobName} checkout must use the pinned Action SHA`);
  }
  const expectedInputs = trustedDefault
    ? {
        ref: DEFAULT_BRANCH_REF,
        "fetch-depth": 1,
        "persist-credentials": false,
      }
    : {
        ref: DOCS_CHECKOUT_REF,
        "fetch-depth": 0,
        "persist-credentials": false,
      };
  exactValues(
    violations,
    path,
    `jobs.${jobName} checkout inputs`,
    step.with,
    expectedInputs,
  );
  if (step.with?.["persist-credentials"] !== false) {
    violations.push(`${path}: jobs.${jobName} checkout must disable persisted credentials`);
  }
  if (trustedDefault && step.with?.ref !== DEFAULT_BRANCH_REF) {
    violations.push(
      `${path}: jobs.${jobName} must use a trusted default branch checkout`,
    );
  }
}

function requireSingleSetupNode(violations, path, jobName, job) {
  const step = requireSingleStep(
    violations,
    path,
    jobName,
    job,
    (candidate) => candidate?.uses === SETUP_NODE_ACTION,
    "pinned Node.js setup",
  );
  if (!step) {
    return;
  }
  exactKeys(violations, path, `jobs.${jobName} Node.js step fields`, step, [
    "name",
    "uses",
    "with",
  ]);
  exactValues(violations, path, `jobs.${jobName} Node.js inputs`, step.with, {
    "node-version": 24,
  });
}

function validateUses(violations, path, workflow) {
  for (const [jobName, job] of Object.entries(jobsOf(workflow))) {
    const references = [];
    if (typeof job?.uses === "string") {
      references.push(job.uses);
    }
    for (const step of stepsOf(job)) {
      if (typeof step?.uses === "string") {
        references.push(step.uses);
      }
      if (Object.hasOwn(step ?? {}, "if") && typeof step.if !== "string") {
        violations.push(
          `${path}: jobs.${jobName} step if must be a string expression`,
        );
      }
      if (isRecord(step?.with)) {
        for (const forbidden of ["allowed_bots", "allowed_non_write_users"]) {
          if (Object.hasOwn(step.with, forbidden)) {
            violations.push(`${path}: ${forbidden} must not be configured`);
          }
        }
      }
    }
    if (Object.hasOwn(job ?? {}, "if") && typeof job.if !== "string") {
      violations.push(`${path}: jobs.${jobName} if must be a string expression`);
    }
    if (job?.name === CHECK_NAME) {
      violations.push(`${path}: workflow job must not be named Claude Review`);
    }
    for (const reference of references) {
      if (reference.startsWith("./")) {
        continue;
      }
      const separator = reference.lastIndexOf("@");
      const revision = separator === -1 ? "" : reference.slice(separator + 1);
      if (!/^[0-9a-f]{40}$/.test(revision)) {
        violations.push(`${path}: Action ${reference} must use a full commit SHA`);
      }
    }
  }
}

function validateWritePermissions(violations, path, workflow) {
  const allowed = new Set([
    `${REVIEW_PATH}:publish:checks`,
    `${REVIEW_PATH}:publish:pull-requests`,
    `${ASSISTANT_PATH}:publish:issues`,
    `${ASSISTANT_PATH}:publish:pull-requests`,
  ]);
  const permissionLocations = [["workflow", workflow.permissions]];
  for (const [jobName, job] of Object.entries(jobsOf(workflow))) {
    permissionLocations.push([jobName, job?.permissions]);
  }
  for (const [location, permissions] of permissionLocations) {
    if (permissions === undefined) {
      continue;
    }
    if (!isRecord(permissions)) {
      violations.push(`${path}: ${location} permissions must be a mapping`);
      continue;
    }
    for (const [permission, access] of Object.entries(permissions)) {
      if (access === "write" && !allowed.has(`${path}:${location}:${permission}`)) {
        violations.push(
          `${path}: jobs.${location} permissions ${permission}: write is not allowed`,
        );
      }
    }
  }
}

function validateTriggerKeys(violations, path, workflow, expected) {
  exactKeys(violations, path, "on", workflow.on, expected);
}

function requireSingleCheckout(violations, path, jobName, job, trustedDefault) {
  const checkouts = checkoutSteps(job);
  if (checkouts.length !== 1) {
    violations.push(`${path}: jobs.${jobName} must contain exactly one checkout`);
  }
  for (const step of checkouts) {
    validateCheckout(violations, path, jobName, step, { trustedDefault });
  }
}

function requireSingleStep(violations, path, jobName, job, predicate, description) {
  const matches = stepsOf(job).filter(predicate);
  if (matches.length !== 1) {
    violations.push(`${path}: jobs.${jobName} must contain one ${description} step`);
    return null;
  }
  return matches[0];
}

function validateRequest(violations, workflow) {
  const path = REQUEST_PATH;
  allowedKeys(violations, path, "workflow fields", workflow, [
    "name",
    "on",
    "permissions",
    "jobs",
  ]);
  if (workflow.name !== "Claude Review Request") {
    violations.push(`${path}: workflow name must be Claude Review Request`);
  }
  validateTriggerKeys(violations, path, workflow, ["pull_request"]);
  const trigger = workflow.on?.pull_request;
  if (!isRecord(trigger) || !sameItems(trigger.types, [
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
    "labeled",
  ])) {
    violations.push(`${path}: pull_request trigger types are incomplete`);
  }
  exactPermissions(violations, path, "workflow", workflow.permissions, {});
  if (!exactKeys(violations, path, "jobs", workflow.jobs, ["request"])) {
    return;
  }
  const job = workflow.jobs.request;
  allowedKeys(violations, path, "request job fields", job, [
    "name",
    "if",
    "runs-on",
    "permissions",
    "steps",
  ]);
  exactPermissions(violations, path, "jobs.request", job?.permissions, {});
  validateRunner(violations, path, "request", job);
  if (job?.name !== "Request Claude Review") {
    violations.push(`${path}: request job name must be Request Claude Review`);
  }
  if (
    typeof job?.if !== "string" ||
    !job.if.includes("head.repo.full_name == github.repository") ||
    !job.if.includes("draft == false") ||
    !job.if.includes("!endsWith(github.actor, '[bot]')") ||
    !job.if.includes("github.event.label.name == 'claude'")
  ) {
    violations.push(`${path}: request job is missing the early PR guards`);
  }
  if (checkoutSteps(job).length > 0) {
    violations.push(`${path}: request workflow must not checkout repository content`);
  }
  const steps = stepsOf(job);
  if (
    steps.length !== 1 ||
    steps[0]?.run !== "echo 'Request accepted for trusted resolution.'" ||
    typeof steps[0]?.uses === "string"
  ) {
    violations.push(`${path}: request workflow may only emit the fixed request message`);
  }
  if (steps.length === 1) {
    exactKeys(violations, path, "request step fields", steps[0], ["name", "run"]);
  }
  if (includesCredentialReference(workflow)) {
    violations.push(`${path}: request workflow must not reference Secrets or model configuration`);
  }
}

function validateClaudeAction(violations, path, jobName, job) {
  const step = requireSingleStep(
    violations,
    path,
    jobName,
    job,
    (candidate) => candidate?.uses === CLAUDE_ACTION,
    "pinned Claude Code Action",
  );
  if (!step) {
    return;
  }
  exactKeys(violations, path, `jobs.${jobName} Claude step fields`, step, [
    "name",
    "id",
    "if",
    "uses",
    "with",
  ]);
  if (step.if !== ELIGIBILITY_IF) {
    violations.push(`${path}: jobs.${jobName} Claude step must use the eligibility guard`);
  }
  const inputs = isRecord(step.with) ? step.with : {};
  exactKeys(violations, path, `jobs.${jobName} Claude Action inputs`, inputs, [
    "anthropic_api_key",
    "github_token",
    "classify_inline_comments",
    "show_full_output",
    "display_report",
    "include_fix_links",
    "prompt",
    "claude_args",
  ]);
  if (inputs.anthropic_api_key !== "${{ secrets.ANTHROPIC_API_KEY }}") {
    violations.push(`${path}: jobs.${jobName} must use the Reviewer API key Secret`);
  }
  if (inputs.github_token !== "${{ github.token }}") {
    violations.push(`${path}: jobs.${jobName} must use the read-only GitHub token`);
  }
  for (const input of [
    "classify_inline_comments",
    "show_full_output",
    "display_report",
    "include_fix_links",
  ]) {
    if (inputs[input] !== "false") {
      violations.push(`${path}: jobs.${jobName} must set ${input} to false`);
    }
  }
  if (
    typeof inputs.prompt !== "string" ||
    !inputs.prompt.includes(".claude-context/context.json")
  ) {
    violations.push(`${path}: jobs.${jobName} prompt must read the bounded context file`);
  }
  const args = typeof inputs.claude_args === "string" ? inputs.claude_args : "";
  const toolLines = args
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("--allowedTools"));
  if (toolLines.length !== 1 || toolLines[0] !== '--allowedTools "Read,Grep,Glob"') {
    violations.push(
      `${path}: jobs.${jobName} allowedTools must be exactly Read,Grep,Glob`,
    );
  }
  if (!args.split("\n").some((line) => line.trim() === "--max-turns 10")) {
    violations.push(`${path}: jobs.${jobName} must limit Claude to 10 turns`);
  }
  if (!args.includes('--model "${{ vars.CLAUDE_REVIEW_MODEL }}"')) {
    violations.push(`${path}: jobs.${jobName} must select the configured model`);
  }
  if (!args.includes("--json-schema")) {
    violations.push(`${path}: jobs.${jobName} must require structured output`);
  }
  const argumentLines = args
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const approvedArguments = argumentLines.every(
    (line) =>
      line === '--model "${{ vars.CLAUDE_REVIEW_MODEL }}"' ||
      line === "--max-turns 10" ||
      line === '--allowedTools "Read,Grep,Glob"' ||
      line.startsWith("--json-schema "),
  );
  if (!approvedArguments) {
    violations.push(`${path}: jobs.${jobName} contains an unapproved Claude argument`);
  }
  const secretValues = collectEntries(job).filter(
    ([, value]) => typeof value === "string" && /\bsecrets\b/.test(value),
  );
  if (
    secretValues.length !== 1 ||
    secretValues[0][1] !== "${{ secrets.ANTHROPIC_API_KEY }}"
  ) {
    violations.push(
      `${path}: jobs.${jobName} may expose the API key only to the pinned Claude Action`,
    );
  }
}

function isKnownAnalysisStep(step) {
  return (
    step?.uses === CHECKOUT_ACTION ||
    step?.uses === SETUP_NODE_ACTION ||
    step?.uses === CLAUDE_ACTION ||
    (step?.id === "eligibility" &&
      step?.run === "node .github/scripts/check-claude-eligibility.mjs") ||
    step?.run === "node .github/scripts/prepare-claude-context.mjs" ||
    step?.run === CONFIG_COMMAND
  );
}

function validateAnalysisJob(violations, path, jobName, job, permissions) {
  exactPermissions(violations, path, `jobs.${jobName}`, job?.permissions, permissions);
  validateRunner(violations, path, jobName, job);
  if (job?.["timeout-minutes"] !== 20) {
    violations.push(`${path}: jobs.${jobName} timeout must be 20 minutes`);
  }
  if (job?.env?.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB !== "1") {
    violations.push(`${path}: jobs.${jobName} must enable subprocess environment scrub`);
  }
  if (job?.env?.ANTHROPIC_BASE_URL !== "${{ vars.ANTHROPIC_BASE_URL }}") {
    violations.push(`${path}: jobs.${jobName} must use the configured Anthropic Base URL`);
  }
  exactKeys(
    violations,
    path,
    `jobs.${jobName} analysis environment`,
    job?.env,
    ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"],
  );
  requireSingleCheckout(violations, path, jobName, job, true);
  requireSingleSetupNode(violations, path, jobName, job);
  const eligibilityStep = requireSingleStep(
    violations,
    path,
    jobName,
    job,
    (step) =>
      step?.id === "eligibility" &&
      step?.run === "node .github/scripts/check-claude-eligibility.mjs",
    "trusted eligibility resolver",
  );
  if (eligibilityStep) {
    exactKeys(
      violations,
      path,
      `jobs.${jobName} eligibility step fields`,
      eligibilityStep,
      ["name", "id", "env", "run"],
    );
    exactValues(
      violations,
      path,
      `jobs.${jobName} eligibility environment`,
      eligibilityStep.env,
      { GITHUB_TOKEN },
    );
  }
  const contextStep = requireSingleStep(
    violations,
    path,
    jobName,
    job,
    (step) => step?.run === "node .github/scripts/prepare-claude-context.mjs",
    "bounded context preparation",
  );
  if (contextStep && contextStep.if !== ELIGIBILITY_IF) {
    violations.push(`${path}: jobs.${jobName} context step must use the eligibility guard`);
  }
  if (contextStep) {
    exactKeys(violations, path, `jobs.${jobName} context step fields`, contextStep, [
      "name",
      "if",
      "env",
      "run",
    ]);
    const expectedContextEnvironment =
      path === REVIEW_PATH
        ? {
            CLAUDE_CONTEXT_MODE: "review",
            EXPECTED_HEAD_SHA: "${{ steps.eligibility.outputs.head_sha }}",
            GITHUB_TOKEN,
            PR_NUMBER: "${{ steps.eligibility.outputs.pr_number }}",
          }
        : {
            CLAUDE_CONTEXT_MODE: "assistant",
            ENTITY_NUMBER: "${{ steps.eligibility.outputs.entity_number }}",
            ENTITY_TYPE: "${{ steps.eligibility.outputs.entity_type }}",
            EXPECTED_HEAD_SHA: "${{ steps.eligibility.outputs.head_sha }}",
            GITHUB_TOKEN,
          };
    exactValues(
      violations,
      path,
      `jobs.${jobName} context environment`,
      contextStep.env,
      expectedContextEnvironment,
    );
  }
  const configStep = requireSingleStep(
    violations,
    path,
    jobName,
    job,
    (step) => step?.run === CONFIG_COMMAND,
    "configuration validator",
  );
  if (configStep) {
    exactKeys(violations, path, `jobs.${jobName} configuration step fields`, configStep, [
      "name",
      "if",
      "env",
      "run",
    ]);
    if (configStep.if !== ELIGIBILITY_IF) {
      violations.push(
        `${path}: jobs.${jobName} configuration step must use the eligibility guard`,
      );
    }
    if (
      exactKeys(
        violations,
        path,
        `jobs.${jobName} configuration environment`,
        configStep.env,
        ["CLAUDE_REVIEW_MODEL"],
      ) &&
      configStep.env.CLAUDE_REVIEW_MODEL !== "${{ vars.CLAUDE_REVIEW_MODEL }}"
    ) {
      violations.push(
        `${path}: jobs.${jobName} configuration environment must use the configured model`,
      );
    }
  }
  const unknown = stepsOf(job).filter((step) => !isKnownAnalysisStep(step));
  if (unknown.length > 0) {
    violations.push(`${path}: jobs.${jobName} contains an unapproved analysis step`);
  }
  validateClaudeAction(violations, path, jobName, job);
}

function validatePublisher(violations, path, jobName, job, permissions, script) {
  exactPermissions(violations, path, `jobs.${jobName}`, job?.permissions, permissions);
  validateRunner(violations, path, jobName, job);
  if (job?.needs !== "analyze") {
    violations.push(`${path}: publisher must depend on the analyze job`);
  }
  if (job?.if !== ALWAYS_IF) {
    violations.push(`${path}: publisher must use if: always()`);
  }
  if (includesCredentialReference(job)) {
    violations.push(`${path}: publisher must not receive model credentials or configuration`);
  }
  requireSingleCheckout(violations, path, jobName, job, true);
  requireSingleSetupNode(violations, path, jobName, job);
  const steps = stepsOf(job);
  const allowed = steps.every(
    (step) =>
      step?.uses === CHECKOUT_ACTION ||
      step?.uses === SETUP_NODE_ACTION ||
      step?.run === script,
  );
  if (!allowed || steps.length !== 3) {
    violations.push(`${path}: publisher may only checkout, set up Node.js, and run ${script}`);
  }
  requireSingleStep(
    violations,
    path,
    jobName,
    job,
    (step) => step?.run === script,
    "trusted publisher",
  );
  const publisherStep = steps.find((step) => step?.run === script);
  if (publisherStep) {
    exactKeys(violations, path, "publisher step fields", publisherStep, [
      "name",
      "env",
      "run",
    ]);
  }
  const expectedEnvironment =
    path === REVIEW_PATH
      ? {
          ANALYSIS_RESULT: "${{ needs.analyze.result }}",
          ELIGIBLE: "${{ needs.analyze.outputs.eligible }}",
          EXPECTED_HEAD_SHA: "${{ needs.analyze.outputs.head_sha }}",
          GITHUB_TOKEN: "${{ github.token }}",
          PR_NUMBER: "${{ needs.analyze.outputs.pr_number }}",
          REVIEW_RUN_ID: "${{ github.run_id }}",
          STRUCTURED_OUTPUT: "${{ needs.analyze.outputs.structured_output }}",
        }
      : {
          ANALYSIS_RESULT: "${{ needs.analyze.result }}",
          ELIGIBLE: "${{ needs.analyze.outputs.eligible }}",
          ENTITY_NUMBER: "${{ needs.analyze.outputs.entity_number }}",
          ENTITY_TYPE: "${{ needs.analyze.outputs.entity_type }}",
          EXPECTED_HEAD_SHA: "${{ needs.analyze.outputs.head_sha }}",
          GITHUB_TOKEN: "${{ github.token }}",
          STRUCTURED_OUTPUT: "${{ needs.analyze.outputs.structured_output }}",
        };
  exactValues(
    violations,
    path,
    "publisher environment",
    publisherStep?.env,
    expectedEnvironment,
  );
}

function validateReview(violations, workflow) {
  const path = REVIEW_PATH;
  allowedKeys(violations, path, "workflow fields", workflow, [
    "name",
    "on",
    "permissions",
    "concurrency",
    "jobs",
  ]);
  if (workflow.name !== "Claude PR Review") {
    violations.push(`${path}: workflow name must be Claude PR Review`);
  }
  validateTriggerKeys(violations, path, workflow, ["workflow_run"]);
  const trigger = workflow.on?.workflow_run;
  if (
    !isRecord(trigger) ||
    !sameItems(trigger.workflows, ["Claude Review Request"]) ||
    !sameItems(trigger.types, ["completed"])
  ) {
    violations.push(`${path}: workflow_run must only consume completed Claude Review Request runs`);
  }
  exactPermissions(violations, path, "workflow", workflow.permissions, {});
  validateClaudeSecretBoundary(violations, path, workflow);
  if (!exactKeys(violations, path, "jobs", workflow.jobs, ["analyze", "publish"])) {
    return;
  }
  const analyze = workflow.jobs.analyze;
  const publish = workflow.jobs.publish;
  allowedKeys(violations, path, "analyze job fields", analyze, [
    "name",
    "runs-on",
    "timeout-minutes",
    "permissions",
    "env",
    "outputs",
    "steps",
  ]);
  allowedKeys(violations, path, "publisher job fields", publish, [
    "name",
    "needs",
    "if",
    "runs-on",
    "permissions",
    "steps",
  ]);
  if (analyze?.name !== "Claude Review Analysis") {
    violations.push(`${path}: analyze job name must be Claude Review Analysis`);
  }
  if (publish?.name !== "Claude Review Publisher") {
    violations.push(`${path}: publisher job name must be Claude Review Publisher`);
  }
  exactValues(violations, path, "Review concurrency", workflow.concurrency, {
    group:
      "claude-review-${{ github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.id }}",
    "cancel-in-progress": true,
  });
  exactValues(violations, path, "analysis output", analyze?.outputs, {
    eligible: "${{ steps.eligibility.outputs.eligible }}",
    reason: "${{ steps.eligibility.outputs.reason }}",
    pr_number: "${{ steps.eligibility.outputs.pr_number }}",
    head_sha: "${{ steps.eligibility.outputs.head_sha }}",
    structured_output: "${{ steps.claude.outputs.structured_output }}",
  });
  validateAnalysisJob(violations, path, "analyze", analyze, {
    actions: "read",
    contents: "read",
    "pull-requests": "read",
  });
  validatePublisher(
    violations,
    path,
    "publish",
    publish,
    { checks: "write", contents: "read", "pull-requests": "write" },
    "node .github/scripts/publish-claude-review.mjs",
  );
}

function validateAssistant(violations, workflow) {
  const path = ASSISTANT_PATH;
  allowedKeys(violations, path, "workflow fields", workflow, [
    "name",
    "on",
    "permissions",
    "jobs",
  ]);
  if (workflow.name !== "Claude Assistant") {
    violations.push(`${path}: workflow name must be Claude Assistant`);
  }
  validateTriggerKeys(violations, path, workflow, [
    "issue_comment",
    "pull_request_review_comment",
    "pull_request_review",
    "issues",
  ]);
  const expectedTypes = {
    issue_comment: ["created"],
    pull_request_review_comment: ["created"],
    pull_request_review: ["submitted"],
    issues: ["labeled"],
  };
  for (const [event, types] of Object.entries(expectedTypes)) {
    if (!isRecord(workflow.on?.[event]) || !sameItems(workflow.on[event].types, types)) {
      violations.push(`${path}: ${event} trigger is incomplete`);
    }
  }
  exactPermissions(violations, path, "workflow", workflow.permissions, {});
  validateClaudeSecretBoundary(violations, path, workflow);
  if (!exactKeys(violations, path, "jobs", workflow.jobs, ["analyze", "publish"])) {
    return;
  }
  const analyze = workflow.jobs.analyze;
  const publish = workflow.jobs.publish;
  allowedKeys(violations, path, "analyze job fields", analyze, [
    "name",
    "if",
    "runs-on",
    "timeout-minutes",
    "permissions",
    "env",
    "outputs",
    "steps",
  ]);
  allowedKeys(violations, path, "publisher job fields", publish, [
    "name",
    "needs",
    "if",
    "runs-on",
    "permissions",
    "steps",
  ]);
  if (analyze?.name !== "Claude Assistant Analysis") {
    violations.push(`${path}: analyze job name must be Claude Assistant Analysis`);
  }
  if (publish?.name !== "Claude Assistant Publisher") {
    violations.push(`${path}: publisher job name must be Claude Assistant Publisher`);
  }
  if (
    typeof analyze?.if !== "string" ||
    !analyze.if.includes("!endsWith(github.actor, '[bot]')") ||
    !analyze.if.includes("contains(github.event.comment.body, '@claude')") ||
    !analyze.if.includes("github.event.label.name == 'claude'")
  ) {
    violations.push(`${path}: Assistant analyze job is missing trigger guards`);
  }
  exactValues(violations, path, "analysis output", analyze?.outputs, {
    eligible: "${{ steps.eligibility.outputs.eligible }}",
    reason: "${{ steps.eligibility.outputs.reason }}",
    entity_type: "${{ steps.eligibility.outputs.entity_type }}",
    entity_number: "${{ steps.eligibility.outputs.entity_number }}",
    head_sha: "${{ steps.eligibility.outputs.head_sha }}",
    structured_output: "${{ steps.claude.outputs.structured_output }}",
  });
  validateAnalysisJob(violations, path, "analyze", analyze, {
    contents: "read",
    issues: "read",
    "pull-requests": "read",
  });
  validatePublisher(
    violations,
    path,
    "publish",
    publish,
    { contents: "read", issues: "write", "pull-requests": "write" },
    "node .github/scripts/publish-claude-assistant.mjs",
  );
}

function validateDocs(violations, workflow) {
  const path = DOCS_PATH;
  allowedKeys(violations, path, "workflow fields", workflow, [
    "name",
    "on",
    "permissions",
    "jobs",
  ]);
  if (workflow.name !== "Docs CI") {
    violations.push(`${path}: workflow name must be Docs CI`);
  }
  validateTriggerKeys(violations, path, workflow, ["pull_request", "push"]);
  if (
    !isRecord(workflow.on?.push) ||
    !sameItems(workflow.on.push.branches, ["main"])
  ) {
    violations.push(`${path}: push trigger must target main`);
  }
  if (workflow.on?.pull_request !== null && !isRecord(workflow.on?.pull_request)) {
    violations.push(`${path}: pull_request trigger is invalid`);
  }
  exactPermissions(violations, path, "workflow", workflow.permissions, {
    contents: "read",
  });
  if (includesCredentialReference(workflow)) {
    violations.push(`${path}: Docs workflow must not reference Secrets or model configuration`);
  }
  if (!exactKeys(violations, path, "jobs", workflow.jobs, ["docs"])) {
    return;
  }
  const job = workflow.jobs.docs;
  allowedKeys(violations, path, "docs job fields", job, [
    "name",
    "runs-on",
    "timeout-minutes",
    "steps",
  ]);
  if (job?.name !== "Docs CI") {
    violations.push(`${path}: docs job name must be Docs CI`);
  }
  validateRunner(violations, path, "docs", job);
  if (job?.["timeout-minutes"] !== 10) {
    violations.push(`${path}: jobs.docs timeout must be 10 minutes`);
  }
  requireSingleCheckout(violations, path, "docs", job, false);
  requireSingleSetupNode(violations, path, "docs", job);
  const runs = stepsOf(job)
    .map((step) => step?.run)
    .filter((run) => typeof run === "string");
  for (const [fragment, description] of [
    ["yaml@2.8.1", "pinned YAML parser installation"],
    ["node --test .github/scripts/*.test.mjs", "repository policy tests"],
    ["node .github/scripts/verify-workflow-policy.mjs", "workflow policy verifier"],
    [".github/scripts/run-actionlint.sh", "actionlint validation"],
  ]) {
    if (!runs.some((run) => run.includes(fragment))) {
      violations.push(`${path}: missing ${description}`);
    }
  }
}

export function findPolicyViolations(workflows) {
  const violations = [];
  const parsed = new Map();
  for (const path of REQUIRED_WORKFLOWS) {
    if (!workflows.has(path)) {
      violations.push(`missing required workflow ${path}`);
    }
  }
  for (const [path, source] of workflows) {
    try {
      parsed.set(path, parseWorkflow(source, path));
    } catch (error) {
      violations.push(error instanceof Error ? error.message : `${path}: invalid YAML`);
    }
  }

  for (const [path, workflow] of parsed) {
    if (Object.hasOwn(workflow.on ?? {}, "pull_request_target")) {
      violations.push(`${path}: pull_request_target is forbidden`);
    }
    validateUses(violations, path, workflow);
    validateWritePermissions(violations, path, workflow);
    if (!REQUIRED_WORKFLOWS.includes(path) && includesCredentialReference(workflow)) {
      violations.push(
        `${path}: additional workflow must not reference Secrets or model configuration`,
      );
    }
  }
  if (parsed.has(REQUEST_PATH)) {
    validateRequest(violations, parsed.get(REQUEST_PATH));
  }
  if (parsed.has(REVIEW_PATH)) {
    validateReview(violations, parsed.get(REVIEW_PATH));
  }
  if (parsed.has(ASSISTANT_PATH)) {
    validateAssistant(violations, parsed.get(ASSISTANT_PATH));
  }
  if (parsed.has(DOCS_PATH)) {
    validateDocs(violations, parsed.get(DOCS_PATH));
  }
  return violations;
}

async function readWorkflows(root) {
  const workflowDirectory = join(root, ".github", "workflows");
  const entries = await readdir(workflowDirectory, { withFileTypes: true });
  const workflows = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) {
      continue;
    }
    const path = `.github/workflows/${entry.name}`;
    workflows.set(path, await readFile(join(workflowDirectory, entry.name), "utf8"));
  }
  return workflows;
}

async function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const root = resolve(scriptDirectory, "..", "..");
  const workflows = await readWorkflows(root);
  const violations = findPolicyViolations(workflows);
  if (violations.length > 0) {
    violations.forEach((violation) => console.error(violation));
    process.exitCode = 1;
    return;
  }
  console.log(`Workflow policy: ${workflows.size} files valid`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
