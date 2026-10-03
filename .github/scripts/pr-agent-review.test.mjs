import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedRightLinesFromTexts,
  collectScopedChangedLines,
  githubRequest,
  parsePrAgentReview,
  publicationFailure,
  PrAgentTargetSuperseded,
  publishPrAgentReview,
  runPrAgentPublisher,
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
  missingPatch = false,
  addedFile = false,
  removedFile = false,
  largeFile = false,
  renamedFile = false,
} = {}) {
  const baseSha = "b".repeat(40);
  const mergeBaseSha = "c".repeat(40);
  const baseBlobSha = "d".repeat(40);
  const headBlobSha = "e".repeat(40);
  let posted;
  const writes = [];
  const requested = [];
  const request = async (path, options = {}) => {
    requested.push(path);
    if (options.method === "POST") {
      writes.push(path);
      if (failPost) throw new Error("GitHub API POST failed: 403");
      posted = JSON.parse(options.body);
      return { id: 77 };
    }
    if (path.endsWith("/reviews?per_page=100&page=1"))
      return posted ? [{ id: 77, user: actor, commit_id: head, body: posted.body }] : [];
    if (path.endsWith("/files?per_page=100&page=1"))
      return [
        {
          filename: "src/math.ts",
          ...(addedFile
            ? { status: "added" }
            : removedFile
              ? { status: "removed" }
              : {}),
          ...(renamedFile ? { previous_filename: "src/old-math.ts" } : {}),
          ...(missingPatch
            ? {}
            : { patch: "@@ -1 +1 @@\n-return a + b;\n+return a - b;" }),
        },
      ];
    if (missingPatch && path.includes("/compare/"))
      return { merge_base_commit: { sha: mergeBaseSha } };
    if (missingPatch && path.includes("/contents/")) {
      const before = path.includes(mergeBaseSha);
      return {
        type: "file",
        sha: before ? baseBlobSha : headBlobSha,
        ...(largeFile
          ? { encoding: "none" }
          : {
              encoding: "base64",
              content: Buffer.from(
                before ? "keep\nold\nend\n" : "keep\nnew\nend\n",
              ).toString("base64"),
            }),
      };
    }
    if (missingPatch && path.endsWith(`/git/blobs/${baseBlobSha}`)) {
      return {
        sha: baseBlobSha,
        encoding: "base64",
        content: Buffer.from("keep\nold\nend\n").toString("base64"),
      };
    }
    if (missingPatch && path.endsWith(`/git/blobs/${headBlobSha}`)) {
      return {
        sha: headBlobSha,
        encoding: "base64",
        content: Buffer.from("keep\nnew\nend\n").toString("base64"),
      };
    }
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
      base: { sha: baseSha },
    };
  };
  return { request, writes, requested, mergeBaseSha };
}

test("reuses the verified publication when the same run is repeated", async () => {
  const { request, writes } = api();
  const first = await publishPrAgentReview({ ...context, raw, request });
  const second = await publishPrAgentReview({ ...context, raw, request });
  assert.deepEqual(second, first);
  assert.equal(writes.length, 1);
});

test("recovers a POST whose response was lost without submitting it twice", async () => {
  const remote = api();
  const request = async (path, options = {}) => {
    const result = await remote.request(path, options);
    if (options.method === "POST") throw new TypeError("synthetic lost response");
    return result;
  };
  const receipt = await publishPrAgentReview({ ...context, raw, request });
  assert.equal(receipt.findingCount, 1);
  assert.equal(remote.writes.length, 1);
});

test("keeps the original POST failure when recovery reads also fail", async () => {
  const remote = api();
  const originalError = new Error("original POST error");
  const diagnostic = {};
  let failedPost = false;
  const request = async (path, options = {}) => {
    if (options.method === "POST") { failedPost = true; throw originalError; }
    if (failedPost) throw new Error("recovery read error");
    return remote.request(path, options);
  };
  await assert.rejects(publishPrAgentReview({ ...context, raw, request, diagnostic }),
    (error) => error === originalError);
  assert.equal(diagnostic.stage, "post-review");
});

