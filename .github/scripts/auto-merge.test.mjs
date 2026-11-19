import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
    eventName: "pull_request_target",
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

function runEnrollment(t, { eventName, action, pr = pullRequest(), unresolved = false, errors = [] }) {
  const directory = mkdtempSync(join(tmpdir(), "auto-merge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const event = join(directory, "event.json");
  writeFileSync(event, JSON.stringify({
    action,
    pull_request: { number: pr.number },
    repository: { default_branch: "main" },
  }));
  const transport = join(directory, "transport.mjs");
  writeFileSync(transport, `
    globalThis.fetch = async (url, options) => {
      if (url === "https://api.github.com/repos/example/agent-infra/pulls/8") {
        return Response.json(${JSON.stringify(pr)});
      }
      if (url !== "https://api.github.com/graphql") throw new Error("Unexpected URL");
      const operation = JSON.parse(options.body).query;
      if (operation.includes("query PullRequestReviewThreads(")) {
        console.log("review threads read");
        return Response.json({ data: { repository: { pullRequest: {
          reviewThreads: {
            nodes: [{ isResolved: ${!unresolved} }],
            pageInfo: { hasNextPage: false },
          },
        } } } });
      }
      if (/\\bmergePullRequest\\b/.test(operation)) throw new Error("Unexpected direct merge");
      if (operation.includes("enablePullRequestAutoMerge(")) {
        console.log("enrollment attempted");
        const errors = ${JSON.stringify(errors)};
        return Response.json(errors.length ? { errors } : { data: {
          enablePullRequestAutoMerge: { pullRequest: { number: 8, autoMergeRequest: { enabledAt: "now" } } },
        } });
      }
      if (operation.includes("disablePullRequestAutoMerge(")) {
        console.log("cancellation attempted");
        return Response.json({ data: { disablePullRequestAutoMerge: { pullRequest: { number: 8 } } } });
      }
      throw new Error("Unexpected GraphQL operation");
    };
  `);
  const run = spawnSync(process.execPath, [
    "--import", transport, fileURLToPath(new URL("./auto-merge.mjs", import.meta.url)),
  ], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      GITHUB_EVENT_NAME: eventName,
      GITHUB_EVENT_PATH: event,
      GITHUB_REPOSITORY: "example/agent-infra",
      GITHUB_TOKEN: "synthetic-test-token",
    },
  });
  assert.ifError(run.error);
  return run;
}

test("review submission and review comment deletion recheck resolved threads and enroll", (t) => {
  for (const [eventName, action] of [
    ["pull_request_review", "submitted"],
    ["pull_request_review_comment", "deleted"],
  ]) {
    const run = runEnrollment(t, { eventName, action });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /review threads read\nenrollment attempted\nAuto-merge enrolled/);
  }
});

test("review submission with unresolved threads skips enrollment and cancels an existing request", (t) => {
  for (const auto_merge of [null, { enabled_by: { login: "member" } }]) {
    const run = runEnrollment(t, {
      eventName: "pull_request_review",
      action: "submitted",
      pr: pullRequest({ auto_merge }),
      unresolved: true,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /review threads read/);
    assert.doesNotMatch(run.stdout, /enrollment attempted/);
    assert.match(run.stdout, auto_merge
      ? /cancellation attempted\nAuto-merge disabled: 1 unresolved review thread/
      : /Auto-merge not enrolled: 1 unresolved review thread/);
  }
});

test("first-pass CI can enroll when GitHub accepts the request", (t) => {
  const run = runEnrollment(t, { eventName: "pull_request_target", action: "ready_for_review" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /enrollment attempted\nAuto-merge enrolled/);
});

test("GitHub declining enrollment for unstable after a CI rerun or clean is a neutral result", (t) => {
  for (const message of [
    "Pull request Pull request is in unstable status",
    "Pull request is in clean status",
  ]) {
    const run = runEnrollment(t, {
      eventName: "pull_request_target",
      action: "ready_for_review",
      errors: [{ message }],
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /enrollment attempted\nAuto-merge not enrolled: GitHub reported (clean|unstable) status/);
  }
});

test("other GraphQL errors still fail enrollment", (t) => {
  const denied = { message: "Resource not accessible by integration" };
  for (const errors of [[denied], [{ message: "Pull request is in unstable status" }, denied]]) {
    const run = runEnrollment(t, { eventName: "pull_request_target", action: "ready_for_review", errors });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /Resource not accessible by integration/);
  }
});
