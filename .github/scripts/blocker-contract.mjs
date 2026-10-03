import { createHash } from "node:crypto";

import { GITHUB_ACTIONS_APP_ID } from "./check-run-contract.mjs";
import { parseBlockedBy } from "./worker-contract.mjs";

export const BLOCKER_PROPOSAL_MARKER = "agent-infra-blocker-proposal";
export const BLOCKER_IDENTITY_MARKER = "agent-infra-blocker-identity";
export const BLOCKER_STATE_MARKER = "agent-infra-blocker-state";
export const BLOCKER_REVIEW_ACK_MARKER = "agent-infra-blocker-review-ack";
export const BLOCKER_WORKER_DISPATCH_ACK_MARKER =
  "agent-infra-blocker-worker-dispatch-ack";
export const HUMAN_HANDOFF_MARKER = "agent-infra-human-handoff";
export const BLOCKER_REVIEW_COMMENT = [
  "@claude Review this newly created unprivileged blocker proposal.",
  "",
  "<!-- agent-infra-blocker-review -->",
].join("\n");
export const BLOCKER_PUBLISH_FAILURE_MESSAGE =
  "The trusted Publisher could not create or register the proposed blocker.";
export const BLOCKER_PUBLISH_TRIAGE_COMMENT = [
  "Codex Worker stopped and requires human triage.",
  "",
  `Reason: ${BLOCKER_PUBLISH_FAILURE_MESSAGE}`,
].join("\n");

const GITHUB_ACTIONS_BOT_ID = 41898282;

const PROPOSAL_KEYS = [
  "acceptance_criteria",
  "deliverable",
  "problem",
  "proposal_id",
  "scope",
  "title",
  "validation",
];
const HUMAN_HANDOFF_KEYS = ["handoff_id", "reason", "required_action"];
const HUMAN_HANDOFF_RECORD_KEYS = [
  "digest",
  "executionContentHash",
  "handoffId",
  "reason",
  "sourceCycle",
  "sourceIssue",
  "version",
];
const HUMAN_HANDOFF_REASONS = new Set([
  "permission_required",
  "protected_path_change",
  "requirements_conflict",
  "credential_required",
  "architecture_decision",
]);
const HUMAN_HANDOFF_ACTIONS = {
  permission_required:
    "A repository owner must review and grant or decline the required permission.",
  protected_path_change:
    "A repository maintainer must implement the protected-boundary change in a human-authored PR.",
  requirements_conflict:
    "The Issue owner must resolve the conflicting requirements before a new Worker cycle.",
  credential_required:
    "A repository owner must provide the required credential through an approved secret channel.",
  architecture_decision:
    "The architecture owner must record the required decision before implementation resumes.",
};
const ACCEPTANCE_CRITERION_KEYS = ["id", "text"];
const PROPOSAL_RECORD_KEYS = [
  "digest",
  "executionContentHash",
  "proposalId",
  "sourceCycle",
  "sourceIssue",
  "version",
];
const IDENTITY_RECORD_KEYS = ["contentHash", "proposal", "version"];
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

export function isActionsCreatedBlockerIssue(value) {
  return Boolean(
    isTrustedActionsObject(value) ||
      (isGitHubActionsBot(value?.user) &&
        value.performed_via_github_app === null),
  );
}

export function isGitHubActionsBot(value) {
  return Boolean(
    value?.id === GITHUB_ACTIONS_BOT_ID &&
      value.login === "github-actions[bot]" &&
      value.type === "Bot",
  );
}

