import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_MARKER,
  parseAssistantResult,
  publishAssistant,
} from "./publish-claude-assistant.mjs";

const HEAD_SHA = "a".repeat(40);
const REPOSITORY = "AgoraIO-Extensions/agent-infra";

function structuredResult(overrides = {}) {
  return {
    completed: true,
    entity_number: 2,
    head_sha: HEAD_SHA,
    response: "The requested analysis is complete.",
    ...overrides,
  };
}

function environment(overrides = {}) {
  return {
    ANALYSIS_RESULT: "success",
    ELIGIBLE: "true",
    ENTITY_NUMBER: "2",
    ENTITY_TYPE: "pull_request",
    EXPECTED_HEAD_SHA: HEAD_SHA,
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ID: "7654321",
    GITHUB_TOKEN: "test-token",
    STRUCTURED_OUTPUT: JSON.stringify(structuredResult()),
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createAssistantApi({ pullRequest = {}, issue = {}, readBack = {} } = {}) {
  const calls = [];
  let body = "";
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const method = options.method ?? "GET";
    const requestBody = options.body === undefined ? undefined : JSON.parse(options.body);
    calls.push({ method, path, requestBody });

    if (method === "GET" && path.endsWith("/pulls/2")) {
      return jsonResponse({
        number: 2,
        state: "open",
        draft: false,
        head: { sha: HEAD_SHA, repo: { full_name: REPOSITORY } },
        ...pullRequest,
      });
    }
    if (method === "GET" && path.endsWith("/issues/2")) {
      return jsonResponse({ number: 2, state: "open", ...issue });
    }
    if (method === "POST" && path.endsWith("/issues/2/comments")) {
      body = requestBody.body;
      return jsonResponse({ id: 44, body }, 201);
    }
    if (method === "GET" && path.endsWith("/issues/comments/44")) {
      return jsonResponse({
        id: 44,
        body,
        user: { login: "github-actions[bot]", type: "Bot" },
        ...readBack,
      });
    }
    throw new Error(`unexpected request ${method} ${path}`);
  };
  return { calls, fetchImpl };
}

test("parses a completed Assistant response for the trusted entity and head", () => {
  assert.deepEqual(
    parseAssistantResult(JSON.stringify(structuredResult()), {
      entityNumber: 2,
      headSha: HEAD_SHA,
    }),
    structuredResult(),
  );
  const issue = structuredResult({ head_sha: "" });
  assert.deepEqual(
    parseAssistantResult(JSON.stringify(issue), { entityNumber: 2, headSha: "" }),
    issue,
  );
});

test("rejects malformed, stale, oversized, and extended Assistant output", () => {
  const expected = { entityNumber: 2, headSha: HEAD_SHA };
  const cases = [
    ["not json", /valid JSON/],
    [JSON.stringify(structuredResult({ completed: false })), /completed must be true/],
    [JSON.stringify(structuredResult({ entity_number: 3 })), /current Issue or PR/],
    [JSON.stringify(structuredResult({ head_sha: "b".repeat(40) })), /current PR head/],
    [JSON.stringify(structuredResult({ response: "x".repeat(8_001) })), /response/],
    [JSON.stringify({ ...structuredResult(), extra: true }), /unexpected field/],
  ];

  for (const [raw, pattern] of cases) {
    assert.throws(() => parseAssistantResult(raw, expected), pattern);
  }
});

test("publishes one sanitized PR response after revalidating the current head", async () => {
  const api = createAssistantApi();
  const result = await publishAssistant({
    env: environment({
      STRUCTURED_OUTPUT: JSON.stringify(
        structuredResult({
          response: "@team <script>x</script> ![track](https://example.test/x)",
        }),
      ),
    }),
    fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(result, { commentId: 44, entityNumber: 2, published: true });
  assert.deepEqual(
    api.calls.map((call) => [call.method, call.path]),
    [
      ["GET", `/repos/${REPOSITORY}/pulls/2`],
      ["POST", `/repos/${REPOSITORY}/issues/2/comments`],
      ["GET", `/repos/${REPOSITORY}/issues/comments/44`],
    ],
  );
  const body = api.calls[1].requestBody.body;
  assert.ok(body.startsWith(ASSISTANT_MARKER));
  assert.match(body, /&#64;team/);
  assert.doesNotMatch(body, /<script>|!\[track\]/);
});

test("publishes an Issue response only after revalidating the Issue identity", async () => {
  const api = createAssistantApi();
  const result = await publishAssistant({
    env: environment({
      ENTITY_TYPE: "issue",
      EXPECTED_HEAD_SHA: "",
      STRUCTURED_OUTPUT: JSON.stringify(structuredResult({ head_sha: "" })),
    }),
    fetchImpl: api.fetchImpl,
  });

  assert.equal(result.commentId, 44);
  assert.equal(api.calls[0].path, `/repos/${REPOSITORY}/issues/2`);
});

test("rejects Draft, fork, and stale PRs before publishing", async () => {
  const cases = [
    [{ draft: true }, /Draft/],
    [{ head: { sha: HEAD_SHA, repo: { full_name: "other/fork" } } }, /base repository/],
    [{ head: { sha: "b".repeat(40), repo: { full_name: REPOSITORY } } }, /PR head changed/],
  ];

  for (const [pullRequest, pattern] of cases) {
    const api = createAssistantApi({ pullRequest });
    await assert.rejects(
      publishAssistant({ env: environment(), fetchImpl: api.fetchImpl }),
      pattern,
    );
    assert.equal(api.calls.some((call) => call.method === "POST"), false);
  }
});

test("rejects an entity or comment read-back mismatch", async () => {
  const badIssue = createAssistantApi({ issue: { pull_request: {} } });
  await assert.rejects(
    publishAssistant({
      env: environment({
        ENTITY_TYPE: "issue",
        EXPECTED_HEAD_SHA: "",
        STRUCTURED_OUTPUT: JSON.stringify(structuredResult({ head_sha: "" })),
      }),
      fetchImpl: badIssue.fetchImpl,
    }),
    /resolved to a PR/,
  );

  const badReadBack = createAssistantApi({
    readBack: { body: "different" },
  });
  await assert.rejects(
    publishAssistant({ env: environment(), fetchImpl: badReadBack.fetchImpl }),
    /read-back/,
  );
});

test("does not publish for an ineligible or failed analysis", async () => {
  for (const env of [
    { ELIGIBLE: "false" },
    { ANALYSIS_RESULT: "skipped", ELIGIBLE: "" },
    environment({ ANALYSIS_RESULT: "failure", STRUCTURED_OUTPUT: "" }),
  ]) {
    let called = false;
    const result = await publishAssistant({
      env,
      fetchImpl: async () => {
        called = true;
        throw new Error("unexpected request");
      },
    });
    assert.equal(result.published, false);
    assert.equal(called, false);
  }
});
