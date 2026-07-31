import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareAssistantContext,
  prepareAssistantContextFromEvent,
  prepareReviewContext,
} from "./prepare-claude-context.mjs";

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
      calls.push(key);
      const queue = remaining.get(key);
      if (!queue || queue.length === 0) {
        throw new Error(`Unexpected GitHub API request: ${key}`);
      }
      return queue.shift();
    },
  };
}

function pullRequest(overrides = {}) {
  return {
    number: 2,
    state: "open",
    draft: false,
    title: "Trusted workflow review",
    body: "Review the requested changes.",
    changed_files: 2,
    user: { login: "author" },
    base: { sha: "b".repeat(40), ref: "main" },
    head: {
      sha: headSha,
      ref: "feature",
      repo: { full_name: repository },
    },
    ...overrides,
  };
}

function validFiles() {
  return [
    {
      filename: "z-last.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: "@@ -1 +1 @@\n-old\n+new",
    },
    {
      filename: "../../data-only.md",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "@@ -0,0 +1 @@\n+data",
    },
  ];
}

function validReviewRoutes({ pr = pullRequest(), files = validFiles() } = {}) {
  return {
    "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": [
      response(pr),
      response(pr),
    ],
    "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2/files?per_page=100&page=1":
      response(files),
    "GET /repos/AgoraIO-Extensions/agent-infra/issues/2/comments?per_page=100&page=1":
      response([{ id: 30, user: { login: "bob" }, body: "top-level" }]),
    "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2/comments?per_page=100&page=1":
      response([
        {
          id: 20,
          user: { login: "carol" },
          body: "line comment",
          path: "z-last.md",
          line: 1,
          side: "RIGHT",
        },
      ]),
    "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2/reviews?per_page=100&page=1":
      response([{ id: 10, user: { login: "dave" }, body: "review body" }]),
  };
}

async function withOutput(run) {
  const directory = await mkdtemp(join(tmpdir(), "agent-infra-context-"));
  const outputPath = join(directory, ".claude-context", "context.json");
  try {
    return await run(outputPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const common = {
  repository,
  token: "token",
  apiUrl,
};

test("writes deterministic complete PR Review context as one JSON file", async () => {
  await withOutput(async (outputPath) => {
    const api = mockApi(validReviewRoutes());
    const result = await prepareReviewContext({
      ...common,
      prNumber: 2,
      headSha,
      outputPath,
      fetchImpl: api.fetchImpl,
    });
    const raw = await readFile(outputPath, "utf8");
    const context = JSON.parse(raw);

    assert.equal(result.outputPath, outputPath);
    assert.equal(result.bytes, Buffer.byteLength(raw));
    assert.equal(result.fileCount, 2);
    assert.equal(result.commentCount, 3);
    assert.equal(context.format_version, 1);
    assert.equal(context.kind, "pull_request_review");
    assert.equal(context.pull_request.head_sha, headSha);
    assert.deepEqual(
      context.files.map((file) => file.filename),
      ["../../data-only.md", "z-last.md"],
    );
    assert.deepEqual(
      context.comments.map((comment) => comment.id),
      [10, 20, 30],
    );
    assert.equal(context.files[0].filename, "../../data-only.md");
  });
});

test("rejects stale or incomplete PR context", async (t) => {
  await t.test("stale head", async () => {
    await withOutput(async (outputPath) => {
      const api = mockApi({
        "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": response(
          pullRequest({
            head: {
              sha: "c".repeat(40),
              ref: "feature",
              repo: { full_name: repository },
            },
          }),
        ),
      });
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /PR head changed/,
      );
    });
  });

  await t.test("missing patch", async () => {
    await withOutput(async (outputPath) => {
      const files = validFiles();
      delete files[0].patch;
      const api = mockApi(validReviewRoutes({ files }));
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /patch is missing/,
      );
    });
  });

  await t.test("changed file count mismatch", async () => {
    await withOutput(async (outputPath) => {
      const api = mockApi(
        validReviewRoutes({ pr: pullRequest({ changed_files: 3 }) }),
      );
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /changed file count/,
      );
    });
  });

  await t.test("truncated patch", async () => {
    await withOutput(async (outputPath) => {
      const files = validFiles();
      files[0].patch = "@@ -1 +1 @@\n+new";
      const api = mockApi(validReviewRoutes({ files }));
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /patch is incomplete/,
      );
    });
  });

  await t.test("head changes after context collection", async () => {
    await withOutput(async (outputPath) => {
      const routes = validReviewRoutes();
      routes["GET /repos/AgoraIO-Extensions/agent-infra/pulls/2"] = [
        response(pullRequest()),
        response(
          pullRequest({
            head: {
              sha: "c".repeat(40),
              ref: "feature",
              repo: { full_name: repository },
            },
          }),
        ),
      ];
      const api = mockApi(routes);
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /PR head changed after context collection/,
      );
    });
  });
});

test("rejects more than 100 changed files before fetching patches", async () => {
  await withOutput(async (outputPath) => {
    const api = mockApi({
      "GET /repos/AgoraIO-Extensions/agent-infra/pulls/2": response(
        pullRequest({ changed_files: 101 }),
      ),
    });
    await assert.rejects(
      prepareReviewContext({
        ...common,
        prNumber: 2,
        headSha,
        outputPath,
        fetchImpl: api.fetchImpl,
      }),
      /exceeds the 100 file limit/,
    );
    assert.equal(api.calls.length, 1);
  });
});

