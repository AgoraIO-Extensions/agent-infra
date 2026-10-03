import { createHash } from "node:crypto";

import { GITHUB_ACTIONS_APP_ID } from "./check-run-contract.mjs";

export const EXECUTION_CONTENT_VERSION = "execution-content-v1";
export const WORKER_OWNERS_TEAM_SLUG = "agent-infra-owners";

const EXECUTION_HEADINGS = [
  ["Problem", "problem"],
  ["Scope", "scope"],
  ["Acceptance criteria", "acceptance_criteria"],
  ["Validation", "validation"],
];
const AUTHORIZATION_MARKER = "agent-infra-worker-authorization";
const AC_EVIDENCE_MARKER = "agent-infra-worker-ac-evidence";
const AUTHORIZATION_RECORD_KEYS = [
  "authorizationActorLogin",
  "authorizationActorType",
  "authorizationEventCreatedAt",
  "authorizationEventId",
  "authorizationEventUrl",
  "blockedByHash",
  "cycle",
  "executionContentHash",
  "issueNumber",
  "membershipRole",
  "membershipState",
  "membershipTeamSlug",
  "reason",
  "recordedAt",
  "state",
  "transition",
  "transitionActorLogin",
  "transitionActorType",
  "transitionAt",
  "transitionEventId",
  "transitionEventUrl",
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

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function boundedString(value, name, maxLength, pattern) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    (pattern && !pattern.test(value))
  ) {
    throw new Error(`${name} is invalid`);
  }
}

function auditTimestamp(value, name) {
  boundedString(
    value,
    name,
    64,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  );
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} is invalid`);
}

function normalizeField(value) {
  const lines = String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""));
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function extractSection(lines, heading) {
  const target = `## ${heading}`;
  const indexes = lines.flatMap((line, index) =>
    line.trim() === target ? [index] : [],
  );
  if (indexes.length !== 1) {
    throw new Error(`Issue must contain exactly one ${target} section`);
  }
  const start = indexes[0] + 1;
  const next = lines.findIndex(
    (line, index) => index >= start && /^##\s+\S/.test(line.trim()),
  );
  const content = normalizeField(
    lines.slice(start, next === -1 ? lines.length : next).join("\n"),
  );
  if (!content) throw new Error(`${target} section is empty`);
  return content;
}

export function parseAcceptanceCriteriaIds(section) {
  const ids = [];
  for (const line of normalizeField(section).split("\n")) {
    const match = /^\s*-\s+\[[ xX]\]\s+\*\*(AC-[1-9][0-9]*):\*\*\s+\S/.exec(
      line,
    );
    if (
      !match &&
      (/^\s*-\s+\[[^\]]*\]/.test(line) ||
        /^\s*-\s+.*\bAC-[0-9]+\b/.test(line))
    ) {
      throw new Error("Acceptance criteria must use - [ ] **AC-N:** <text>");
    }
    if (!match) continue;
    ids.push(match[1]);
  }
  if (ids.length === 0) throw new Error("Issue must contain at least one AC-N");
  if (new Set(ids).size !== ids.length) {
    throw new Error("Acceptance criteria IDs must be unique");
  }
  return ids;
}

function normalizeAcceptanceCriteria(section) {
  return normalizeField(section).replace(
    /^(\s*-\s+)\[[xX]\](\s+\*\*AC-[1-9][0-9]*:\*\*)/gm,
    "$1[ ]$2",
  );
}

