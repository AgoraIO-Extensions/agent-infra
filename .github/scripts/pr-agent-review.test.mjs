import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePrAgentReview,
  publishPrAgentReview,
  verifyPrAgentPublication,
} from "./pr-agent-review.mjs";

const head = "a".repeat(40);
const context = {
  repository: "org/repo",
  prNumber: 42,
  expectedHead: head,
  runId: "123",
  attempt: "1",
};
const finding = {
  relevant_file: "src/math.ts",
  issue_header: "Wrong operator",
  issue_content: "Addition uses subtraction, so add(2, 1) returns 1.",
  start_line: 1,
  end_line: 1,
};
const raw = JSON.stringify({ key_issues_to_review: [finding] });
const actor = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
function api({
  failPost = false,
  wrongHead = false,
  dropComments = false,
} = {}) {
  let posted;
  const writes = [];
  const request = async (path, options = {}) => {
    if (options.method === "POST") {
      writes.push(path);
      if (failPost) throw new Error("GitHub API POST failed: 403");
      posted = JSON.parse(options.body);
      return { id: 77 };
    }
    if (path.endsWith("/files?per_page=100&page=1"))
      return [
        {
          filename: "src/math.ts",
          patch: "@@ -1 +1 @@\n-return a + b;\n+return a - b;",
        },
      ];
    if (path.endsWith("/reviews/77/comments?per_page=100"))
      return dropComments
        ? []
        : posted.comments.map((_c, index) => ({
            id: 100 + index,
            position: 1,
          }));
    if (/\/pulls\/comments\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1));
      const c = posted.comments[id - 100];
      return {
        ...c,
        id,
        user: actor,
        original_line: c.line,
        original_commit_id: head,
        pull_request_review_id: 77,
      };
    }
    if (path.endsWith("/reviews/77"))
      return {
        id: 77,
        user: actor,
        state: "COMMENTED",
        commit_id: wrongHead ? "b".repeat(40) : head,
        body: posted.body,
      };
    return {
      state: "open",
      head: { sha: head, repo: { full_name: "org/repo" } },
    };
  };
  return { request, writes };
}

test("validates the official review output, including explicit zero findings", () => {
  assert.equal(parsePrAgentReview(raw).length, 1);
  assert.deepEqual(parsePrAgentReview('{"key_issues_to_review":[]}'), []);
  for (const value of [
    "",
    "{}",
    "null",
    '{"review":{}}',
    '{"key_issues_to_review":null}',
    '{"key_issues_to_review":[{}]}',
  ]) {
    assert.throws(() => parsePrAgentReview(value), /PR-Agent/);
  }
});

test("publishes findings as native threads and verifies the exact head, body and comments", async () => {
  const { request, writes } = api();
  const receipt = await publishPrAgentReview({ ...context, raw, request });
  assert.equal(writes.length, 1);
  assert.equal(receipt.reviewId, 77);
  assert.equal(
    await verifyPrAgentPublication({ ...context, receipt, request }),
    true,
  );
  assert.equal(
    await verifyPrAgentPublication({
      ...context,
      runId: "124",
      receipt,
      request,
    }),
    false,
  );
  assert.equal(
    await verifyPrAgentPublication({
      ...context,
      attempt: "2",
      receipt,
      request,
    }),
    false,
  );
});

test("publishes a clear no-findings conclusion", async () => {
  const { request } = api();
  const receipt = await publishPrAgentReview({
    ...context,
    raw: '{"key_issues_to_review":[]}',
    request,
  });
  const review = await request("/reviews/77");
  assert.match(review.body, /No major issues detected/);
  assert.equal(receipt.findingCount, 0);
});

test("does not publish invalid or unanchorable model results", async () => {
  for (const output of [
    "{}",
    JSON.stringify({
      key_issues_to_review: [{ ...finding, start_line: 100, end_line: 100 }],
    }),
    JSON.stringify({
      key_issues_to_review: [{ ...finding, relevant_file: "other.ts" }],
    }),
  ]) {
    const { request, writes } = api();
    await assert.rejects(
      publishPrAgentReview({ ...context, raw: output, request }),
    );
    assert.equal(writes.length, 0);
  }
});

test("rejects publication failures, stale results and missing published findings", async () => {
  for (const options of [
    { failPost: true },
    { wrongHead: true },
    { dropComments: true },
  ]) {
    await assert.rejects(
      publishPrAgentReview({ ...context, raw, ...api(options) }),
    );
  }
});

test("rejects forged authors, edited bodies and cross-head comments", async () => {
  const original = api();
  const receipt = await publishPrAgentReview({
    ...context,
    raw,
    request: original.request,
  });
  for (const [target, patch] of [
    ["/reviews/77", { user: { ...actor, id: 1 } }],
    ["/reviews/77", { body: "No problems" }],
    ["/reviews/77", { state: "DISMISSED" }],
    ["/comments/100", { body: "edited" }],
    ["/comments/100", { user: { ...actor, type: "User" } }],
    ["/comments/100", { original_commit_id: "b".repeat(40) }],
    ["/comments/100", { original_line: 42 }],
    ["/comments/100", { side: "LEFT" }],
  ]) {
    const request = async (path) => {
      const value = await original.request(path);
      return path.endsWith(target) ? { ...value, ...patch } : value;
    };
    assert.equal(
      await verifyPrAgentPublication({ ...context, receipt, request }),
      false,
    );
  }
});

test("rejects a changed head or cross-repository target before publishing", async () => {
  for (const pr of [
    {
      state: "open",
      head: { sha: "b".repeat(40), repo: { full_name: "org/repo" } },
    },
    { state: "open", head: { sha: head, repo: { full_name: "other/repo" } } },
  ]) {
    let writes = 0;
    await assert.rejects(
      publishPrAgentReview({
        ...context,
        raw,
        request: async (_path, options) => {
          if (options?.method === "POST") writes++;
          return pr;
        },
      }),
    );
    assert.equal(writes, 0);
  }
});
