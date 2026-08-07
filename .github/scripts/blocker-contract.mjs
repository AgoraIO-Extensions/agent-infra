import { createHash } from "node:crypto";

import { GITHUB_ACTIONS_APP_ID } from "./check-run-contract.mjs";
import { parseBlockedBy } from "./worker-contract.mjs";

export const BLOCKER_PROPOSAL_MARKER = "agent-infra-blocker-proposal";
export const BLOCKER_IDENTITY_MARKER = "agent-infra-blocker-identity";
export const BLOCKER_STATE_MARKER = "agent-infra-blocker-state";
export const BLOCKER_REVIEW_ACK_MARKER = "agent-infra-blocker-review-ack";
export const BLOCKER_WORKER_DISPATCH_ACK_MARKER =
  "agent-infra-blocker-worker-dispatch-ack";
export const BLOCKER_REVIEW_COMMENT = [
  "@claude Review this newly created unprivileged blocker proposal.",
  "",
  "<!-- agent-infra-blocker-review -->",
].join("\n");

const PROPOSAL_KEYS = [
  "acceptance_criteria",
  "problem",
  "proposal_id",
  "scope",
  "title",
  "validation",
];
const ACCEPTANCE_CRITERION_KEYS = ["id", "text"];
const PROPOSAL_RECORD_KEYS = [
  "digest",
  "executionContentHash",
  "proposalId",
  "sourceCycle",
  "sourceIssue",
  "version",
];
const STATE_RECORD_KEYS = [
  "blockers",
  "issueNumber",
  "reason",
  "signature",
  "state",
  "version",
];
const STATE_BLOCKER_KEYS = ["number", "status"];
const REVIEW_ACK_KEYS = ["digest", "issueNumber", "sourceCycle", "sourceIssue", "version"];
const WORKER_DISPATCH_ACK_KEYS = ["issueNumber", "operation", "signature", "version"];
const BLOCKER_STATUSES = new Set([
  "completed",
  "invalid",
  "missing",
  "not_planned",
  "open",
]);

function exactKeys(value, expected, name) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${name} must be an object`);
  }
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")) {
    throw new Error(`${name} contains missing or unexpected fields`);
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function boundedText(value, name, maxLength, { singleLine = false } = {}) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ||
    (singleLine && /[\r\n]/.test(value))
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function boundedTextList(value, name, { min = 1, max = 20 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${name} must contain ${min}-${max} entries`);
  }
  return value.map((entry, index) =>
    boundedText(entry, `${name}[${index}]`, 1_000, { singleLine: true }),
  );
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isTrustedActionsObject(value, { appendOnly = false } = {}) {
  return Boolean(
    value?.user?.login === "github-actions[bot]" &&
      value.user.type === "Bot" &&
      value.performed_via_github_app?.id === GITHUB_ACTIONS_APP_ID &&
      (!appendOnly ||
        (typeof value.created_at === "string" &&
          value.created_at === value.updated_at)),
  );
}

function encodeMarker(prefix, value) {
  return `<!-- ${prefix}:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")} -->`;
}

function decodeMarker(body, prefix, name) {
  const pattern = new RegExp(
    `^<!-- ${prefix}:([A-Za-z0-9_-]{1,16384}) -->`,
  );
  const match = pattern.exec(String(body ?? ""));
  if (!match) return null;
  try {
    return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    throw new Error(`${name} marker is invalid`);
  }
}

