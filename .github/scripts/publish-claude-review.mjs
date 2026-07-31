import { pathToFileURL } from "node:url";

import {
  githubRequest,
  paginate,
  requireEnv,
  safeMarkdown,
  validateRepository,
} from "./github-api.mjs";

export const CHECK_NAME = "Claude Review";
export const SUMMARY_MARKER = "<!-- agent-infra:claude-review-summary -->";

const BOT_LOGIN = "github-actions[bot]";
const RESULT_FIELDS = [
  "completed",
  "findings",
  "head_sha",
  "residual_risks",
  "scope",
  "summary",
];
const FINDING_FIELDS = ["body", "line", "path", "severity", "title"];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[0-9]+$/;
const MAX_RESULT_BYTES = 524_288;
const MAX_FILES = 100;

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function boundedString(value, name, { min = 1, max }) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    byteLength(value) > max
  ) {
    throw new Error(`${name} must be a string between ${min} and ${max} bytes`);
  }
  return value;
}

function exactFields(value, expected, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      throw new Error(`${name} contains unexpected field ${key}`);
    }
  }
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`${name} is missing field ${field}`);
    }
  }
}

function stringArray(value, name, { min, max, itemMax }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${name} must contain between ${min} and ${max} items`);
  }
  return value.map((item, index) =>
    boundedString(item, `${name}[${index}]`, { max: itemMax }),
  );
}

function findingPath(value, name) {
  const path = boundedString(value, name, { max: 1_024 });
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error(`${name} must be a normalized repository-relative path`);
  }
  return path;
}

function parseFinding(value, index) {
  const name = `findings[${index}]`;
  exactFields(value, FINDING_FIELDS, name);
  if (!new Set(["P0", "P1", "P2"]).has(value.severity)) {
    throw new Error(`${name}.severity must be P0, P1, or P2`);
  }
  if (!Number.isInteger(value.line) || value.line < 1 || value.line > 2_147_483_647) {
    throw new Error(`${name}.line must be a positive integer`);
  }
  return {
    severity: value.severity,
    title: boundedString(value.title, `${name}.title`, { max: 200 }),
    body: boundedString(value.body, `${name}.body`, { max: 4_000 }),
    path: findingPath(value.path, `${name}.path`),
    line: value.line,
  };
}

export function parseReviewResult(raw, expectedHeadSha) {
  if (!SHA_PATTERN.test(expectedHeadSha ?? "")) {
    throw new Error("expected head must be a 40-character lowercase commit SHA");
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    byteLength(raw) > MAX_RESULT_BYTES
  ) {
    throw new Error("structured output must be a non-empty bounded string");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("structured output must be valid JSON");
  }
  exactFields(parsed, RESULT_FIELDS, "structured output");
  if (parsed.completed !== true) {
    throw new Error("completed must be true");
  }
  if (typeof parsed.head_sha !== "string" || !SHA_PATTERN.test(parsed.head_sha)) {
    throw new Error("head_sha must be a 40-character lowercase commit SHA");
  }
  if (parsed.head_sha !== expectedHeadSha) {
    throw new Error("structured output does not match the current PR head");
  }
  if (!Array.isArray(parsed.findings) || parsed.findings.length > 100) {
    throw new Error("findings must contain at most 100 items");
  }
  const findings = parsed.findings.map(parseFinding);
  const seen = new Set();
  for (const item of findings) {
    const identity = JSON.stringify(item);
    if (seen.has(identity)) {
      throw new Error("structured output contains a duplicate finding");
    }
    seen.add(identity);
  }

  return {
    completed: true,
    head_sha: parsed.head_sha,
    scope: stringArray(parsed.scope, "scope", {
      min: 1,
      max: 20,
      itemMax: 200,
    }),
    findings,
    summary: boundedString(parsed.summary, "summary", { max: 4_000 }),
    residual_risks: stringArray(parsed.residual_risks, "residual_risks", {
      min: 0,
      max: 10,
      itemMax: 300,
    }),
  };
}

export function parsePatchRightLines(patch) {
  if (typeof patch !== "string" || patch.length === 0) {
    throw new Error("patch must be a non-empty string");
  }
  const lines = patch.split("\n");
  const addedLines = new Set();
  let rightLine = 0;
  let inHunk = false;
  let hunkCount = 0;

  for (const line of lines) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      rightLine = Number(hunk[1]);
      inHunk = true;
      hunkCount += 1;
      continue;
    }
    if (!inHunk || line === "\\ No newline at end of file") {
      continue;
    }
    if (line.startsWith("+")) {
      addedLines.add(rightLine);
      rightLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      rightLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      continue;
    }
    inHunk = false;
  }

  if (hunkCount === 0) {
    throw new Error("patch does not contain a unified diff hunk");
  }
  return addedLines;
}

function inlineFindingMarker(headSha, runId, index) {
  if (
    !SHA_PATTERN.test(headSha) ||
    !RUN_ID_PATTERN.test(runId) ||
    !Number.isInteger(index) ||
    index < 0
  ) {
    throw new Error("inline finding marker requires a valid head, run, and index");
  }
  return `agent-infra-claude-review-finding:${headSha}:${runId}:${index}`;
}

export function buildInlineComment(item, { headSha, runId, index }) {
  const marker = inlineFindingMarker(headSha, runId, index);
  return `[${item.severity}] ${safeMarkdown(item.title)}

${safeMarkdown(item.body)}

Review evidence: \`${marker}\`
`;
}