test("stops when the target closes, becomes Draft or changes head before publication", async () => {
  for (const [change, reason] of [
    [{ state: "closed" }, "pr-closed"],
    [{ draft: true }, "pr-draft"],
    [{ head: { sha: "b".repeat(40), repo: { full_name: context.repository } } }, "head-superseded"],
  ]) {
    const remote = api();
    let reads = 0;
    const request = async (path, options) => {
      const result = await remote.request(path, options);
      return path.endsWith("/pulls/42") && ++reads === 1 ? { ...result, ...change } : result;
    };
    await assert.rejects(publishPrAgentReview({ ...context, raw: "not-json", request }),
      (error) => error instanceof PrAgentTargetSuperseded && error.reason === reason);
    assert.equal(remote.writes.length, 0);
  }
});

test("maps verified unified-diff changes to per-file right-side lines", () => {
  const lines = collectScopedChangedLines(
    "diff --git a/src/math.ts b/src/math.ts\nindex 111..222 100644\n--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,2 +1,3 @@\n keep\n+return a - b;\n old\n",
  );
  assert.deepEqual([...lines.get("src/math.ts")], [2]);
});

async function gitQuotedPathDiff() {
  const directory = await mkdtemp(join(tmpdir(), "pr-agent-quoted-paths-"));
  const files = [
    { filename: "src/aaa.ts", line: 2 },
    { filename: "src/space name.ts", line: 2 },
    { filename: "src/tab\t\"quote\\name.ts", line: 3 },
    { filename: "src/中文.ts", line: 4 },
  ];
  const git = (...args) => execFileSync("git", ["-C", directory,
    "-c", "core.quotePath=true", ...args], { encoding: "utf8" });
  try {
    git("init", "--quiet");
    await mkdir(join(directory, "src"));
    const before = "one\ntwo\nthree\nfour\n";
    for (const file of files) await writeFile(join(directory, file.filename), before);
    git("add", ".");
    for (const file of files) {
      const lines = before.trimEnd().split("\n");
      lines[file.line - 1] = "regression";
      await writeFile(join(directory, file.filename), `${lines.join("\n")}\n`);
      file.before = before;
      file.after = `${lines.join("\n")}\n`;
      file.patch = git("diff", "--no-ext-diff", "--no-textconv", "--", file.filename);
    }
    return { files, diff: git("diff", "--no-ext-diff", "--no-textconv") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("keeps ordinary and Git-quoted Unicode, tab and quote path changes separate", async () => {
  const { diff, files } = await gitQuotedPathDiff();
  assert.match(diff, /diff --git a\/src\/aaa\.ts b\/src\/aaa\.ts/);
  assert.match(diff, /diff --git "a\//);
  const changed = collectScopedChangedLines(diff);
  assert.equal(changed.size, files.length);
  for (const file of files) assert.deepEqual([...changed.get(file.filename)], [file.line]);
});

test("publishes and reads back nonempty scoped findings for Git-quoted paths", async () => {
  const { diff, files } = await gitQuotedPathDiff();
  const remote = api();
  const issue = { number: 7, state: "open", title: "Quoted-path publication", body: "Preserve the file anchors." };
  const request = async (path, options = {}) => {
    if (path.endsWith("/pulls/42")) {
      const current = await remote.request(path, options);
      return { ...current, body: "Closes #7", base: { ...current.base, ref: "main", repo: { full_name: context.repository } } };
    }
    if (path.endsWith("/issues/7")) return issue;
    if (path.includes("/contents/")) {
      const url = new URL(`https://example.test${path}`);
      const filename = decodeURIComponent(url.pathname.split("/contents/")[1]);
      const file = files.find((candidate) => candidate.filename === filename);
      const value = url.searchParams.get("ref") === head ? file.after : file.before;
      return { type: "file", sha: head, encoding: "base64", content: Buffer.from(value).toString("base64") };
    }
    if (path.includes("/compare/")) return options.responseType === "text" ? diff
      : { status: "ahead", merge_base_commit: { sha: "b".repeat(40) },
          files: files.map(({ filename }) => ({ filename, status: "modified", additions: 1, deletions: 1 })) };
    if (path.includes("/files?")) return files;
    return remote.request(path, options);
  };
  const { issueContractHash, prepareReviewScope } = await import("./pr-agent-review-scope.mjs");
  const { scope } = await prepareReviewScope({ ...context, request }, {
    headSha: head, issueNumber: 7, contractSha256: issueContractHash(issue),
  });
  const receipt = await publishPrAgentReview({ ...context, request, scope,
    raw: JSON.stringify({ key_issues_to_review: files.map(({ filename, line }) => ({
      ...finding, relevant_file: filename, start_line: line, end_line: line,
    })) }),
  });
  assert.equal(receipt.findingCount, files.length);
  assert.equal(remote.writes.length, 1);
  const comments = (await remote.request("/reviews/77/comments?per_page=100"))
    .map((comment) => remote.request(`/repos/org/repo/pulls/comments/${comment.id}`));
  assert.deepEqual((await Promise.all(comments)).map(({ path, line, side }) => ({ path, line, side })),
    files.map(({ filename, line }) => ({ path: filename, line, side: "RIGHT" })));
  assert.equal(await verifyPrAgentPublication({ ...context, request, receipt }), true);
});

test("retries transient reads but never blindly retries a POST", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1 ? new Response(null, { status: 503 }) : Response.json({ ok: true });
  });
  assert.deepEqual(await githubRequest("/repos/org/repo/pulls/42"), { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(githubRequest("/repos/org/repo/pulls/42/reviews", { method: "POST", body: "{}" }));
  assert.equal(calls, 1);
});

test("a later network failure does not inherit the previous HTTP response diagnostics", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) return new Response(null, { status: 503, headers: { "x-github-request-id": "AAAA:BBBB:CCCC" } });
    throw new Error("private network detail");
  });
  const error = await githubRequest("/repos/org/repo/pulls/42").catch((error) => error);
  assert.equal(calls, 3);
  assert.deepEqual(publicationFailure({ stage: "target-entry" }, error), {
    stage: "target-entry", category: "network", method: "GET", route: "pulls",
  });
});

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