function sanitizeMarkdown(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/@(?=[\w-])/g, "@\u200b")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/```/g, "`\u200b``")
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/gi, "$1\u200b")
    .replace(/^([ \t]*)(?=#{1,6}(?:[ \t]+|$))/gm, "$1\\")
    .replace(/#(?=[1-9][0-9]*\b)/g, "\\#");
}

export function validateBlockerProposals(proposals) {
  if (!Array.isArray(proposals) || proposals.length > 5) {
    throw new Error("Blocker proposals must be an array with at most 5 entries");
  }
  const ids = [];
  const validated = proposals.map((proposal, index) => {
    exactKeys(proposal, PROPOSAL_KEYS, `Blocker proposal[${index}]`);
    const proposalId = boundedText(
      proposal.proposal_id,
      `Blocker proposal[${index}].proposal_id`,
      64,
      { singleLine: true },
    );
    if (!/^[a-z][a-z0-9-]*$/.test(proposalId)) {
      throw new Error(`Blocker proposal[${index}].proposal_id is invalid`);
    }
    ids.push(proposalId);
    const acceptanceCriteria = proposal.acceptance_criteria;
    if (
      !Array.isArray(acceptanceCriteria) ||
      acceptanceCriteria.length < 1 ||
      acceptanceCriteria.length > 20
    ) {
      throw new Error(`Blocker proposal[${index}].acceptance_criteria is invalid`);
    }
    const acIds = [];
    const normalizedCriteria = acceptanceCriteria.map((criterion, criterionIndex) => {
      exactKeys(
        criterion,
        ACCEPTANCE_CRITERION_KEYS,
        `Blocker proposal[${index}].acceptance_criteria[${criterionIndex}]`,
      );
      const id = criterion.id;
      if (id !== `AC-${criterionIndex + 1}`) {
        throw new Error("Blocker proposal acceptance criteria must use contiguous AC-N IDs");
      }
      acIds.push(id);
      return {
        id,
        text: boundedText(
          criterion.text,
          `Blocker proposal[${index}].acceptance_criteria[${criterionIndex}].text`,
          1_000,
          { singleLine: true },
        ),
      };
    });
    if (new Set(acIds).size !== acIds.length) {
      throw new Error("Blocker proposal acceptance criteria IDs must be unique");
    }
    return {
      proposal_id: proposalId,
      title: boundedText(proposal.title, `Blocker proposal[${index}].title`, 200, {
        singleLine: true,
      }),
      problem: boundedText(proposal.problem, `Blocker proposal[${index}].problem`, 4_000),
      scope: boundedTextList(proposal.scope, `Blocker proposal[${index}].scope`),
      acceptance_criteria: normalizedCriteria,
      validation: boundedTextList(
        proposal.validation,
        `Blocker proposal[${index}].validation`,
      ),
    };
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Blocker proposal IDs must be unique");
  }
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > 64 * 1024) {
    throw new Error("Blocker proposals exceed 64 KiB");
  }
  return validated;
}

export function buildBlockerIssue({
  sourceIssue,
  sourceCycle,
  executionContentHash,
  proposal,
}) {
  positiveInteger(sourceIssue, "Blocker source Issue");
  positiveInteger(sourceCycle, "Blocker source cycle");
  if (!/^[0-9a-f]{64}$/.test(executionContentHash ?? "")) {
    throw new Error("Blocker source execution-content hash is invalid");
  }
  const validated = validateBlockerProposals([proposal])[0];
  const digest = sha256(JSON.stringify(validated));
  const title = `blocker: ${sanitizeMarkdown(validated.title)}`;
  const visibleBody = [
    "## Problem",
    "",
    sanitizeMarkdown(validated.problem),
    "",
    "## Scope",
    "",
    ...validated.scope.map((item) => `- ${sanitizeMarkdown(item)}`),
    "",
    "## Acceptance criteria",
    "",
    ...validated.acceptance_criteria.map(
      (item) => `- [ ] **${item.id}:** ${sanitizeMarkdown(item.text)}`,
    ),
    "",
    "## Validation",
    "",
    ...validated.validation.map((item) => `- ${sanitizeMarkdown(item)}`),
    "",
    "## Blocked by",
    "",
    "None",
    "",
  ].join("\n");
  const record = {
    version: 1,
    sourceIssue,
    sourceCycle,
    executionContentHash,
    proposalId: validated.proposal_id,
    digest,
  };
  const body = `${encodeMarker(BLOCKER_PROPOSAL_MARKER, record)}\n${visibleBody}`;
  return {
    title,
    body,
    identityComment: buildBlockerIdentityComment(record),
    record,
  };
}

function validateBlockerProposalRecord(record) {
  exactKeys(record, PROPOSAL_RECORD_KEYS, "Blocker proposal record");
  if (record.version !== 1) throw new Error("Blocker proposal version is unsupported");
  positiveInteger(record.sourceIssue, "Blocker proposal source Issue");
  positiveInteger(record.sourceCycle, "Blocker proposal source cycle");
  boundedText(record.proposalId, "Blocker proposal ID", 64, { singleLine: true });
  if (!/^[a-z][a-z0-9-]*$/.test(record.proposalId)) {
    throw new Error("Blocker proposal ID is invalid");
  }
  for (const [value, name] of [
    [record.executionContentHash, "Blocker proposal execution-content hash"],
    [record.digest, "Blocker proposal digest"],
  ]) {
    if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${name} is invalid`);
  }
  return record;
}

export function sameBlockerProposalRecord(left, right) {
  return PROPOSAL_RECORD_KEYS.every((key) => left?.[key] === right?.[key]);
}

export function buildBlockerIdentityComment(record) {
  validateBlockerProposalRecord(record);
  return [
    encodeMarker(BLOCKER_IDENTITY_MARKER, record),
    "## Blocker proposal identity audit",
    "",
    `- Source Issue: #${record.sourceIssue}`,
    `- Source cycle: ${record.sourceCycle}`,
    `- Proposal: \`${record.proposalId}\``,
    `- Digest: \`${record.digest}\``,
  ].join("\n");
}

export function parseBlockerProposalRecord(
  issue,
  { trusted = true, comments = [] } = {},
) {
  const record = decodeMarker(
    issue?.body,
    BLOCKER_PROPOSAL_MARKER,
    "Blocker proposal",
  );
  if (!record) return null;
  validateBlockerProposalRecord(record);
  if (!trusted) return record;
  if (!isTrustedActionsObject(issue)) return null;
  const identities = [];
  for (const comment of comments) {
    if (!isTrustedActionsObject(comment, { appendOnly: true })) continue;
    const identity = decodeMarker(
      comment.body,
      BLOCKER_IDENTITY_MARKER,
      "Blocker identity",
    );
    if (!identity) continue;
    validateBlockerProposalRecord(identity);
    if (sameBlockerProposalRecord(identity, record)) identities.push(identity);
  }
  if (identities.length > 1) {
    throw new Error("Blocker proposal has multiple trusted identity audits");
  }
  return identities[0] ?? null;
}

export function isTrustedBlockerReviewComment(comment) {
  return (
    isTrustedActionsObject(comment, { appendOnly: true }) &&
    comment.body === BLOCKER_REVIEW_COMMENT
  );
}

export function buildBlockerReviewAck(issueNumber, record) {
  positiveInteger(issueNumber, "Blocker review Issue");
  validateBlockerProposalRecord(record);
  const ack = {
    version: 1,
    issueNumber,
    sourceIssue: record.sourceIssue,
    sourceCycle: record.sourceCycle,
    digest: record.digest,
  };
  return [
    encodeMarker(BLOCKER_REVIEW_ACK_MARKER, ack),
    "Blocker advisory review dispatch accepted.",
  ].join("\n\n");
}

export function hasTrustedBlockerReviewAck(comments, issueNumber, record) {
  positiveInteger(issueNumber, "Blocker review Issue");
  validateBlockerProposalRecord(record);
  return (comments ?? []).some((comment) => {
    if (!isTrustedActionsObject(comment, { appendOnly: true })) return false;
    const ack = decodeMarker(
      comment.body,
      BLOCKER_REVIEW_ACK_MARKER,
      "Blocker review acknowledgement",
    );
    if (!ack) return false;
    exactKeys(ack, REVIEW_ACK_KEYS, "Blocker review acknowledgement");
    return (
      ack.version === 1 &&
      ack.issueNumber === issueNumber &&
      ack.sourceIssue === record.sourceIssue &&
      ack.sourceCycle === record.sourceCycle &&
      ack.digest === record.digest
    );
  });
}

export function buildWorkerDispatchAck(issueNumber, signature, operation) {
  positiveInteger(issueNumber, "Worker dispatch Issue");
  if (!/^[0-9a-f]{64}$/.test(signature ?? "")) {
    throw new Error("Worker dispatch signature is invalid");
  }
  if (!["evaluate", "pause", "triage"].includes(operation)) {
    throw new Error("Worker dispatch operation is invalid");
  }
  const record = { version: 1, issueNumber, signature, operation };
  return [
    encodeMarker(BLOCKER_WORKER_DISPATCH_ACK_MARKER, record),
    "Codex Worker accepted this blocker-state dispatch.",
  ].join("\n\n");
}

export function hasTrustedWorkerDispatchAck(
  comments,
  issueNumber,
  signature,
  operation,
) {
  positiveInteger(issueNumber, "Worker dispatch Issue");
  if (!/^[0-9a-f]{64}$/.test(signature ?? "")) {
    throw new Error("Worker dispatch signature is invalid");
  }
  return (comments ?? []).some((comment) => {
    if (!isTrustedActionsObject(comment, { appendOnly: true })) return false;
    const record = decodeMarker(
      comment.body,
      BLOCKER_WORKER_DISPATCH_ACK_MARKER,
      "Worker dispatch acknowledgement",
    );
    if (!record) return false;
    exactKeys(record, WORKER_DISPATCH_ACK_KEYS, "Worker dispatch acknowledgement");
    return (
      record.version === 1 &&
      record.issueNumber === issueNumber &&
      record.signature === signature &&
      record.operation === operation
    );
  });
}

export function replaceBlockedBy(body, blockerNumbers, { issueNumber } = {}) {
  if (
    !Array.isArray(blockerNumbers) ||
    blockerNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
    new Set(blockerNumbers).size !== blockerNumbers.length ||
    blockerNumbers.includes(issueNumber)
  ) {
    throw new Error("Blocked by replacement contains invalid Issue numbers");
  }
  parseBlockedBy(body, { issueNumber });
  const lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Blocked by");
  const next = lines.findIndex(
    (line, index) => index > heading && /^##\s+\S/.test(line.trim()),
  );
  const end = next === -1 ? lines.length : next;
  const replacement = [
    "## Blocked by",
    "",
    ...(blockerNumbers.length
      ? blockerNumbers.map((number) => `- #${number}`)
      : ["None"]),
    "",
  ];
  return [...lines.slice(0, heading), ...replacement, ...lines.slice(end)]
    .join("\n")
    .replace(/\n{3,}$/g, "\n\n");
}

function issueLabels(issue) {
  return (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
}

export function blockerStatus(issue) {
  if (!issue) return "missing";
  if (issueLabels(issue).includes("wontfix")) return "not_planned";
  if (issue.state !== "closed") return "open";
  if (issue.state_reason === "completed") return "completed";
  if (issue.state_reason === "not_planned") return "not_planned";
  return "invalid";
}

function cycleNodes(adjacency) {
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const found = new Set();
  function visit(number) {
    if (visiting.has(number)) {
      const start = stack.indexOf(number);
      for (const entry of stack.slice(start)) found.add(entry);
      return;
    }
    if (visited.has(number)) return;
    visiting.add(number);
    stack.push(number);
    for (const blocker of adjacency.get(number) ?? []) visit(blocker);
    stack.pop();
    visiting.delete(number);
    visited.add(number);
  }
  for (const number of adjacency.keys()) visit(number);
  return found;
}

export function inspectBlockerGraph(
  issues,
  { maxIssues = 1_000, maxEdges = 5_000 } = {},
) {
  if (!Array.isArray(issues)) throw new Error("Blocker graph Issues are invalid");
  const issuesByNumber = new Map();
  const adjacency = new Map();
  const reverse = new Map();
  const errors = new Map();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue?.number) || issue.number < 1 || issue.pull_request) {
      continue;
    }
    issuesByNumber.set(issue.number, issue);
  }
  let edgeCount = 0;
  for (const issue of issuesByNumber.values()) {
    if (!String(issue.body ?? "").includes("## Blocked by")) continue;
    try {
      const blockers = parseBlockedBy(issue.body, { issueNumber: issue.number });
      edgeCount += blockers.length;
      adjacency.set(issue.number, blockers);
    } catch (error) {
      errors.set(issue.number, error instanceof Error ? error.message : String(error));
    }
  }
  const participantNumbers = new Set(errors.keys());
  for (const [source, blockers] of adjacency) {
    if (blockers.length > 0) participantNumbers.add(source);
    for (const blocker of blockers) {
      participantNumbers.add(blocker);
      if (!issuesByNumber.has(blocker)) {
        errors.set(source, `Blocked by Issue #${blocker} is missing or is a PR`);
        continue;
      }
      const dependents = reverse.get(blocker) ?? [];
      dependents.push(source);
      reverse.set(blocker, dependents);
    }
  }
  const overflowReason =
    participantNumbers.size > maxIssues
      ? "Blocker graph exceeds the participating Issue limit"
      : edgeCount > maxEdges
        ? "Blocker graph exceeds the edge limit"
        : null;
  if (overflowReason) {
    for (const number of participantNumbers) errors.set(number, overflowReason);
  } else {
    for (const number of cycleNodes(adjacency)) {
      errors.set(number, "Blocked by graph contains a cycle");
    }
  }
  return {
    adjacency,
    reverse,
    issuesByNumber,
    errors,
    edgeCount,
    participantCount: participantNumbers.size,
    overflow: overflowReason,
  };
}