export function executionContent(issue, { blockerNumbers = [] } = {}) {
  positiveInteger(issue?.number, "Issue number");
  const title = normalizeField(issue?.title);
  boundedString(title, "Issue title", 512);
  const lines = String(issue?.body ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (lines.filter((line) => line.trim() === "## Blocked by").length !== 1) {
    throw new Error("Issue must contain exactly one ## Blocked by section");
  }
  const sections = Object.fromEntries(
    EXECUTION_HEADINGS.map(([heading, key]) => [key, extractSection(lines, heading)]),
  );
  const acceptanceCriteriaIds = parseAcceptanceCriteriaIds(
    sections.acceptance_criteria,
  );
  sections.acceptance_criteria = normalizeAcceptanceCriteria(
    sections.acceptance_criteria,
  );
  const canonical = {
    version: EXECUTION_CONTENT_VERSION,
    title,
    problem: normalizeField(sections.problem),
    scope: normalizeField(sections.scope),
    acceptance_criteria: sections.acceptance_criteria,
    validation: normalizeField(sections.validation),
  };
  const preimage = JSON.stringify(canonical);
  return {
    version: EXECUTION_CONTENT_VERSION,
    canonical,
    preimage,
    hash: createHash("sha256").update(preimage, "utf8").digest("hex"),
    acceptanceCriteriaIds,
    blockerNumbers,
    blockedByHash: blockedByStateHash(blockerNumbers),
  };
}

export function blockedByStateHash(blockerNumbers) {
  if (
    !Array.isArray(blockerNumbers) ||
    blockerNumbers.some(
      (number) => !Number.isSafeInteger(number) || number < 1,
    ) ||
    new Set(blockerNumbers).size !== blockerNumbers.length
  ) {
    throw new Error("Blocked by state contains invalid Issue numbers");
  }
  return createHash("sha256")
    .update(JSON.stringify({ version: "blocked-by-v1", blockerNumbers }), "utf8")
    .digest("hex");
}

export function parseBlockedBy(body, { issueNumber } = {}) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const headings = lines.flatMap((line, index) =>
    line.trim() === "## Blocked by" ? [index] : [],
  );
  if (headings.length !== 1) {
    throw new Error("Issue must contain exactly one ## Blocked by section");
  }
  const start = headings[0] + 1;
  const next = lines.findIndex(
    (line, index) => index >= start && /^##\s+\S/.test(line.trim()),
  );
  const values = lines
    .slice(start, next === -1 ? lines.length : next)
    .map((line) => line.trim())
    .filter(Boolean);
  if (values.length === 1 && values[0] === "None") return [];
  if (values.length === 0) throw new Error("Blocked by section is empty");
  const blockers = values.map((line) => {
    const match = /^- #(\d+)$/.exec(line);
    if (!match || Number(match[1]) < 1) {
      throw new Error("Blocked by entries must use - #<issue-number>");
    }
    return Number(match[1]);
  });
  if (new Set(blockers).size !== blockers.length) {
    throw new Error("Blocked by entries must be unique");
  }
  if (issueNumber && blockers.includes(issueNumber)) {
    throw new Error("Issue cannot block itself");
  }
  return blockers;
}

