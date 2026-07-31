import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAssistantRequest,
  resolveReviewRequest,
} from "./check-claude-eligibility.mjs";

const repository = "AgoraIO-Extensions/agent-infra";
const apiUrl = "https://api.github.test";
const headSha = "a".repeat(40);

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockApi(routes) {
  const calls = [];
  const remaining = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) && value.every((item) => item instanceof Response)
        ? [...value]
        : [value],
    ]),
  );
  return {
    calls,
    async fetchImpl(url, options = {}) {
      const parsed = new URL(url);
      const key = `${options.method ?? "GET"} ${parsed.pathname}${parsed.search}`;
      calls.push({ key, options });
      const queue = remaining.get(key);
      if (!queue || queue.length === 0) {
        throw new Error(`Unexpected GitHub API request: ${key}`);
      }
      return queue.shift();
    },
  };
}

function reviewEvent(overrides = {}) {
  return {
    action: "completed",
    workflow_run: {
      id: 77,
      name: "payload fields are not authoritative",
      actor: { login: "payload-user", type: "Bot" },
      ...overrides,
    },
  };
}

function workflowRun(overrides = {}) {
  return {
    id: 77,
    name: "Claude Review Request",
    path: ".github/workflows/claude-review-request.yml",
    event: "pull_request",
    conclusion: "success",
    head_sha: headSha,
    actor: { login: "maintainer", type: "User" },
    repository: { full_name: repository },
    pull_requests: [{ number: 2 }],
    ...overrides,
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 2,
    state: "open",
    draft: false,
    head: { sha: headSha, repo: { full_name: repository } },
    ...overrides,
  };
}

function validReviewRoutes({
  run = workflowRun(),
  pr = pullRequest(),
  permission = "write",
  jobs = [{ name: "Request Claude Review", conclusion: "success" }],
} = {}) {
  return {
    "GET /repos/AgoraIO-Extensions/agent-infra/actions/runs/77": response(run),
    "GET /repos/AgoraIO-Extensions/agent-infra/actions/runs/77/jobs?per_page=100&page=1":
      response({ total_count: jobs.length, jobs }),
    "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": response(pr),
    "GET /repos/AgoraIO-Extensions/agent-infra/collaborators/maintainer/permission":
      response({ permission }),
  };
}

const common = { repository, token: "token", apiUrl };

function reviewDenied(reason) {
  return {
    eligible: false,
    reason,
    prNumber: 0,
    headSha: "",
    actor: "",
  };
}

function assistantDenied(reason) {
  return {
    eligible: false,
    reason,
    entityType: "",
    entityNumber: 0,
    headSha: "",
    actor: "",
    request: "",
  };
}

test("resolves Review authority from the run API, not event payload", async () => {
  const api = mockApi(validReviewRoutes());
  const result = await resolveReviewRequest({
    ...common,
    event: reviewEvent(),
    fetchImpl: api.fetchImpl,
  });

  assert.deepEqual(result, {
    eligible: true,
    reason: "eligible",
    prNumber: 2,
    headSha,
    actor: "maintainer",
  });
  assert.equal(
    api.calls[0].key,
    "GET /repos/AgoraIO-Extensions/agent-infra/actions/runs/77",
  );
});

