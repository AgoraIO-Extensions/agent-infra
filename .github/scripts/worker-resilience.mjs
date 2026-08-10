import { createHash } from "node:crypto";

const IDENTITY_KEYS = ["issueNumber", "cycle", "workerRunId", "baseSha"];
const GITHUB_ACTIONS_APP_ID = 15_368;
const GITHUB_ACTIONS_BOT_ID = 41_898_282;
const ATTEMPT_MARKER = "agent-infra-worker-attempt";
const RECOVERY_MARKER = "agent-infra-pr-recovery";
const ATTEMPT_KEYS = [
  "attempt",
  "baseSha",
  "checkpoint",
  "cycle",
  "issueNumber",
  "outcome",
  "recordedAt",
  "remainingAcceptanceCriteria",
  "terminationReason",
  "version",
  "workerRunId",
];
const CHECKPOINT_KEYS = [
  "artifactName",
  "artifactRunId",
  "baseSha",
  "cycle",
  "issueNumber",
  "patchSha256",
  "remainingAcceptanceCriteria",
  "sourceAttempt",
  "workerRunId",
];
const RECOVERY_KEYS = [
  "action",
  "cycle",
  "fingerprint",
  "headSha",
  "issueNumber",
  "pullRequestNumber",
  "reason",
  "recordedAt",
  "round",
  "version",
];

function exactKeys(value, expected) {
  return (
    value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).sort().join("\0") === expected.join("\0")
  );
}

function validAcceptanceCriteria(value) {
  return (
    Array.isArray(value) &&
    value.length <= 50 &&
    new Set(value).size === value.length &&
    value.every((id) => /^AC-[1-9][0-9]*$/.test(id))
  );
}

function hasIdentity(value, identity) {
  return Boolean(
    value && IDENTITY_KEYS.every((key) => value[key] === identity[key]),
  );
}

function validateCheckpointRecord(checkpoint, record) {
  if (!exactKeys(checkpoint, CHECKPOINT_KEYS) || !hasIdentity(checkpoint, record)) {
    throw new Error("Worker attempt checkpoint is invalid");
  }
  if (
    checkpoint.sourceAttempt !== record.attempt ||
    !Number.isSafeInteger(checkpoint.artifactRunId) ||
    checkpoint.artifactRunId < 1 ||
    checkpoint.artifactName !==
      `codex-worker-checkpoint-${record.workerRunId}-attempt-${record.attempt}` ||
    !/^[0-9a-f]{64}$/.test(checkpoint.patchSha256) ||
    !validAcceptanceCriteria(checkpoint.remainingAcceptanceCriteria) ||
    checkpoint.remainingAcceptanceCriteria.join("\0") !==
      record.remainingAcceptanceCriteria.join("\0")
  ) {
    throw new Error("Worker attempt checkpoint is invalid");
  }
}

export function validateWorkerAttemptRecord(record) {
  if (!exactKeys(record, ATTEMPT_KEYS) || record.version !== 1) {
    throw new Error("Worker attempt record is invalid");
  }
  if (
    !Number.isSafeInteger(record.issueNumber) ||
    record.issueNumber < 1 ||
    !Number.isSafeInteger(record.cycle) ||
    record.cycle < 1 ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(record.workerRunId) ||
    !/^[0-9a-f]{40}$/.test(record.baseSha) ||
    !Number.isSafeInteger(record.attempt) ||
    record.attempt < 1 ||
    record.attempt > 3 ||
    !["started", "completed", "recoverable", "non_retryable"].includes(
      record.outcome,
    ) ||
    !/^[a-z0-9_]{1,64}$/.test(record.terminationReason) ||
    !validAcceptanceCriteria(record.remainingAcceptanceCriteria) ||
    !Number.isFinite(Date.parse(record.recordedAt))
  ) {
    throw new Error("Worker attempt record is invalid");
  }
  if (record.outcome === "recoverable") {
    validateCheckpointRecord(record.checkpoint, record);
  } else if (record.checkpoint !== null) {
    throw new Error("Terminal Worker attempt cannot contain a checkpoint");
  }
  return record;
}

