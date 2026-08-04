import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function parseBlockedBy(body, { issueNumber } = {}) {
  const lines = String(body ?? "").split(/\r?\n/);
  const headings = lines.flatMap((line, index) =>
    line.trim() === "## Blocked by" ? [index] : [],
  );
  if (headings.length !== 1) {
    throw new Error("Issue must contain exactly one ## Blocked by section");
  }

  const start = headings[0] + 1;
  const nextHeading = lines.findIndex(
    (line, index) => index >= start && /^##\s+\S/.test(line.trim()),
  );
  const section = lines
    .slice(start, nextHeading === -1 ? lines.length : nextHeading)
    .map((line) => line.trim())
    .filter(Boolean);

  if (section.length === 1 && section[0] === "None") return [];
  if (section.length === 0) throw new Error("Blocked by section is empty");

  const blockers = section.map((line) => {
    const match = /^- #(\d+)$/.exec(line);
    if (!match || Number(match[1]) < 1) {
      throw new Error("Blocked by entries must use - #<issue-number>");
    }
    return Number(match[1]);
  });
  if (new Set(blockers).size !== blockers.length) {
    throw new Error("Blocked by entries must be unique");
  }
  if (issueNumber && blockers.includes(issueNumber)) {
    throw new Error("Issue cannot block itself");
  }
  return blockers;
}

