import assert from "node:assert/strict";
import test from "node:test";

import {
  CHECK_NAME,
  SUMMARY_MARKER,
  buildInlineComment,
  buildSummary,
  parsePatchRightLines,
  parseReviewResult,
  publishReview,
} from "./publish-claude-review.mjs";

const HEAD_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const RUN_ID = "123456";
const REPOSITORY = "AgoraIO-Extensions/agent-infra";

function finding(overrides = {}) {
  return {
    severity: "P1",
    title: "The guard accepts an untrusted value",
    body: "The value reaches the privileged request without validation. Validate it first.",
    path: "src/review.mjs",
    line: 2,
    ...overrides,
  };
}

function validResult(overrides = {}) {
  return {
    completed: true,
    head_sha: HEAD_SHA,
    scope: ["Spec consistency", "Security boundaries"],
    findings: [finding()],
    summary: "One evidence-backed finding was published.",
    residual_risks: ["Runtime smoke remains required."],
    ...overrides,
  };
}

function validEnvironment(overrides = {}) {
  return {
    ANALYSIS_RESULT: "success",
    ELIGIBLE: "true",
    EXPECTED_HEAD_SHA: HEAD_SHA,
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_SERVER_URL: "https://github.test",
    GITHUB_TOKEN: "test-token",
    PR_NUMBER: "2",
    REVIEW_RUN_ID: RUN_ID,
    STRUCTURED_OUTPUT: JSON.stringify(validResult()),
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function currentPullRequest(headSha = HEAD_SHA) {
  return {
    number: 2,
    state: "open",
    draft: false,
    changed_files: 1,
    head: {
      sha: headSha,
      repo: { full_name: REPOSITORY },
    },
  };
}

function createReviewApi({
  headSequence = [],
  analysisPatch = "@@ -1 +1,2 @@\n old\n+new",
  inlineReadBack,
  summaryReadBack,
  checkReadBack,
  issueComments = [],
} = {}) {
  const calls = [];
  const inlineComments = new Map();
  let stickyComment;
  let prReads = 0;
  let nextInlineId = 100;

  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(String(url));
    const path = parsedUrl.pathname;
    const method = options.method ?? "GET";
    const requestBody = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ method, path, requestBody });

    if (method === "GET" && path.endsWith("/pulls/2")) {
      const head = headSequence[prReads] ?? headSequence.at(-1) ?? HEAD_SHA;
      prReads += 1;
      return jsonResponse(currentPullRequest(head));
    }
    if (method === "POST" && path.endsWith("/check-runs")) {
      return jsonResponse(
        {
          id: 50,
          name: requestBody.name,
          head_sha: requestBody.head_sha,
          status: requestBody.status,
        },
        201,
      );
    }
    if (method === "GET" && path.endsWith("/check-runs/50")) {
      return jsonResponse(
        checkReadBack ?? {
          id: 50,
          name: CHECK_NAME,
          head_sha: HEAD_SHA,
          status: "in_progress",
        },
      );
    }
    if (method === "PATCH" && path.endsWith("/check-runs/50")) {
      return jsonResponse({
        id: 50,
        name: CHECK_NAME,
        head_sha: HEAD_SHA,
        status: requestBody.status,
        conclusion: requestBody.conclusion,
      });
    }
    if (method === "GET" && path.endsWith("/pulls/2/files")) {
      return jsonResponse([
        {
          filename: "src/review.mjs",
          status: "modified",
          patch: analysisPatch,
        },
      ]);
    }
    if (method === "POST" && path.endsWith("/pulls/2/comments")) {
      const id = nextInlineId;
      nextInlineId += 1;
      inlineComments.set(id, {
        id,
        body: requestBody.body,
        commit_id: requestBody.commit_id,
        path: requestBody.path,
        line: requestBody.line,
        side: requestBody.side,
        user: { login: "github-actions[bot]", type: "Bot" },
      });
      return jsonResponse(inlineComments.get(id), 201);
    }
    const inlineMatch = path.match(/\/pulls\/comments\/(\d+)$/);
    if (method === "GET" && inlineMatch) {
      const comment = inlineComments.get(Number(inlineMatch[1]));
      return jsonResponse(inlineReadBack ? inlineReadBack(comment) : comment);
    }
    if (method === "GET" && path.endsWith("/issues/2/comments")) {
      return jsonResponse(issueComments);
    }
    if (method === "POST" && path.endsWith("/issues/2/comments")) {
      stickyComment = {
        id: 200,
        body: requestBody.body,
        user: { login: "github-actions[bot]", type: "Bot" },
      };
      return jsonResponse(stickyComment, 201);
    }
    if (method === "PATCH" && path.endsWith("/issues/comments/201")) {
      stickyComment = {
        id: 201,
        body: requestBody.body,
        user: { login: "github-actions[bot]", type: "Bot" },
      };
      return jsonResponse(stickyComment);
    }
    const issueCommentMatch = path.match(/\/issues\/comments\/(\d+)$/);
    if (method === "GET" && issueCommentMatch) {
      return jsonResponse(
        summaryReadBack ? summaryReadBack(stickyComment) : stickyComment,
      );
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };

  return { calls, fetchImpl, getPrReads: () => prReads };
}