test("finds changed lines when a large-file patch is unavailable", async () => {
  assert.deepEqual(
    await changedRightLinesFromTexts("keep\nold\nend\n", "keep\nnew\nend\n"),
    [{ start: 2, end: 2 }],
  );
  assert.deepEqual(
    await changedRightLinesFromTexts(
      "first\nlast\n",
      "first\ninserted\nlast\n",
    ),
    [{ start: 2, end: 2 }],
  );
  assert.deepEqual(
    await changedRightLinesFromTexts(
      "b\nc\na\nb",
      "c\nb\nd\na\nc\na",
    ),
    [
      { start: 2, end: 3 },
      { start: 5, end: 6 },
    ],
  );
  assert.deepEqual(await changedRightLinesFromTexts("a", ""), []);
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

test("anchors findings from GitHub content when a large-file patch is omitted", async () => {
  const { request } = api({ missingPatch: true });
  const receipt = await publishPrAgentReview({
    ...context,
    raw: JSON.stringify({
      key_issues_to_review: [{ ...finding, start_line: 2, end_line: 2 }],
    }),
    request,
  });
  assert.equal(receipt.findingCount, 1);
});

test("anchors findings in a newly added file when GitHub omits its patch", async () => {
  const { request } = api({ missingPatch: true, addedFile: true });
  const receipt = await publishPrAgentReview({
    ...context,
    raw: JSON.stringify({
      key_issues_to_review: [{ ...finding, start_line: 2, end_line: 2 }],
    }),
    request,
  });
  assert.equal(receipt.findingCount, 1);
});

test("uses Git blobs, merge-base content, and previous filename for large renames", async () => {
  const { request, requested, mergeBaseSha } = api({
    missingPatch: true,
    largeFile: true,
    renamedFile: true,
  });
  const receipt = await publishPrAgentReview({
    ...context,
    raw: JSON.stringify({
      key_issues_to_review: [{ ...finding, start_line: 2, end_line: 2 }],
    }),
    request,
  });
  assert.equal(receipt.findingCount, 1);
  assert.ok(
    requested.some((path) =>
      path.includes(`/contents/src/old-math.ts?ref=${mergeBaseSha}`),
    ),
  );
  assert.ok(requested.some((path) => path.endsWith(`/git/blobs/${"d".repeat(40)}`)));
});

test("does not read removed files when GitHub omits their patch", async () => {
  const { request, requested, writes } = api({
    missingPatch: true,
    removedFile: true,
  });
  await assert.rejects(
    publishPrAgentReview({
      ...context,
      raw: JSON.stringify({
        key_issues_to_review: [{ ...finding, start_line: 2, end_line: 2 }],
      }),
      request,
    }),
    /cannot be anchored/,
  );
  assert.equal(writes.length, 0);
  assert.equal(requested.some((path) => path.includes("/compare/")), false);
  assert.equal(requested.some((path) => path.includes("/contents/")), false);
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

test("retains HTTP status/request ID without parsing or logging arbitrary error bodies", async (t) => {
  for (const [status, requestId] of [
    [403, "ABCD:1234:5678"],
    [422, "ABCD:1234:5678"],
    [500, "PRIVATE_HEADER_SENTINEL"],
  ]) {
    t.mock.method(globalThis, "fetch", async () => ({
      ok: false,
      status,
      headers: new Headers({ "x-github-request-id": requestId }),
      json: () =>
        assert.fail("Error body must not be read: PRIVATE_BODY_SENTINEL"),
    }));
    const error = await githubRequest("/repos/org/repo/pulls/42/reviews", {
      method: "POST",
      body: "PRIVATE_REVIEW_SENTINEL",
    }).catch((error) => error);
    assert.deepEqual(publicationFailure({ stage: "post-review" }, error), {
      stage: "post-review",
      category: "http",
      method: "POST",
      route: "reviews",
      status,
      ...(status !== 500 ? { requestId } : {}),
    });
  }
});

test("terminal permission/rate failures expose only fixed messages and bounded headers", async (t) => {
  for (const [status, message, messageCategory] of [
    [403, "Resource not accessible by integration", "integration-permission"],
    [403, "Resource not accessible by personal access token", "token-permission"],
    [403, "API rate limit exceeded for PRIVATE_TOKEN_SENTINEL", "primary-rate-limit"],
    [429, "You have exceeded a secondary rate limit. PRIVATE_TOKEN_SENTINEL", "secondary-rate-limit"],
  ]) {
    let posts = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      assert.equal(options.method, "POST");
      posts++;
      return new Response(JSON.stringify({ message,
        documentation_url: "https://docs.github.com/rest/overview/resources-in-the-rest-api?PRIVATE_TOKEN_SENTINEL#secondary-rate-limits",
        secret: "PRIVATE_TOKEN_SENTINEL",
      }), { status, headers: {
        "x-github-request-id": "ABCD:1234:5678",
        "retry-after": "60",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1790907800",
        "x-ratelimit-resource": "core",
        "x-accepted-github-permissions": "pull_requests=write,contents=read; issues=read,metadata=read",
        "x-private-header": "PRIVATE_TOKEN_SENTINEL",
      } });
    });
    const error = await githubRequest("/repos/org/repo/pulls/42/reviews", { method: "POST" }).catch((error) => error);
    assert.deepEqual(publicationFailure({ stage: "post-review" }, error), {
      stage: "post-review", category: "http", method: "POST", route: "reviews", status,
      requestId: "ABCD:1234:5678", retryAfterSeconds: 60, rateLimitRemaining: 0,
      rateLimitReset: 1790907800, rateLimitResource: "core",
      acceptedPermissions: "pull_requests=write,contents=read;issues=read,metadata=read",
      messageCategory,
      documentationUrl: "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api",
    });
    assert.equal(posts, 1);
    assert.doesNotMatch(JSON.stringify(error.diagnostic), /PRIVATE/);
  }
});

test("unknown/control messages, URLs and unapproved headers never enter diagnostics", async (t) => {
  for (const [message, documentation_url] of [
    ["PRIVATE_TOKEN_SENTINEL", "https://private.example/PRIVATE_TOKEN_SENTINEL"],
    ["Resource not accessible by integration\nPRIVATE_TOKEN_SENTINEL", "https://docs.github.com/PRIVATE_TOKEN_SENTINEL"],
    ["PRIVATE_TOKEN_SENTINEL", "https://PRIVATE_TOKEN_SENTINEL@docs.github.com/rest/pulls/reviews"],
  ]) {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message, documentation_url }), {
      status: 403, headers: {
        "retry-after": "86401", "x-ratelimit-remaining": "-1", "x-ratelimit-reset": "4102444801",
        "x-ratelimit-resource": "PRIVATE_TOKEN_SENTINEL", "x-accepted-github-permissions": "PRIVATE_TOKEN_SENTINEL=write",
        "x-github-request-id": "ABCD:1234:5678",
      },
    }));
    const error = await githubRequest("/repos/org/repo/pulls/42/reviews", { method: "POST" }).catch((error) => error);
    assert.deepEqual(publicationFailure({ stage: "post-review" }, error), {
      stage: "post-review", category: "http", method: "POST", route: "reviews", status: 403, requestId: "ABCD:1234:5678",
    });
  }
});

