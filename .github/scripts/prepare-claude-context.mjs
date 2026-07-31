import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  githubRequest,
  paginate,
  requireEnv,
  validateRepository,
  writeOutputs,
} from "./github-api.mjs";
import { resolveAssistantRequest } from "./check-claude-eligibility.mjs";

const MAX_FILES = 100;
const MAX_COMMENTS = 100;
const MAX_CONTEXT_BYTES = 1_048_576;
const MAX_TITLE_BYTES = 512;
const MAX_BODY_BYTES = 20_000;
const MAX_PATH_BYTES = 1_024;
const MAX_PATCH_BYTES = 262_144;
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function boundedString(value, label, maxBytes, { optional = false } = {}) {
  if ((value === null || value === undefined) && optional) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return value;
}

function boundedLogin(value, label = "author") {
  return boundedString(value, label, 100);
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function validateCompletePatch(patch, expected) {
  let additions = 0;
  let deletions = 0;
  let oldUsed = 0;
  let newUsed = 0;
  let oldCount = 0;
  let newCount = 0;
  let inHunk = false;
  let hunkCount = 0;

  const finishHunk = () => {
    if (inHunk && (oldUsed !== oldCount || newUsed !== newCount)) {
      throw new Error("patch is incomplete or inconsistent with its hunk header");
    }
  };

  const lines = patch.split("\n");
  for (const [index, line] of lines.entries()) {
    const hunk = line.match(
      /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/,
    );
    if (hunk) {
      finishHunk();
      oldCount = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newCount = hunk[2] === undefined ? 1 : Number(hunk[2]);
      oldUsed = 0;
      newUsed = 0;
      inHunk = true;
      hunkCount += 1;
      continue;
    }
    if (!inHunk) {
      if (line === "" && index === lines.length - 1) {
        continue;
      }
      throw new Error("patch is incomplete or does not contain a unified diff hunk");
    }
    if (line === "\\ No newline at end of file") {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
      newUsed += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      oldUsed += 1;
    } else if (line.startsWith(" ")) {
      oldUsed += 1;
      newUsed += 1;
    } else if (line === "" && index === lines.length - 1) {
      continue;
    } else {
      throw new Error("patch is incomplete or contains invalid hunk data");
    }
    if (oldUsed > oldCount || newUsed > newCount) {
      throw new Error("patch is incomplete or inconsistent with its hunk header");
    }
  }
  finishHunk();
  if (
    hunkCount === 0 ||
    additions !== expected.additions ||
    deletions !== expected.deletions ||
    additions + deletions !== expected.changes
  ) {
    throw new Error("patch is incomplete or inconsistent with file change counts");
  }
}

function validateCommon({ repository, token, apiUrl, outputPath }) {
  validateRepository(repository);
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("a GitHub token is required");
  }
  if (typeof apiUrl !== "string" || !/^https:\/\/[^\s]+$/.test(apiUrl)) {
    throw new Error("GitHub API URL must use HTTPS");
  }
  if (typeof outputPath !== "string" || outputPath.length === 0) {
    throw new Error("outputPath is required");
  }
  if (
    basename(outputPath) !== "context.json" ||
    basename(dirname(outputPath)) !== ".claude-context"
  ) {
    throw new Error("outputPath must end with .claude-context/context.json");
  }
}

function sanitizeFile(file) {
  if (typeof file?.patch !== "string" || file.patch.length === 0) {
    throw new Error("patch is missing");
  }
  const patch = boundedString(file?.patch, "patch", MAX_PATCH_BYTES);
  const additions = nonNegativeInteger(file?.additions, "file additions");
  const deletions = nonNegativeInteger(file?.deletions, "file deletions");
  const changes = nonNegativeInteger(file?.changes, "file changes");
  validateCompletePatch(patch, { additions, deletions, changes });
  return {
    filename: boundedString(file?.filename, "filename", MAX_PATH_BYTES),
    status: boundedString(file?.status, "file status", 32),
    additions,
    deletions,
    changes,
    patch,
  };
}