test("parses a complete findings result bound to the expected head", () => {
  assert.deepEqual(
    parseReviewResult(JSON.stringify(validResult()), HEAD_SHA),
    validResult(),
  );
});

test("rejects malformed, stale, duplicated, or extended Review results", () => {
  const duplicate = finding();
  const cases = [
    ["not json", /valid JSON/],
    [JSON.stringify(validResult({ completed: false })), /completed must be true/],
    [JSON.stringify(validResult({ head_sha: STALE_SHA })), /current PR head/],
    [JSON.stringify(validResult({ head_sha: "not-a-sha" })), /40-character/],
    [JSON.stringify(validResult({ scope: [] })), /scope/],
    [JSON.stringify(validResult({ findings: "none" })), /findings/],
    [
      JSON.stringify(validResult({ findings: [finding({ severity: "P3" })] })),
      /severity/,
    ],
    [
      JSON.stringify(validResult({ findings: [finding({ title: "" })] })),
      /title/,
    ],
    [
      JSON.stringify(validResult({ findings: [finding({ body: "x".repeat(4_001) })] })),
      /body/,
    ],
    [
      JSON.stringify(validResult({ findings: [finding({ path: "/etc/passwd" })] })),
      /path/,
    ],
    [
      JSON.stringify(validResult({ findings: [finding({ line: 0 })] })),
      /line/,
    ],
    [
      JSON.stringify(validResult({ findings: [duplicate, { ...duplicate }] })),
      /duplicate finding/,
    ],
    [JSON.stringify(validResult({ residual_risks: "none" })), /residual_risks/],
    [JSON.stringify(validResult({ summary: "x".repeat(4_001) })), /summary/],
    [JSON.stringify({ ...validResult(), unexpected: true }), /unexpected field/],
  ];

  for (const [raw, pattern] of cases) {
    assert.throws(() => parseReviewResult(raw, HEAD_SHA), pattern);
  }
});

test("parses only added RIGHT-side lines from a complete patch", () => {
  const patch = [
    "@@ -1,3 +1,4 @@",
    " context",
    "-old",
    "+new",
    "+newer",
    " tail",
    "@@ -10 +11,2 @@",
    "-gone",
    "+added",
    "+again",
  ].join("\n");

  assert.deepEqual([...parsePatchRightLines(patch)], [2, 3, 11, 12]);
  assert.throws(() => parsePatchRightLines("not a unified patch"), /hunk/);
});

