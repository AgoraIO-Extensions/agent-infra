import assert from "node:assert/strict";
import test from "node:test";

import {
  activeAuthorization,
  authorizeCycle,
  blockedByStateHash,
  buildAcceptanceCriteriaEvidenceMarker,
  buildAuthorizationRecordComment,
  executionContent,
  latestAuthorizationRecord,
  parseAcceptanceCriteriaEvidence,
  parseAuthorizationRecords,
  transitionAuthorization,
} from "./worker-contract.mjs";

const issueBody = `## Problem

Normalize e\u0301 content.${"  "}

## Scope

- Keep the contract bounded.

## Acceptance criteria

- [x] **AC-1:** The first outcome is verified.
- [ ] **AC-2:** The second outcome is verified.

## Validation

Run node tests.

## Blocked by

None
`;

function issue(overrides = {}) {
  return {
    number: 42,
    state: "open",
    title: "Contract lifecycle",
    body: issueBody,
    labels: [{ name: "ready-for-agent" }],
    ...overrides,
  };
}

function labeledEvent(overrides = {}) {
  return {
    id: 1234,
    event: "labeled",
    actor: { login: "owner", type: "User" },
    label: { name: "ready-for-agent" },
    created_at: "2026-08-06T00:00:00Z",
    url: "https://api.github.com/repos/example/repo/issues/events/1234",
    authorizationCycle: 1,
    ...overrides,
  };
}

test("canonicalizes protected execution content and stable AC checkboxes", () => {
  const first = executionContent(issue(), { blockerNumbers: [] });
  const second = executionContent(
    issue({
      body: issueBody
        .replace(/\n/g, "\r\n")
        .replace("e\u0301", "é")
        .replace("- [x] **AC-1:**", "- [ ] **AC-1:**")
        .replace("None\r\n", "- #7\r\n"),
    }),
    { blockerNumbers: [] },
  );
  assert.equal(first.version, "execution-content-v1");
  assert.deepEqual(first.acceptanceCriteriaIds, ["AC-1", "AC-2"]);
  assert.equal(first.hash, second.hash);
  assert.match(first.preimage, /"version":"execution-content-v1"/);
  assert.doesNotMatch(first.preimage, /Blocked by/);
  assert.equal(
    executionContent(issue(), { blockerNumbers: [7] }).blockedByHash,
    blockedByStateHash([7]),
  );
  assert.equal(second.blockedByHash, first.blockedByHash);
  assert.throws(() => blockedByStateHash([7, 7]), /invalid Issue numbers/);

  const changed = executionContent(
    issue({ body: issueBody.replace("Keep the contract bounded.", "Expand scope.") }),
  );
  assert.notEqual(first.hash, changed.hash);
});

test("rejects missing protected sections and malformed or duplicate AC IDs", () => {
  assert.throws(
    () => executionContent(issue({ body: issueBody.replace("## Problem", "## Context") })),
    /Problem/,
  );
  assert.throws(
    () => executionContent(issue({ body: issueBody.replace("- [x] **AC-1:**", "- AC-1") })),
    /AC-N/,
  );
  assert.throws(
    () =>
      executionContent(
        issue({
          body: issueBody.replace(
            "- [x] **AC-1:** The first outcome is verified.",
            "- [ ] The first outcome is verified.",
          ),
        }),
      ),
    /AC-N/,
  );
  assert.throws(
    () => executionContent(issue({ body: issueBody.replace("AC-2", "AC-1") })),
    /unique/,
  );
  assert.throws(
    () =>
      executionContent(
        issue({ body: issueBody.replace("## Blocked by", "## Dependencies") }),
      ),
    /Blocked by/,
  );
  assert.doesNotThrow(() =>
    executionContent(
      issue({ body: issueBody.replace("None", "Migration projection pending") }),
      { blockerNumbers: [7] },
    ),
  );
});

