import { pathToFileURL } from "node:url";

import {
  gateExternalId,
  selectCurrentGateCheck,
} from "./check-run-contract.mjs";

const SUMMARY_MARKER_PREFIX = "agent-infra-claude-review-summary";
const FINDING_KEYS = ["body", "line", "path", "severity", "side", "title"];
const MAX_FINDINGS = 10;
const OUTPUT_KEYS = ["completed", "findings", "head_sha", "summary"];

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

export function parseReviewOutput(raw, expectedHead) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > 256 * 1024) {
    throw new Error("Claude Review output is missing or too large");
  }
  const result = JSON.parse(raw);
  if (!exactKeys(result, OUTPUT_KEYS) || result.completed !== true) {
    throw new Error("Claude Review output has an invalid shape");
  }
  if (result.head_sha !== expectedHead || !/^[0-9a-f]{40}$/.test(result.head_sha)) {
    throw new Error("Claude Review output is stale");
  }
  if (!boundedString(result.summary, 4_000) || !Array.isArray(result.findings)) {
    throw new Error("Claude Review summary or findings are invalid");
  }
  if (result.findings.length > MAX_FINDINGS) {
    throw new Error("Claude Review returned too many findings");
  }

  for (const finding of result.findings) {
    if (
      !exactKeys(finding, FINDING_KEYS) ||
      !["P0", "P1", "P2"].includes(finding.severity) ||
      !boundedString(finding.title, 200) ||
      !boundedString(finding.body, 4_000) ||
      !boundedString(finding.path, 1_024) ||
      !["LEFT", "RIGHT"].includes(finding.side) ||
      !Number.isSafeInteger(finding.line) ||
      finding.line < 1
    ) {
      throw new Error("Claude Review finding is invalid");
    }
  }
  return result;
}

export function selectReviewGateCheck(checkRuns, expectedHead, prNumber) {
  return selectCurrentGateCheck(checkRuns, {
    name: "Claude Review Gate",
    headSha: expectedHead,
    prNumber,
  });
}

export function buildReviewCheckOutput(
  conclusion,
  reasonCode,
  blockingFindingCount = 0,
) {
  const success = conclusion === "success" && reasonCode === "success";
  const blockingFinding =
    conclusion === "failure" && reasonCode === "blocking_finding";
  const blockingFindingCountLine =
    blockingFinding &&
    Number.isSafeInteger(blockingFindingCount) &&
    blockingFindingCount > 0
      ? `\nblocking_finding_count: ${blockingFindingCount}`
      : "";
  return {
    title: `Claude Review Gate: ${conclusion}`,
    summary: success
      ? "reason_code: success\n\nReview completed for the current head."
      : blockingFinding
        ? `reason_code: blocking_finding${blockingFindingCountLine}\n\nReview completed with blocking P0/P1 findings.`
        : `reason_code: ${reasonCode}\n\nThe trusted Review workflow did not produce a publishable result.`,
  };
}

export function reviewGateOutcome(blockingFindings) {
  return blockingFindings.length > 0
    ? { conclusion: "failure", reasonCode: "blocking_finding" }
    : { conclusion: "success", reasonCode: "success" };
}

export function assertCurrentReviewTarget(pr, expectedHead) {
  if (pr?.state !== "open" || pr?.head?.sha !== expectedHead) {
    throw new Error("PR is closed or its head changed before Claude Review publication");
  }
}

export async function requireCurrentReviewTarget({
  repository,
  prNumber,
  expectedHead,
  request,
}) {
  const pr = await request(`/repos/${repository}/pulls/${prNumber}`);
  assertCurrentReviewTarget(pr, expectedHead);
  return pr;
}

export function collectChangedDiffLines(patch = "") {
  const changed = { LEFT: new Set(), RIGHT: new Set() };
  let leftLine;
  let rightLine;
  for (const text of patch.split("\n")) {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      leftLine = Number(hunk[1]);
      rightLine = Number(hunk[2]);
      continue;
    }
    if (leftLine === undefined || rightLine === undefined || text.startsWith("\\")) {
      continue;
    }
    if (text.startsWith("+")) {
      changed.RIGHT.add(rightLine);
      rightLine += 1;
    } else if (text.startsWith("-")) {
      changed.LEFT.add(leftLine);
      leftLine += 1;
    } else if (!text.startsWith("-")) {
      leftLine += 1;
      rightLine += 1;
    }
  }
  return changed;
}

export function validateFindingLocations(findings, files) {
  const locations = new Map(
    files.map((file) => [file.filename, collectChangedDiffLines(file.patch)]),
  );
  for (const finding of findings) {
    if (!locations.get(finding.path)?.[finding.side]?.has(finding.line)) {
      throw new Error(
        `Claude Review finding is outside the changed diff: ${finding.path}:${finding.line}:${finding.side}`,
      );
    }
  }
}

export function sanitizeMarkdown(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("-->", "--&gt;")
    .replaceAll("@", "@\u200b");
}

export function reviewSummaryMarker(head) {
  return `<!-- ${SUMMARY_MARKER_PREFIX}:${head} -->`;
}

export function isTrustedReviewComment(comment, marker) {
  return (
    comment.user?.login === "github-actions[bot]" &&
    comment.user?.type === "Bot" &&
    comment.body?.includes(marker)
  );
}

