import { pathToFileURL } from "node:url";

import {
  hasTrustedBlockerReviewAck,
  isTrustedActionsObject,
  isTrustedBlockerReviewComment,
  parseBlockerProposalRecord,
} from "./blocker-contract.mjs";

export const BLOCKER_REVIEW_RESULT_MARKER =
  "agent-infra-blocker-review-result";

const RESULT_KEYS = ["completed", "findings", "issue_number", "summary"];
const FINDING_KEYS = ["body", "severity", "title"];
const MARKER_KEYS = [
  "digest",
  "issueNumber",
  "sourceCycle",
  "sourceIssue",
  "status",
  "version",
];

function exactKeys(value, expected, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${name} contains missing or unexpected fields`);
  }
}

function boundedText(value, name, maximum) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function encodeMarker(value) {
  return `<!-- ${BLOCKER_REVIEW_RESULT_MARKER}:${Buffer.from(
    JSON.stringify(value),
    "utf8",
  ).toString("base64url")} -->`;
}

function decodeMarker(body) {
  const match = new RegExp(
    `^<!-- ${BLOCKER_REVIEW_RESULT_MARKER}:([A-Za-z0-9_-]{1,4096}) -->`,
  ).exec(String(body ?? ""));
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("Blocker Review result marker is invalid");
  }
}

export function sanitizeBlockerReviewMarkdown(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/@(?=[\w-])/g, "@\u200b")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/```/g, "`\u200b``")
    .trim();
}

export function validateBlockerReviewOutput(raw, issueNumber) {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  exactKeys(value, RESULT_KEYS, "Blocker Review output");
  if (value.completed !== true || value.issue_number !== issueNumber) {
    throw new Error("Blocker Review output does not match the requested Issue");
  }
  if (!Array.isArray(value.findings) || value.findings.length > 10) {
    throw new Error("Blocker Review findings are invalid");
  }
  const findings = value.findings.map((finding, index) => {
    exactKeys(finding, FINDING_KEYS, `Blocker Review finding[${index}]`);
    if (!["P0", "P1", "P2"].includes(finding.severity)) {
      throw new Error(`Blocker Review finding[${index}] severity is invalid`);
    }
    return {
      severity: finding.severity,
      title: boundedText(finding.title, `Blocker Review finding[${index}] title`, 200),
      body: boundedText(finding.body, `Blocker Review finding[${index}] body`, 4_000),
    };
  });
  return {
    completed: true,
    issue_number: issueNumber,
    summary: boundedText(value.summary, "Blocker Review summary", 4_000),
    findings,
  };
}

function resultMarker(issueNumber, record, status) {
  return {
    version: 1,
    issueNumber,
    sourceIssue: record.sourceIssue,
    sourceCycle: record.sourceCycle,
    digest: record.digest,
    status,
  };
}

function sameResultMarker(value, issueNumber, record) {
  exactKeys(value, MARKER_KEYS, "Blocker Review result marker");
  return (
    value.version === 1 &&
    value.issueNumber === issueNumber &&
    value.sourceIssue === record.sourceIssue &&
    value.sourceCycle === record.sourceCycle &&
    value.digest === record.digest &&
    ["success", "infrastructure_failure", "invalid_output"].includes(value.status)
  );
}

export function hasTrustedBlockerReviewResult(comments, issueNumber, record) {
  return (comments ?? []).some((comment) => {
    if (!isTrustedActionsObject(comment, { appendOnly: true })) return false;
    const marker = decodeMarker(comment.body);
    return marker ? sameResultMarker(marker, issueNumber, record) : false;
  });
}

export function buildBlockerReviewResultComment({
  issueNumber,
  record,
  status,
  review,
}) {
  const marker = resultMarker(issueNumber, record, status);
  const lines = [encodeMarker(marker), "## Claude blocker advisory review", ""];
  if (status !== "success") {
    lines.push(
      "Claude Review did not produce a publishable advisory result.",
      "",
      `- Reason: \`${status}\``,
    );
    return lines.join("\n");
  }
  lines.push(sanitizeBlockerReviewMarkdown(review.summary));
  if (review.findings.length === 0) {
    lines.push("", "No concrete blocker-definition findings were identified.");
  } else {
    lines.push("", "### Findings", "");
    for (const finding of review.findings) {
      lines.push(
        `- **${finding.severity}: ${sanitizeBlockerReviewMarkdown(finding.title)}**`,
        `  ${sanitizeBlockerReviewMarkdown(finding.body)}`,
      );
    }
  }
  lines.push(
    "",
    "This review is advisory and does not grant `ready-for-agent` authorization.",
  );
  return lines.join("\n");
}

async function githubRequest(apiPath, { token, ...options } = {}) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`GitHub blocker Review request failed: ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}

async function githubPaginate(apiPath, { token, request = githubRequest } = {}) {
  const values = [];
  for (let page = 1; page <= 20; page += 1) {
    const separator = apiPath.includes("?") ? "&" : "?";
    const batch = await request(
      `${apiPath}${separator}per_page=100&page=${page}`,
      { token },
    );
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error("GitHub blocker Review pagination limit exceeded");
}

export async function publishBlockerReview({
  repository,
  issueNumber,
  analysisResult,
  structuredOutput,
  token,
  request = githubRequest,
  paginate = githubPaginate,
}) {
  const [issue, comments] = await Promise.all([
    request(`/repos/${repository}/issues/${issueNumber}`, { token }),
    paginate(`/repos/${repository}/issues/${issueNumber}/comments`, {
      token,
      request,
    }),
  ]);
  const record = parseBlockerProposalRecord(issue, { comments });
  if (
    !record ||
    !comments.some((comment) => isTrustedBlockerReviewComment(comment)) ||
    !hasTrustedBlockerReviewAck(comments, issueNumber, record)
  ) {
    throw new Error("Blocker Review publication is not authorized");
  }
  if (hasTrustedBlockerReviewResult(comments, issueNumber, record)) {
    return { published: false, reason: "already-published" };
  }

  let status = "success";
  let review;
  if (analysisResult !== "success") {
    status = "infrastructure_failure";
  } else {
    try {
      review = validateBlockerReviewOutput(structuredOutput, issueNumber);
    } catch {
      status = "invalid_output";
    }
  }
  const body = buildBlockerReviewResultComment({
    issueNumber,
    record,
    status,
    review,
  });
  await request(`/repos/${repository}/issues/${issueNumber}/comments`, {
    token,
    method: "POST",
    body: JSON.stringify({ body }),
  });
  return { published: true, status };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  await publishBlockerReview({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    issueNumber: Number(requiredEnvironment("BLOCKER_ISSUE_NUMBER")),
    analysisResult: requiredEnvironment("ANALYSIS_RESULT"),
    structuredOutput: process.env.STRUCTURED_OUTPUT ?? "",
    token: requiredEnvironment("GITHUB_TOKEN"),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