function labelsOf(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

export function classifyWorkerEvent({
  eventName,
  action,
  label,
  headRef,
  merged,
  sameRepository,
}) {
  if (eventName === "pull_request_target") {
    return action === "closed" &&
      !merged &&
      sameRepository === true &&
      /^codex\/issue-\d+$/.test(headRef ?? "")
      ? "closed-pr"
      : "noop";
  }
  if (eventName !== "issues") return "noop";
  if (action === "closed" || (action === "labeled" && label === "wontfix")) {
    return "close";
  }
  if (
    (action === "unlabeled" && label === "ready-for-agent") ||
    (action === "labeled" &&
      ["ready-for-human", "needs-triage"].includes(label))
  ) {
    return "pause";
  }
  if (
    action === "reopened" ||
    (action === "labeled" && label === "ready-for-agent") ||
    (action === "unlabeled" &&
      ["ready-for-human", "needs-triage", "wontfix"].includes(label))
  ) {
    return "evaluate";
  }
  return "noop";
}

export function evaluateFrontierIssue({
  issue,
  blockers,
  workerPullRequests,
  branchSha,
  defaultSha,
}) {
  const branch = `codex/issue-${issue.number}`;
  const labels = labelsOf(issue);
  if (issue.state !== "open" || labels.includes("wontfix")) {
    return { operation: "close", reason: "issue-closed" };
  }
  if (
    !labels.includes("ready-for-agent") ||
    labels.some((label) => ["ready-for-human", "needs-triage"].includes(label))
  ) {
    return { operation: "noop", reason: "issue-not-frontier" };
  }
  if (blockers.some((blocker) => blocker.state !== "closed")) {
    return { operation: "noop", reason: "open-blockers" };
  }

  const pullRequests = workerPullRequests.filter((pullRequest) => !pullRequest.merged_at);
  if (pullRequests.length > 1) {
    return { operation: "triage", reason: "multiple-worker-prs" };
  }
  const pullRequest = pullRequests[0];
  if (pullRequest?.state === "closed") {
    return {
      operation: "triage",
      reason: "closed-worker-pr",
      pullRequestNumber: pullRequest.number,
    };
  }
  if (pullRequest && !branchSha) {
    return {
      operation: "triage",
      reason: "worker-branch-missing",
      pullRequestNumber: pullRequest.number,
    };
  }
  if (pullRequest && !pullRequest.draft) {
    return {
      operation: "noop",
      reason: "ready-pr-exists",
      pullRequestNumber: pullRequest.number,
    };
  }

  const startSha = branchSha ?? defaultSha;
  if (!/^[0-9a-f]{40}$/.test(startSha ?? "")) {
    return { operation: "triage", reason: "invalid-start-sha" };
  }
  return {
    operation: "implement",
    reason: "frontier",
    startSha,
    branch,
    pullRequestNumber: pullRequest?.number ?? null,
  };
}

export function createWorkerPlan({
  repository,
  defaultBranch,
  issue,
  blockers,
  workerPullRequests,
  branchSha,
  defaultSha,
}) {
  if (
    workerPullRequests
      .filter((pullRequest) => !pullRequest.merged_at)
      .some(
        (pullRequest) =>
          !isOwnedWorkerPullRequest(pullRequest, {
            repository,
            defaultBranch,
            branch: `codex/issue-${issue.number}`,
          }),
      )
  ) {
    return { operation: "triage", reason: "foreign-worker-pr" };
  }
  const decision = evaluateFrontierIssue({
    issue,
    blockers,
    workerPullRequests,
    branchSha,
    defaultSha,
  });
  if (decision.operation !== "implement") return decision;
  const plan = {
    version: 1,
    repository,
    defaultBranch,
    issueNumber: issue.number,
    startSha: decision.startSha,
    branch: decision.branch,
    branchExisted: branchSha !== null,
    pullRequestNumber: decision.pullRequestNumber,
  };
  validateWorkerPlan(plan);
  return { operation: "implement", reason: decision.reason, plan };
}

export function evaluatePublicationState({
  plan,
  issue,
  blockers,
  workerPullRequests,
  branchSha,
}) {
  validateWorkerPlan(plan);
  const labels = labelsOf(issue);
  if (issue.state !== "open" || labels.includes("wontfix")) {
    return { operation: "close", reason: "issue-closed" };
  }
  if (
    !labels.includes("ready-for-agent") ||
    labels.some((label) => ["ready-for-human", "needs-triage"].includes(label)) ||
    blockers.some((blocker) => blocker.state !== "closed")
  ) {
    return { operation: "pause", reason: "issue-not-frontier" };
  }

  const pullRequests = workerPullRequests.filter((pullRequest) => !pullRequest.merged_at);
  if (
    pullRequests.some((pullRequest) => !isOwnedWorkerPullRequest(pullRequest, plan))
  ) {
    return { operation: "triage", reason: "foreign-worker-pr" };
  }
  if (pullRequests.length > 1) {
    return { operation: "triage", reason: "multiple-worker-prs" };
  }
  const pullRequest = pullRequests[0];
  if (
    (plan.pullRequestNumber === null && pullRequest) ||
    (plan.pullRequestNumber !== null && pullRequest?.number !== plan.pullRequestNumber) ||
    pullRequest?.state === "closed" ||
    (pullRequest && !pullRequest.draft)
  ) {
    return { operation: "triage", reason: "stale-worker-pr" };
  }

  const branchMatches = plan.branchExisted
    ? branchSha === plan.startSha
    : branchSha === null;
  if (!branchMatches) {
    return { operation: "triage", reason: "stale-worker-branch" };
  }
  return { operation: "publish", reason: "authorized" };
}

function isOwnedWorkerPullRequest(pullRequest, { repository, defaultBranch, branch }) {
  return (
    pullRequest?.head?.ref === branch &&
    pullRequest?.base?.ref === defaultBranch &&
    pullRequest?.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase()
  );
}

const PLAN_KEYS = [
  "branch",
  "branchExisted",
  "defaultBranch",
  "issueNumber",
  "pullRequestNumber",
  "repository",
  "startSha",
  "version",
];

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

export function validateWorkerPlan(plan, expected = {}) {
  if (!plan || Array.isArray(plan) || typeof plan !== "object") {
    throw new Error("Worker plan must be an object");
  }
  if (Object.keys(plan).sort().join("\0") !== PLAN_KEYS.join("\0")) {
    throw new Error("Worker plan contains missing or unexpected fields");
  }
  if (plan.version !== 1) throw new Error("Worker plan version is unsupported");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plan.repository)) {
    throw new Error("Worker plan repository is invalid");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(plan.defaultBranch)) {
    throw new Error("Worker plan default branch is invalid");
  }
  assertPositiveInteger(plan.issueNumber, "Worker plan Issue");
  if (plan.branch !== `codex/issue-${plan.issueNumber}`) {
    throw new Error("Worker plan branch does not match its Issue");
  }
  if (!/^[0-9a-f]{40}$/.test(plan.startSha)) {
    throw new Error("Worker plan start commit is invalid");
  }
  if (typeof plan.branchExisted !== "boolean") {
    throw new Error("Worker plan branch state is invalid");
  }
  if (plan.pullRequestNumber !== null) {
    assertPositiveInteger(plan.pullRequestNumber, "Worker plan pull request");
  }
  for (const [name, value] of Object.entries(expected)) {
    if (value !== undefined && plan[name] !== value) {
      throw new Error(`Worker plan ${name} does not match the trusted event`);
    }
  }
  return plan;
}