function sanitizeComment(comment, kind) {
  const result = {
    kind,
    id: positiveInteger(comment?.id, "comment ID"),
    author: boundedLogin(comment?.user?.login, "comment author"),
    body: boundedString(comment?.body, "comment body", MAX_BODY_BYTES, {
      optional: true,
    }),
  };
  if (kind === "review_comment") {
    result.path = boundedString(comment?.path, "comment path", MAX_PATH_BYTES);
    if (comment?.line !== null && comment?.line !== undefined) {
      result.line = positiveInteger(comment.line, "comment line");
    }
    if (comment?.side !== null && comment?.side !== undefined) {
      result.side = boundedString(comment.side, "comment side", 16);
    }
  }
  return result;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function writeContext(outputPath, context) {
  const raw = `${JSON.stringify(context, null, 2)}\n`;
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > MAX_CONTEXT_BYTES) {
    throw new Error(`context exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }
  const contextDirectory = dirname(outputPath);
  await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(contextDirectory);
  if (directoryStat.isSymbolicLink()) {
    throw new Error("context directory must not be a symbolic link");
  }
  if (!directoryStat.isDirectory()) {
    throw new Error("context directory must be a directory");
  }

  try {
    const outputStat = await lstat(outputPath);
    if (outputStat.isSymbolicLink()) {
      throw new Error("context file must not be a symbolic link");
    }
    if (!outputStat.isFile()) {
      throw new Error("context output must be a regular file");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const handle = await open(
    outputPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(raw, "utf8");
  } finally {
    await handle.close();
  }
  return bytes;
}

async function collectPullRequestContext({
  repository,
  prNumber,
  headSha,
  token,
  apiUrl,
  fetchImpl,
}) {
  positiveInteger(prNumber, "PR number");
  if (!SHA_PATTERN.test(headSha ?? "")) {
    throw new Error("headSha must be a 40-character lowercase SHA");
  }

  const { data: pr } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/pulls/${prNumber}`,
    fetchImpl,
  });
  if (pr?.state !== "open" || pr?.draft !== false) {
    throw new Error("PR is not an open non-Draft PR");
  }
  if (pr?.head?.repo?.full_name !== repository) {
    throw new Error("PR is not from the base repository");
  }
  if (pr?.head?.sha !== headSha) {
    throw new Error("PR head changed before context preparation");
  }

  const changedFiles = nonNegativeInteger(pr?.changed_files, "changed file count");
  if (changedFiles > MAX_FILES) {
    throw new Error(`PR exceeds the ${MAX_FILES} file limit`);
  }

  const files = await paginate({
    apiUrl,
    token,
    path: `/repos/${repository}/pulls/${prNumber}/files`,
    maxItems: MAX_FILES,
    fetchImpl,
  });
  if (files.length !== changedFiles) {
    throw new Error(
      `GitHub changed file count ${changedFiles} does not match ${files.length} patches`,
    );
  }

  const [issueComments, reviewComments, reviews] = await Promise.all([
    paginate({
      apiUrl,
      token,
      path: `/repos/${repository}/issues/${prNumber}/comments`,
      maxItems: MAX_COMMENTS,
      fetchImpl,
    }),
    paginate({
      apiUrl,
      token,
      path: `/repos/${repository}/pulls/${prNumber}/comments`,
      maxItems: MAX_COMMENTS,
      fetchImpl,
    }),
    paginate({
      apiUrl,
      token,
      path: `/repos/${repository}/pulls/${prNumber}/reviews`,
      maxItems: MAX_COMMENTS,
      fetchImpl,
    }),
  ]);

  const comments = [
    ...issueComments.map((comment) => sanitizeComment(comment, "issue_comment")),
    ...reviewComments.map((comment) =>
      sanitizeComment(comment, "review_comment"),
    ),
    ...reviews.map((comment) => sanitizeComment(comment, "review")),
  ];
  if (comments.length > MAX_COMMENTS) {
    throw new Error(`PR exceeds the ${MAX_COMMENTS} combined comment limit`);
  }

  const { data: currentPr } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/pulls/${prNumber}`,
    fetchImpl,
  });
  if (currentPr?.head?.sha !== headSha) {
    throw new Error("PR head changed after context collection");
  }
  if (
    currentPr?.state !== "open" ||
    currentPr?.draft !== false ||
    currentPr?.head?.repo?.full_name !== repository
  ) {
    throw new Error("PR authority changed after context collection");
  }

  return {
    pull_request: {
      number: positiveInteger(pr?.number, "PR response number"),
      state: "open",
      title: boundedString(pr?.title, "title", MAX_TITLE_BYTES),
      body: boundedString(pr?.body, "body", MAX_BODY_BYTES, { optional: true }),
      author: boundedLogin(pr?.user?.login),
      base_ref: boundedString(pr?.base?.ref, "base ref", 255),
      base_sha: boundedString(pr?.base?.sha, "base SHA", 40),
      head_ref: boundedString(pr?.head?.ref, "head ref", 255),
      head_sha: headSha,
    },
    files: files
      .map(sanitizeFile)
      .sort((left, right) => compareText(left.filename, right.filename)),
    comments: comments.sort((left, right) => left.id - right.id),
  };
}

export async function prepareReviewContext({
  repository,
  prNumber,
  headSha,
  token,
  apiUrl,
  outputPath,
  fetchImpl = fetch,
}) {
  validateCommon({ repository, token, apiUrl, outputPath });
  const data = await collectPullRequestContext({
    repository,
    prNumber,
    headSha,
    token,
    apiUrl,
    fetchImpl,
  });
  const context = {
    format_version: 1,
    kind: "pull_request_review",
    repository,
    ...data,
  };
  const bytes = await writeContext(outputPath, context);
  return {
    outputPath,
    bytes,
    fileCount: data.files.length,
    commentCount: data.comments.length,
  };
}

async function collectIssueContext({
  repository,
  entityNumber,
  token,
  apiUrl,
  fetchImpl,
}) {
  const { data: issue } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/issues/${entityNumber}`,
    fetchImpl,
  });
  if (issue?.pull_request) {
    throw new Error("Assistant issue context unexpectedly resolved to a PR");
  }
  const comments = await paginate({
    apiUrl,
    token,
    path: `/repos/${repository}/issues/${entityNumber}/comments`,
    maxItems: MAX_COMMENTS,
    fetchImpl,
  });
  return {
    issue: {
      number: positiveInteger(issue?.number, "Issue response number"),
      state: boundedString(issue?.state, "Issue state", 16),
      title: boundedString(issue?.title, "title", MAX_TITLE_BYTES),
      body: boundedString(issue?.body, "body", MAX_BODY_BYTES, { optional: true }),
      author: boundedLogin(issue?.user?.login),
    },
    comments: comments
      .map((comment) => sanitizeComment(comment, "issue_comment"))
      .sort((left, right) => left.id - right.id),
  };
}