test("invalid, oversized, unreadable and stalled bodies retain the original HTTP failure", async (t) => {
  let cancelled = 0;
  for (const body of [
    "PRIVATE_BODY_SENTINEL: not JSON",
    JSON.stringify({ message: `API rate limit exceeded ${"x".repeat(4096)}` }),
    new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE_BODY_SENTINEL")); } }),
    new ReadableStream({ cancel() { cancelled++; } }),
  ]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body, {
      status: 403, headers: { "x-github-request-id": "ABCD:1234:5678" },
    }));
    const start = Date.now();
    const error = await githubRequest("/repos/org/repo/pulls/42/reviews", { method: "POST" }).catch((error) => error);
    assert.deepEqual(publicationFailure({ stage: "post-review" }, error), {
      stage: "post-review", category: "http", method: "POST", route: "reviews", status: 403, requestId: "ABCD:1234:5678",
    });
    assert.ok(Date.now() - start < 2500, "Diagnostic body read is bounded");
  }
  assert.equal(cancelled, 1);
});

test("control characters invalidate otherwise valid response header values", async (t) => {
  for (const suffix of ["\n", "\u2028", "\u2029"]) {
    const values = { "retry-after": `1${suffix}`, "x-ratelimit-remaining": `0${suffix}`,
      "x-ratelimit-reset": `1790907800${suffix}`, "x-accepted-github-permissions": `pull_requests=write${suffix}` };
    t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 403,
      headers: { get: (name) => values[name] ?? null }, body: null }));
    const error = await githubRequest("/repos/org/repo/pulls/42/reviews", { method: "POST" }).catch((error) => error);
    assert.deepEqual(publicationFailure({ stage: "post-review" }, error), {
      stage: "post-review", category: "http", method: "POST", route: "reviews", status: 403,
    });
  }
});