export function validateWorkerConfiguration({ endpoint, model, effort, timeout }) {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 2048) {
    throw new Error("CODEX_RESPONSES_API_ENDPOINT is invalid");
  }
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new Error("CODEX_RESPONSES_API_ENDPOINT is invalid");
  }
  if (
    endpointUrl.protocol !== "https:" ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.hash
  ) {
    throw new Error("CODEX_RESPONSES_API_ENDPOINT is invalid");
  }
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
    throw new Error("CODEX_MODEL is invalid");
  }
  if (!["minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
    throw new Error("CODEX_EFFORT is invalid");
  }
  if (!/^\d+$/.test(String(timeout))) {
    throw new Error("CODEX_WORKER_TIMEOUT_MINUTES is invalid");
  }
  const timeoutMinutes = Number(timeout);
  if (!Number.isSafeInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 360) {
    throw new Error("CODEX_WORKER_TIMEOUT_MINUTES is invalid");
  }
  return { endpoint, model, effort, timeout: timeoutMinutes };
}

export function buildWorkerPrompt({ issue, plan }) {
  validateWorkerPlan(plan);
  if (issue?.number !== plan.issueNumber) {
    throw new Error("Prompt Issue does not match the Worker plan");
  }
  assertBoundedString(issue.title, "Issue title", 512);
  assertBoundedString(issue.body, "Issue body", 128 * 1024, { allowEmpty: true });
  return [
    `Implement GitHub Issue #${plan.issueNumber} in this checkout.`,
    "",
    "Use the project-level $implement Skill and follow AGENTS.md and the repository's trusted specs.",
    "The Issue is already approved for implementation. Do not ask questions in this unattended run.",
    "If requirements conflict or cannot be implemented safely, do not create the Patch or claim completion; the run must stop for triage.",
    "",
    "Hard constraints:",
    "- Do not commit, push, create a PR, call GitHub write APIs, or change git remotes.",
    "- Do not modify protected workflow, Agent, dependency-resolution, PRD, or architecture files.",
    "- Work only from the recorded start commit and fixed Issue scope.",
    "- Run appropriate repository validation before reporting completion.",
    "- Decide whether real human validation is required. Unit and smoke coverage may be sufficient for simple changes.",
    "",
    "Before the final response, create `.codex-worker-artifact/output/change.patch` with:",
    "`mkdir -p .codex-worker-artifact/output`",
    "`git add -N .`",
    "`git diff --full-index --no-renames HEAD -- . ':(exclude).codex-worker-artifact' > .codex-worker-artifact/output/change.patch`",
    "The Patch must be textual, no larger than 400 KiB, and must contain the complete change.",
    "It may be empty only when the recorded branch already contains the complete implementation and all required validation passes.",
    "Return only the JSON object required by the provided output Schema.",
    "",
    `Issue title: ${issue.title}`,
    "",
    "Issue body:",
    "--- BEGIN ISSUE BODY ---",
    issue.body ?? "",
    "--- END ISSUE BODY ---",
    "",
    `Recorded start commit: ${plan.startSha}`,
    `Fixed branch: ${plan.branch}`,
    `Recorded branch existed: ${plan.branchExisted ? "yes" : "no"}`,
  ].join("\n");
}

const RESULT_KEYS = [
  "acceptance_criteria",
  "branch",
  "completed",
  "human_validation",
  "human_validation_required",
  "issue_number",
  "not_run",
  "risks",
  "start_sha",
  "summary",
  "tests",
];

function assertBoundedString(value, name, maxLength, { allowEmpty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maxLength
  ) {
    throw new Error(`${name} must be a string of at most ${maxLength} characters`);
  }
}

function assertStringList(value, name) {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${name} must be an array with at most 50 entries`);
  }
  value.forEach((item, index) =>
    assertBoundedString(item, `${name}[${index}]`, 1000),
  );
}

export function validateWorkerResult(raw, plan) {
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new Error("Worker result exceeds 256 KiB");
  }
  const result = JSON.parse(raw);
  if (!result || Array.isArray(result) || typeof result !== "object") {
    throw new Error("Worker result must be an object");
  }
  const keys = Object.keys(result).sort();
  if (keys.join("\0") !== RESULT_KEYS.join("\0")) {
    throw new Error("Worker result contains missing or unexpected fields");
  }
  if (result.completed !== true) throw new Error("Worker result is incomplete");
  if (result.issue_number !== plan.issueNumber) {
    throw new Error("Worker result Issue does not match the plan");
  }
  if (result.start_sha !== plan.startSha) {
    throw new Error("Worker result start commit does not match the plan");
  }
  if (result.branch !== plan.branch) {
    throw new Error("Worker result branch does not match the plan");
  }
  if (typeof result.human_validation_required !== "boolean") {
    throw new Error("human_validation_required must be boolean");
  }
  assertBoundedString(result.summary, "summary", 4000);
  for (const name of [
    "acceptance_criteria",
    "tests",
    "not_run",
    "human_validation",
    "risks",
  ]) {
    assertStringList(result[name], name);
  }
  if (result.human_validation_required && result.human_validation.length === 0) {
    throw new Error("Worker result must describe required human validation");
  }
  return result;
}

export function sanitizeWorkerMarkdown(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/@(?=[\w-])/g, "@\u200b")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/```/g, "`\u200b``")
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi, "$1\u200b")
    .replace(/^(\s*)#/gm, "$1\\#");
}