export async function prepareAssistantContext({
  repository,
  entityType,
  entityNumber,
  headSha,
  request,
  token,
  apiUrl,
  outputPath,
  fetchImpl = fetch,
}) {
  validateCommon({ repository, token, apiUrl, outputPath });
  positiveInteger(entityNumber, "entity number");
  const boundedRequest = boundedString(request, "request", MAX_BODY_BYTES);

  let context;
  if (entityType === "pull_request") {
    const data = await collectPullRequestContext({
      repository,
      prNumber: entityNumber,
      headSha,
      token,
      apiUrl,
      fetchImpl,
    });
    context = {
      format_version: 1,
      kind: "assistant_pull_request",
      repository,
      request: boundedRequest,
      ...data,
    };
  } else if (entityType === "issue") {
    if (headSha !== "") {
      throw new Error("Issue Assistant context must not contain a head SHA");
    }
    const data = await collectIssueContext({
      repository,
      entityNumber,
      token,
      apiUrl,
      fetchImpl,
    });
    context = {
      format_version: 1,
      kind: "assistant_issue",
      repository,
      request: boundedRequest,
      ...data,
    };
  } else {
    throw new Error("entityType must be issue or pull_request");
  }

  const bytes = await writeContext(outputPath, context);
  return {
    outputPath,
    bytes,
    fileCount: context.files?.length ?? 0,
    commentCount: context.comments.length,
  };
}

export async function prepareAssistantContextFromEvent({
  eventName,
  event,
  repository,
  entityType,
  entityNumber,
  headSha,
  token,
  apiUrl,
  outputPath,
  fetchImpl = fetch,
}) {
  const resolved = await resolveAssistantRequest({
    eventName,
    event,
    repository,
    token,
    apiUrl,
    fetchImpl,
  });
  if (!resolved.eligible) {
    throw new Error(`Assistant request is no longer eligible: ${resolved.reason}`);
  }
  if (
    resolved.entityType !== entityType ||
    resolved.entityNumber !== entityNumber ||
    resolved.headSha !== headSha
  ) {
    throw new Error("Assistant request authority changed before context preparation");
  }
  return prepareAssistantContext({
    repository,
    entityType,
    entityNumber,
    headSha,
    request: resolved.request,
    token,
    apiUrl,
    outputPath,
    fetchImpl,
  });
}

async function main() {
  try {
    const env = process.env;
    const mode = requireEnv(env, "CLAUDE_CONTEXT_MODE");
    const outputPath = join(process.cwd(), ".claude-context", "context.json");
    const common = {
      repository: requireEnv(env, "GITHUB_REPOSITORY"),
      token: requireEnv(env, "GITHUB_TOKEN"),
      apiUrl: requireEnv(env, "GITHUB_API_URL"),
      outputPath,
    };
    const result =
      mode === "review"
        ? await prepareReviewContext({
            ...common,
            prNumber: Number(requireEnv(env, "PR_NUMBER")),
            headSha: requireEnv(env, "EXPECTED_HEAD_SHA"),
          })
        : await prepareAssistantContextFromEvent({
            ...common,
            eventName: requireEnv(env, "GITHUB_EVENT_NAME"),
            event: JSON.parse(
              await readFile(requireEnv(env, "GITHUB_EVENT_PATH"), "utf8"),
            ),
            entityType: requireEnv(env, "ENTITY_TYPE"),
            entityNumber: Number(requireEnv(env, "ENTITY_NUMBER")),
            headSha: env.EXPECTED_HEAD_SHA ?? "",
          });

    if (env.GITHUB_OUTPUT) {
      await writeOutputs(env.GITHUB_OUTPUT, {
        context_path: result.outputPath,
        context_bytes: result.bytes,
        file_count: result.fileCount,
        comment_count: result.commentCount,
      });
    }
    console.log(
      `Claude context prepared: ${result.bytes} bytes, ${result.fileCount} files, ${result.commentCount} comments`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Claude context preparation failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