test("an expired original request deadline ends body diagnostics before the one-second limit", async (t) => {
  const controller = new AbortController();
  let cancelled = 0;
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    assert.equal(milliseconds, 15_000);
    return controller.signal;
  });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error("PRIVATE_ERROR_SENTINEL"));
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 403 });
  });
  const start = Date.now();
  const error = await githubRequest("/repos/org/repo/pulls/42/reviews", { method: "POST" }).catch((error) => error);
  assert.ok(Date.now() - start < 800, "The original deadline must not get another one-second budget");
  assert.equal(cancelled, 1);
  assert.deepEqual(publicationFailure({ stage: "post-review" }, error), {
    stage: "post-review", category: "http", method: "POST", route: "reviews", status: 403,
  });
});

test("success parsing and existing bounded GET retries remain unchanged", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return calls === 1
      ? new Response("PRIVATE_BODY_SENTINEL", { status: 429, headers: { "retry-after": "0" } })
      : new Response('{"ok":true}');
  });
  assert.deepEqual(await githubRequest("/repos/org/repo/pulls/42"), { ok: true });
  assert.equal(calls, 2);
  t.mock.method(globalThis, "fetch", async () => new Response("successful text"));
  assert.equal(await githubRequest("/repos/org/repo/pulls/42", { responseType: "text" }), "successful text");
});