test("rejects a non-completed workflow_run event before API access", async () => {
  assert.deepEqual(
    await resolveReviewRequest({
      ...common,
      event: { ...reviewEvent(), action: "requested" },
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    reviewDenied("workflow-run-not-completed"),
  );
});

test("rejects invalid authoritative Review run state", async (t) => {
  const cases = [
    ["workflow", { name: "Other" }, "unexpected-source-workflow"],
    [
      "workflow path",
      { path: ".github/workflows/spoofed.yml" },
      "unexpected-source-workflow",
    ],
    ["event", { event: "workflow_dispatch" }, "unexpected-source-event"],
    ["conclusion", { conclusion: "failure" }, "source-run-failed"],
    [
      "repository",
      { repository: { full_name: "attacker/fork" } },
      "source-repository-mismatch",
    ],
    ["linked PR", { pull_requests: [] }, "missing-source-pr"],
    [
      "bot",
      { actor: { login: "automation[bot]", type: "Bot" } },
      "bot",
    ],
    ["missing actor type", { actor: { login: "unknown" } }, "bot"],
  ];

  for (const [name, overrides, reason] of cases) {
    await t.test(name, async () => {
      const api = mockApi({
        "GET /repos/AgoraIO-Extensions/agent-infra/actions/runs/77": response(
          workflowRun(overrides),
        ),
      });
      assert.deepEqual(
        await resolveReviewRequest({
          ...common,
          event: reviewEvent(),
          fetchImpl: api.fetchImpl,
        }),
        reviewDenied(reason),
      );
    });
  }
});

test("reads all source-job pages and requires one successful request job", async () => {
  const unrelated = Array.from({ length: 100 }, (_, index) => ({
    name: `unrelated-${index}`,
    conclusion: "success",
  }));
  const routes = validReviewRoutes();
  routes[
    "GET /repos/AgoraIO-Extensions/agent-infra/actions/runs/77/jobs?per_page=100&page=1"
  ] = response({ total_count: 101, jobs: unrelated });
  routes[
    "GET /repos/AgoraIO-Extensions/agent-infra/actions/runs/77/jobs?per_page=100&page=2"
  ] = response({
    total_count: 101,
    jobs: [{ name: "Request Claude Review", conclusion: "success" }],
  });
  const api = mockApi(routes);

  const result = await resolveReviewRequest({
    ...common,
    event: reviewEvent(),
    fetchImpl: api.fetchImpl,
  });
  assert.equal(result.eligible, true);
  assert.ok(api.calls.some((call) => call.key.endsWith("page=2")));
});

test("rejects missing, skipped, or duplicated request jobs", async (t) => {
  for (const [name, jobs] of [
    ["missing", [{ name: "other", conclusion: "success" }]],
    ["skipped", [{ name: "Request Claude Review", conclusion: "skipped" }]],
    [
      "duplicated",
      [
        { name: "Request Claude Review", conclusion: "success" },
        { name: "Request Claude Review", conclusion: "success" },
      ],
    ],
  ]) {
    await t.test(name, async () => {
      const routes = validReviewRoutes({ jobs });
      delete routes["GET /repos/AgoraIO-Extensions/agent-infra/pulls/2"];
      delete routes[
        "GET /repos/AgoraIO-Extensions/agent-infra/collaborators/maintainer/permission"
      ];
      const api = mockApi(routes);
      assert.deepEqual(
        await resolveReviewRequest({
          ...common,
          event: reviewEvent(),
          fetchImpl: api.fetchImpl,
        }),
        reviewDenied("source-request-not-successful"),
      );
    });
  }
});

test("rejects current PR and permission failures", async (t) => {
  const cases = [
    ["closed", pullRequest({ state: "closed" }), "closed-pr"],
    ["Draft", pullRequest({ draft: true }), "draft-pr"],
    ["missing Draft state", pullRequest({ draft: undefined }), "draft-pr"],
    [
      "fork",
      pullRequest({
        head: { sha: headSha, repo: { full_name: "external/fork" } },
      }),
      "fork-pr",
    ],
    [
      "stale",
      pullRequest({
        head: { sha: "b".repeat(40), repo: { full_name: repository } },
      }),
      "stale-head",
    ],
  ];
  for (const [name, pr, reason] of cases) {
    await t.test(name, async () => {
      const routes = validReviewRoutes({ pr });
      delete routes[
        "GET /repos/AgoraIO-Extensions/agent-infra/collaborators/maintainer/permission"
      ];
      const api = mockApi(routes);
      assert.deepEqual(
        await resolveReviewRequest({
          ...common,
          event: reviewEvent(),
          fetchImpl: api.fetchImpl,
        }),
        reviewDenied(reason),
      );
    });
  }

  await t.test("read-only actor", async () => {
    const api = mockApi(validReviewRoutes({ permission: "read" }));
    assert.deepEqual(
      await resolveReviewRequest({
        ...common,
        event: reviewEvent(),
        fetchImpl: api.fetchImpl,
      }),
      reviewDenied("insufficient-permission"),
    );
  });
});

function assistantPr() {
  return pullRequest();
}

function permissionRoute(actor = "maintainer", permission = "write") {
  return {
    [`GET /repos/AgoraIO-Extensions/agent-infra/collaborators/${actor}/permission`]:
      response({ permission }),
  };
}

test("resolves Assistant author and request from API resources", async (t) => {
  const cases = [
    {
      name: "Issue comment",
      eventName: "issue_comment",
      event: {
        action: "created",
        sender: { login: "spoofed", type: "Bot" },
        issue: { number: 9 },
        comment: { id: 10, body: "payload is ignored" },
      },
      routes: {
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/10": response({
          id: 10,
          body: "@claude summarize",
          user: { login: "maintainer", type: "User" },
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": response({
          number: 9,
          pull_request: undefined,
        }),
        ...permissionRoute(),
      },
      expected: {
        entityType: "issue",
        entityNumber: 9,
        headSha: "",
        request: "@claude summarize",
      },
    },
    {
      name: "PR top-level comment",
      eventName: "issue_comment",
      event: {
        action: "created",
        issue: { number: 2 },
        comment: { id: 10 },
      },
      routes: {
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/10": response({
          id: 10,
          body: "@claude inspect",
          user: { login: "maintainer", type: "User" },
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/2": response({
          number: 2,
          pull_request: {},
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": response(assistantPr()),
        ...permissionRoute(),
      },
      expected: {
        entityType: "pull_request",
        entityNumber: 2,
        headSha,
        request: "@claude inspect",
      },
    },
    {
      name: "PR line comment",
      eventName: "pull_request_review_comment",
      event: {
        action: "created",
        pull_request: { number: 2 },
        comment: { id: 11 },
      },
      routes: {
        "GET /repos/AgoraIO-Extensions/agent-infra/pulls/comments/11": response({
          id: 11,
          body: "@claude inspect line",
          user: { login: "maintainer", type: "User" },
          pull_request_url:
            "https://api.github.test/repos/AgoraIO-Extensions/agent-infra/pulls/2",
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": response(assistantPr()),
        ...permissionRoute(),
      },
      expected: {
        entityType: "pull_request",
        entityNumber: 2,
        headSha,
        request: "@claude inspect line",
      },
    },
    {
      name: "PR review summary",
      eventName: "pull_request_review",
      event: {
        action: "submitted",
        pull_request: { number: 2 },
        review: { id: 12 },
      },
      routes: {
        "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2/reviews/12": response({
          id: 12,
          body: "@claude inspect review",
          user: { login: "maintainer", type: "User" },
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": response(assistantPr()),
        ...permissionRoute(),
      },
      expected: {
        entityType: "pull_request",
        entityNumber: 2,
        headSha,
        request: "@claude inspect review",
      },
    },
    {
      name: "Issue label",
      eventName: "issues",
      event: {
        action: "labeled",
        issue: { number: 9 },
        label: { name: "claude" },
      },
      routes: {
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": response({
          number: 9,
          labels: [{ name: "claude" }],
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/9/timeline?per_page=100&page=1":
          response([
            {
              id: 50,
              event: "labeled",
              label: { name: "claude" },
              actor: { login: "maintainer", type: "User" },
            },
          ]),
        ...permissionRoute(),
      },
      expected: {
        entityType: "issue",
        entityNumber: 9,
        headSha: "",
        request: "Analyze Issue #9 after the claude label was applied.",
      },
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const api = mockApi(item.routes);
      assert.deepEqual(
        await resolveAssistantRequest({
          ...common,
          eventName: item.eventName,
          event: item.event,
          fetchImpl: api.fetchImpl,
        }),
        {
          eligible: true,
          reason: "eligible",
          actor: "maintainer",
          ...item.expected,
        },
      );
    });
  }
});

test("Assistant API data cannot be overridden by event sender or body", async (t) => {
  await t.test("API body lacks trigger", async () => {
    const api = mockApi({
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/10": response({
        id: 10,
        body: "ordinary comment",
        user: { login: "maintainer", type: "User" },
      }),
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": response({ number: 9 }),
    });
    assert.deepEqual(
      await resolveAssistantRequest({
        ...common,
        eventName: "issue_comment",
        event: {
          action: "created",
          sender: { login: "maintainer", type: "User" },
          issue: { number: 9 },
          comment: { id: 10, body: "@claude spoofed" },
        },
        fetchImpl: api.fetchImpl,
      }),
      assistantDenied("trigger-missing"),
    );
  });

  await t.test("API author is a bot", async () => {
    const api = mockApi({
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/10": response({
        id: 10,
        body: "@claude run",
        user: { login: "automation[bot]", type: "Bot" },
      }),
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": response({ number: 9 }),
    });
    assert.deepEqual(
      await resolveAssistantRequest({
        ...common,
        eventName: "issue_comment",
        event: { action: "created", issue: { number: 9 }, comment: { id: 10 } },
        fetchImpl: api.fetchImpl,
      }),
      assistantDenied("bot"),
    );
  });

  await t.test("API author type is not a User", async () => {
    const api = mockApi({
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/10": response({
        id: 10,
        body: "@claude run",
        user: { login: "unknown-actor", type: "Organization" },
      }),
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": response({ number: 9 }),
    });
    assert.deepEqual(
      await resolveAssistantRequest({
        ...common,
        eventName: "issue_comment",
        event: { action: "created", issue: { number: 9 }, comment: { id: 10 } },
        fetchImpl: api.fetchImpl,
      }),
      assistantDenied("bot"),
    );
  });
});

