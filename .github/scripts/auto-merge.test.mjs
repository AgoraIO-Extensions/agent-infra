import assert from "node:assert/strict";
import test from "node:test";

import {
  enrollPullRequest,
  evaluateAutoMergeEligibility,
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
  return evaluateAutoMergeEligibility({
    action,
    pullRequest: pullRequest(overrides),
    repository: "example/agent-infra",
    defaultBranch: "main",
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