export function buildSummary(result, { headSha, runId, runUrl }) {
  if (result.head_sha !== headSha || !SHA_PATTERN.test(headSha)) {
    throw new Error("summary head does not match the validated Review result");
  }
  if (!RUN_ID_PATTERN.test(runId) || !/^https:\/\/[^\s]+$/.test(runUrl)) {
    throw new Error("summary context requires a valid run ID and HTTPS run URL");
  }
  const scope = result.scope.map((item) => `- ${safeMarkdown(item)}`).join("\n");
  const residualRisks =
    result.residual_risks.length === 0
      ? "No residual risks reported."
      : result.residual_risks.map((item) => `- ${safeMarkdown(item)}`).join("\n");
  const findings =
    result.findings.length === 0
      ? "No inline findings were published."
      : `${result.findings.length} inline finding(s) were published.`;

  return `${SUMMARY_MARKER}
## Claude Review

- Head: \`${headSha}\`
- Run: [${runId}](${runUrl})
- Status: completed

### Summary

${safeMarkdown(result.summary)}

### Scope

${scope}

### Findings

${findings}

### Residual Risks

${residualRisks}
`;
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return number;
}

function httpsUrl(value, name) {
  const url = boundedString(value, name, { max: 500 }).replace(/\/$/, "");
  if (!/^https:\/\/[^\s]+$/.test(url)) {
    throw new Error(`${name} must use HTTPS`);
  }
  return url;
}

async function assertCurrentPullRequest({
  apiUrl,
  token,
  repository,
  prNumber,
  headSha,
  fetchImpl,
}) {
  const { data: pullRequest } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/pulls/${prNumber}`,
    fetchImpl,
  });
  if (pullRequest?.state !== "open") {
    throw new Error("PR is no longer open");
  }
  if (pullRequest?.draft !== false) {
    throw new Error("PR became a Draft");
  }
  if (pullRequest?.head?.repo?.full_name !== repository) {
    throw new Error("PR is no longer from the base repository");
  }
  if (pullRequest?.head?.sha !== headSha) {
    throw new Error("PR head changed before publication");
  }
  return pullRequest;
}

async function changedRightLines(context) {
  const pullRequest = await assertCurrentPullRequest(context);
  if (
    !Number.isInteger(pullRequest.changed_files) ||
    pullRequest.changed_files < 0 ||
    pullRequest.changed_files > MAX_FILES
  ) {
    throw new Error(`PR changed file count must be between 0 and ${MAX_FILES}`);
  }
  const files = await paginate({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/pulls/${context.prNumber}/files`,
    maxItems: MAX_FILES,
    fetchImpl: context.fetchImpl,
  });
  if (files.length !== pullRequest.changed_files) {
    throw new Error("changed file pagination is incomplete");
  }
  const result = new Map();
  for (const file of files) {
    const path = findingPath(file?.filename, "changed file path");
    if (result.has(path)) {
      throw new Error("changed file response contains duplicate paths");
    }
    result.set(path, parsePatchRightLines(file?.patch));
  }
  return result;
}

function verifyCheck(value, expected) {
  if (
    value?.id !== expected.id ||
    value?.name !== CHECK_NAME ||
    value?.head_sha !== expected.headSha ||
    value?.status !== expected.status ||
    (expected.conclusion !== undefined && value?.conclusion !== expected.conclusion)
  ) {
    throw new Error("Claude Review Check response did not match the trusted target");
  }
}

