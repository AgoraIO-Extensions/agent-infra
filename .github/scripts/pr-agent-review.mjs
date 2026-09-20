import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  collectChangedDiffLines,
  requireCurrentReviewTarget,
} from "./claude-review.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value, limit) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const agentAuthor = (user) =>
  user?.id === 41898282 &&
  user.login === "github-actions[bot]" &&
  user.type === "Bot";

export function parsePrAgentReview(raw) {
  if (typeof raw !== "string" || !raw || Buffer.byteLength(raw) > 64 * 1024) {
    throw new Error("PR-Agent review output is missing or too large");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PR-Agent review output is not JSON");
  }
  const findings = value?.key_issues_to_review;
  if (!Array.isArray(findings) || findings.length > 10)
    throw new Error("PR-Agent review findings are invalid");
  for (const finding of findings) {
    if (
      !finding ||
      !text(finding.relevant_file, 1024) ||
      !text(finding.issue_header, 200) ||
      !text(finding.issue_content, 4000) ||
      !Number.isSafeInteger(finding.start_line) ||
      !Number.isSafeInteger(finding.end_line) ||
      finding.start_line < 1 ||
      finding.end_line < finding.start_line
    ) {
      throw new Error("PR-Agent review finding is invalid");
    }
  }
  return findings;
}

const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

const encodedPath = (filename) =>
  filename
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

function decodeBase64Content(value) {
  if (typeof value !== "string") throw new Error("GitHub file content is invalid");
  return Buffer.from(value.replace(/\s/g, ""), "base64").toString("utf8");
}

/**
 * Read a file through the Contents API and fall back to the Git Blob API for
 * files where Contents returns encoding=none (currently the large-file path).
 */
async function readGitHubFile({ repository, filename, ref, request }) {
  const content = await request(
    `/repos/${repository}/contents/${encodedPath(filename)}?ref=${encodeURIComponent(ref)}`,
  );
  if (content?.type !== "file" || !sha(content.sha))
    throw new Error("PR-Agent review file contents are invalid");
  if (content.encoding === "base64" && typeof content.content === "string")
    return decodeBase64Content(content.content);

  const blob = await request(`/repos/${repository}/git/blobs/${content.sha}`);
  if (
    blob?.sha !== content.sha ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string"
  )
    throw new Error("PR-Agent review file blob is invalid");
  return decodeBase64Content(blob.content);
}

async function resolveMergeBase({ repository, baseSha, headSha, request }) {
  if (!sha(baseSha) || !sha(headSha))
    throw new Error("PR-Agent review commit is invalid");
  const comparison = await request(
    `/repos/${repository}/compare/${baseSha}...${headSha}`,
  );
  if (!sha(comparison?.merge_base_commit?.sha))
    throw new Error("PR-Agent review merge-base is invalid");
  return comparison.merge_base_commit.sha;
}

/**
 * Use Git's own zero-context hunk calculation so repeated lines and EOF
 * insertions follow the same anchors as the pull-request diff.
 */
export async function changedRightLinesFromTexts(before, after) {
  const directory = await mkdtemp(join(tmpdir(), "agent-infra-pr-diff-"));
  const beforePath = join(directory, "before");
  const afterPath = join(directory, "after");
  try {
    await Promise.all([
      writeFile(beforePath, before, "utf8"),
      writeFile(afterPath, after, "utf8"),
    ]);
    const changed = new Set();
    await new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "diff",
          "--no-index",
          "--unified=0",
          "--diff-algorithm=myers",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          beforePath,
          afterPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let pending = "";
      let stderr = "";
      const consume = (line) => {
        const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!match) return;
        const start = Number(match[1]);
        const count = Number(match[2] ?? 1);
        for (let offset = 0; offset < count; offset += 1)
          changed.add(start + offset);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) consume(line);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (pending) consume(pending);
        if (code === 0 || code === 1) return resolve();
        reject(new Error(`git diff failed with exit code ${code}: ${stderr.trim()}`));
      });
    });
    return changed;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function validateContext({
  repository,
  prNumber,
  expectedHead,
  runId,
  attempt,
}) {
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    !Number.isSafeInteger(prNumber) ||
    prNumber < 1 ||
    !/^[a-f0-9]{40}$/.test(expectedHead) ||
    !/^[1-9]\d*$/.test(runId) ||
    !/^[1-9]\d*$/.test(attempt)
  ) {
    throw new Error("PR-Agent review target is invalid");
  }
}

function reviewBody({ expectedHead, runId, attempt }, count) {
  return `## PR-Agent Review\n\nCommit: \`${expectedHead}\`\n\n${count ? `${count} finding(s) published as review threads.` : "No major issues detected."}\n\n<!-- agent-infra:pr-agent-review:${runId}:${attempt}:${expectedHead} -->`;
}

function commentContent(comment) {
  return {
    path: comment.path,
    line: comment.original_line ?? comment.line,
    side: comment.side,
    body: comment.body,
  };
}

const commentDigest = (comments) =>
  digest(
    comments
      .map(commentContent)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );

export async function verifyPrAgentPublication(context) {
  const {
    repository,
    prNumber,
    expectedHead,
    runId,
    attempt,
    receipt,
    request,
  } = context;
  validateContext(context);
  if (
    !receipt ||
    receipt.headSha !== expectedHead ||
    receipt.runId !== runId ||
    receipt.attempt !== attempt ||
    !Number.isSafeInteger(receipt.reviewId) ||
    receipt.reviewId < 1 ||
    !Number.isSafeInteger(receipt.findingCount) ||
    receipt.findingCount < 0 ||
    receipt.findingCount > 10
  )
    return false;
  const path = `/repos/${repository}/pulls/${prNumber}/reviews/${receipt.reviewId}`;
  const review = await request(path);
  // The review-scoped list only exposes legacy positions, not line/side.
  const listed = await request(`${path}/comments?per_page=100`);
  if (
    !Array.isArray(listed) ||
    listed.length !== receipt.findingCount ||
    listed.some(
      (comment) => !Number.isSafeInteger(comment.id) || comment.id < 1,
    ) ||
    new Set(listed.map((comment) => comment.id)).size !== listed.length
  )
    return false;
  const comments = await Promise.all(
    listed.map((comment) =>
      request(`/repos/${repository}/pulls/comments/${comment.id}`),
    ),
  );
  if (comments.some((comment, index) => comment.id !== listed[index].id))
    return false;
  return (
    review.id === receipt.reviewId &&
    agentAuthor(review.user) &&
    review.state === "COMMENTED" &&
    review.commit_id === expectedHead &&
    review.body === reviewBody(context, receipt.findingCount) &&
    Array.isArray(comments) &&
    comments.length === receipt.findingCount &&
    comments.every(
      (comment) =>
        agentAuthor(comment.user) &&
        comment.pull_request_review_id === receipt.reviewId &&
        comment.original_commit_id === expectedHead,
    ) &&
    commentDigest(comments) === receipt.commentsSha256
  );
}

export async function publishPrAgentReview(context) {
  const { repository, prNumber, expectedHead, runId, attempt, raw, request } =
    context;
  validateContext(context);
  const findings = parsePrAgentReview(raw);
  const current = await requireCurrentReviewTarget(context);
  if (current.head.repo?.full_name !== repository)
    throw new Error("PR-Agent review target must be in the same repository");
  const files = new Map();
  const fileMetadata = new Map();
  const missingPatches = new Set();
  const addedFiles = new Set();
  // GitHub caps PR files at 3000; reaching the cap is not evidence of a complete list.
  for (let page = 1; page <= 30; page++) {
    const batch = await request(
      `/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    for (const file of batch) {
      fileMetadata.set(file.filename, file);
      if (typeof file.patch === "string") {
        files.set(file.filename, collectChangedDiffLines(file.patch).RIGHT);
      } else if (findings.some((finding) => finding.relevant_file.trim() === file.filename)) {
        missingPatches.add(file.filename);
        if (file.status === "added") addedFiles.add(file.filename);
      }
    }
    if (batch.length < 100) break;
    if (page === 30) throw new Error("PR-Agent review file list is incomplete");
  }
  if (missingPatches.size > 0) {
    const mergeBaseSha = await resolveMergeBase({
      repository,
      baseSha: current.base?.sha,
      headSha: expectedHead,
      request,
    });
    for (const filename of missingPatches) {
      const metadata = fileMetadata.get(filename);
      const beforeFilename = metadata?.previous_filename ?? filename;
      const [before, after] = await Promise.all([
        addedFiles.has(filename)
          ? undefined
          : readGitHubFile({
              repository,
              filename: beforeFilename,
              ref: mergeBaseSha,
              request,
            }),
        readGitHubFile({
          repository,
          filename,
          ref: expectedHead,
          request,
        }),
      ]);
      files.set(
        filename,
        await changedRightLinesFromTexts(
          before === undefined ? "" : before,
          after,
        ),
      );
    }
  }
  const comments = findings.map((finding) => {
    const path = finding.relevant_file.trim();
    const line = [...(files.get(path) ?? [])].find(
      (line) => line >= finding.start_line && line <= finding.end_line,
    );
    if (!line)
      throw new Error(
        "PR-Agent finding cannot be anchored in the current diff",
      );
    return {
      path,
      line,
      side: "RIGHT",
      body: `**${finding.issue_header.trim()}**\n\n${finding.issue_content.trim()}`,
    };
  });
  await requireCurrentReviewTarget(context);
  const review = await request(
    `/repos/${repository}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      body: JSON.stringify({
        commit_id: expectedHead,
        event: "COMMENT",
        body: reviewBody(context, findings.length),
        comments,
      }),
    },
  );
  const receipt = {
    headSha: expectedHead,
    runId,
    attempt,
    reviewId: review.id,
    findingCount: comments.length,
    commentsSha256: commentDigest(comments),
  };
  if (!(await verifyPrAgentPublication({ ...context, receipt })))
    throw new Error("PR-Agent published review could not be verified");
  await requireCurrentReviewTarget(context);
  return receipt;
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok)
    throw new Error(`PR-Agent GitHub API failed: ${response.status}`);
  return response.json();
}

async function main() {
  const event = JSON.parse(
    await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const receipt = await publishPrAgentReview({
    repository: process.env.GITHUB_REPOSITORY,
    prNumber: event.pull_request?.number,
    expectedHead: event.pull_request?.head?.sha,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    raw: process.env.PR_AGENT_REVIEW,
    request: githubRequest,
  });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `receipt=${JSON.stringify(receipt)}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error("PR-Agent review output or publication is invalid");
    process.exitCode = 1;
  });
}