function renderWorkerList(values) {
  return values.length
    ? values.map((value) => `- ${sanitizeWorkerMarkdown(value)}`).join("\n")
    : "- 无";
}

export function buildWorkerPullRequestBody(result, issueNumber) {
  const humanValidation = result.human_validation_required
    ? renderWorkerList(result.human_validation)
    : "- 自动验证已充分";
  return [
    `Closes #${issueNumber}`,
    "",
    "## 变更摘要",
    "",
    sanitizeWorkerMarkdown(result.summary),
    "",
    "## 验收标准",
    "",
    renderWorkerList(result.acceptance_criteria),
    "",
    "## 自动验证",
    "",
    renderWorkerList(result.tests),
    "",
    "## 未执行检查",
    "",
    renderWorkerList(result.not_run),
    "",
    "## 人工验证",
    "",
    humanValidation,
    "",
    "## 风险",
    "",
    renderWorkerList(result.risks),
    "",
  ].join("\n");
}

const PROTECTED_BASENAMES = new Set([
  ".gitattributes",
  ".gitmodules",
  ".markdown-link-check.json",
  ".markdownlint-cli2.jsonc",
  ".mcp.json",
  ".npmrc",
  "AGENTS.md",
  "CLAUDE.md",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);

export function isProtectedWorkerPath(filePath) {
  const normalized = filePath.replace(/^\.\//, "");
  const basename = path.posix.basename(normalized);
  return (
    PROTECTED_BASENAMES.has(basename) ||
    normalized === ".git" ||
    normalized.startsWith(".git/") ||
    normalized === ".github" ||
    normalized.startsWith(".github/") ||
    normalized === ".codex" ||
    normalized.startsWith(".codex/") ||
    normalized === ".claude" ||
    normalized.startsWith(".claude/") ||
    normalized === ".codex-worker-artifact" ||
    normalized.startsWith(".codex-worker-artifact/") ||
    normalized === ".agents/skills" ||
    normalized.startsWith(".agents/skills/") ||
    normalized === "docs/prd" ||
    normalized.startsWith("docs/prd/") ||
    normalized === "docs/architecture" ||
    normalized.startsWith("docs/architecture/")
  );
}

function runGit(workspace, args) {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`Git validation failed: ${args.slice(0, 2).join(" ")}`);
  }
  return result;
}

function validatePatchPath(filePath) {
  if (
    !filePath ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(filePath) ||
    filePath.split("/").some((part) => !part || part === "." || part === "..") ||
    path.posix.normalize(filePath) !== filePath
  ) {
    throw new Error("Worker Patch contains an unsafe path");
  }
  if (isProtectedWorkerPath(filePath)) {
    throw new Error(`Worker Patch modifies protected path: ${filePath}`);
  }
}

function changedPathsFromPatch(workspace, patchPath) {
  const result = runGit(workspace, ["apply", "--numstat", "-z", patchPath]);
  const records = result.stdout.split("\0").filter(Boolean);
  const changedPaths = records.map((record) => {
    const match = /^[^\t]+\t[^\t]+\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Worker Patch contains a rename or malformed path");
    validatePatchPath(match[1]);
    return match[1];
  });
  if (changedPaths.length === 0) throw new Error("Worker Patch is empty");
  return [...new Set(changedPaths)].sort();
}

function validatePatchMetadata(patch) {
  if (patch.includes("\u0000") || /^Binary files |^GIT binary patch$/m.test(patch)) {
    throw new Error("Worker Patch contains binary content");
  }
  if (/^(?:rename|copy) (?:from|to) /m.test(patch)) {
    throw new Error("Worker Patch contains a rename or copy");
  }
  if (/^(?:old mode|new mode) /m.test(patch)) {
    throw new Error("Worker Patch contains a file mode change");
  }
  for (const match of patch.matchAll(/^(?:new|deleted) file mode (\d+)$/gm)) {
    if (match[1] !== "100644") {
      throw new Error("Worker Patch contains an unsupported file mode");
    }
  }
  if (/^index [0-9a-f]+\.\.[0-9a-f]+ (?:100755|120000|160000)$/m.test(patch)) {
    throw new Error("Worker Patch contains an unsupported file mode");
  }
}

