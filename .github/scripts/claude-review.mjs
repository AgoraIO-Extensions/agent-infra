import { pathToFileURL } from "node:url";

const SUMMARY_MARKER = "<!-- agent-infra-claude-review-summary -->";
const FINDING_KEYS = ["body", "line", "path", "severity", "title"];
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
      !Number.isSafeInteger(finding.line) ||
      finding.line < 1
    ) {
      throw new Error("Claude Review finding is invalid");
    }
  }
  return result;
}

export function collectAddedRightLines(patch = "") {
  const lines = new Set();
  let rightLine;
  for (const text of patch.split("\n")) {
    const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      rightLine = Number(hunk[1]);
      continue;
    }
    if (rightLine === undefined || text.startsWith("\\")) continue;
    if (text.startsWith("+")) {
      lines.add(rightLine);
      rightLine += 1;
    } else if (!text.startsWith("-")) {
      rightLine += 1;
    }
  }
  return lines;
}

export function validateFindingLocations(findings, files) {
  const locations = new Map(
    files.map((file) => [file.filename, collectAddedRightLines(file.patch)]),
  );
  for (const finding of findings) {
    if (!locations.get(finding.path)?.has(finding.line)) {
      throw new Error(
        `Claude Review finding is outside the added diff: ${finding.path}:${finding.line}`,
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
            )}:${finding.line}\`: ${sanitizeMarkdown(finding.body)}`,
        )
        .join("\n")
    : "No P2 findings.";

  return {
    blocking,
    markdown: [
      SUMMARY_MARKER,
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
    `${finding.severity}\0${finding.path}\0${finding.line}`,
  ).toString("base64url");
  return `<!-- agent-infra-claude-review:${head}:${key} -->`;
}

async function publishSummary(repository, prNumber, markdown) {
  const comments = await paginate(`/repos/${repository}/issues/${prNumber}/comments`);
  const existing = comments.find(
    (comment) => comment.user?.type === "Bot" && comment.body?.includes(SUMMARY_MARKER),
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

async function main() {
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const prNumber = Number(requiredEnvironment("PR_NUMBER"));
  const expectedHead = requiredEnvironment("EXPECTED_HEAD_SHA");
  const pr = await githubRequest(`/repos/${repository}/pulls/${prNumber}`);
  if (pr.state !== "open" || pr.head.sha !== expectedHead) {
    throw new Error("PR is closed or its head changed before Claude Review publication");
  }

  const check = await githubRequest(`/repos/${repository}/check-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Claude Review",
      head_sha: expectedHead,
      status: "in_progress",
      details_url: `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    }),
  });

  try {
    if (requiredEnvironment("ANALYSIS_RESULT") !== "success") {
      throw new Error("Claude Review analysis did not complete successfully");
    }
    const result = parseReviewOutput(requiredEnvironment("STRUCTURED_OUTPUT"), expectedHead);
    const files = await paginate(`/repos/${repository}/pulls/${prNumber}/files`);
    validateFindingLocations(result.findings, files);

    const existingComments = await paginate(
      `/repos/${repository}/pulls/${prNumber}/comments`,
    );
    const { blocking, markdown } = buildReviewSummary(result);
    for (const finding of blocking) {
      const marker = findingMarker(expectedHead, finding);
      if (existingComments.some((comment) => isTrustedReviewComment(comment, marker))) {
        continue;
      }
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
          side: "RIGHT",
        }),
      });
    }
    await publishSummary(repository, prNumber, markdown);
    await githubRequest(`/repos/${repository}/check-runs/${check.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", conclusion: "success" }),
    });
  } catch (error) {
    await githubRequest(`/repos/${repository}/check-runs/${check.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Claude Review failed",
          summary: "The trusted Review workflow did not produce a publishable result.",
        },
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