export function buildReviewSummary(result) {
  const blocking = result.findings.filter((finding) => finding.severity !== "P2");
  const advisory = result.findings.filter((finding) => finding.severity === "P2");
  const advisoryMarkdown = advisory.length
    ? advisory
        .map(
          (finding) =>
            `- **P2 ${sanitizeMarkdown(finding.title)}** at \`${sanitizeMarkdown(
              finding.path,
            )}:${finding.line}:${finding.side}\`: ${sanitizeMarkdown(finding.body)}`,
        )
        .join("\n")
    : "No P2 findings.";

  return {
    blocking,
    markdown: [
      reviewSummaryMarker(result.head_sha),
      "## Claude Review",
      "",
      sanitizeMarkdown(result.summary),
      "",
      `Blocking threads: ${blocking.length}`,
      "",
      "### Advisory Findings",
      "",
      advisoryMarkdown,
    ].join("\n"),
  };
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

function findingMarker(head, finding) {
  const key = Buffer.from(
    `${finding.severity}\0${finding.path}\0${finding.line}\0${finding.side}`,
  ).toString("base64url");
  return `<!-- agent-infra-claude-review:${head}:${key} -->`;
}

async function publishSummary(repository, prNumber, expectedHead, markdown) {
  const comments = await paginate(`/repos/${repository}/issues/${prNumber}/comments`);
  const marker = reviewSummaryMarker(expectedHead);
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(marker),
  );
  const request = {
    method: existing ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: markdown }),
  };
  const path = existing
    ? `/repos/${repository}/issues/comments/${existing.id}`
    : `/repos/${repository}/issues/${prNumber}/comments`;
  await githubRequest(path, request);
}

async function getOrCreateReviewGate(repository, prNumber, expectedHead, targetUrl) {
  const checkName = encodeURIComponent("Claude Review Gate");
  const response = await githubRequest(
    `/repos/${repository}/commits/${expectedHead}/check-runs?check_name=${checkName}&filter=latest&per_page=100`,
  );
  const existing = selectReviewGateCheck(response.check_runs, expectedHead, prNumber);
  if (existing) return existing;
  return githubRequest(`/repos/${repository}/check-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Claude Review Gate",
      head_sha: expectedHead,
      status: "in_progress",
      details_url: targetUrl,
      external_id: gateExternalId({
        name: "Claude Review Gate",
        headSha: expectedHead,
        prNumber,
      }),
      output: {
        title: "Claude Review Gate: in_progress",
        summary: "Waiting for a publishable current-head Review result.",
      },
    }),
  });
}

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const prNumber = Number(requiredEnvironment("PR_NUMBER"));
  const expectedHead = requiredEnvironment("EXPECTED_HEAD_SHA");
  await requireCurrentReviewTarget({
    repository,
    prNumber,
    expectedHead,
    request: githubRequest,
  });

  const check = await getOrCreateReviewGate(
    repository,
    prNumber,
    expectedHead,
    `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  );

  let failureKind = "invalid_output";
  try {
    if (requiredEnvironment("ANALYSIS_RESULT") !== "success") {
      failureKind = "infrastructure_failure";
      throw new Error("Claude Review analysis did not complete successfully");
    }
    const result = parseReviewOutput(requiredEnvironment("STRUCTURED_OUTPUT"), expectedHead);
    const files = await paginate(`/repos/${repository}/pulls/${prNumber}/files`);
    validateFindingLocations(result.findings, files);

    failureKind = "infrastructure_failure";
    const existingComments = await paginate(
      `/repos/${repository}/pulls/${prNumber}/comments`,
    );
    const { blocking, markdown } = buildReviewSummary(result);
    for (const finding of blocking) {
      const marker = findingMarker(expectedHead, finding);
      if (existingComments.some((comment) => isTrustedReviewComment(comment, marker))) {
        continue;
      }
      await requireCurrentReviewTarget({
        repository,
        prNumber,
        expectedHead,
        request: githubRequest,
      });
      await githubRequest(`/repos/${repository}/pulls/${prNumber}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: `**${finding.severity}: ${sanitizeMarkdown(finding.title)}**\n\n${sanitizeMarkdown(
            finding.body,
          )}\n\n${marker}`,
          commit_id: expectedHead,
          path: finding.path,
          line: finding.line,
          side: finding.side,
        }),
      });
    }
    await requireCurrentReviewTarget({
      repository,
      prNumber,
      expectedHead,
      request: githubRequest,
    });
    await publishSummary(repository, prNumber, expectedHead, markdown);
    await requireCurrentReviewTarget({
      repository,
      prNumber,
      expectedHead,
      request: githubRequest,
    });
    const gateOutcome = reviewGateOutcome(blocking);
    await githubRequest(`/repos/${repository}/check-runs/${check.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        conclusion: gateOutcome.conclusion,
        output: buildReviewCheckOutput(
          gateOutcome.conclusion,
          gateOutcome.reasonCode,
          blocking.length,
        ),
      }),
    });
  } catch (error) {
    await githubRequest(`/repos/${repository}/check-runs/${check.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        conclusion: "failure",
        output: buildReviewCheckOutput("failure", failureKind),
      }),
    });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
