import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { executionContent } from "./worker-contract.mjs";

export function validateSupervisedBranch(branch) {
  if (/^codex\/issue-/.test(branch)) {
    throw new Error(
      "Human-supervised work must not use the reserved codex/issue-<N>-cycle-<N> Worker namespace",
    );
  }
  if (!/^[a-z0-9][a-z0-9._/-]*$/.test(branch)) {
    throw new Error("Branch name contains unsupported characters");
  }
}

export function validateSupervisedIssue(issue) {
  if (issue.state !== "OPEN") throw new Error("Primary Issue must be open");
  const labels = issue.labels.map((label) => label.name);
  if (!labels.includes("ready-for-human")) {
    throw new Error("Primary Issue must have the ready-for-human label");
  }
  return executionContent({
    body: issue.body,
    number: issue.number,
    title: issue.title,
  });
}

function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return typeof output === "string" ? output.trim() : "";
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const issueNumber = Number(argument("--issue"));
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Usage: node .github/scripts/connection-pr-preflight.mjs --issue <N>");
  }

  const branch = run("git", ["branch", "--show-current"]);
  validateSupervisedBranch(branch);
  if (run("git", ["status", "--porcelain"])) {
    throw new Error("Worktree must be clean before delivery preflight");
  }

  run("git", ["fetch", "origin", "connection", "--prune"], { inherit: true });
  run("git", ["merge-base", "--is-ancestor", "origin/connection", "HEAD"]);

  const repository = run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const issue = JSON.parse(
    run("gh", [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      repository,
      "--json",
      "number,title,state,labels,body",
    ]),
  );
  const contract = validateSupervisedIssue(issue);
  const baseSha = run("git", ["rev-parse", "origin/connection"]);
  const checks = JSON.parse(
    run("gh", [
      "api",
      `repos/${repository}/commits/${baseSha}/check-runs`,
      "--jq",
      "[.check_runs[] | select(.conclusion == \"failure\") | .name] | unique",
    ]) || "[]",
  );

  console.log(`OK branch: ${branch}`);
  console.log(`OK issue: #${issue.number} (${contract.acceptanceCriteriaIds.join(", ")})`);
  console.log(`OK base: ${baseSha}`);
  console.log(
    checks.length
      ? `WARN base failing checks: ${checks.join(", ")}`
      : "OK base checks: no recorded failures",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