export async function validateAndApplyWorkerArtifact({
  workspace,
  patchPath,
  resultPath,
  plan,
}) {
  const [patchStat, resultStat] = await Promise.all([
    fs.lstat(patchPath),
    fs.lstat(resultPath),
  ]);
  if (!patchStat.isFile() || !resultStat.isFile()) {
    throw new Error("Worker Artifact inputs must be regular files");
  }
  if (patchStat.size > 400 * 1024) throw new Error("Worker Patch exceeds 400 KiB");
  if (resultStat.size > 256 * 1024) throw new Error("Worker result exceeds 256 KiB");
  const patch = await fs.readFile(patchPath, "utf8");
  validatePatchMetadata(patch);

  const status = runGit(workspace, ["status", "--porcelain"]).stdout;
  if (status) throw new Error("Worker publish workspace is not clean");
  const currentHead = runGit(workspace, ["rev-parse", "HEAD"]).stdout.trim();
  if (currentHead !== plan.startSha) {
    throw new Error("Worker publish workspace is not at the recorded start commit");
  }

  const changedPaths = patchStat.size === 0 ? [] : changedPathsFromPatch(workspace, patchPath);
  if (changedPaths.length === 0 && !plan.branchExisted) {
    throw new Error("Worker first publication Patch is empty");
  }
  const result = validateWorkerResult(await fs.readFile(resultPath, "utf8"), plan);
  if (changedPaths.length > 0) {
    runGit(workspace, [
      "apply",
      "--check",
      "--index",
      "--whitespace=error-all",
      patchPath,
    ]);
    runGit(workspace, [
      "apply",
      "--index",
      "--whitespace=error-all",
      patchPath,
    ]);
  }

  return {
    changedPaths,
    result,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function writeOutput(name, value) {
  const outputPath = requiredEnvironment("GITHUB_OUTPUT");
  await fs.appendFile(outputPath, `${name}=${String(value)}\n`, "utf8");
}

async function githubRequest(apiPath, { token, allowNotFound = false, ...options } = {}) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...options.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const method = options.method ?? "GET";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetch(`https://api.github.com${apiPath}`, {
        ...options,
        headers,
      });
    } catch (error) {
      if (method !== "GET" || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      continue;
    }
    if (allowNotFound && response.status === 404) return null;
    if (response.ok) return response.status === 204 ? null : response.json();
    if (
      method !== "GET" ||
      attempt === 3 ||
      ![429, 500, 502, 503, 504].includes(response.status)
    ) {
      throw new Error(`GitHub API ${method} request failed with ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error(`GitHub API ${method} request failed`);
}

async function fetchBranchSha(repository, branch, token) {
  const ref = await githubRequest(
    `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    { token, allowNotFound: true },
  );
  return ref?.object?.sha ?? null;
}

async function fetchWorkerPullRequests(repository, branch, token) {
  const owner = repository.split("/")[0];
  const head = encodeURIComponent(`${owner}:${branch}`);
  return githubRequest(`/repos/${repository}/pulls?state=all&head=${head}&per_page=100`, {
    token,
  });
}

async function fetchIssueState(repository, issueNumber, token) {
  const issue = await githubRequest(`/repos/${repository}/issues/${issueNumber}`, {
    token,
  });
  const blockerNumbers = parseBlockedBy(issue.body, { issueNumber });
  const blockers = await Promise.all(
    blockerNumbers.map((number) =>
      githubRequest(`/repos/${repository}/issues/${number}`, { token }),
    ),
  );
  return { issue, blockers };
}

async function fetchWorkerState({ repository, issueNumber, defaultBranch, token }) {
  const branch = `codex/issue-${issueNumber}`;
  const [{ issue, blockers }, workerPullRequests, branchSha, defaultSha] =
    await Promise.all([
      fetchIssueState(repository, issueNumber, token),
      fetchWorkerPullRequests(repository, branch, token),
      fetchBranchSha(repository, branch, token),
      fetchBranchSha(repository, defaultBranch, token),
    ]);
  return { issue, blockers, workerPullRequests, branchSha, defaultSha };
}

function issueNumberFromEvent(event, eventName) {
  if (eventName === "issues") return event.issue?.number;
  const match = /^codex\/issue-(\d+)$/.exec(event.pull_request?.head?.ref ?? "");
  return match ? Number(match[1]) : null;
}

async function writePrepareOutputs({ operation, reason, issueNumber, plan }) {
  await writeOutput("operation", operation);
  await writeOutput("reason", reason ?? "none");
  await writeOutput("issue_number", issueNumber ?? "");
  await writeOutput("start_sha", plan?.startSha ?? "");
  await writeOutput("default_branch", plan?.defaultBranch ?? "");
}

async function prepareCommand() {
  const event = JSON.parse(
    await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"),
  );
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const eventName = requiredEnvironment("GITHUB_EVENT_NAME");
  const action = classifyWorkerEvent({
    eventName,
    action: event.action,
    label: event.label?.name,
    headRef: event.pull_request?.head?.ref,
    merged: event.pull_request?.merged,
    sameRepository:
      event.pull_request?.head?.repo?.full_name?.toLowerCase() ===
      repository.toLowerCase(),
  });
  const issueNumber = issueNumberFromEvent(event, eventName);
  if (!issueNumber) {
    await writePrepareOutputs({ operation: "noop", reason: "unrelated-event" });
    return;
  }
  if (action !== "evaluate") {
    await writePrepareOutputs({
      operation: action,
      reason:
        action === "noop"
          ? "unrelated-event"
          : action === "closed-pr"
            ? "closed-worker-pr"
            : "control-event",
      issueNumber,
    });
    return;
  }

  const defaultBranch = event.repository?.default_branch;
  if (!/^[A-Za-z0-9._/-]+$/.test(defaultBranch ?? "")) {
    await writePrepareOutputs({
      operation: "triage",
      reason: "invalid-default-branch",
      issueNumber,
    });
    return;
  }

  let state;
  try {
    state = await fetchWorkerState({
      repository,
      issueNumber,
      defaultBranch,
      token: process.env.GITHUB_TOKEN,
    });
  } catch {
    await writePrepareOutputs({
      operation: "triage",
      reason: "prepare-failed",
      issueNumber,
    });
    return;
  }
  const decision = createWorkerPlan({
    repository,
    defaultBranch,
    ...state,
  });
  if (decision.operation !== "implement") {
    await writePrepareOutputs({ ...decision, issueNumber });
    return;
  }

  try {
    validateWorkerConfiguration({
      endpoint: requiredEnvironment("CODEX_RESPONSES_API_ENDPOINT"),
      model: requiredEnvironment("CODEX_MODEL"),
      effort: requiredEnvironment("CODEX_EFFORT"),
      timeout: requiredEnvironment("CODEX_WORKER_TIMEOUT_MINUTES"),
    });
  } catch {
    await writePrepareOutputs({
      operation: "triage",
      reason: "invalid-worker-configuration",
      issueNumber,
    });
    return;
  }
  const prepareDirectory = requiredEnvironment("WORKER_PREPARE_DIR");
  await fs.mkdir(prepareDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(prepareDirectory, "plan.json"),
      `${JSON.stringify(decision.plan, null, 2)}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(prepareDirectory, "prompt.md"),
      buildWorkerPrompt({ issue: state.issue, plan: decision.plan }),
      "utf8",
    ),
  ]);
  await writePrepareOutputs({ ...decision, issueNumber });
}

async function readWorkerPlan(filePath, expected = {}) {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.size > 64 * 1024) {
    throw new Error("Worker plan must be a bounded regular file");
  }
  return validateWorkerPlan(JSON.parse(await fs.readFile(filePath, "utf8")), expected);
}

function fixedFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/protected path/.test(message)) return "protected-change";
  if (/start commit|stale-worker-branch/.test(message)) return "stale-worker-branch";
  if (/Worker result/.test(message)) return "invalid-result";
  return "unsafe-artifact";
}

async function preflightCommand() {
  const expected = {
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    issueNumber: Number(requiredEnvironment("WORKER_ISSUE_NUMBER")),
    startSha: requiredEnvironment("WORKER_START_SHA"),
    defaultBranch: requiredEnvironment("WORKER_DEFAULT_BRANCH"),
  };
  try {
    const plan = await readWorkerPlan(requiredEnvironment("WORKER_PLAN_PATH"), expected);
    const state = await fetchWorkerState({
      repository: plan.repository,
      issueNumber: plan.issueNumber,
      defaultBranch: plan.defaultBranch,
      token: process.env.GITHUB_TOKEN,
    });
    const authorization = evaluatePublicationState({ plan, ...state });
    if (authorization.operation !== "publish") {
      await writeOutput("valid", "false");
      await writeOutput("operation", authorization.operation);
      await writeOutput("reason", authorization.reason);
      return;
    }
    const validated = await validateAndApplyWorkerArtifact({
      workspace: requiredEnvironment("WORKER_WORKSPACE"),
      patchPath: requiredEnvironment("WORKER_PATCH_PATH"),
      resultPath: requiredEnvironment("WORKER_RESULT_PATH"),
      plan,
    });
    if (validated.changedPaths.length > 0) {
      runGit(requiredEnvironment("WORKER_WORKSPACE"), [
        "-c",
        "user.name=github-actions[bot]",
        "-c",
        "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-m",
        `feat: implement issue #${plan.issueNumber}`,
      ]);
    }
    const commitSha = runGit(requiredEnvironment("WORKER_WORKSPACE"), [
      "rev-parse",
      "HEAD",
    ]).stdout.trim();
    await writeOutput("valid", "true");
    await writeOutput("operation", "publish");
    await writeOutput("reason", "authorized");
    await writeOutput("commit_sha", commitSha);
  } catch (error) {
    await writeOutput("valid", "false");
    await writeOutput("operation", "triage");
    await writeOutput("reason", fixedFailureReason(error));
  }
}