export function validateAuthorizationRecord(record) {
  exactKeys(record, AUTHORIZATION_RECORD_KEYS, "Worker authorization record");
  if (record.version !== 1) throw new Error("Authorization version is unsupported");
  positiveInteger(record.issueNumber, "Authorization Issue");
  positiveInteger(record.cycle, "Authorization cycle");
  boundedString(
    record.executionContentHash,
    "Authorization execution-content hash",
    64,
    /^[0-9a-f]{64}$/,
  );
  boundedString(record.blockedByHash, "Authorization Blocked by hash", 64, /^[0-9a-f]{64}$/);
  if (!["active", "paused", "invalidated", "consumed"].includes(record.state)) {
    throw new Error("Authorization state is invalid");
  }
  if (
    ![
      "authorized",
      "resumed",
      "frontier-updated",
      "paused",
      "invalidated",
      "consumed",
    ].includes(record.transition)
  ) {
    throw new Error("Authorization transition is invalid");
  }
  const expectedState = {
    authorized: "active",
    resumed: "active",
    "frontier-updated": record.state,
    paused: "paused",
    invalidated: "invalidated",
    consumed: "consumed",
  }[record.transition];
  if (record.state !== expectedState) {
    throw new Error("Authorization state does not match its transition");
  }
  if (
    record.transition === "frontier-updated" &&
    !["active", "paused"].includes(record.state)
  ) {
    throw new Error("Authorization frontier update state is invalid");
  }
  boundedString(record.authorizationActorLogin, "Authorization actor", 64);
  if (record.authorizationActorType !== "User") {
    throw new Error("Authorization actor must be a User");
  }
  positiveInteger(record.authorizationEventId, "Authorization timeline event");
  auditTimestamp(record.authorizationEventCreatedAt, "Authorization event time");
  boundedString(record.authorizationEventUrl, "Authorization event URL", 2048, /^https:\/\//);
  if (record.membershipState !== "active") {
    throw new Error("Authorization membership must be active");
  }
  if (!["member", "maintainer"].includes(record.membershipRole)) {
    throw new Error("Authorization membership role is invalid");
  }
  if (record.membershipTeamSlug !== WORKER_OWNERS_TEAM_SLUG) {
    throw new Error("Authorization membership Team is invalid");
  }
  boundedString(record.transitionActorLogin, "Authorization transition actor", 128);
  if (!["User", "Bot"].includes(record.transitionActorType)) {
    throw new Error("Authorization transition actor type is invalid");
  }
  boundedString(record.transitionEventId, "Authorization transition event", 256);
  auditTimestamp(record.transitionAt, "Authorization transition time");
  boundedString(record.transitionEventUrl, "Authorization transition URL", 2048, /^https:\/\//);
  boundedString(record.reason, "Authorization transition reason", 128, /^[a-z0-9-]+$/);
  auditTimestamp(record.recordedAt, "Authorization record time");
  return record;
}

function encodeMarker(prefix, value) {
  return `<!-- ${prefix}:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")} -->`;
}

function decodeMarker(encoded, name) {
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error(`${name} marker is invalid`);
  }
  return value;
}

export function buildAuthorizationRecordComment(record) {
  validateAuthorizationRecord(record);
  const marker = encodeMarker(AUTHORIZATION_MARKER, record);
  return [
    marker,
    "## Worker authorization audit",
    "",
    `- Issue: #${record.issueNumber}`,
    `- Cycle: ${record.cycle}`,
    `- State: ${record.state}`,
    `- Execution content: \`${record.executionContentHash}\``,
    `- Blocked by state: \`${record.blockedByHash}\``,
    `- Authorized by: ${record.authorizationActorLogin}`,
    `- Authorization Team: ${record.membershipTeamSlug}`,
    `- Authorization event: ${record.authorizationEventUrl}`,
    `- Transition: ${record.transition} (${record.reason})`,
    `- Recorded at: ${record.recordedAt}`,
  ].join("\n");
}

function authorizationTimeline(events) {
  return (events ?? [])
    .filter(
      (event) =>
        event?.event === "labeled" &&
        event.label?.name === "ready-for-agent" &&
        Number.isSafeInteger(event.id),
    )
    .sort((left, right) => left.id - right.id);
}

export function latestAuthorizationTimelineEvent(events, { actorLogin } = {}) {
  const timeline = authorizationTimeline(events);
  const event = timeline
    .filter(
      (candidate) =>
        actorLogin === undefined || candidate.actor?.login === actorLogin,
    )
    .at(-1);
  if (!event) return null;
  return {
    ...event,
    authorizationCycle:
      timeline.findIndex((candidate) => candidate.id === event.id) + 1,
  };
}

function verifyAuthorizationTimelineRecord(record, events) {
  const timeline = authorizationTimeline(events);
  const index = timeline.findIndex(
    (event) => event.id === record.authorizationEventId,
  );
  if (index === -1) {
    throw new Error("Authorization timeline event is missing");
  }
  const event = timeline[index];
  if (
    event.actor?.login !== record.authorizationActorLogin ||
    event.actor?.type !== record.authorizationActorType ||
    event.created_at !== record.authorizationEventCreatedAt ||
    event.url !== record.authorizationEventUrl
  ) {
    throw new Error("Authorization timeline evidence does not match its record");
  }
  const eventCycle = index + 1;
  if (
    (record.transition === "authorized" && record.cycle !== eventCycle) ||
    (record.transition === "resumed" && record.cycle >= eventCycle)
  ) {
    throw new Error("Authorization cycle does not match its timeline event");
  }
  if (
    ["authorized", "resumed"].includes(record.transition) &&
    (record.transitionEventId !== String(event.id) ||
      record.transitionActorLogin !== event.actor.login ||
      record.transitionActorType !== event.actor.type ||
      record.transitionAt !== event.created_at ||
      record.transitionEventUrl !== event.url)
  ) {
    throw new Error("Authorization transition does not match its timeline event");
  }
}

export function parseAuthorizationRecords(comments, issueNumber, timelineEvents) {
  const records = [];
  const marker = new RegExp(`^<!-- ${AUTHORIZATION_MARKER}:([A-Za-z0-9_-]{1,8192}) -->`);
  for (const comment of comments ?? []) {
    const match = marker.exec(comment.body ?? "");
    if (!match) continue;
    const trusted =
      comment.user?.login === "github-actions[bot]" &&
      comment.user?.type === "Bot" &&
      comment.performed_via_github_app?.id === GITHUB_ACTIONS_APP_ID;
    if (!trusted) continue;
    positiveInteger(comment.id, "Authorization comment");
    auditTimestamp(comment.created_at, "Authorization comment created time");
    auditTimestamp(comment.updated_at, "Authorization comment updated time");
    if (comment.created_at !== comment.updated_at) {
      throw new Error("Authorization audit comments must be append-only");
    }
    const record = validateAuthorizationRecord(
      decodeMarker(match[1], "Worker authorization"),
    );
    if (record.issueNumber !== issueNumber) {
      throw new Error("Authorization record belongs to another Issue");
    }
    verifyAuthorizationTimelineRecord(record, timelineEvents);
    records.push({
      ...record,
      commentId: comment.id,
      commentUrl: comment.html_url,
      commentCreatedAt: comment.created_at,
    });
  }
  return records.sort((left, right) =>
    left.cycle - right.cycle || left.commentId - right.commentId,
  );
}

export function latestAuthorizationRecord(records) {
  if (!records?.length) return null;
  return [...records].sort((left, right) =>
    left.cycle - right.cycle || left.commentId - right.commentId,
  ).at(-1);
}

function authorizationFields({ timelineEvent, membership }) {
  if (
    timelineEvent?.event !== "labeled" ||
    timelineEvent?.label?.name !== "ready-for-agent" ||
    timelineEvent?.actor?.type !== "User" ||
    !timelineEvent.actor.login ||
    !Number.isSafeInteger(timelineEvent.id)
  ) {
    throw new Error("Authorization requires a ready-for-agent labeled timeline event");
  }
  if (
    membership?.state !== "active" ||
    !["member", "maintainer"].includes(membership.role)
  ) {
    throw new Error("Authorization actor is not an active CODEOWNERS Team member");
  }
  auditTimestamp(timelineEvent.created_at, "Authorization event time");
  return {
    authorizationActorLogin: timelineEvent.actor.login,
    authorizationActorType: timelineEvent.actor.type,
    authorizationEventId: timelineEvent.id,
    authorizationEventCreatedAt: timelineEvent.created_at,
    authorizationEventUrl: timelineEvent.url,
    membershipState: membership.state,
    membershipRole: membership.role,
    membershipTeamSlug: WORKER_OWNERS_TEAM_SLUG,
  };
}

export function authorizeCycle({
  issueNumber,
  executionContentHash,
  blockedByHash,
  records = [],
  timelineEvent,
  membership,
  recordedAt,
  forceNewCycle = false,
}) {
  const existingEvent = records.find(
    (record) => record.authorizationEventId === timelineEvent?.id,
  );
  if (existingEvent) return null;
  const current = latestAuthorizationRecord(records);
  const resume =
    !forceNewCycle &&
    current &&
    ["active", "paused"].includes(current.state) &&
    current.executionContentHash === executionContentHash;
  positiveInteger(timelineEvent?.authorizationCycle, "Authorization timeline cycle");
  const cycle = resume
    ? current.cycle
    : timelineEvent.authorizationCycle;
  if (
    timelineEvent.authorizationCycle <=
      Math.max(0, ...records.map((record) => record.cycle))
  ) {
    throw new Error("Authorization timeline cycle is not monotonic");
  }
  const authorization = authorizationFields({ timelineEvent, membership });
  return validateAuthorizationRecord({
    version: 1,
    issueNumber,
    cycle,
    executionContentHash,
    blockedByHash,
    state: "active",
    transition: resume ? "resumed" : "authorized",
    reason: resume ? "label-restored" : "team-authorization",
    ...authorization,
    transitionActorLogin: timelineEvent.actor.login,
    transitionActorType: timelineEvent.actor.type,
    transitionEventId: String(timelineEvent.id),
    transitionAt: timelineEvent.created_at,
    transitionEventUrl: timelineEvent.url,
    recordedAt,
  });
}

export function transitionAuthorization({
  current,
  state,
  transition,
  reason,
  actor,
  eventId,
  eventAt,
  eventUrl,
  recordedAt,
  blockedByHash = current?.blockedByHash,
}) {
  if (!current) return null;
  return validateAuthorizationRecord({
    version: 1,
    issueNumber: current.issueNumber,
    cycle: current.cycle,
    executionContentHash: current.executionContentHash,
    blockedByHash,
    state,
    transition,
    reason,
    authorizationActorLogin: current.authorizationActorLogin,
    authorizationActorType: current.authorizationActorType,
    authorizationEventId: current.authorizationEventId,
    authorizationEventCreatedAt: current.authorizationEventCreatedAt,
    authorizationEventUrl: current.authorizationEventUrl,
    membershipState: current.membershipState,
    membershipRole: current.membershipRole,
    membershipTeamSlug: current.membershipTeamSlug,
    transitionActorLogin: actor.login,
    transitionActorType: actor.type,
    transitionEventId: String(eventId),
    transitionAt: eventAt,
    transitionEventUrl: eventUrl,
    recordedAt,
  });
}

export function activeAuthorization({ issue, contract, record }) {
  const labels = (issue?.labels ?? []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
  if (issue?.state !== "open" || labels.includes("wontfix")) {
    return { ok: false, reason: "issue-closed" };
  }
  if (!labels.includes("ready-for-agent")) {
    return { ok: false, reason: "authorization-paused" };
  }
  if (labels.some((label) => ["ready-for-human", "needs-triage"].includes(label))) {
    return { ok: false, reason: "issue-not-frontier" };
  }
  if (!record || record.state !== "active") {
    return { ok: false, reason: "missing-active-authorization" };
  }
  if (record.issueNumber !== issue.number || record.executionContentHash !== contract.hash) {
    return { ok: false, reason: "authorization-content-mismatch" };
  }
  if (record.blockedByHash !== contract.blockedByHash) {
    return { ok: false, reason: "authorization-blocker-mismatch" };
  }
  return { ok: true, reason: "authorized", cycle: record.cycle };
}

export function validateAcceptanceCriteriaEvidence(items, expectedIds) {
  if (!Array.isArray(items) || items.length > 50) {
    throw new Error("Acceptance criteria evidence must be a bounded array");
  }
  const ids = [];
  for (const [index, item] of items.entries()) {
    exactKeys(item, ["evidence", "id", "status"], `AC evidence[${index}]`);
    boundedString(item.id, `AC evidence[${index}].id`, 32, /^AC-[1-9][0-9]*$/);
    if (!["pass", "not_applicable"].includes(item.status)) {
      throw new Error(`AC evidence[${index}].status is invalid`);
    }
    boundedString(item.evidence, `AC evidence[${index}].evidence`, 4000);
    ids.push(item.id);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("Acceptance criteria evidence IDs must be unique");
  }
  if (
    ids.length !== expectedIds.length ||
    ids.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error("Acceptance criteria evidence does not match the Issue AC IDs");
  }
  if (
    Buffer.byteLength(JSON.stringify({ version: 1, items }), "utf8") >
    32 * 1024
  ) {
    throw new Error("Acceptance criteria evidence exceeds 32 KiB");
  }
  return items;
}

export function buildAcceptanceCriteriaEvidenceMarker(items, expectedIds) {
  validateAcceptanceCriteriaEvidence(items, expectedIds);
  return encodeMarker(AC_EVIDENCE_MARKER, { version: 1, items });
}

export function parseAcceptanceCriteriaEvidence(body, expectedIds) {
  const pattern = new RegExp(`<!-- ${AC_EVIDENCE_MARKER}:([A-Za-z0-9_-]{1,65536}) -->`, "g");
  const matches = [...String(body ?? "").matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("Worker PR must contain exactly one AC evidence marker");
  }
  const payload = decodeMarker(matches[0][1], "Worker AC evidence");
  exactKeys(payload, ["items", "version"], "Worker AC evidence");
  if (payload.version !== 1) throw new Error("Worker AC evidence version is unsupported");
  return validateAcceptanceCriteriaEvidence(payload.items, expectedIds);
}
