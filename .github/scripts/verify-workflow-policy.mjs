import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import YAML from "yaml";

const REQUIRED_WORKFLOWS = [
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

  const gates = workflows["pr-gates.yml"]?.jobs?.gates;
  const gateCheckout = gates?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  if (gateCheckout?.with?.ref !== "${{ github.event.repository.default_branch }}") {
    errors.push("PR Gates must checkout only the trusted default branch");
  }
  if (JSON.stringify(gates).includes("pull_request.head")) {
    errors.push("PR Gates must not read or execute the untrusted PR head");
  }

  const review = workflows["claude-pr-review.yml"];
  if (!review?.on?.workflow_run?.workflows?.includes("Docs CI")) {
    errors.push("Claude PR Review must run only after Docs CI");
  }
  if (JSON.stringify(review?.jobs?.publish ?? {}).includes("secrets.")) {
    errors.push("Claude Review publisher must not receive a model Secret");
  }

  const issueReview = workflows["claude-issue-review.yml"];
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