export function buildWorkerAttemptComment(record) {
  validateWorkerAttemptRecord(record);
  const encoded = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
  return [
    `<!-- ${ATTEMPT_MARKER}:${encoded} -->`,
    "## Worker attempt audit",
    "",
    `- Worker run: \`${record.workerRunId}\``,
    `- Attempt: ${record.attempt}/3`,
    `- Outcome: \`${record.outcome}\` (${record.terminationReason})`,
    `- Remaining AC: ${record.remainingAcceptanceCriteria.join(", ") || "None"}`,
    `- Recorded at: ${record.recordedAt}`,
  ].join("\n");
}

export function parseWorkerAttemptRecords(comments, identity) {
  const marker = new RegExp(
    `^<!-- ${ATTEMPT_MARKER}:([A-Za-z0-9_-]{1,32768}) -->`,
  );
  const records = [];
  for (const comment of comments ?? []) {
    const match = marker.exec(comment.body ?? "");
    if (!match) continue;
    if (
      comment.user?.login !== "github-actions[bot]" ||
      comment.user?.type !== "Bot" ||
      comment.performed_via_github_app?.id !== GITHUB_ACTIONS_APP_ID
    ) {
      continue;
    }
    if (
      !Number.isSafeInteger(comment.id) ||
      comment.created_at !== comment.updated_at
    ) {
      throw new Error("Worker attempt audit comments must be append-only");
    }
    let record;
    try {
      record = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    } catch {
      throw new Error("Worker attempt marker is invalid");
    }
    validateWorkerAttemptRecord(record);
    if (!hasIdentity(record, identity)) {
      continue;
    }
    records.push({
      ...record,
      commentId: comment.id,
      commentUrl: comment.html_url,
    });
  }
  records.sort((left, right) => left.commentId - right.commentId);
  const attempts = new Map();
  for (const record of records) {
    const transitions = attempts.get(record.attempt) ?? [];
    transitions.push(record);
    if (
      transitions.length > 2 ||
      (transitions.length === 2 &&
        (transitions[0].outcome !== "started" ||
          transitions[1].outcome === "started"))
    ) {
      throw new Error("Worker attempt transitions are invalid");
    }
    attempts.set(record.attempt, transitions);
  }
  const collapsed = [...attempts]
    .sort(([left], [right]) => left - right)
    .map(([, transitions]) => transitions.at(-1));
  if (collapsed.some((record, index) => record.attempt !== index + 1)) {
    throw new Error("Worker attempt records are not contiguous");
  }
  return collapsed;
}

export function validatePullRequestRecoveryRecord(record) {
  if (
    !exactKeys(record, RECOVERY_KEYS) ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.issueNumber) ||
    record.issueNumber < 1 ||
    !Number.isSafeInteger(record.cycle) ||
    record.cycle < 1 ||
    !Number.isSafeInteger(record.pullRequestNumber) ||
    record.pullRequestNumber < 1 ||
    !/^[0-9a-f]{40}$/.test(record.headSha) ||
    !["ci_retry", "repair"].includes(record.action) ||
    !/^[a-z0-9_]{1,64}$/.test(record.reason) ||
    !Number.isFinite(Date.parse(record.recordedAt))
  ) {
    throw new Error("Pull request recovery record is invalid");
  }
  if (
    (record.action === "ci_retry" &&
      (!/^[0-9a-f]{64}$/.test(record.fingerprint ?? "") ||
        record.round !== 0)) ||
    (record.action === "repair" &&
      (record.fingerprint !== null ||
        !Number.isSafeInteger(record.round) ||
        record.round < 1 ||
        record.round > 2))
  ) {
    throw new Error("Pull request recovery budget is invalid");
  }
  return record;
}

export function buildPullRequestRecoveryComment(record) {
  validatePullRequestRecoveryRecord(record);
  const encoded = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
  return [
    `<!-- ${RECOVERY_MARKER}:${encoded} -->`,
    "## Pull request recovery audit",
    "",
    `- Head: \`${record.headSha}\``,
    `- Action: \`${record.action}\``,
    `- Repair round: ${record.round || "not applicable"}`,
    `- Reason: \`${record.reason}\``,
    `- Recorded at: ${record.recordedAt}`,
  ].join("\n");
}

