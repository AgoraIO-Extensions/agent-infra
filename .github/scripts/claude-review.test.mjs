import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCurrentReviewTarget,
  buildReviewSummary,
  buildReviewCheckOutput,
  collectChangedDiffLines,
  isTrustedReviewComment,
  parseReviewOutput,
  requireCurrentReviewTarget,
  reviewFailureKind,
  reviewGateOutcome,
  sanitizeMarkdown,
  selectReviewGateCheck,
  validateFindingLocations,
} from "./claude-review.mjs";

const head = "a".repeat(40);

function validOutput(overrides = {}) {
  return JSON.stringify({
    completed: true,
    head_sha: head,
    summary: "Review completed.",
    findings: [],
    ...overrides,
  });
}

test("parses a bounded Review result for the expected head", () => {
  assert.deepEqual(parseReviewOutput(validOutput(), head), {
    completed: true,
    head_sha: head,
    summary: "Review completed.",
    findings: [],
  });
});

test("marks only parsed or validated Review output defects as invalid output", () => {
  let missingOutputError;
  try {
    parseReviewOutput("", head);
  } catch (error) {
    missingOutputError = error;
  }
  assert.equal(reviewFailureKind(missingOutputError), "infrastructure_failure");

  let malformedOutputError;
  try {
    parseReviewOutput("{", head);
  } catch (error) {
    malformedOutputError = error;
  }
  assert.equal(reviewFailureKind(malformedOutputError), "invalid_output");
  assert.throws(
    () =>
      validateFindingLocations(
        [
          {
            severity: "P1",
            title: "Bug",
            body: "Impact",
            path: "a.ts",
            line: 9,
            side: "RIGHT",
          },
        ],
        [{ filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
      ),
    { name: "ReviewOutputError" },
  );
  assert.equal(
    reviewFailureKind(new Error("GitHub API GET /pulls/1/files: 502")),
    "infrastructure_failure",
  );
});

test("selects only the latest current-head GitHub Actions Review Gate", () => {
  const expectedExternalId = `agent-infra:pr:42:claude-review-gate:${head}`;
  assert.deepEqual(
    selectReviewGateCheck(
      [
        {
          id: 1,
          name: "Claude Review Gate",
          head_sha: head,
          app: { id: 15368 },
          external_id: expectedExternalId,
        },
        {
          id: 2,
          name: "Claude Review Gate",
          head_sha: head,
          app: { id: 999 },
          external_id: expectedExternalId,
        },
        {
          id: 3,
          name: "Claude Review Gate",
          head_sha: "b".repeat(40),
          app: { id: 15368 },
          external_id: expectedExternalId,
        },
        {
          id: 4,
          name: "Claude Review Gate",
          head_sha: head,
          app: { id: 15368 },
          external_id: `agent-infra:pr:99:claude-review-gate:${head}`,
        },
      ],
      head,
      42,
    ),
    {
      id: 1,
      name: "Claude Review Gate",
      head_sha: head,
      app: { id: 15368 },
      external_id: expectedExternalId,
    },
  );
});

test("publishes stable Review Gate success and failure reason codes", () => {
  assert.deepEqual(buildReviewCheckOutput("success", "success"), {
    title: "Claude Review Gate: success",
    summary: "reason_code: success\n\nReview completed for the current head.",
  });
  assert.deepEqual(buildReviewCheckOutput("failure", "infrastructure_failure"), {
    title: "Claude Review Gate: failure",
    summary:
      "reason_code: infrastructure_failure\n\nThe trusted Review workflow did not produce a publishable result.",
  });
  assert.deepEqual(buildReviewCheckOutput("failure", "blocking_finding"), {
    title: "Claude Review Gate: failure",
    summary:
      "reason_code: blocking_finding\n\nReview completed with blocking P0/P1 findings.",
  });
  assert.deepEqual(reviewGateOutcome([]), {
    conclusion: "success",
    reasonCode: "success",
  });
  assert.deepEqual(reviewGateOutcome([{ severity: "P1" }]), {
    conclusion: "failure",
    reasonCode: "blocking_finding",
  });
});

test("records the trusted blocking finding count in the Review Gate", () => {
  assert.deepEqual(buildReviewCheckOutput("failure", "blocking_finding", 2), {
    title: "Claude Review Gate: failure",
    summary:
      "reason_code: blocking_finding\nblocking_finding_count: 2\n\nReview completed with blocking P0/P1 findings.",
  });
});

test("rejects stale, incomplete, extended, or malformed Review output", () => {
  assert.throws(() => parseReviewOutput(validOutput({ head_sha: "b".repeat(40) }), head));
  assert.throws(() => parseReviewOutput(validOutput({ completed: false }), head));
  assert.throws(() => parseReviewOutput(validOutput({ unexpected: true }), head));
  assert.throws(() =>
    parseReviewOutput(
      validOutput({
        findings: [
          {
            severity: "P3",
            title: "x",
            body: "x",
            path: "a.ts",
            line: 1,
            side: "RIGHT",
          },
        ],
      }),
      head,
    ),
  );
});

test("rejects closed or stale PRs before completing a Review Gate", () => {
  assert.doesNotThrow(() =>
    assertCurrentReviewTarget({ state: "open", head: { sha: head } }, head),
  );
  assert.throws(() =>
    assertCurrentReviewTarget({ state: "closed", head: { sha: head } }, head),
  );
  assert.throws(() =>
    assertCurrentReviewTarget(
      { state: "open", head: { sha: "b".repeat(40) } },
      head,
    ),
  );
});

test("rechecks the live PR head before a Review publisher write", async () => {
  const paths = [];
  await assert.rejects(() =>
    requireCurrentReviewTarget({
      repository: "example/repo",
      prNumber: 42,
      expectedHead: head,
      request: async (path) => {
        paths.push(path);
        return { state: "open", head: { sha: "b".repeat(40) } };
      },
    }),
  );
  assert.deepEqual(paths, ["/repos/example/repo/pulls/42"]);
});

test("accepts at most the number of findings permitted by the Review schema", () => {
  const findings = Array.from({ length: 10 }, (_, index) => ({
    severity: "P2",
    title: `Finding ${index}`,
    body: "Impact",
    path: "a.ts",
    line: index + 1,
    side: "RIGHT",
  }));
  assert.doesNotThrow(() => parseReviewOutput(validOutput({ findings }), head));
  assert.throws(() =>
    parseReviewOutput(
      validOutput({
        findings: [
          ...findings,
          {
            severity: "P2",
            title: "Extra",
            body: "Impact",
            path: "a.ts",
            line: 11,
            side: "RIGHT",
          },
        ],
      }),
      head,
    ),
  );
});

test("collects deleted LEFT and added RIGHT lines from a unified patch", () => {
  const patch = "@@ -10,2 +10,3 @@\n same\n-old\n+new\n+more";
  const changed = collectChangedDiffLines(patch);
  assert.deepEqual([...changed.LEFT], [11]);
  assert.deepEqual([...changed.RIGHT], [11, 12]);
});

test("accepts LEFT and RIGHT findings only on their matching changed side", () => {
  const files = [{ filename: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" }];
  assert.doesNotThrow(() =>
    validateFindingLocations(
      [
        {
          severity: "P1",
          title: "Bug",
          body: "Impact",
          path: "src/a.ts",
          line: 1,
          side: "LEFT",
        },
        {
          severity: "P1",
          title: "Bug",
          body: "Impact",
          path: "src/a.ts",
          line: 1,
          side: "RIGHT",
        },
      ],
      files,
    ),
  );
  assert.throws(() =>
    validateFindingLocations(
      [
        {
          severity: "P1",
          title: "Bug",
          body: "Impact",
          path: "src/a.ts",
          line: 2,
          side: "LEFT",
        },
      ],
      files,
    ),
  );
});

test("P0 and P1 become blocking threads while P2 stays in the summary", () => {
  const summary = buildReviewSummary({
    head_sha: head,
    summary: "Review completed.",
    findings: [
      {
        severity: "P1",
        title: "Broken",
        body: "Impact",
        path: "a.ts",
        line: 1,
        side: "RIGHT",
      },
      {
        severity: "P2",
        title: "Minor",
        body: "Small impact",
        path: "b.ts",
        line: 2,
        side: "LEFT",
      },
    ],
  });
  assert.deepEqual(summary.blocking.map((finding) => finding.severity), ["P1"]);
  assert.match(
    summary.markdown,
    new RegExp(`agent-infra-claude-review-summary:${head}`),
  );
  assert.match(summary.markdown, /P2 Minor/);
  assert.doesNotMatch(summary.markdown, /P1 Broken/);
});

test("sanitizes mentions and trusted comment markers", () => {
  assert.equal(
    sanitizeMarkdown("@team <!-- claude-review-summary -->\u0000"),
    "@\u200bteam &lt;!-- claude-review-summary --&gt;",
  );
});

test("deduplicates findings only against github-actions bot comments", () => {
  const marker = "<!-- agent-infra-claude-review:head:key -->";
  assert.equal(
    isTrustedReviewComment(
      { user: { login: "github-actions[bot]", type: "Bot" }, body: marker },
      marker,
    ),
    true,
  );
  assert.equal(
    isTrustedReviewComment(
      { user: { login: "contributor", type: "User" }, body: marker },
      marker,
    ),
    false,
  );
});
