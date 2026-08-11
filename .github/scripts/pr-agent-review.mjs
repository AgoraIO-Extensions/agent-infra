import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  collectChangedDiffLines,
  sanitizeMarkdown,
} from "./claude-review.mjs";

const ISSUE_KEYS = [
  "end_line",
  "issue_content",
  "issue_header",
  "relevant_file",
  "start_line",
];
const MAX_FINDINGS = 10;
const REVIEW_KEYS = ["key_issues_to_review"];
const SUMMARY_MARKER_PREFIX = "agent-infra-pr-agent-review";

export class PrAgentOutputError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PrAgentOutputError";
  }
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function boundedString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function parsePrAgentOutput(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("PR-Agent output is missing");
  }
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) {
    throw new PrAgentOutputError("PR-Agent output is too large");
  }

  let review;
  try {
    review = JSON.parse(raw);
  } catch (error) {
    throw new PrAgentOutputError("PR-Agent output is not valid JSON", {
      cause: error,
    });
  }
  if (!exactKeys(review, REVIEW_KEYS) || !Array.isArray(review.key_issues_to_review)) {
    throw new PrAgentOutputError("PR-Agent output has an invalid shape");
  }
  if (review.key_issues_to_review.length > MAX_FINDINGS) {
    throw new PrAgentOutputError("PR-Agent returned too many findings");
  }

  for (const issue of review.key_issues_to_review) {
    if (
      !exactKeys(issue, ISSUE_KEYS) ||
      !boundedString(issue.issue_header, 200) ||
      !boundedString(issue.issue_content, 4_000) ||
      !boundedString(issue.relevant_file, 1_024) ||
      !Number.isSafeInteger(issue.start_line) ||
      !Number.isSafeInteger(issue.end_line) ||
      issue.start_line < 1 ||
      issue.end_line < issue.start_line ||
      issue.end_line - issue.start_line > 100
    ) {
      throw new PrAgentOutputError("PR-Agent finding is invalid");
    }
  }
  return review;
}

export function validatePrAgentLocations(issues, files) {
  const changedLines = new Map(
    files.map((file) => [file.filename, collectChangedDiffLines(file.patch).RIGHT]),
  );
  for (const issue of issues) {
    const lines = changedLines.get(issue.relevant_file);
    let coversChangedLine = false;
    for (let line = issue.start_line; line <= issue.end_line; line += 1) {
      if (lines?.has(line)) {
        coversChangedLine = true;
        break;
      }
    }
    if (!coversChangedLine) {
      throw new PrAgentOutputError(
        `PR-Agent finding is outside the changed diff: ${issue.relevant_file}:${issue.start_line}-${issue.end_line}`,
      );
    }
  }
}

export function assertCurrentPrAgentTarget(pr, expectedHead) {
  if (pr?.state !== "open" || pr?.head?.sha !== expectedHead) {
    throw new Error("PR is closed or its head changed before PR-Agent publication");
  }
  if (pr?.head?.repo?.full_name !== pr?.base?.repo?.full_name) {
    throw new Error("PR-Agent publication is limited to same-repository PRs");
  }
}

export function parsePrAgentEvent(raw) {
  let event;
  try {
    event = JSON.parse(raw);
  } catch (error) {
    throw new Error("PR-Agent event is not valid JSON", { cause: error });
  }
  const head = event?.pull_request?.head;
  const base = event?.pull_request?.base;
  if (
    !/^[0-9a-f]{40}$/.test(head?.sha ?? "") ||
    head?.repo?.full_name !== base?.repo?.full_name
  ) {
    throw new Error("PR-Agent event target is invalid");
  }
  return head.sha;
}

export function prAgentReviewMarker(head) {
  return `<!-- ${SUMMARY_MARKER_PREFIX}:${head} -->`;
}

export function buildPrAgentReview(review, expectedHead) {
  const issues = review.key_issues_to_review;
  const findings = issues.length
    ? issues.map((issue) => {
        const range =
          issue.start_line === issue.end_line
            ? String(issue.start_line)
            : `${issue.start_line}-${issue.end_line}`;
        return `- **${sanitizeMarkdown(issue.issue_header)}** at \`${sanitizeMarkdown(
          issue.relevant_file,
        )}:${range}\`: ${sanitizeMarkdown(issue.issue_content)}`;
      })
    : ["No actionable findings."];
  return [
    prAgentReviewMarker(expectedHead),
    "## PR-Agent Review",
    "",
    ...findings,
  ].join("\n");
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${options.method ?? "GET"} ${path}: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function paginate(path) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubRequest(`${path}${separator}per_page=100&page=${page}`);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error(`GitHub API pagination limit exceeded for ${path}`);
}

async function recordCommand() {
  const event = await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8");
  const head = parsePrAgentEvent(event);
  await fs.appendFile(requiredEnvironment("GITHUB_OUTPUT"), `head_sha=${head}\n`);
}

async function publishCommand() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const prNumber = Number(requiredEnvironment("PR_NUMBER"));
  const expectedHead = requiredEnvironment("EXPECTED_HEAD_SHA");
  if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !/^[0-9a-f]{40}$/.test(expectedHead)) {
    throw new Error("PR-Agent publication target is invalid");
  }

  const prPath = `/repos/${repository}/pulls/${prNumber}`;
  const pr = await githubRequest(prPath);
  assertCurrentPrAgentTarget(pr, expectedHead);
  const review = parsePrAgentOutput(requiredEnvironment("STRUCTURED_OUTPUT"));
  const files = await paginate(`/repos/${repository}/pulls/${prNumber}/files`);
  validatePrAgentLocations(review.key_issues_to_review, files);
  const body = buildPrAgentReview(review, expectedHead);

  const comments = await paginate(`/repos/${repository}/issues/${prNumber}/comments`);
  const marker = prAgentReviewMarker(expectedHead);
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(marker),
  );
  assertCurrentPrAgentTarget(await githubRequest(prPath), expectedHead);
  await githubRequest(
    existing
      ? `/repos/${repository}/issues/comments/${existing.id}`
      : `/repos/${repository}/issues/${prNumber}/comments`,
    {
      method: existing ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
}

async function main() {
  const command = process.argv[2];
  if (command === "record") return recordCommand();
  if (command === "publish") return publishCommand();
  throw new Error("Expected PR-Agent command: record or publish");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