export function parsePullRequestRecoveryRecords(comments, identity) {
  const marker = new RegExp(
    `^<!-- ${RECOVERY_MARKER}:([A-Za-z0-9_-]{1,16384}) -->`,
  );
  const records = [];
  for (const comment of comments ?? []) {
    const match = marker.exec(comment.body ?? "");
    if (!match) continue;
    if (
      comment.user?.login !== "github-actions[bot]" ||
      comment.user?.type !== "Bot" ||
      comment.performed_via_github_app?.id !== GITHUB_ACTIONS_APP_ID
    ) {
      continue;
    }
    if (
      !Number.isSafeInteger(comment.id) ||
      comment.created_at !== comment.updated_at
    ) {
      throw new Error("Pull request recovery comments must be append-only");
    }
    let record;
    try {
      record = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
    } catch {
      throw new Error("Pull request recovery marker is invalid");
    }
    validatePullRequestRecoveryRecord(record);
    if (
      record.issueNumber !== identity.issueNumber ||
      record.cycle !== identity.cycle ||
      record.pullRequestNumber !== identity.pullRequestNumber
    ) {
      throw new Error("Pull request recovery record belongs to another PR");
    }
    records.push({ ...record, commentId: comment.id });
  }
  const noCodeRetries = records.filter((record) => record.action === "ci_retry");
  const repairRounds = records.filter((record) => record.action === "repair");
  if (
    new Set(noCodeRetries.map((record) => record.headSha)).size !==
      noCodeRetries.length ||
    repairRounds.some((record, index) => record.round !== index + 1)
  ) {
    throw new Error("Pull request recovery records are inconsistent");
  }
  return { noCodeRetries, repairRounds };
}

export function planWorkerAttempt({ identity, controlState, attempts }) {
  if (controlState !== "active") {
    return {
      operation: "pause",
      reason: "worker-paused",
      attemptsUsed: attempts.length,
    };
  }
  const previous = attempts.at(-1);
  if (!previous) return { operation: "invoke", attempt: 1, checkpoint: null };
  if (previous.outcome === "completed") {
    return {
      operation: "terminal",
      reason: "completed",
      attemptsUsed: previous.attempt,
    };
  }
  if (previous.outcome === "non_retryable") {
    return {
      operation: "terminal",
      reason: previous.terminationReason ?? "non_retryable",
      attemptsUsed: previous.attempt,
    };
  }
  if (previous.outcome === "started") {
    if (previous.attempt >= 3) {
      return {
        operation: "terminal",
        reason: "attempts_exhausted",
        attemptsUsed: previous.attempt,
      };
    }
    const checkpoint = [...attempts]
      .reverse()
      .find((attempt) => attempt.outcome === "recoverable")?.checkpoint;
    if (
      checkpoint &&
      (!hasIdentity(checkpoint, identity) ||
        checkpoint.sourceAttempt >= previous.attempt)
    ) {
      return { operation: "terminal", reason: "invalid-checkpoint" };
    }
    return {
      operation: "invoke",
      attempt: previous.attempt + 1,
      checkpoint: checkpoint ?? null,
    };
  }
  if (
    previous.outcome !== "recoverable" ||
    previous.checkpoint?.sourceAttempt !== previous.attempt ||
    !hasIdentity(previous.checkpoint, identity)
  ) {
    return { operation: "terminal", reason: "invalid-checkpoint" };
  }
  if (previous.attempt >= 3) {
    return {
      operation: "terminal",
      reason: "attempts_exhausted",
      attemptsUsed: previous.attempt,
    };
  }
  return {
    operation: "invoke",
    attempt: previous.attempt + 1,
    checkpoint: previous.checkpoint,
  };
}

function sanitizeRepairContext(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/@(?=[\w-])/g, "@\u200b")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/```/g, "`\u200b``");
}