async function updateCheck(context, checkRunId, conclusion) {
  await assertCurrentPullRequest(context);
  const { data } = await githubRequest({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/check-runs/${checkRunId}`,
    method: "PATCH",
    body: {
      name: CHECK_NAME,
      status: "completed",
      conclusion,
      output: {
        title:
          conclusion === "success"
            ? "Claude Review completed"
            : "Claude Review failed",
        summary:
          conclusion === "success"
            ? "All review comments and the summary were published and verified."
            : "The analysis or trusted publication did not complete successfully.",
      },
    },
    fetchImpl: context.fetchImpl,
  });
  verifyCheck(data, {
    id: checkRunId,
    headSha: context.headSha,
    status: "completed",
    conclusion,
  });
}

async function createCheck(context, detailsUrl) {
  await assertCurrentPullRequest(context);
  const { data: created } = await githubRequest({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/check-runs`,
    method: "POST",
    body: {
      name: CHECK_NAME,
      head_sha: context.headSha,
      status: "in_progress",
      details_url: detailsUrl,
      output: {
        title: "Claude Review is running",
        summary: "Trusted publication is validating the review result.",
      },
    },
    fetchImpl: context.fetchImpl,
  });
  if (!Number.isSafeInteger(created?.id) || created.id < 1) {
    throw new Error("GitHub Check creation did not return a valid ID");
  }
  const { data: readBack } = await githubRequest({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/check-runs/${created.id}`,
    fetchImpl: context.fetchImpl,
  });
  verifyCheck(readBack, {
    id: created.id,
    headSha: context.headSha,
    status: "in_progress",
  });
  return created.id;
}

function verifyInlineComment(comment, expected) {
  if (
    comment?.id !== expected.id ||
    comment?.body !== expected.body ||
    comment?.commit_id !== expected.headSha ||
    comment?.path !== expected.path ||
    comment?.line !== expected.line ||
    comment?.side !== "RIGHT" ||
    comment?.user?.login !== BOT_LOGIN ||
    comment?.user?.type !== "Bot"
  ) {
    throw new Error("Claude Review inline comment read-back did not match publication");
  }
}

async function publishFinding(context, item, body) {
  await assertCurrentPullRequest(context);
  const { data: created } = await githubRequest({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/pulls/${context.prNumber}/comments`,
    method: "POST",
    body: {
      body,
      commit_id: context.headSha,
      path: item.path,
      line: item.line,
      side: "RIGHT",
    },
    fetchImpl: context.fetchImpl,
  });
  if (!Number.isSafeInteger(created?.id) || created.id < 1) {
    throw new Error("GitHub inline comment creation did not return a valid ID");
  }
  const { data: readBack } = await githubRequest({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/pulls/comments/${created.id}`,
    fetchImpl: context.fetchImpl,
  });
  verifyInlineComment(readBack, {
    id: created.id,
    body,
    headSha: context.headSha,
    path: item.path,
    line: item.line,
  });
}

async function publishSummary(context, result, runUrl) {
  const comments = await paginate({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/issues/${context.prNumber}/comments`,
    maxItems: 10_000,
    fetchImpl: context.fetchImpl,
  });
  const trusted = comments.filter(
    (comment) =>
      typeof comment?.body === "string" &&
      comment.body.startsWith(SUMMARY_MARKER) &&
      comment?.user?.login === BOT_LOGIN &&
      comment?.user?.type === "Bot",
  );
  if (trusted.length > 1) {
    throw new Error("multiple trusted Claude Review summaries exist");
  }
  const body = buildSummary(result, {
    headSha: context.headSha,
    runId: context.runId,
    runUrl,
  });

  await assertCurrentPullRequest(context);
  const targetPath =
    trusted.length === 1
      ? `/repos/${context.repository}/issues/comments/${trusted[0].id}`
      : `/repos/${context.repository}/issues/${context.prNumber}/comments`;
  const { data: published } = await githubRequest({
    apiUrl: context.apiUrl,
    token: context.token,
    path: targetPath,
    method: trusted.length === 1 ? "PATCH" : "POST",
    body: { body },
    fetchImpl: context.fetchImpl,
  });
  if (!Number.isSafeInteger(published?.id) || published.id < 1) {
    throw new Error("GitHub summary publication did not return a valid ID");
  }
  const { data: readBack } = await githubRequest({
    apiUrl: context.apiUrl,
    token: context.token,
    path: `/repos/${context.repository}/issues/comments/${published.id}`,
    fetchImpl: context.fetchImpl,
  });
  if (
    readBack?.id !== published.id ||
    readBack?.body !== body ||
    readBack?.user?.login !== BOT_LOGIN ||
    readBack?.user?.type !== "Bot"
  ) {
    throw new Error("Claude Review summary read-back did not match publication");
  }
  return published.id;
}

