import assert from "node:assert/strict";
import test from "node:test";

import {
  countUnresolvedReviewThreads,
  disableAutoMerge,
  enrollPullRequest,
  evaluateAutoMergeEligibility,
  unresolvedReviewThreadCount,
} from "./auto-merge.mjs";

function pullRequest(overrides = {}) {
  return {
    number: 8,
    node_id: "PR_node_id",
    state: "open",
    draft: false,
    auto_merge: null,
    base: { ref: "main" },
    head: { repo: { full_name: "example/agent-infra" } },
    ...overrides,
  };
}

function eligibility(action, overrides = {}) {
  const { unresolvedReviewThreads, ...pullRequestOverrides } = overrides;
  return evaluateAutoMergeEligibility({
    action,
    pullRequest: pullRequest(pullRequestOverrides),
    repository: "example/agent-infra",
    defaultBranch: "main",
    unresolvedReviewThreads,
  });
}

test("accepts only the configured enrollment actions", () => {
  for (const action of ["opened", "reopened", "ready_for_review"]) {
    assert.deepEqual(eligibility(action), {
      eligible: true,
      reason: "eligible",
    });
  }
  assert.deepEqual(eligibility("synchronize"), {
    eligible: false,
    reason: "unsupported action",
  });
});

test("rejects closed, draft, fork, and non-default-branch PRs", () => {
  assert.equal(eligibility("opened", { state: "closed" }).eligible, false);
  assert.equal(eligibility("opened", { draft: true }).eligible, false);
  assert.equal(
    eligibility("opened", { head: { repo: { full_name: "outside/fork" } } }).eligible,
    false,
  );
  assert.equal(
    eligibility("opened", { base: { ref: "release" } }).eligible,
    false,
  );
});

test("refuses auto-merge while review threads are unresolved", () => {
  assert.deepEqual(eligibility("opened", { unresolvedReviewThreads: 1 }), {
    eligible: false,
    reason: "1 unresolved review thread",
  });
  assert.equal(
    countUnresolvedReviewThreads([{ isResolved: false }, { isResolved: true }]),
    1,
  );
});

test("paginates review threads and counts only unresolved threads", async () => {
  const calls = [];
  const count = await unresolvedReviewThreadCount({
    repository: "example/agent-infra",
    number: 8,
    request: async (path, options) => {
      calls.push({ path, options });
      const variables = JSON.parse(options.body).variables;
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: variables.cursor
                ? {
                    nodes: [{ isResolved: false }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  }
                : {
                    nodes: [{ isResolved: true }, { isResolved: false }],
                    pageInfo: { hasNextPage: true, endCursor: "next" },
                  },
            },
          },
        },
      };
    },
  });
  assert.equal(count, 2);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body).variables.cursor, "next");
});

test("treats an existing auto-merge request as an idempotent no-op", async () => {
  let requested = false;
  const result = await enrollPullRequest({
    pullRequest: pullRequest({ auto_merge: { enabled_by: { login: "member" } } }),
    request: async () => {
      requested = true;
    },
  });
  assert.equal(result, "already-enrolled");
  assert.equal(requested, false);
});

test("enables native Squash auto-merge without a direct merge mutation", async () => {
  const calls = [];
  const result = await enrollPullRequest({
    pullRequest: pullRequest(),
    request: async (path, options) => {
      calls.push({ path, options });
      return { data: { enablePullRequestAutoMerge: { pullRequest: { number: 8 } } } };
    },
  });

  assert.equal(result, "enrolled");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/graphql");
  const payload = JSON.parse(calls[0].options.body);
  assert.match(payload.query, /enablePullRequestAutoMerge/);
  assert.match(payload.query, /mergeMethod:\s*SQUASH/);
  assert.doesNotMatch(payload.query, /\bmergePullRequest\b/);
  assert.deepEqual(payload.variables, { pullRequestId: "PR_node_id" });
});

test("disables an existing auto-merge request when a thread blocks it", async () => {

	const calls = [];
	const result = await disableAutoMerge({
		pullRequest: pullRequest({ auto_merge: { enabled_by: { login: "member" } } }),
		request: async (path, options) => {
			calls.push({ path, options });
			return { data: { disablePullRequestAutoMerge: { pullRequest: { number: 8 } } } };
		},
	});
	assert.equal(result, "disabled");
	const payload = JSON.parse(calls[0].options.body);
	assert.match(payload.query, /disablePullRequestAutoMerge/);
	assert.doesNotMatch(payload.query, /enablePullRequestAutoMerge/);
});
