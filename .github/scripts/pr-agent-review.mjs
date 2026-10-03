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
} from "./claude-review.mjs";

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value, limit) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const agentAuthor = (user) =>
  user?.id === 41898282 &&
  user.login === "github-actions[bot]" &&
  user.type === "Bot";

const stageCategories = {
  "event-read": "input",
  "validate-output": "validation",
  "validate-scope": "validation",
  "target-entry": "target",
  files: "diff",
  "hydrate-diff": "diff",
  "anchor-findings": "validation",
  "target-before-post": "target",
  "post-review": "publication",
  "lookup-review": "readback",
  "read-review": "readback",
  "read-comments": "readback",
  verify: "verification",
  "target-final": "target",
  "output-write": "output",
};
const markStage = (context, stage) => {
  if (context.diagnostic) context.diagnostic.stage = stage;
};

class GitHubRequestFailure extends Error {
  constructor(category, details) {
    super("PR-Agent GitHub request failed");
    this.diagnostic = { category, ...details };
  }
}

export class PrAgentTargetSuperseded extends Error {
  constructor(reason) {
    super(`PR-Agent target skipped: ${reason}`);
    this.reason = reason;
  }
}

export async function requirePrAgentTarget({ repository, prNumber, expectedHead, request }) {
  const current = await request(`/repos/${repository}/pulls/${prNumber}`);
  if (current?.head?.repo?.full_name !== repository || !sha(current.head.sha))
    throw new Error("PR-Agent target identity is invalid");
  const reason = current.state === "closed" ? "pr-closed"
    : current.head.sha !== expectedHead ? "head-superseded"
    : current.draft === true ? "pr-draft" : null;
  if (reason) throw new PrAgentTargetSuperseded(reason);
  if (current.state !== "open") throw new Error("PR-Agent target state is invalid");
  return current;
}

export function publicationFailure(diagnostic, error) {
  const stage = Object.hasOwn(stageCategories, diagnostic?.stage)
    ? diagnostic.stage
    : "unknown";
  return {
    stage,
    ...(error instanceof GitHubRequestFailure
      ? error.diagnostic
      : { category: stageCategories[stage] ?? "unknown" }),
  };
}

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

function decodeGitPath(filename) {
  if (!filename.startsWith('"') || !filename.endsWith('"')) return filename;
  const encoded = filename.slice(1, -1);
  const chunks = [];
  const escapes = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, '"': 34 };
  let offset = 0;
  for (const match of encoded.matchAll(/\\([0-7]{1,3}|[abfnrtv\\"])/g)) {
    chunks.push(Buffer.from(encoded.slice(offset, match.index), "utf8"));
    chunks.push(Buffer.from([/^[0-7]/.test(match[1]) ? Number.parseInt(match[1], 8) : escapes[match[1]]]));
    offset = match.index + match[0].length;
  }
  chunks.push(Buffer.from(encoded.slice(offset), "utf8"));
  return Buffer.concat(chunks).toString("utf8");
}

// Keep the verified range's right-side line anchors separate by file. This is
// used to prove an incremental finding belongs to the supplied delta before
// mapping it onto GitHub's current PR diff.
export function collectScopedChangedLines(diff = "") {
  const files = new Map();
  let path;
  let rightLine;
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      path = undefined;
      rightLine = undefined;
      continue;
    }
    if (rightLine === undefined && text.startsWith("+++ ")) {
      const filename = decodeGitPath(text.slice(4).split("\t", 1)[0]);
      path = filename.startsWith("b/") ? filename.slice(2) : undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      rightLine = Number(hunk[1]);
      if (path && !files.has(path)) files.set(path, new Set());
      continue;
    }
    if (!path || rightLine === undefined || text.startsWith("\\")) continue;
    if (text.startsWith("+")) {
      files.get(path)?.add(rightLine);
      rightLine += 1;
    } else if (!text.startsWith("-")) {
      rightLine += 1;
    }
  }
  return files;
}

const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

const encodedPath = (filename) =>
  filename
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

function decodeBase64Content(value, encoding = "utf8") {
  if (typeof value !== "string") throw new Error("GitHub file content is invalid");
  const bytes = Buffer.from(value.replace(/\s/g, ""), "base64");
  return encoding === null ? bytes : bytes.toString(encoding);
}

/**
 * Read a file through the Contents API and fall back to the Git Blob API for
 * files where Contents returns encoding=none (currently the large-file path).
 */