function claudeRepairContext(comments, headSha) {
  if (!Array.isArray(comments) || !/^[0-9a-f]{40}$/.test(headSha)) return [];
  const marker = new RegExp(
    `<!-- agent-infra-claude-review:${headSha}:[A-Za-z0-9_-]{1,512} -->`,
  );
  return [...comments]
    .sort((left, right) => (left.id ?? 0) - (right.id ?? 0))
    .flatMap((comment) => {
      const body = comment.body ?? "";
      const heading = /^\*\*(P[01]): ([^\r\n]{1,500})\*\*(?:\r?\n|$)/.exec(body);
      const markerMatch = marker.exec(body);
      const validPath =
        typeof comment.path === "string" &&
        /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f\u007f]{1,512}$/.test(
          comment.path,
        );
      if (
        comment.user?.id !== GITHUB_ACTIONS_BOT_ID ||
        comment.user?.login !== "github-actions[bot]" ||
        comment.user?.type !== "Bot" ||
        comment.original_commit_id !== headSha ||
        !Number.isSafeInteger(comment.line) ||
        comment.line < 1 ||
        !validPath ||
        !heading ||
        !markerMatch
      ) {
        return [];
      }
      const details = body
        .slice(heading[0].length, markerMatch.index)
        .trim()
        .slice(0, 4000);
      return [
        sanitizeRepairContext(
          `${heading[1]} at ${comment.path}:${comment.line}\n${heading[2]}${
            details ? `\n${details}` : ""
          }`,
        ).slice(0, 1000),
      ];
    })
    .slice(0, 20);
}

export function planPullRequestRecovery({
  event,
  headSha,
  noCodeRetries,
  repairRounds,
}) {
  if (event.headSha !== headSha) {
    return { operation: "noop", reason: "stale_head" };
  }
  const repair = (reason) =>
    repairRounds.length >= 2
      ? {
          operation: "triage",
          reason: "repair_budget_exhausted",
          headSha,
          roundsUsed: repairRounds.length,
        }
      : {
          operation: "repair",
          reason,
          headSha,
          round: repairRounds.length + 1,
        };
  if (event.kind === "ci_failure") {
    const retried = noCodeRetries.some((record) => record.headSha === headSha);
    if (!retried) {
      return {
        operation: "retry_ci",
        reason: "first_ci_failure",
        headSha,
        fingerprint: event.fingerprint,
      };
    }
    return event.failureClass === "deterministic"
      ? repair("repeated_deterministic_ci_failure")
      : { operation: "triage", reason: "ci_infrastructure_failure", headSha };
  }
  if (event.kind === "claude_blocking") {
    const recoveryContext = claudeRepairContext(event.reviewComments, headSha);
    if (recoveryContext.length === 0) {
      return { operation: "triage", reason: "claude_findings_unavailable", headSha };
    }
    const decision = repair("claude_p0_p1");
    return decision.operation === "repair"
      ? { ...decision, recoveryContext }
      : decision;
  }
  if (event.kind === "base_advanced") {
    if (event.mergeable === "unknown") {
      return { operation: "noop", reason: "mergeability_pending", headSha };
    }
    return event.mergeable === "clean"
      ? {
          operation: "update_base",
          reason: "clean_base_update",
          headSha,
          baseSha: event.baseSha,
        }
      : { operation: "triage", reason: "base_update_conflict", headSha };
  }
  if (event.kind === "no_change") {
    return Number.isSafeInteger(event.draftPrNumber)
      ? {
          operation: "reuse_pr",
          reason: "no_change",
          headSha,
          pullRequestNumber: event.draftPrNumber,
        }
      : {
          operation: "triage",
          reason: "no_change",
          headSha,
          createPullRequest: false,
          closeIssue: false,
        };
  }
  return { operation: "noop", reason: "unsupported_event" };
}

const DETERMINISTIC_CI_STEPS = new Set([
  "Check formatting and lint",
  "Check TypeScript",
  "Run tests",
  "Build applications",
  "Smoke test applications",
  "Lint Markdown",
  "Verify workflow policy",
  "Check whitespace errors",
]);

export function classifyCiFailure(jobs) {
  const failedSteps = [];
  for (const job of jobs ?? []) {
    const steps = (job.steps ?? []).filter((step) =>
      ["failure", "cancelled", "timed_out", "stale"].includes(step.conclusion),
    );
    if (steps.length === 0 && job.conclusion !== "success") {
      failedSteps.push(`${job.name}:job:${job.conclusion ?? "unknown"}`);
      continue;
    }
    for (const step of steps) {
      failedSteps.push(`${job.name}:${step.name}:${step.conclusion}`);
    }
  }
  failedSteps.sort();
  const failureClass =
    failedSteps.length > 0 &&
    failedSteps.every((entry) =>
      DETERMINISTIC_CI_STEPS.has(entry.split(":").at(-2)),
    )
      ? "deterministic"
      : "infrastructure";
  return {
    failureClass,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(failedSteps), "utf8")
      .digest("hex"),
    failedSteps,
  };
}