test("Assistant rejects Draft, fork, and non-writer API state", async (t) => {
  for (const [name, pr, reason] of [
    ["Draft", pullRequest({ draft: true }), "draft-pr"],
    [
      "fork",
      pullRequest({
        head: { sha: headSha, repo: { full_name: "external/fork" } },
      }),
      "fork-pr",
    ],
  ]) {
    await t.test(name, async () => {
      const api = mockApi({
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/10": response({
          id: 10,
          body: "@claude run",
          user: { login: "maintainer", type: "User" },
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/issues/2": response({
          number: 2,
          pull_request: {},
        }),
        "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": response(pr),
      });
      assert.deepEqual(
        await resolveAssistantRequest({
          ...common,
          eventName: "issue_comment",
          event: { action: "created", issue: { number: 2 }, comment: { id: 10 } },
          fetchImpl: api.fetchImpl,
        }),
        assistantDenied(reason),
      );
    });
  }

  await t.test("read-only API author", async () => {
    const api = mockApi({
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/10": response({
        id: 10,
        body: "@claude run",
        user: { login: "maintainer", type: "User" },
      }),
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": response({ number: 9 }),
      ...permissionRoute("maintainer", "read"),
    });
    assert.deepEqual(
      await resolveAssistantRequest({
        ...common,
        eventName: "issue_comment",
        event: { action: "created", issue: { number: 9 }, comment: { id: 10 } },
        fetchImpl: api.fetchImpl,
      }),
      assistantDenied("insufficient-permission"),
    );
  });
});

test("fails closed on malformed identifiers and GitHub API errors", async () => {
  await assert.rejects(
    resolveReviewRequest({
      ...common,
      event: reviewEvent(),
      fetchImpl: async () => new Response("failure", { status: 503 }),
    }),
    /GitHub API.*503/,
  );
  await assert.rejects(
    resolveAssistantRequest({
      ...common,
      eventName: "issue_comment",
      event: null,
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
    }),
    /event must be an object/,
  );
});