export function nativeDependencyDecision(
  blockerNumbers,
  nativeBlockers,
  issuesByNumber,
) {
  if (
    !Array.isArray(blockerNumbers) ||
    blockerNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
    new Set(blockerNumbers).size !== blockerNumbers.length ||
    !Array.isArray(nativeBlockers) ||
    !(issuesByNumber instanceof Map)
  ) {
    throw new Error("Native dependency inputs are invalid");
  }
  const nativeNumbers = nativeBlockers.map((issue) => issue?.number);
  if (
    nativeNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
    new Set(nativeNumbers).size !== nativeNumbers.length
  ) {
    return { status: "triage", reason: "native-dependency-response-invalid" };
  }
  const body = new Set(blockerNumbers);
  const native = new Set(nativeNumbers);
  const extras = nativeNumbers.filter((number) => !body.has(number));
  if (extras.length > 0) {
    return {
      status: "triage",
      reason: "native-dependency-mismatch",
      extraNumbers: extras.sort((left, right) => left - right),
    };
  }
  const add = [];
  for (const number of blockerNumbers) {
    if (native.has(number)) continue;
    const issueId = issuesByNumber.get(number)?.id;
    if (!Number.isSafeInteger(issueId) || issueId < 1) {
      return {
        status: "triage",
        reason: "native-dependency-target-invalid",
      };
    }
    add.push({ number, issueId });
  }
  return { status: "sync", add };
}