test("creates monotonic authorization cycles and resumes an unchanged paused cycle", () => {
  const contract = executionContent(issue());
  const first = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [],
    timelineEvent: labeledEvent(),
    membership: { state: "active", role: "maintainer" },
    recordedAt: "2026-08-06T00:00:01Z",
  });
  assert.equal(first.cycle, 1);
  assert.equal(first.transition, "authorized");
  assert.equal(
    authorizeCycle({
      issueNumber: 42,
      executionContentHash: contract.hash,
      blockedByHash: contract.blockedByHash,
      records: [first],
      timelineEvent: labeledEvent(),
      membership: { state: "active", role: "maintainer" },
      recordedAt: "2026-08-06T00:00:02Z",
    }),
    null,
  );

  const paused = transitionAuthorization({
    current: first,
    state: "paused",
    transition: "paused",
    reason: "label-removed",
    actor: { login: "owner", type: "User" },
    eventId: 1235,
    eventAt: "2026-08-06T00:01:00Z",
    eventUrl: "https://api.github.com/repos/example/repo/issues/events/1235",
    recordedAt: "2026-08-06T00:01:01Z",
  });
  const resumed = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [first, paused],
    timelineEvent: labeledEvent({
      id: 1236,
      created_at: "2026-08-06T00:02:00Z",
      url: "https://api.github.com/repos/example/repo/issues/events/1236",
      authorizationCycle: 2,
    }),
    membership: { state: "active", role: "member" },
    recordedAt: "2026-08-06T00:02:01Z",
  });
  assert.equal(resumed.cycle, 1);
  assert.equal(resumed.transition, "resumed");

  const next = authorizeCycle({
    issueNumber: 42,
    executionContentHash: "b".repeat(64),
    blockedByHash: contract.blockedByHash,
    records: [first, paused],
    timelineEvent: labeledEvent({
      id: 1237,
      created_at: "2026-08-06T00:03:00Z",
      url: "https://api.github.com/repos/example/repo/issues/events/1237",
      authorizationCycle: 3,
    }),
    membership: { state: "active", role: "member" },
    recordedAt: "2026-08-06T00:03:01Z",
  });
  assert.equal(next.cycle, 3);
  assert.equal(next.transition, "authorized");
  assert.throws(() =>
    authorizeCycle({
      issueNumber: 42,
      executionContentHash: contract.hash,
      blockedByHash: contract.blockedByHash,
      records: [],
      timelineEvent: labeledEvent(),
      membership: { state: "inactive", role: "member" },
      recordedAt: "2026-08-06T00:00:01Z",
    }),
  );
});

test("consumed authorization cannot authorize a reopened Issue or reuse its cycle", () => {
  const contract = executionContent(issue());
  const first = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [],
    timelineEvent: labeledEvent(),
    membership: { state: "active", role: "maintainer" },
    recordedAt: "2026-08-06T00:00:01Z",
  });
  const consumed = transitionAuthorization({
    current: first,
    state: "consumed",
    transition: "consumed",
    reason: "issue-closed",
    actor: { login: "owner", type: "User" },
    eventId: 1235,
    eventAt: "2026-08-06T00:01:00Z",
    eventUrl: "https://api.github.com/repos/example/repo/issues/events/1235",
    recordedAt: "2026-08-06T00:01:01Z",
  });
  assert.equal(
    activeAuthorization({ issue: issue(), contract, record: consumed }).reason,
    "missing-active-authorization",
  );
  const reauthorized = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [first, consumed],
    timelineEvent: labeledEvent({
      id: 1236,
      created_at: "2026-08-06T00:02:00Z",
      url: "https://api.github.com/repos/example/repo/issues/events/1236",
      authorizationCycle: 2,
    }),
    membership: { state: "active", role: "member" },
    recordedAt: "2026-08-06T00:02:01Z",
  });
  assert.equal(reauthorized.cycle, 2);
});

test("an intervening close or reopen forces a new timeline-backed cycle", () => {
  const contract = executionContent(issue());
  const first = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [],
    timelineEvent: labeledEvent(),
    membership: { state: "active", role: "maintainer" },
    recordedAt: "2026-08-06T00:00:01Z",
  });
  const next = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [first],
    timelineEvent: labeledEvent({
      id: 1236,
      created_at: "2026-08-06T00:02:00Z",
      url: "https://api.github.com/repos/example/repo/issues/events/1236",
      authorizationCycle: 2,
    }),
    membership: { state: "active", role: "member" },
    recordedAt: "2026-08-06T00:02:01Z",
    forceNewCycle: true,
  });
  assert.equal(next.cycle, 2);
  assert.equal(next.transition, "authorized");
});