export async function readGitHubFile({ repository, filename, ref, request, encoding = "utf8" }) {
  const content = await request(
    `/repos/${repository}/contents/${encodedPath(filename)}?ref=${encodeURIComponent(ref)}`,
  );
  if (content?.type !== "file" || !sha(content.sha))
    throw new Error("PR-Agent review file contents are invalid");
  if (content.encoding === "base64" && typeof content.content === "string")
    return decodeBase64Content(content.content, encoding);

  const blob = await request(`/repos/${repository}/git/blobs/${content.sha}`);
  if (
    blob?.sha !== content.sha ||
    blob.encoding !== "base64" ||
    typeof blob.content !== "string"
  )
    throw new Error("PR-Agent review file blob is invalid");
  return decodeBase64Content(blob.content, encoding);
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
    const changed = [];
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
        if (count > 0) changed.push({ start, end: start + count - 1 });
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

function findChangedLine(changed, start, end) {
  if (changed instanceof Set) {
    for (const line of changed) {
      if (line >= start && line <= end) return line;
    }
    return undefined;
  }
  for (const range of changed ?? []) {
    const line = Math.max(start, range.start);
    if (line <= Math.min(end, range.end)) return line;
  }
  return undefined;
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

function reviewBody({ expectedHead, runId, attempt, scope }, count) {
  const range = scope ? `\n\nScope: ${scope.mode}; \`${scope.fromSha}\` → \`${scope.headSha}\`.` : "";
  const empty = scope?.mode === "unchanged" ? "No code changes since the certified baseline; no model review was needed."
    : scope?.mode === "incremental" ? "No major issues detected in the new changes." : "No major issues detected.";
  return `## PR-Agent Review\n\nCommit: \`${expectedHead}\`${range}\n\n${count ? `${count} finding(s) published as review threads.` : empty}\n\n<!-- agent-infra:pr-agent-review:${runId}:${attempt}:${expectedHead} -->`;
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
  markStage(context, "verify");
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
  markStage(context, "read-review");
  const review = await request(path);
  // The review-scoped list only exposes legacy positions, not line/side.
  markStage(context, "read-comments");
  const listed = await request(`${path}/comments?per_page=100`);
  markStage(context, "verify");
  if (
    !Array.isArray(listed) ||
    listed.length !== receipt.findingCount ||
    listed.some(
      (comment) => !Number.isSafeInteger(comment.id) || comment.id < 1,
    ) ||
    new Set(listed.map((comment) => comment.id)).size !== listed.length
  )
    return false;
  markStage(context, "read-comments");
  const comments = await Promise.all(
    listed.map((comment) =>
      request(`/repos/${repository}/pulls/comments/${comment.id}`),
    ),
  );
  markStage(context, "verify");
  if (comments.some((comment, index) => comment.id !== listed[index].id))
    return false;
  return (
    review.id === receipt.reviewId &&
    agentAuthor(review.user) &&
    review.state === "COMMENTED" &&
    review.commit_id === expectedHead &&
    review.body === reviewBody({ ...context, scope: receipt.scope }, receipt.findingCount) &&
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
  markStage(context, "target-entry");
  const current = await requirePrAgentTarget(context);
  markStage(context, "validate-output");
  const findings = context.scope?.mode === "unchanged" ? [] : parsePrAgentReview(raw);
  let verifiedRange;
  if (context.scope) {
    markStage(context, "validate-scope");
    const { verifyReviewScope } = await import("./pr-agent-review-scope.mjs");
    verifiedRange = await verifyReviewScope(context, context.scope);
  }
  const files = new Map();
  const fileMetadata = new Map();
  const missingPatches = new Set();
  const addedFiles = new Set();
  markStage(context, "files");
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
        if (file.status === "removed") {
          files.set(file.filename, new Set());
        } else {
          missingPatches.add(file.filename);
          if (file.status === "added") addedFiles.add(file.filename);
        }
      }
    }
    if (batch.length < 100) break;
    if (page === 30) throw new Error("PR-Agent review file list is incomplete");
  }
  if (missingPatches.size > 0) {
    markStage(context, "hydrate-diff");
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
  markStage(context, "anchor-findings");
  const scopedLines = context.scope ? collectScopedChangedLines(verifiedRange.diff) : null;
  const comments = findings.map((finding) => {
    const path = finding.relevant_file.trim();
    if (scopedLines && !findChangedLine(scopedLines.get(path), finding.start_line, finding.end_line))
      throw new Error("PR-Agent finding is outside the verified review range");
    if (scopedLines && !fileMetadata.has(path))
      throw new Error("PR-Agent incremental finding cannot be anchored in the current PR diff");
    const line = findChangedLine(
      files.get(path),
      finding.start_line,
      finding.end_line,
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
  markStage(context, "target-before-post");
  await requirePrAgentTarget(context);
  if (context.scope) {
    markStage(context, "validate-scope");
    const { verifyReviewScope } = await import("./pr-agent-review-scope.mjs");
    await verifyReviewScope(context, context.scope);
  }
  const receiptFor = (review) => ({
    headSha: expectedHead,
    runId,
    attempt,
    reviewId: review.id,
    findingCount: comments.length,
    commentsSha256: commentDigest(comments),
    ...(context.scope ? { scope: context.scope } : {}),
  });
  const recover = async () => {
    markStage(context, "lookup-review");
    for (let page = 1; page <= 10; page++) {
      const reviews = await request(`/repos/${repository}/pulls/${prNumber}/reviews?per_page=100&page=${page}`);
      if (!Array.isArray(reviews)) throw new Error("PR-Agent review list is invalid");
      const matching = reviews.filter((review) => agentAuthor(review.user) &&
        review.commit_id === expectedHead && review.body === reviewBody(context, findings.length));
      if (matching.length > 1) throw new Error("PR-Agent publication is ambiguous");
      if (matching.length === 1) {
        const receipt = receiptFor(matching[0]);
        if (!(await verifyPrAgentPublication({ ...context, receipt })))
          throw new Error("PR-Agent previous publication could not be verified");
        await requirePrAgentTarget(context);
        return receipt;
      }
      if (reviews.length < 100) return null;
    }
    throw new Error("PR-Agent review list is incomplete");
  };
  const existing = await recover();
  if (existing) return existing;
  markStage(context, "target-before-post");
  await requirePrAgentTarget(context);
  if (context.scope) {
    markStage(context, "validate-scope");
    const { verifyReviewScope } = await import("./pr-agent-review-scope.mjs");
    await verifyReviewScope(context, context.scope);
  }
  markStage(context, "post-review");
  let review;
  try {
    review = await request(
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
  } catch (error) {
    // A timed-out POST may already exist. Recover only an exact verified result;
    // never retry the write and risk creating duplicate review threads.
    const recovered = await recover().catch((recoveryError) => {
      if (recoveryError instanceof PrAgentTargetSuperseded) throw recoveryError;
      return null;
    });
    if (recovered) return recovered;
    markStage(context, "post-review");
    throw error;
  }
  const receipt = receiptFor(review);
  if (!(await verifyPrAgentPublication({ ...context, receipt })))
    throw new Error("PR-Agent published review could not be verified");
  markStage(context, "target-final");
  await requirePrAgentTarget(context);
  return receipt;
}

export async function githubRequest(path, options = {}) {
  const route =
    [
      "contents",
      "compare",
      "git/blobs",
      "files",
      "reviews",
      "comments",
      "issues",
      "pulls",
    ].find((part) => path.includes(`/${part}`)) ?? "unknown";
  const requestDetails = {
    method: ["GET", "POST"].includes(options.method ?? "GET")
      ? (options.method ?? "GET")
      : "unknown",
    route,
  };
  const { responseType, ...fetchOptions } = options;
  for (let attempt = 0; ; attempt++) {
    const details = { ...requestDetails };
    const signal = AbortSignal.timeout(15_000);
    let response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        ...fetchOptions,
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          ...(options.method === "POST" ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      if (details.method === "GET" && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        continue;
      }
      throw new GitHubRequestFailure("network", details);
    }
    details.status = response.status;
    const requestId = response.headers.get("x-github-request-id");
    if (/^[a-f0-9]{1,16}(?::[a-f0-9]{1,16}){2,7}$/i.test(requestId ?? ""))
      details.requestId = requestId;
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      if (details.method === "GET" && attempt < 2 &&
          [408, 429, 500, 502, 503, 504].includes(response.status) &&
          Number.isFinite(retryAfter) && retryAfter >= 0 && retryAfter <= 2) {
        await response.body?.cancel();
        await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter * 1000, 250 * (attempt + 1))));
        continue;
      }
      // Only terminal failures collect advisory metadata; request/retry policy is unchanged.
      for (const [header, field, maximum] of [
        ["retry-after", "retryAfterSeconds", 86_400],
        ["x-ratelimit-remaining", "rateLimitRemaining", 1_000_000],
        ["x-ratelimit-reset", "rateLimitReset", 4_102_444_800],
      ]) {
        const value = response.headers.get(header);
        if (/^(0|[1-9]\d{0,9})(?![\s\S])/.test(value ?? "") && Number(value) <= maximum)
          details[field] = Number(value);
      }
      const resource = response.headers.get("x-ratelimit-resource");
      if (["core", "search", "code_search", "graphql", "integration_manifest"].includes(resource))
        details.rateLimitResource = resource;
      const permissions = response.headers.get("x-accepted-github-permissions");
      const permission = "(?:pull_requests|contents|issues|checks|metadata)=(?:read|write|admin)";
      if (permissions?.length <= 256 && new RegExp(`^${permission}(?:[,;] *${permission})*(?![\\s\\S])`).test(permissions))
        details.acceptedPermissions = permissions.replaceAll(" ", "");
      let reader;
      let timer;
      let abort;
      try {
        reader = response.body?.getReader();
        if (reader) {
          const raw = await Promise.race([
            (async () => {
              const chunks = [];
              let size = 0;
              for (let count = 0; count < 64; count++) {
                const { done, value } = await reader.read();
                if (done) return Buffer.concat(chunks).toString("utf8");
                if (!(value instanceof Uint8Array) || (size += value.byteLength) > 4096)
                  throw new Error("Diagnostic body exceeds limit");
                chunks.push(Buffer.from(value));
              }
              throw new Error("Diagnostic body exceeds chunk limit");
            })(),
            new Promise((_, reject) => {
              abort = () => reject(new Error("Diagnostic body deadline exceeded"));
              timer = setTimeout(abort, 1000);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
          const body = JSON.parse(raw);
          if (typeof body?.message === "string" && !/[\u0000-\u001f\u007f]/.test(body.message)) {
            for (const [phrase, category] of [
              ["Resource not accessible by integration", "integration-permission"],
              ["Resource not accessible by personal access token", "token-permission"],
              ["API rate limit exceeded", "primary-rate-limit"],
              ["You have exceeded a secondary rate limit", "secondary-rate-limit"],
            ]) {
              if (body.message === phrase || body.message.startsWith(`${phrase}.`) || body.message.startsWith(`${phrase} `))
                details.messageCategory = category;
            }
          }
          if (text(body?.documentation_url, 512) && !/[\u0000-\u0020\u007f]/.test(body.documentation_url)) {
            const url = new URL(body.documentation_url);
            const path = url.pathname.replace(/^\/en\//, "/");
            const documents = {
              "/rest/using-the-rest-api/troubleshooting-the-rest-api": "/en/rest/using-the-rest-api/troubleshooting-the-rest-api",
              "/rest/using-the-rest-api/rate-limits-for-the-rest-api": "/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
              "/rest/overview/resources-in-the-rest-api": "/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
              "/rest/pulls/reviews": "/en/rest/pulls/reviews",
            };
            if (url.protocol === "https:" && url.hostname === "docs.github.com" && !url.port && !url.username && !url.password && Object.hasOwn(documents, path))
              details.documentationUrl = `https://docs.github.com${documents[path]}`;
          }
        }
      } catch {
        // Malformed/unreadable bodies must never replace the original HTTP failure.
      } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener("abort", abort);
        // Cancellation is best effort and cannot extend the diagnostic deadline.
        try { void reader?.cancel().catch(() => {}); } catch {}
      }
      throw new GitHubRequestFailure("http", details);
    }
    try {
      return responseType === "text" ? await response.text() : await response.json();
    } catch {
      throw new GitHubRequestFailure("invalid-json", details);
    }
  }
}

export async function runPrAgentPublisher(request = githubRequest) {
  const diagnostic = { stage: "event-read" };
  try {
    const event = JSON.parse(
      await readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    if (process.env.PR_AGENT_REVIEW_SCOPE_REQUIRED === "true" && !process.env.PR_AGENT_REVIEW_SCOPE)
      throw new Error("PR-Agent required review scope is missing");
    const receipt = await publishPrAgentReview({
      repository: process.env.GITHUB_REPOSITORY,
      prNumber: event.pull_request?.number,
      expectedHead: event.pull_request?.head?.sha,
      runId: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      raw: process.env.PR_AGENT_REVIEW,
      ...(process.env.PR_AGENT_REVIEW_SCOPE ? { scope: JSON.parse(process.env.PR_AGENT_REVIEW_SCOPE) } : {}),
      request,
      diagnostic,
    });
    diagnostic.stage = "output-write";
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `applicable=true\nreceipt=${JSON.stringify(receipt)}\n`,
    );
  } catch (error) {
    if (error instanceof PrAgentTargetSuperseded) {
      await appendFile(process.env.GITHUB_OUTPUT, `applicable=false\nreason=${error.reason}\n`);
      console.log(error.message);
      return;
    }
    console.error(
      "PR-Agent publication failed",
      JSON.stringify(publicationFailure(diagnostic, error)),
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runPrAgentPublisher();
}