function issueAuthorization(issue, blockers) {
  const labels = labelsOf(issue);
  if (issue.state !== "open" || labels.includes("wontfix")) return "close";
  if (
    !labels.includes("ready-for-agent") ||
    labels.some((label) => ["ready-for-human", "needs-triage"].includes(label)) ||
    blockers.some((blocker) => blocker.state !== "closed")
  ) {
    return "pause";
  }
  return "authorized";
}

async function requirePublishAuthorization(repository, issueNumber, token) {
  const state = await fetchIssueState(repository, issueNumber, token);
  const authorization = issueAuthorization(state.issue, state.blockers);
  if (authorization !== "authorized") {
    throw new Error(`Worker publication stopped: ${authorization}`);
  }
}

async function publishCommand() {
  const token = requiredEnvironment("CODEX_GITHUB_TOKEN");
  const workspace = requiredEnvironment("WORKER_WORKSPACE");
  const expected = {
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    issueNumber: Number(requiredEnvironment("WORKER_ISSUE_NUMBER")),
    startSha: requiredEnvironment("WORKER_START_SHA"),
    defaultBranch: requiredEnvironment("WORKER_DEFAULT_BRANCH"),
  };
  const plan = await readWorkerPlan(requiredEnvironment("WORKER_PLAN_PATH"), expected);
  const commitSha = requiredEnvironment("WORKER_COMMIT_SHA");
  const result = validateWorkerResult(
    await fs.readFile(requiredEnvironment("WORKER_RESULT_PATH"), "utf8"),
    plan,
  );
  if (runGit(workspace, ["rev-parse", "HEAD"]).stdout.trim() !== commitSha) {
    throw new Error("Worker publication commit does not match preflight");
  }
  if (
    commitSha !== plan.startSha &&
    runGit(workspace, ["rev-parse", "HEAD^"]).stdout.trim() !== plan.startSha
  ) {
    throw new Error("Worker publication commit is not a direct fast-forward");
  }

  const state = await fetchWorkerState({
    repository: plan.repository,
    issueNumber: plan.issueNumber,
    defaultBranch: plan.defaultBranch,
    token,
  });
  const authorization = evaluatePublicationState({ plan, ...state });
  if (authorization.operation !== "publish") {
    throw new Error(`Worker publication stopped: ${authorization.operation}`);
  }

  if (commitSha !== plan.startSha) {
    await requirePublishAuthorization(plan.repository, plan.issueNumber, token);
    const remoteUrl = `https://github.com/${plan.repository}.git`;
    const currentRemote = runGit(workspace, ["remote", "get-url", "origin"]).stdout.trim();
    if (currentRemote !== remoteUrl) {
      throw new Error("Worker publication remote is unexpected");
    }
    const askPassPath = path.join(requiredEnvironment("RUNNER_TEMP"), "codex-askpass.sh");
    await fs.writeFile(
      askPassPath,
      "#!/bin/sh\ncase \"$1\" in\n  *Username*) printf '%s\\n' x-access-token ;;\n  *Password*) printf '%s\\n' \"$CODEX_GITHUB_TOKEN\" ;;\n  *) exit 1 ;;\nesac\n",
      { mode: 0o700 },
    );
    const push = spawnSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "origin",
        `HEAD:refs/heads/${plan.branch}`,
      ],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_ASKPASS: askPassPath,
          GIT_TERMINAL_PROMPT: "0",
        },
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    await fs.rm(askPassPath, { force: true });
    if (push.status !== 0) throw new Error("Worker branch push failed");
  }

  await requirePublishAuthorization(plan.repository, plan.issueNumber, token);
  const pullRequestBody = buildWorkerPullRequestBody(result, plan.issueNumber);
  const pullRequest = plan.pullRequestNumber
    ? await githubRequest(
        `/repos/${plan.repository}/pulls/${plan.pullRequestNumber}`,
        {
          token,
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: `feat: implement issue #${plan.issueNumber}`,
            body: pullRequestBody,
          }),
        },
      )
    : await githubRequest(`/repos/${plan.repository}/pulls`, {
        token,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `feat: implement issue #${plan.issueNumber}`,
          body: pullRequestBody,
          head: plan.branch,
          base: plan.defaultBranch,
          draft: true,
        }),
      });

  await requirePublishAuthorization(plan.repository, plan.issueNumber, token);
  if (result.human_validation_required) {
    await githubRequest(
      `/repos/${plan.repository}/issues/${pullRequest.number}/labels`,
      {
        token,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels: ["ready-for-human"] }),
      },
    );
  } else if (labelsOf(pullRequest).includes("ready-for-human")) {
    await githubRequest(
      `/repos/${plan.repository}/issues/${pullRequest.number}/labels/ready-for-human`,
      { token, method: "DELETE", allowNotFound: true },
    );
  }

  await requirePublishAuthorization(plan.repository, plan.issueNumber, token);
  await githubRequest(
    `/repos/${plan.repository}/pulls/${pullRequest.number}/ready_for_review`,
    { token, method: "POST" },
  );
}