export async function publishReview({ env = process.env, fetchImpl = fetch } = {}) {
  if (
    env.ELIGIBLE === "false" ||
    (env.ELIGIBLE === "" && env.ANALYSIS_RESULT === "skipped")
  ) {
    return { published: false, reason: "ineligible" };
  }
  if (env.ELIGIBLE !== "true") {
    throw new Error("ELIGIBLE must be true or false");
  }

  const repository = validateRepository(requireEnv(env, "GITHUB_REPOSITORY"));
  const headSha = requireEnv(env, "EXPECTED_HEAD_SHA");
  if (!SHA_PATTERN.test(headSha)) {
    throw new Error("EXPECTED_HEAD_SHA must be a lowercase 40-character SHA");
  }
  const prNumber = positiveInteger(requireEnv(env, "PR_NUMBER"), "PR_NUMBER");
  const runId = requireEnv(env, "REVIEW_RUN_ID");
  if (!RUN_ID_PATTERN.test(runId) || runId !== requireEnv(env, "GITHUB_RUN_ID")) {
    throw new Error("REVIEW_RUN_ID must be numeric and match GITHUB_RUN_ID");
  }
  const apiUrl = httpsUrl(requireEnv(env, "GITHUB_API_URL"), "GITHUB_API_URL");
  const serverUrl = httpsUrl(
    requireEnv(env, "GITHUB_SERVER_URL"),
    "GITHUB_SERVER_URL",
  );
  const token = requireEnv(env, "GITHUB_TOKEN");
  const context = {
    apiUrl,
    token,
    repository,
    prNumber,
    headSha,
    runId,
    fetchImpl,
  };
  const runUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;

  let checkRunId = 0;
  let checkVerified = false;
  let finalSuccessStarted = false;
  try {
    checkRunId = await createCheck(context, runUrl);
    checkVerified = true;
    if (env.ANALYSIS_RESULT !== "success") {
      throw new Error("Claude analysis did not succeed");
    }
    const result = parseReviewResult(requireEnv(env, "STRUCTURED_OUTPUT"), headSha);
    const linesByPath = await changedRightLines(context);
    for (const item of result.findings) {
      if (!linesByPath.get(item.path)?.has(item.line)) {
        throw new Error(
          `finding target is not an added RIGHT-side diff line: ${item.path}:${item.line}`,
        );
      }
    }

    for (const [index, item] of result.findings.entries()) {
      await publishFinding(
        context,
        item,
        buildInlineComment(item, { headSha, runId, index }),
      );
    }
    const commentId = await publishSummary(context, result, runUrl);

    await assertCurrentPullRequest(context);
    finalSuccessStarted = true;
    const { data: completed } = await githubRequest({
      apiUrl,
      token,
      path: `/repos/${repository}/check-runs/${checkRunId}`,
      method: "PATCH",
      body: {
        name: CHECK_NAME,
        status: "completed",
        conclusion: "success",
        output: {
          title: "Claude Review completed",
          summary: "All review comments and the summary were published and verified.",
        },
      },
      fetchImpl,
    });
    verifyCheck(completed, {
      id: checkRunId,
      headSha,
      status: "completed",
      conclusion: "success",
    });
    return {
      checkRunId,
      commentId,
      findingCount: result.findings.length,
      headSha,
      published: true,
    };
  } catch (error) {
    if (checkVerified && !finalSuccessStarted) {
      try {
        await updateCheck(context, checkRunId, "failure");
      } catch {
        // A stale head or uncertain API response must leave the Check non-successful.
      }
    }
    throw error;
  }
}

async function main() {
  try {
    const result = await publishReview();
    if (result.published) {
      console.log(
        `Claude Review verified for ${result.headSha} with ${result.findingCount} finding(s)`,
      );
    } else {
      console.log(`Claude Review publication skipped: ${result.reason}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Claude Review publication failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