export function assertCanAddBlockers(graph, sourceIssue, blockerNumbers) {
  positiveInteger(sourceIssue, "Blocker graph source Issue");
  if (graph.errors.size > 0) throw new Error("Existing Blocked by graph is invalid");
  if (!graph.issuesByNumber.has(sourceIssue)) {
    throw new Error("Blocker graph source Issue is missing");
  }
  const existing = graph.adjacency.get(sourceIssue) ?? [];
  const combined = [...existing, ...blockerNumbers];
  if (new Set(combined).size !== combined.length) {
    throw new Error("Blocked by graph contains a duplicate edge");
  }
  for (const blocker of blockerNumbers) {
    if (!graph.issuesByNumber.has(blocker)) {
      throw new Error(`Blocked by Issue #${blocker} is missing or is a PR`);
    }
  }
  const adjacency = new Map(
    [...graph.adjacency].map(([number, blockers]) => [number, [...blockers]]),
  );
  adjacency.set(sourceIssue, combined);
  if (cycleNodes(adjacency).size > 0) {
    throw new Error("Blocked by graph contains a cycle");
  }
  return combined;
}

export function affectedDependents(graph, changedIssue) {
  positiveInteger(changedIssue, "Changed blocker Issue");
  const affected = new Set();
  const queue = [...(graph.reverse.get(changedIssue) ?? [])];
  while (queue.length > 0) {
    const number = queue.shift();
    if (affected.has(number)) continue;
    affected.add(number);
    queue.push(...(graph.reverse.get(number) ?? []));
  }
  return [...affected].sort((left, right) => left - right);
}