test("accepts only GitHub Actions App authorization audit comments", () => {
  const contract = executionContent(issue());
  const record = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [],
    timelineEvent: labeledEvent(),
    membership: { state: "active", role: "maintainer" },
    recordedAt: "2026-08-06T00:00:01Z",
  });
  const body = buildAuthorizationRecordComment(record);
  const comments = [
    {
      id: 1,
      body,
      user: { login: "owner", type: "User" },
      performed_via_github_app: null,
    },
    {
      id: 2,
      body,
      html_url: "https://github.com/example/repo/issues/42#issuecomment-2",
      created_at: "2026-08-06T00:00:02Z",
      updated_at: "2026-08-06T00:00:02Z",
      user: { login: "github-actions[bot]", type: "Bot" },
      performed_via_github_app: { id: 15368 },
    },
  ];
  const parsed = parseAuthorizationRecords(comments, 42, [labeledEvent()]);
  assert.equal(parsed.length, 1);
  assert.equal(latestAuthorizationRecord(parsed).commentId, 2);
  assert.deepEqual(activeAuthorization({ issue: issue(), contract, record: parsed[0] }), {
    ok: true,
    reason: "authorized",
    cycle: 1,
  });
  assert.equal(
    activeAuthorization({
      issue: issue(),
      contract: { ...contract, hash: "c".repeat(64) },
      record: parsed[0],
    }).reason,
    "authorization-content-mismatch",
  );
  assert.equal(
    activeAuthorization({
      issue: issue(),
      contract: { ...contract, blockedByHash: "d".repeat(64) },
      record: parsed[0],
    }).reason,
    "authorization-blocker-mismatch",
  );
  const refreshed = transitionAuthorization({
    current: parsed[0],
    state: "active",
    transition: "frontier-updated",
    reason: "trusted-blocker-edit",
    actor: { login: "github-actions[bot]", type: "Bot" },
    eventId: "run-7",
    eventAt: "2026-08-06T00:03:00Z",
    eventUrl: "https://github.com/example/repo/issues/42",
    recordedAt: "2026-08-06T00:03:01Z",
    blockedByHash: "d".repeat(64),
  });
  assert.equal(
    activeAuthorization({
      issue: issue(),
      contract: { ...contract, blockedByHash: "d".repeat(64) },
      record: refreshed,
    }).ok,
    true,
  );
});

test("rejects edited audit comments and cycles forged beyond timeline evidence", () => {
  const contract = executionContent(issue());
  const record = authorizeCycle({
    issueNumber: 42,
    executionContentHash: contract.hash,
    blockedByHash: contract.blockedByHash,
    records: [],
    timelineEvent: labeledEvent(),
    membership: { state: "active", role: "maintainer" },
    recordedAt: "2026-08-06T00:00:01Z",
  });
  const comment = {
    id: 2,
    body: buildAuthorizationRecordComment(record),
    html_url: "https://github.com/example/repo/issues/42#issuecomment-2",
    created_at: "2026-08-06T00:00:02Z",
    updated_at: "2026-08-06T00:00:02Z",
    user: { login: "github-actions[bot]", type: "Bot" },
    performed_via_github_app: { id: 15368 },
  };
  assert.throws(
    () =>
      parseAuthorizationRecords(
        [{ ...comment, updated_at: "2026-08-06T00:00:03Z" }],
        42,
        [labeledEvent()],
      ),
    /append-only/,
  );
  const forged = { ...record, cycle: 99 };
  assert.throws(
    () =>
      parseAuthorizationRecords(
        [{ ...comment, body: buildAuthorizationRecordComment(forged) }],
        42,
        [labeledEvent()],
      ),
    /timeline event/,
  );
});

test("round-trips exact AC status and evidence through the PR marker", () => {
  const items = [
    { id: "AC-1", status: "pass", evidence: "node --test passed" },
    {
      id: "AC-2",
      status: "not_applicable",
      evidence: "No external environment is involved.",
    },
  ];
  const marker = buildAcceptanceCriteriaEvidenceMarker(items, ["AC-1", "AC-2"]);
  assert.deepEqual(
    parseAcceptanceCriteriaEvidence(`## 验收标准\n\n${marker}`, ["AC-1", "AC-2"]),
    items,
  );
  assert.throws(() =>
    buildAcceptanceCriteriaEvidenceMarker(
      [{ id: "AC-1", status: "pass", evidence: "ok" }],
      ["AC-1", "AC-2"],
    ),
  );
  assert.throws(() =>
    parseAcceptanceCriteriaEvidence(`${marker}\n${marker}`, ["AC-1", "AC-2"]),
  );
  assert.throws(
    () =>
      buildAcceptanceCriteriaEvidenceMarker(
        Array.from({ length: 10 }, (_, index) => ({
          id: `AC-${index + 1}`,
          status: "pass",
          evidence: "证".repeat(1200),
        })),
        Array.from({ length: 10 }, (_, index) => `AC-${index + 1}`),
      ),
    /32 KiB/,
  );
});