const FAILURE_MESSAGES = {
  "closed-worker-pr": "The Worker PR was closed without merging.",
  "foreign-worker-pr": "The fixed Worker branch or PR is not owned by this repository.",
  "invalid-default-branch": "The repository default branch could not be validated.",
  "invalid-result": "The Worker returned an invalid structured result.",
  "invalid-start-sha": "The Worker start commit could not be validated.",
  "invalid-worker-configuration": "The Codex Worker repository configuration is invalid.",
  "model-failed": "The Codex model job failed or timed out before producing an Artifact.",
  "multiple-worker-prs": "More than one unmerged Worker PR exists for this Issue.",
  "prepare-failed": "The Worker could not validate the Issue frontier.",
  "protected-change": "The Worker attempted to modify a protected repository boundary.",
  "publish-failed": "The trusted publisher could not complete the fixed publication sequence.",
  "stale-worker-branch": "The fixed Worker branch changed while implementation was running.",
  "stale-worker-pr": "The fixed Worker PR changed while implementation was running.",
  "unsafe-artifact": "The Worker Artifact failed trusted publication validation.",
  "worker-branch-missing": "The existing Worker PR no longer has its fixed branch.",
};

async function closeWorkerPullRequests(repository, issueNumber, token) {
  const branch = `codex/issue-${issueNumber}`;
  const pullRequests = await fetchWorkerPullRequests(repository, branch, token);
  await Promise.all(
    pullRequests
      .filter((pullRequest) => pullRequest.state === "open" && !pullRequest.merged_at)
      .map((pullRequest) =>
        githubRequest(`/repos/${repository}/pulls/${pullRequest.number}`, {
          token,
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: "closed" }),
        }),
      ),
  );
}