export function reconciliationIssueNumbers(graph, changedIssue) {
  const targets = new Set(
    [...graph.adjacency]
      .filter(([, blockers]) => blockers.length > 0)
      .map(([number]) => number),
  );
  for (const number of graph.errors.keys()) targets.add(number);
  if (changedIssue !== undefined) {
    positiveInteger(changedIssue, "Changed blocker Issue");
    for (const number of affectedDependents(graph, changedIssue)) targets.add(number);
    if ((graph.adjacency.get(changedIssue) ?? []).length > 0) {
      targets.add(changedIssue);
    }
  }
  return [...targets].sort((left, right) => left - right);
}

export function classifyDependentBlockers(graph, issueNumber) {
  positiveInteger(issueNumber, "Dependent Issue");
  if (graph.errors.has(issueNumber)) {
    const error = String(graph.errors.get(issueNumber));
    const reason = error.startsWith("native-dependency-")
      ? error
      : "invalid-graph";
    return blockerStateResult(issueNumber, [], "triage", reason);
  }
  const blockerNumbers = graph.adjacency.get(issueNumber) ?? [];
  const blockers = blockerNumbers.map((number) => ({
    number,
    status: blockerStatus(graph.issuesByNumber.get(number)),
  }));
  if (blockers.some((blocker) => ["missing", "invalid"].includes(blocker.status))) {
    return blockerStateResult(issueNumber, blockers, "triage", "invalid-blocker-state");
  }
  if (blockers.some((blocker) => blocker.status === "not_planned")) {
    return blockerStateResult(issueNumber, blockers, "triage", "blocker-not-planned");
  }
  if (blockers.some((blocker) => blocker.status === "open")) {
    return blockerStateResult(issueNumber, blockers, "blocked", "open-blockers");
  }
  return blockerStateResult(issueNumber, blockers, "frontier", "blockers-completed");
}

