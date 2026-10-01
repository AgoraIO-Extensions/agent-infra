import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { evaluateIssueGate, extractPrimaryIssueNumbers } from "./pr-gates.mjs";

export const PRIMARY_ISSUE_MAX_BYTES = 32 * 1024;
const IMAGE = "sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6";
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

function requireContract(body) {
  if (typeof body !== "string" || !body.trim() || Buffer.byteLength(body, "utf8") > PRIMARY_ISSUE_MAX_BYTES) {
    throw new Error("Primary Issue body is missing or exceeds the input byte limit");
  }
  const sections = new Map();
  const headings = [...body.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  for (const name of ["Problem", "Scope", "Acceptance criteria", "Validation", "Blocked by"]) {
    const indexes = headings.flatMap((heading, index) => heading[1] === name ? [index] : []);
    if (indexes.length !== 1) throw new Error("Primary Issue contract sections are invalid");
    const index = indexes[0];
    const start = headings[index].index + headings[index][0].length;
    const end = headings[index + 1]?.index ?? body.length;
    const section = body.slice(start, end);
    if (!section.trim()) throw new Error("Primary Issue contract section is empty");
    sections.set(name, section);
  }
  const ids = [];
  for (const line of sections.get("Acceptance criteria").split(/\r?\n/)) {
    const match = /^\s*-\s+\[[ xX]\]\s+(?:\*\*)?(AC-[1-9][0-9]*)(?:[:：])(?:\*\*)?\s*\S/.exec(line);
    if (!match && /^\s*-\s+(?:\[[^\]]*\]|.*\bAC-[0-9]+\b)/.test(line)) {
      throw new Error("Primary Issue acceptance criterion is invalid");
    }
    if (match) ids.push(match[1]);
  }
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error("Primary Issue acceptance criteria IDs are missing or duplicated");
  }
  return ids;
}

export async function preparePrimaryIssue({ repository, prNumber, expectedHead, runId, attempt, request }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "") ||
      !Number.isSafeInteger(prNumber) || prNumber < 1 || !sha(expectedHead) ||
      !/^[1-9][0-9]*$/.test(runId ?? "") || !/^[1-9][0-9]*$/.test(attempt ?? "")) {
    throw new Error("Primary Issue review identity is invalid");
  }
  const pullRequest = await request(`/repos/${repository}/pulls/${prNumber}`);
  if (pullRequest?.number !== prNumber || pullRequest.state !== "open" ||
      pullRequest.head?.repo?.full_name !== repository || pullRequest.base?.repo?.full_name !== repository ||
      pullRequest.head.sha !== expectedHead || !sha(pullRequest.base?.sha)) {
    throw new Error("Primary Issue review target is stale or belongs to another repository");
  }
  const body = pullRequest.body ?? "";
  const issueNumbers = extractPrimaryIssueNumbers(body);
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  if (issueNumbers.length !== 1 || !Number.isSafeInteger(issueNumbers[0]) || issueNumbers[0] < 1 ||
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https?:\/\/|[\w.-]+\/[\w.-]+#)/i.test(withoutFences)) {
    throw new Error("PR must reference exactly one same-repository primary Issue");
  }
  const issue = await request(`/repos/${repository}/issues/${issueNumbers[0]}`);
  const gate = evaluateIssueGate({ issueNumbers, issue, headRef: pullRequest.head.ref, pullRequestCreatedAt: pullRequest.created_at });
  if (!gate.ok || !Number.isSafeInteger(issue.id) || issue.id < 1 ||
      issue.html_url !== `https://github.com/${repository}/issues/${issue.number}` ||
      typeof issue.title !== "string" || !issue.title.trim() || issue.title.length > 512 ||
      !Number.isFinite(Date.parse(issue.updated_at))) {
    throw new Error("Primary Issue identity or state is invalid");
  }
  const acceptanceCriteriaIds = requireContract(issue.body);
  // The immutable runtime disables Dynaconf @ casts. Its env loader still parses
  // TOML; JSON-quoted string literals preserve the user data inside constant keys.
  const tickets = `[{ticket_id=${issue.number},ticket_url=${JSON.stringify(issue.html_url)},title=${JSON.stringify(issue.title)},body=${JSON.stringify(issue.body)}}]`;
  if (Buffer.byteLength(tickets, "utf8") > 64 * 1024) {
    throw new Error("Primary Issue encoded input exceeds the byte limit");
  }
  return {
    relatedTickets: tickets,
    evidence: {
      repository, prNumber, baseSha: pullRequest.base.sha, headSha: expectedHead,
      runId, attempt, imageDigest: IMAGE, issueNumber: issue.number, issueId: issue.id,
      issueUpdatedAt: issue.updated_at, bodyBytes: Buffer.byteLength(issue.body, "utf8"),
      bodySha256: digest(issue.body), acceptanceCriteriaIds,
      preparation: "complete", delivery: "not_observed", findings: "not_evaluated",
    },
  };
}

const commandData = (value) => value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const prepared = await preparePrimaryIssue({
    repository: process.env.GITHUB_REPOSITORY, prNumber: event.pull_request?.number,
    expectedHead: event.pull_request?.head?.sha, runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    request: async (path) => {
      const response = await fetch(`https://api.github.com${path}`, {
        signal: AbortSignal.timeout(15_000),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!response.ok) throw new Error("Primary Issue GitHub API read failed");
      return response.json();
    },
  });
  // Mask the complete encoded value before GitHub displays the next step's env.
  console.log(`::add-mask::${commandData(prepared.relatedTickets)}`);
  await appendFile(process.env.GITHUB_OUTPUT, `related_tickets=${prepared.relatedTickets}\n`);
  console.log(`Primary Issue input preparation: ${JSON.stringify(prepared.evidence)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("PR-Agent primary Issue input preparation failed");
    process.exitCode = 1;
  });
}