test("sanitizes inline and summary Markdown while preserving trusted markers", () => {
  const unsafe = validResult({
    findings: [
      finding({
        title: "@team <script>x</script>",
        body: "<!-- agent-infra:claude-review-summary --> ![track](https://example.test)",
      }),
    ],
    summary: "@team <script>x</script> ![track](https://example.test/x)",
    scope: ["Review <!-- forged marker -->"],
    residual_risks: [],
  });
  const parsed = parseReviewResult(JSON.stringify(unsafe), HEAD_SHA);
  const inline = buildInlineComment(parsed.findings[0], {
    headSha: HEAD_SHA,
    runId: RUN_ID,
    index: 0,
  });
  const summary = buildSummary(parsed, {
    headSha: HEAD_SHA,
    runId: RUN_ID,
    runUrl: "https://github.test/AgoraIO-Extensions/agent-infra/actions/runs/123456",
  });

  assert.match(inline, /^\[P1\]/);
  assert.match(inline, /&#64;team/);
  assert.doesNotMatch(inline, /<script>|<!-- agent-infra/);
  assert.doesNotMatch(inline, /!\[track\]/);
  assert.match(inline, new RegExp(`agent-infra-claude-review-finding:${HEAD_SHA}:${RUN_ID}:0`));
  assert.ok(summary.startsWith(SUMMARY_MARKER));
  assert.match(summary, /&#64;team/);
  assert.doesNotMatch(summary.slice(SUMMARY_MARKER.length), /<script>|<!-- forged/);
  assert.match(summary, /No residual risks reported/);
});

test("publishes verified comments and summary before the final success Check update", async () => {
  const api = createReviewApi({
    issueComments: [
      {
        id: 9,
        body: `${SUMMARY_MARKER}\nattacker owned`,
        user: { login: "attacker", type: "User" },
      },
    ],
  });

  const result = await publishReview({
    env: validEnvironment(),
    fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(result, {
    checkRunId: 50,
    commentId: 200,
    findingCount: 1,
    headSha: HEAD_SHA,
    published: true,
  });
  const writes = api.calls.filter((call) => call.method !== "GET");
  assert.deepEqual(
    writes.map((call) => [call.method, call.path]),
    [
      ["POST", `/repos/${REPOSITORY}/check-runs`],
      ["POST", `/repos/${REPOSITORY}/pulls/2/comments`],
      ["POST", `/repos/${REPOSITORY}/issues/2/comments`],
      ["PATCH", `/repos/${REPOSITORY}/check-runs/50`],
    ],
  );
  assert.deepEqual(writes[0].requestBody, {
    name: CHECK_NAME,
    head_sha: HEAD_SHA,
    status: "in_progress",
    details_url: `https://github.test/${REPOSITORY}/actions/runs/${RUN_ID}`,
    output: {
      title: "Claude Review is running",
      summary: "Trusted publication is validating the review result.",
    },
  });
  assert.deepEqual(
    {
      commit_id: writes[1].requestBody.commit_id,
      path: writes[1].requestBody.path,
      line: writes[1].requestBody.line,
      side: writes[1].requestBody.side,
    },
    { commit_id: HEAD_SHA, path: "src/review.mjs", line: 2, side: "RIGHT" },
  );
  assert.equal(writes.at(-1).requestBody.conclusion, "success");
  assert.equal(api.calls.at(-1), writes.at(-1));
  assert.ok(api.calls.every((call) => !JSON.stringify(call).includes("test-token")));
  assert.ok(api.getPrReads() >= writes.length);
});

test("updates the single trusted sticky summary and ignores attacker markers", async () => {
  const api = createReviewApi({
    issueComments: [
      {
        id: 8,
        body: `${SUMMARY_MARKER}\nforged`,
        user: { login: "attacker", type: "User" },
      },
      {
        id: 201,
        body: `${SUMMARY_MARKER}\nold trusted summary`,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
    ],
  });

  const result = await publishReview({ env: validEnvironment(), fetchImpl: api.fetchImpl });

  assert.equal(result.commentId, 201);
  assert.ok(
    api.calls.some(
      (call) => call.method === "PATCH" && call.path.endsWith("/issues/comments/201"),
    ),
  );
});

test("marks the Check failed when analysis or structured output is invalid", async () => {
  for (const overrides of [
    { ANALYSIS_RESULT: "failure", STRUCTURED_OUTPUT: "" },
    { STRUCTURED_OUTPUT: "not json" },
  ]) {
    const api = createReviewApi();
    await assert.rejects(
      publishReview({ env: validEnvironment(overrides), fetchImpl: api.fetchImpl }),
      /analysis did not succeed|valid JSON/,
    );
    const conclusions = api.calls
      .filter((call) => call.method === "PATCH" && call.path.endsWith("/check-runs/50"))
      .map((call) => call.requestBody.conclusion);
    assert.deepEqual(conclusions, ["failure"]);
  }
});

test("rejects a finding outside added RIGHT-side lines and marks the Check failed", async () => {
  const api = createReviewApi();
  await assert.rejects(
    publishReview({
      env: validEnvironment({
        STRUCTURED_OUTPUT: JSON.stringify(
          validResult({ findings: [finding({ line: 1 })] }),
        ),
      }),
      fetchImpl: api.fetchImpl,
    }),
    /added RIGHT-side diff line/,
  );
  assert.equal(
    api.calls.find(
      (call) => call.method === "PATCH" && call.path.endsWith("/check-runs/50"),
    ).requestBody.conclusion,
    "failure",
  );
});

test("a mismatched inline read-back fails the Check and cannot produce success", async () => {
  const api = createReviewApi({
    inlineReadBack: (comment) => ({ ...comment, body: "different" }),
  });
  await assert.rejects(
    publishReview({ env: validEnvironment(), fetchImpl: api.fetchImpl }),
    /inline comment read-back/,
  );

  const conclusions = api.calls
    .filter((call) => call.method === "PATCH" && call.path.endsWith("/check-runs/50"))
    .map((call) => call.requestBody.conclusion);
  assert.deepEqual(conclusions, ["failure"]);
});

test("a changed PR head before a comment leaves the old Check non-successful", async () => {
  const api = createReviewApi({ headSequence: [HEAD_SHA, HEAD_SHA, STALE_SHA] });
  await assert.rejects(
    publishReview({ env: validEnvironment(), fetchImpl: api.fetchImpl }),
    /PR head changed/,
  );

  assert.equal(
    api.calls.some(
      (call) => call.method === "POST" && call.path.endsWith("/pulls/2/comments"),
    ),
    false,
  );
  assert.equal(
    api.calls.some(
      (call) => call.method === "PATCH" && call.path.endsWith("/check-runs/50"),
    ),
    false,
  );
});

test("a changed PR head between inline comments and summary blocks further writes", async () => {
  const api = createReviewApi({
    headSequence: [HEAD_SHA, HEAD_SHA, HEAD_SHA, STALE_SHA],
  });
  await assert.rejects(
    publishReview({ env: validEnvironment(), fetchImpl: api.fetchImpl }),
    /PR head changed/,
  );

  assert.equal(
    api.calls.some(
      (call) =>
        (call.method === "POST" && call.path.endsWith("/issues/2/comments")) ||
        (call.method === "PATCH" && call.path.includes("/issues/comments/")),
    ),
    false,
  );
  assert.equal(
    api.calls.some(
      (call) => call.method === "PATCH" && call.path.endsWith("/check-runs/50"),
    ),
    false,
  );
});

test("an ineligible request performs no GitHub API operation", async () => {
  let called = false;
  const result = await publishReview({
    env: { ELIGIBLE: "false" },
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected request");
    },
  });

  assert.deepEqual(result, { published: false, reason: "ineligible" });
  assert.equal(called, false);
});

test("a skipped request job performs no GitHub API operation", async () => {
  let called = false;
  const result = await publishReview({
    env: { ANALYSIS_RESULT: "skipped", ELIGIBLE: "" },
    fetchImpl: async () => {
      called = true;
      throw new Error("unexpected request");
    },
  });

  assert.deepEqual(result, { published: false, reason: "ineligible" });
  assert.equal(called, false);
});