test("the real publisher reports safe POST failure, unchanged payload and no successful receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pr-agent-http-"));
  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "output");
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 42, head: { sha: head } } }));
  await writeFile(outputPath, "");
  const env = { GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
    GITHUB_REPOSITORY: "org/repo", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1",
    PR_AGENT_REVIEW: '{"key_issues_to_review":[]}', PR_AGENT_REVIEW_SCOPE_REQUIRED: "false", PR_AGENT_REVIEW_SCOPE: "",
    GITHUB_TOKEN: "PRIVATE_TOKEN_SENTINEL" };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const exitCode = process.exitCode;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, env);
  const original = api();
  let posts = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") {
      posts++;
      const payload = JSON.parse(options.body);
      assert.equal(payload.event, "COMMENT");
      assert.equal(payload.commit_id, head);
      assert.deepEqual(payload.comments, []);
      return new Response(JSON.stringify({ message: "Resource not accessible by integration", secret: "PRIVATE_BODY_SENTINEL" }), {
        status: 403, headers: { "x-accepted-github-permissions": "pull_requests=write" },
      });
    }
    return new Response(JSON.stringify(await original.request(url.replace("https://api.github.com", ""))));
  });
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  await runPrAgentPublisher();
  assert.equal(posts, 1);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(JSON.parse(logs[0][1]), {
    stage: "post-review", category: "http", method: "POST", route: "reviews", status: 403,
    acceptedPermissions: "pull_requests=write", messageCategory: "integration-permission",
  });
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
  assert.equal(await readFile(outputPath, "utf8"), "");
});

test("network/JSON failures and local exceptions cannot log arbitrary messages", async (t) => {
  for (const category of ["network", "invalid-json"]) {
    t.mock.method(globalThis, "fetch", async () => {
      if (category === "network") throw new Error("PRIVATE_TOKEN_SENTINEL");
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => {
          throw new SyntaxError("PRIVATE_BODY_SENTINEL");
        },
      };
    });
    const error = await githubRequest("/repos/org/repo/pulls/42").catch(
      (error) => error,
    );
    assert.deepEqual(publicationFailure({ stage: "target-entry" }, error), {
      stage: "target-entry",
      category,
      method: "GET",
      route: "pulls",
      ...(category === "invalid-json" ? { status: 200 } : {}),
    });
  }
  assert.deepEqual(
    publicationFailure(
      { stage: "PRIVATE_STAGE_SENTINEL" },
      new Error("PRIVATE_TOKEN_SENTINEL"),
    ),
    {
      stage: "unknown",
      category: "unknown",
    },
  );
});

test("failed empty publication identifies its actual boundary and returns no receipt", async () => {
  const stages = [
    "target-entry",
    "files",
    "target-before-post",
    "lookup-review",
    "post-review",
    "read-review",
    "read-comments",
    "target-final",
  ];
  for (const stage of stages) {
    const original = api();
    const diagnostic = {};
    let failed = false;
    let receipt;
    await assert.rejects(
      publishPrAgentReview({
        ...context,
        diagnostic,
        raw: '{"key_issues_to_review":[]}',
        request: async (...args) => {
          if (!failed && diagnostic.stage === stage) {
            failed = true;
            throw new Error("PRIVATE_ERROR_SENTINEL");
          }
          return original.request(...args);
        },
      }).then((value) => {
        receipt = value;
      }),
    );
    assert.equal(receipt, undefined);
    assert.equal(diagnostic.stage, stage);
    assert.doesNotMatch(
      JSON.stringify(
        publicationFailure(diagnostic, new Error("PRIVATE_ERROR_SENTINEL")),
      ),
      /PRIVATE/,
    );
  }
  const diagnostic = {};
  await assert.rejects(
    publishPrAgentReview({
      ...context,
      raw,
      diagnostic,
      ...api({ wrongHead: true }),
    }),
  );
  assert.deepEqual(
    publicationFailure(diagnostic, new Error("PRIVATE_ERROR_SENTINEL")),
    { stage: "verify", category: "verification" },
  );
});

test("the CLI reports output-write failure without producing a receipt or leaking its path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pr-agent-output-"));
  const eventPath = join(directory, "event.json");
  const outputPath = join(directory, "PRIVATE_PATH_SENTINEL", "output");
  await writeFile(
    eventPath,
    JSON.stringify({ pull_request: { number: 42, head: { sha: head } } }),
  );
  const env = {
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_REPOSITORY: "org/repo",
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
    PR_AGENT_REVIEW: '{"key_issues_to_review":[]}',
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  const exitCode = process.exitCode;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = exitCode;
    await rm(directory, { recursive: true, force: true });
  });
  Object.assign(process.env, env);
  const logs = [];
  t.mock.method(console, "error", (...args) => logs.push(args));
  await runPrAgentPublisher(api().request);
  assert.equal(process.exitCode, 1);
  assert.deepEqual(logs, [
    [
      "PR-Agent publication failed",
      '{"stage":"output-write","category":"output"}',
    ],
  ]);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});