function blockerStateResult(issueNumber, blockers, state, reason) {
  const canonical = {
    version: 1,
    issueNumber,
    blockers,
    state,
    reason,
  };
  return {
    ...canonical,
    signature: sha256(JSON.stringify(canonical)),
  };
}

export function buildBlockerStateComment(record) {
  exactKeys(record, STATE_RECORD_KEYS, "Blocker state record");
  if (record.version !== 1) throw new Error("Blocker state version is unsupported");
  positiveInteger(record.issueNumber, "Blocker state Issue");
  if (!Array.isArray(record.blockers) || record.blockers.length > 100) {
    throw new Error("Blocker state blockers are invalid");
  }
  for (const [index, blocker] of record.blockers.entries()) {
    exactKeys(blocker, STATE_BLOCKER_KEYS, `Blocker state blocker[${index}]`);
    positiveInteger(blocker.number, `Blocker state blocker[${index}] Issue`);
    if (!BLOCKER_STATUSES.has(blocker.status)) {
      throw new Error(`Blocker state blocker[${index}] status is invalid`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(record.signature ?? "")) {
    throw new Error("Blocker state signature is invalid");
  }
  if (!["blocked", "frontier", "triage"].includes(record.state)) {
    throw new Error("Blocker state is invalid");
  }
  boundedText(record.reason, "Blocker state reason", 128, { singleLine: true });
  return [
    encodeMarker(BLOCKER_STATE_MARKER, record),
    "## Blocker reconciliation audit",
    "",
    `- Issue: #${record.issueNumber}`,
    `- State: ${record.state}`,
    `- Reason: ${record.reason}`,
    `- Signature: \`${record.signature}\``,
  ].join("\n");
}

export function latestBlockerStateRecord(comments, issueNumber) {
  const records = [];
  for (const comment of comments ?? []) {
    if (!isTrustedActionsObject(comment, { appendOnly: true })) {
      continue;
    }
    const record = decodeMarker(comment.body, BLOCKER_STATE_MARKER, "Blocker state");
    if (!record) continue;
    exactKeys(record, STATE_RECORD_KEYS, "Blocker state record");
    if (record.issueNumber !== issueNumber) continue;
    buildBlockerStateComment(record);
    records.push({ ...record, commentId: comment.id });
  }
  return records.sort((left, right) => left.commentId - right.commentId).at(-1) ?? null;
}