export function hasTrustedBlockerIdentityAudit(comments) {
  return (comments ?? []).some((comment) => {
    if (!isTrustedActionsObject(comment, { appendOnly: true })) return false;
    try {
      return Boolean(
        decodeMarker(comment.body, BLOCKER_IDENTITY_MARKER, "Blocker identity"),
      );
    } catch {
      return true;
    }
  });
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
      deliverable: boundedText(
        proposal.deliverable,
        `Blocker proposal[${index}].deliverable`,
        1_000,
        { singleLine: true },
      ),
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

export function validateHumanHandoffs(handoffs) {
  if (!Array.isArray(handoffs) || handoffs.length > 5) {
    throw new Error("Human handoffs must be an array with at most 5 entries");
  }
  const ids = [];
  const validated = handoffs.map((handoff, index) => {
    exactKeys(handoff, HUMAN_HANDOFF_KEYS, `Human handoff[${index}]`);
    const handoffId = boundedText(
      handoff.handoff_id,
      `Human handoff[${index}].handoff_id`,
      64,
      { singleLine: true },
    );
    if (!/^[a-z][a-z0-9-]*$/.test(handoffId)) {
      throw new Error(`Human handoff[${index}].handoff_id is invalid`);
    }
    if (!HUMAN_HANDOFF_REASONS.has(handoff.reason)) {
      throw new Error(`Human handoff[${index}].reason is invalid`);
    }
    ids.push(handoffId);
    return {
      handoff_id: handoffId,
      reason: handoff.reason,
      required_action: boundedText(
        handoff.required_action,
        `Human handoff[${index}].required_action`,
        1_000,
        { singleLine: true },
      ),
    };
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("Human handoff IDs must be unique");
  }
  if (Buffer.byteLength(JSON.stringify(validated), "utf8") > 32 * 1024) {
    throw new Error("Human handoffs exceed 32 KiB");
  }
  return validated;
}

function validateHumanHandoffRecord(record) {
  exactKeys(record, HUMAN_HANDOFF_RECORD_KEYS, "Human handoff record");
  if (record.version !== 1) throw new Error("Human handoff record version is invalid");
  positiveInteger(record.sourceIssue, "Human handoff source Issue");
  positiveInteger(record.sourceCycle, "Human handoff source cycle");
  if (!/^[0-9a-f]{64}$/.test(record.executionContentHash ?? "")) {
    throw new Error("Human handoff execution-content hash is invalid");
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(record.handoffId ?? "")) {
    throw new Error("Human handoff record ID is invalid");
  }
  if (!HUMAN_HANDOFF_REASONS.has(record.reason)) {
    throw new Error("Human handoff record reason is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(record.digest ?? "")) {
    throw new Error("Human handoff record digest is invalid");
  }
  return record;
}

function humanHandoffCommentBody(record) {
  return [
    encodeMarker(HUMAN_HANDOFF_MARKER, record),
    "",
    "Codex Worker stopped and requires human triage.",
    "",
    `Reason code: ${record.reason}`,
    "",
    `Required action: ${HUMAN_HANDOFF_ACTIONS[record.reason]}`,
  ].join("\n");
}

export function buildHumanHandoffComment({
  sourceIssue,
  sourceCycle,
  executionContentHash,
  handoff,
}) {
  positiveInteger(sourceIssue, "Human handoff source Issue");
  positiveInteger(sourceCycle, "Human handoff source cycle");
  if (!/^[0-9a-f]{64}$/.test(executionContentHash ?? "")) {
    throw new Error("Human handoff execution-content hash is invalid");
  }
  const validated = validateHumanHandoffs([handoff])[0];
  const record = {
    version: 1,
    sourceIssue,
    sourceCycle,
    executionContentHash,
    handoffId: validated.handoff_id,
    reason: validated.reason,
    digest: sha256(JSON.stringify(validated)),
  };
  return { body: humanHandoffCommentBody(record), record };
}

export function parseHumanHandoffComment(comment) {
  if (!isTrustedActionsObject(comment, { appendOnly: true })) return null;
  const record = decodeMarker(
    comment.body,
    HUMAN_HANDOFF_MARKER,
    "Human handoff",
  );
  if (!record) return null;
  validateHumanHandoffRecord(record);
  return comment.body === humanHandoffCommentBody(record) ? record : null;
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
    "## Deliverable",
    "",
    sanitizeMarkdown(validated.deliverable),
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
    identityComment: buildBlockerIdentityComment(record, { title, body }),
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

export function canRegisterBlockerIdentity(issue, rendered) {
  if (!isActionsCreatedBlockerIssue(issue)) return false;
  let record;
  try {
    record = parseBlockerProposalRecord(issue, { trusted: false });
  } catch {
    return false;
  }
  return Boolean(
    record &&
      sameBlockerProposalRecord(record, rendered?.record) &&
      issue.title === rendered?.title &&
      issue.body === rendered?.body,
  );
}

function immutableBlockerIssueBody(body) {
  if (typeof body !== "string") return body;
  try {
    parseBlockedBy(body);
  } catch {
    return body;
  }
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const heading = lines.findIndex((line) => line.trim() === "## Blocked by");
  const next = lines.findIndex(
    (line, index) => index > heading && /^##\s+\S/.test(line.trim()),
  );
  return [
    ...lines.slice(0, heading + 1),
    ...lines.slice(next === -1 ? lines.length : next),
  ].join("\n");
}

function blockerIssueContentHash(issue) {
  return sha256(
    JSON.stringify({
      title: issue?.title,
      body: immutableBlockerIssueBody(issue?.body),
    }),
  );
}

export function buildBlockerIdentityComment(record, issue) {
  validateBlockerProposalRecord(record);
  if (typeof issue?.title !== "string" || typeof issue?.body !== "string") {
    throw new Error("Blocker identity Issue content is invalid");
  }
  const identity = {
    version: 1,
    proposal: record,
    contentHash: blockerIssueContentHash(issue),
  };
  return [
    encodeMarker(BLOCKER_IDENTITY_MARKER, identity),
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
  if (!isActionsCreatedBlockerIssue(issue)) return null;
  const identities = [];
  for (const comment of comments) {
    if (!isTrustedActionsObject(comment, { appendOnly: true })) continue;
    const identity = decodeMarker(
      comment.body,
      BLOCKER_IDENTITY_MARKER,
      "Blocker identity",
    );
    if (!identity) continue;
    if (Object.hasOwn(identity, "proposal")) {
      exactKeys(identity, IDENTITY_RECORD_KEYS, "Blocker identity");
      if (
        identity.version !== 1 ||
        !/^[0-9a-f]{64}$/.test(identity.contentHash ?? "")
      ) {
        throw new Error("Blocker identity is invalid");
      }
      validateBlockerProposalRecord(identity.proposal);
      if (
        sameBlockerProposalRecord(identity.proposal, record) &&
        identity.contentHash === blockerIssueContentHash(issue)
      ) {
        identities.push(identity.proposal);
      }
      continue;
    }
    validateBlockerProposalRecord(identity);
    if (
      isTrustedActionsObject(issue) &&
      sameBlockerProposalRecord(identity, record)
    ) {
      identities.push(identity);
    }
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
  const lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const headings = lines.flatMap((line, index) =>
    line.trim() === "## Blocked by" ? [index] : [],
  );
  if (headings.length !== 1) {
    throw new Error("Issue must contain exactly one ## Blocked by section");
  }
  const heading = headings[0];
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

const IMPLEMENTATION_HEADINGS = [
  "## Problem",
  "## Scope",
  "## Acceptance criteria",
  "## Validation",
  "## Blocked by",
];

export function workItemKind(issue) {
  if (issue?.pull_request) return "pull-request";
  const labels = issueLabels(issue);
  if (labels.includes("wayfinder:map")) return "map";
  if (labels.some((label) => label.startsWith("wayfinder:"))) return "decision";
  const lines = String(issue?.body ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  return IMPLEMENTATION_HEADINGS.every(
    (heading) => lines.filter((line) => line === heading).length === 1,
  )
    ? "implementation"
    : "other";
}

export async function hydrateNativeDependencies(
  issues,
  load,
  { concurrency = 8 } = {},
) {
  if (
    !Array.isArray(issues) ||
    typeof load !== "function" ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 32
  ) {
    throw new Error("Native dependency hydration inputs are invalid");
  }
  const candidates = issues.filter(
    (issue) => workItemKind(issue) === "implementation",
  );
  const snapshot = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const issue = candidates[cursor];
      cursor += 1;
      if (issue.issue_dependencies_summary?.total_blocked_by === 0) {
        snapshot.set(issue.number, []);
        continue;
      }
      try {
        snapshot.set(issue.number, await load(issue));
      } catch {
        snapshot.set(issue.number, null);
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, candidates.length) },
      () => worker(),
    ),
  );
  return snapshot;
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
  {
    maxIssues = 1_000,
    maxEdges = 5_000,
    nativeDependencies,
  } = {},
) {
  if (!Array.isArray(issues)) throw new Error("Blocker graph Issues are invalid");
  const repositoryIssues = new Map();
  const issuesByNumber = new Map();
  const adjacency = new Map();
  const reverse = new Map();
  const errors = new Map();
  for (const issue of issues) {
    if (!Number.isSafeInteger(issue?.number) || issue.number < 1 || issue.pull_request) {
      continue;
    }
    repositoryIssues.set(issue.number, issue);
    if (workItemKind(issue) === "implementation") {
      issuesByNumber.set(issue.number, issue);
    }
  }
  let edgeCount = 0;
  for (const issue of issuesByNumber.values()) {
    const nativeBlockers = nativeDependencies instanceof Map
      ? nativeDependencies.get(issue.number)
      : issue.native_blockers;
    if (!Array.isArray(nativeBlockers)) {
      errors.set(issue.number, "native-dependency-response-invalid");
      continue;
    }
    const blockers = [];
    for (const blocker of nativeBlockers) {
      const number = typeof blocker === "number" ? blocker : blocker?.number;
      if (!Number.isSafeInteger(number) || number < 1 || blockers.includes(number)) {
        errors.set(issue.number, "native-dependency-response-invalid");
        continue;
      }
      const target = repositoryIssues.get(number);
      if (!target || target.pull_request) {
        errors.set(issue.number, `Blocked by Issue #${number} is missing or is a PR`);
        continue;
      }
      if (workItemKind(target) !== "implementation") {
        errors.set(issue.number, `Blocked by Issue #${number} is a cross-domain edge`);
        continue;
      }
      blockers.push(number);
    }
    edgeCount += blockers.length;
    adjacency.set(issue.number, blockers);
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

export function validatedExecutionIssue(
  issues,
  issueNumber,
  { nativeDependencies } = {},
) {
  positiveInteger(issueNumber, "Execution Graph Issue");
  const graph = inspectBlockerGraph(issues, { nativeDependencies });
  const issue = graph.issuesByNumber.get(issueNumber);
  if (!issue) throw new Error("Execution Graph target is not an Implementation Issue");
  if (graph.errors.has(issueNumber)) {
    throw new Error(String(graph.errors.get(issueNumber)));
  }
  const blockerNumbers = graph.adjacency.get(issueNumber) ?? [];
  return {
    blockerNumbers,
    blockers: blockerNumbers.map((number) => graph.issuesByNumber.get(number)),
    graph,
    issue,
  };
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
    const reason =
      error.startsWith("native-dependency-") ||
      error === "body-projection-update-failed"
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