test("rejects more than 100 combined comments instead of truncating", async () => {
  await withOutput(async (outputPath) => {
    const firstPage = Array.from({ length: 100 }, (_, id) => ({
      id,
      user: { login: "reviewer" },
      body: `comment ${id}`,
    }));
    const routes = validReviewRoutes();
    routes[
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/2/comments?per_page=100&page=1"
    ] = response(firstPage);
    routes[
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/2/comments?per_page=100&page=2"
    ] = response([{ id: 101, user: { login: "reviewer" }, body: "overflow" }]);
    const api = mockApi(routes);
    await assert.rejects(
      prepareReviewContext({
        ...common,
        prNumber: 2,
        headSha,
        outputPath,
        fetchImpl: api.fetchImpl,
      }),
      /exceeded the 100 item limit/,
    );
  });
});

test("enforces field and total UTF-8 byte limits", async (t) => {
  await t.test("title field", async () => {
    await withOutput(async (outputPath) => {
      const api = mockApi(
        validReviewRoutes({ pr: pullRequest({ title: "x".repeat(513) }) }),
      );
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /title exceeds 512 bytes/,
      );
    });
  });

  await t.test("patch field", async () => {
    await withOutput(async (outputPath) => {
      const files = validFiles();
      files[0].patch = "x".repeat(262_145);
      const api = mockApi(validReviewRoutes({ files }));
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /patch exceeds 262144 bytes/,
      );
    });
  });

  await t.test("total context", async () => {
    await withOutput(async (outputPath) => {
      const files = Array.from({ length: 5 }, (_, index) => ({
        filename: `file-${index}.md`,
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: `@@ -0,0 +1 @@\n+${index}${"x".repeat(219_980)}`,
      }));
      const api = mockApi(
        validReviewRoutes({
          pr: pullRequest({ changed_files: files.length }),
          files,
        }),
      );
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /context exceeds 1048576 bytes/,
      );
    });
  });
});

test("writes bounded Issue Assistant context", async () => {
  await withOutput(async (outputPath) => {
    const api = mockApi({
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": response({
        number: 9,
        state: "open",
        title: "Architecture question",
        body: "How should this work?",
        user: { login: "author" },
        pull_request: undefined,
      }),
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9/comments?per_page=100&page=1":
        response([
          { id: 1, user: { login: "author" }, body: "@claude analyze" },
        ]),
    });
    const result = await prepareAssistantContext({
      ...common,
      entityType: "issue",
      entityNumber: 9,
      headSha: "",
      request: "@claude analyze",
      outputPath,
      fetchImpl: api.fetchImpl,
    });
    const context = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.commentCount, 1);
    assert.equal(context.kind, "assistant_issue");
    assert.equal(context.request, "@claude analyze");
    assert.equal(context.issue.number, 9);
  });
});

test("re-resolves Assistant request text from GitHub API before writing context", async () => {
  await withOutput(async (outputPath) => {
    const request = "@claude inspect $(do-not-run)\n${{ secrets.NOT_AVAILABLE }}";
    const issue = {
      number: 9,
      state: "open",
      title: "Architecture question",
      body: "How should this work?",
      user: { login: "author" },
    };
    const api = mockApi({
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/7": response({
        id: 7,
        body: request,
        user: { login: "maintainer", type: "User" },
      }),
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9": [
        response(issue),
        response(issue),
      ],
      "GET /repos/AgoraIO-Extensions/agent-infra/collaborators/maintainer/permission":
        response({ permission: "write" }),
      "GET /repos/AgoraIO-Extensions/agent-infra/issues/9/comments?per_page=100&page=1":
        response([{ id: 7, user: { login: "maintainer" }, body: request }]),
    });

    await prepareAssistantContextFromEvent({
      ...common,
      eventName: "issue_comment",
      event: {
        action: "created",
        issue: { number: 9 },
        comment: { id: 7, body: "payload text is not authoritative" },
      },
      entityType: "issue",
      entityNumber: 9,
      headSha: "",
      outputPath,
      fetchImpl: api.fetchImpl,
    });

    const context = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(context.request, request);
    assert.ok(api.calls.includes("GET /repos/AgoraIO-Extensions/agent-infra/issues/comments/7"));
  });
});

test("requires the fixed context path and refuses symlinks", async (t) => {
  await t.test("arbitrary path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-infra-context-"));
    try {
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath: join(directory, "arbitrary.json"),
          fetchImpl: async () => {
            throw new Error("must not fetch");
          },
        }),
        /must end with \.claude-context\/context\.json/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("symlinked context directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-infra-context-"));
    const target = join(directory, "target");
    const contextDirectory = join(directory, ".claude-context");
    const outputPath = join(contextDirectory, "context.json");
    try {
      await mkdir(target);
      await symlink(target, contextDirectory);
      const api = mockApi(validReviewRoutes());
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /context directory must not be a symbolic link/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  await t.test("symlinked context file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-infra-context-"));
    const contextDirectory = join(directory, ".claude-context");
    const outputPath = join(contextDirectory, "context.json");
    const target = join(directory, "target.json");
    try {
      await mkdir(contextDirectory);
      await symlink(target, outputPath);
      const api = mockApi(validReviewRoutes());
      await assert.rejects(
        prepareReviewContext({
          ...common,
          prNumber: 2,
          headSha,
          outputPath,
          fetchImpl: api.fetchImpl,
        }),
        /context file must not be a symbolic link/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