async function handleCommand() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const issueNumber = Number(requiredEnvironment("WORKER_ISSUE_NUMBER"));
  assertPositiveInteger(issueNumber, "Worker Issue");
  const operation = requiredEnvironment("WORKER_OPERATION");
  const token = requiredEnvironment("GITHUB_TOKEN");
  if (operation === "pause" || operation === "noop") return;

  const issue = await githubRequest(`/repos/${repository}/issues/${issueNumber}`, {
    token,
  });
  if (issue.pull_request) return;
  const labels = labelsOf(issue);
  if (issue.state !== "open" || labels.includes("wontfix")) {
    await closeWorkerPullRequests(repository, issueNumber, token);
    return;
  }
  if (operation === "close") return;
  if (
    !labels.includes("ready-for-agent") ||
    labels.some((label) => ["ready-for-human", "needs-triage"].includes(label))
  ) {
    return;
  }

  const reason = requiredEnvironment("WORKER_REASON");
  const message = FAILURE_MESSAGES[reason] ?? FAILURE_MESSAGES["unsafe-artifact"];
  await githubRequest(`/repos/${repository}/issues/${issueNumber}/labels`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ labels: ["needs-triage"] }),
  });
  await githubRequest(`/repos/${repository}/issues/${issueNumber}/comments`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      body: `Codex Worker stopped and requires human triage.\n\nReason: ${message}`,
    }),
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "prepare") return prepareCommand();
  if (command === "preflight") return preflightCommand();
  if (command === "publish") return publishCommand();
  if (command === "handle") return handleCommand();
  throw new Error("Expected prepare, preflight, publish, or handle command");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
