import assert from "node:assert/strict";
import test from "node:test";
import { gateExternalId, GATE_PUBLISHER_APP_ID } from "./check-run-contract.mjs";
import { publishPrAgentReview } from "./pr-agent-review.mjs";
import { buildCoverageCheckOutput } from "./review-coverage.mjs";
import { issueContractHash, prepareReviewScope, validateDiffInput, verifyReviewScope } from "./pr-agent-review-scope.mjs";

const repository = "org/repo";
const base = "b".repeat(40);
const first = "a".repeat(40);
const second = "c".repeat(40);
const third = "d".repeat(40);
const actor = { id: 41898282, login: "github-actions[bot]", type: "Bot" };
const patch = (before, after) => `diff --git a/src/math.ts b/src/math.ts\nindex 1111111..2222222 100644\n--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
const source = { [base]: "return a + b;", [first]: "return a - b;", [second]: "return a * b;", [third]: "return a / b;" };

function fixture() {
  const state = { head: first, reviews: [], checks: [], calls: [], issue: { number: 7, state: "open", title: "Arithmetic", body: "Preserve addition." } };
  const request = async (path, options = {}) => {
    state.calls.push({ path, options });
    if (path.endsWith("/pulls/42")) return { number: 42, state: "open", draft: false, body: "Closes #7",
      head: { sha: state.head, repo: { full_name: repository } },
      base: { sha: base, ref: "main", repo: { full_name: repository } } };
    if (path.endsWith("/issues/7")) return state.issue;
    const compare = /\/compare\/([a-f0-9]+)\.\.\.([a-f0-9]+)$/.exec(path);
    if (compare) {
      const [, from, to] = compare;
      const diff = source[from] === source[to] ? "" : patch(source[from], source[to]);
      return options.responseType === "text" ? diff : {
        status: from === to ? "identical" : "ahead", merge_base_commit: { sha: from },
        files: diff ? [{ filename: "src/math.ts", status: "modified", additions: 1, deletions: 1 }] : [],
      };
    }
    if (path.includes("/files?")) return [{ filename: "src/math.ts", patch: patch(source[base], source[state.head]) }];
    if (options.method === "POST" && path.endsWith("/reviews")) {
      const review = { ...JSON.parse(options.body), id: 70 + state.reviews.length, user: actor, state: "COMMENTED" };
      state.reviews.push(review);
      return review;
    }
    if (path.endsWith("/reviews?per_page=100&page=1")) return state.reviews;
    const review = /\/reviews\/(\d+)(\/comments\?per_page=100)?$/.exec(path);
    if (review) {
      const found = state.reviews.find((item) => item.id === Number(review[1]));
      return review[2] ? found.comments : found;
    }
    if (path.includes("/commits/") && path.includes("/check-runs?")) {
      const head = path.split("/commits/")[1].slice(0, 40);
      const checks = state.checks.filter((check) => check.head_sha === head);
      return { check_runs: checks, total_count: checks.length };
    }
    const check = /\/check-runs\/(\d+)$/.exec(path);
    if (check) return state.checks.find((item) => item.id === Number(check[1]));
    throw new Error(`Unexpected test route: ${path}`);
  };
  const context = () => ({ repository, prNumber: 42, expectedHead: state.head, runId: String(100 + state.reviews.length), attempt: "1", request });
  const primary = () => ({ headSha: state.head, issueNumber: 7, contractSha256: issueContractHash(state.issue) });
  const plan = () => prepareReviewScope(context(), primary());
  const certify = async () => {
    const { scope } = await plan();
    const receipt = await publishPrAgentReview({ ...context(), scope, raw: '{"key_issues_to_review":[]}' });
    const check = { id: 1000 + state.checks.length, name: "Automated Review Coverage", head_sha: state.head,
      app: { id: GATE_PUBLISHER_APP_ID }, status: "completed", conclusion: "success",
      external_id: gateExternalId({ name: "Automated Review Coverage", headSha: state.head, prNumber: 42 }),
      details_url: `https://github.com/${repository}/actions/runs/${receipt.runId}`,
      output: buildCoverageCheckOutput({ provider: "pr-agent", headSha: state.head, conclusion: "success", reasonCode: "complete", omittedFileCount: 0, scope, receipt }) };
    state.checks.push(check);
    return { scope, receipt, check };
  };
  return { state, context, primary, plan, certify };
}

test("first review covers the complete PR and a later push supplies only its exact delta", async () => {
  const f = fixture();
  const initial = await f.plan();
  assert.equal(initial.scope.mode, "full");
  assert.equal(initial.scope.fromSha, base);
  await f.certify();
  f.state.head = second;
  const next = await f.plan();
  assert.equal(next.scope.mode, "incremental");
  assert.equal(next.scope.fromSha, first);
  assert.equal(next.diff, patch(source[first], source[second]));
  assert.ok(!next.diff.includes(source[base]));
  await verifyReviewScope(f.context(), next.scope);
});

test("a failed or cancelled review never advances the next push baseline", async () => {
  const f = fixture();
  await f.certify();
  f.state.head = second;
  const failed = await f.plan();
  await publishPrAgentReview({ ...f.context(), scope: failed.scope, raw: '{"key_issues_to_review":[]}' });
  // A publication alone, without the dedicated successful Coverage Check, is not a baseline.
  f.state.head = third;
  const next = await f.plan();
  assert.equal(next.scope.fromSha, first);
  assert.equal(next.diff, patch(source[first], source[third]));
});

test("same-head edits do not invoke a model again and Issue changes invalidate the baseline", async () => {
  const f = fixture();
  await f.certify();
  assert.deepEqual(await f.plan(), { applicable: false, reason: "already-reviewed" });
  f.state.issue.body += " New acceptance criterion.";
  const next = await f.plan();
  assert.equal(next.scope.mode, "full");
  assert.equal(next.scope.fromSha, base);
});

test("an unrelated App, failed Coverage or modified Review cannot certify a baseline", async () => {
  for (const corrupt of [
    (f) => { f.state.checks[0].app.id = 15368; },
    (f) => { f.state.checks[0].conclusion = "failure"; },
    (f) => { f.state.reviews[0].body += "modified"; },
  ]) {
    const f = fixture();
    await f.certify();
    corrupt(f);
    f.state.head = second;
    assert.equal((await f.plan()).scope.mode, "full");
  }
});

test("a malformed successful-looking scope is ignored instead of blocking a full review", async () => {
  const f = fixture();
  await f.certify();
  f.state.checks[0].output.summary = "provider: pr-agent\nreason_code: complete\nreview_scope: {}\npublication_receipt: {}";
  f.state.head = second;
  const next = await f.plan();
  assert.equal(next.scope.mode, "full");
  assert.equal(next.scope.fromSha, base);
});

test("changed base, merge base or rewritten history resets to a complete PR review", async () => {
  for (const change of ["base", "merge-base", "history"]) {
    const f = fixture();
    await f.certify();
    f.state.head = second;
    const newBase = "e".repeat(40);
    const request = async (path, options) => {
      if (path.endsWith(`/compare/${newBase}...${second}`)) return options?.responseType === "text"
        ? patch("new base", source[second])
        : { status: "ahead", merge_base_commit: { sha: newBase }, files: [{ filename: "src/math.ts", status: "modified", additions: 1, deletions: 1 }] };
      const response = await f.context().request(path, options);
      if (change === "base" && path.endsWith("/pulls/42")) response.base.ref = "release";
      if (change === "merge-base" && path.endsWith(`/compare/${base}...${second}`) && !options?.responseType)
        response.merge_base_commit.sha = newBase;
      if (change === "history" && path.endsWith(`/compare/${first}...${second}`)) {
        response.status = "diverged";
        response.merge_base_commit.sha = base;
      }
      return response;
    };
    const { scope } = await prepareReviewScope({ ...f.context(), request }, f.primary());
    assert.equal(scope.mode, "full");
    assert.equal(scope.fromSha, change === "merge-base" ? newBase : base);
    assert.equal(scope.baseline, undefined);
  }
});

test("publisher rechecks the immutable diff and current Issue before accepting a scoped result", async () => {
  const f = fixture();
  const { scope } = await f.plan();
  await assert.rejects(verifyReviewScope(f.context(), { ...scope, diffSha256: "0".repeat(64) }), /input changed/);
  f.state.issue.body += " changed";
  await assert.rejects(verifyReviewScope(f.context(), scope), /contract changed/);
  assert.equal(f.state.reviews.length, 0);
});

test("no-change commits inherit only a certified baseline and publish an explicit no-model receipt", async () => {
  const f = fixture();
  await f.certify();
  const previous = source[third];
  try {
    source[third] = source[first];
    f.state.head = third;
    const { scope, diff } = await f.plan();
    assert.equal(scope.mode, "unchanged");
    assert.equal(diff, "");
    const receipt = await publishPrAgentReview({ ...f.context(), scope });
    assert.equal(receipt.findingCount, 0);
    assert.match(f.state.reviews.at(-1).body, /no model review was needed/);
  } finally { source[third] = previous; }
});

test("truncated, mismatched or binary raw diffs cannot be accepted as complete input", () => {
  const diff = patch("before", "after");
  assert.equal(validateDiffInput(diff, [{ filename: "src/math.ts", status: "modified", additions: 1, deletions: 1 }]).diffBytes, Buffer.byteLength(diff));
  assert.throws(() => validateDiffInput(diff, []), /does not match/);
  assert.equal(validateDiffInput(diff, [{ filename: "src/math.ts", status: "modified", additions: 0, deletions: 0 }]).diffBytes, Buffer.byteLength(diff));
  assert.throws(() => validateDiffInput(diff.slice(0, -12), [{ filename: "src/math.ts", status: "modified", additions: 1, deletions: 1 }]), /cannot be parsed/);
  const binary = "diff --git a/image.png b/image.png\nindex 1111111..2222222 100644\nBinary files a/image.png and b/image.png differ\n";
  assert.throws(() => validateDiffInput(binary, [{ filename: "image.png", status: "modified", additions: 0, deletions: 0 }]), /unsupported binary/);
});

test("API patch omission and unusable statistics do not override immutable hunk counts", () => {
  for (const statistics of [{ additions: 0, deletions: 0 }, { additions: 999, deletions: 999 }, {}]) {
    assert.equal(validateDiffInput(patch("before", "after"), [
      { filename: "src/math.ts", status: "modified", ...statistics },
    ]).diffBytes, Buffer.byteLength(patch("before", "after")));
  }
});

test("missing, duplicate, unknown and inconsistent identities or statuses fail closed", () => {
  const diff = patch("before", "after");
  const file = { filename: "src/math.ts", status: "modified" };
  for (const files of [[file, file], [{ ...file, filename: "wrong.ts" }], [{ ...file, status: "added" }],
    [{ ...file, status: "removed" }], [{ ...file, status: "renamed" }], [{ ...file, status: "copied" }],
    [{ ...file, previous_filename: "old.ts" }], [null], [{}]]) {
    assert.throws(() => validateDiffInput(diff, files));
  }
  assert.throws(() => validateDiffInput(diff + diff, [file, { filename: "other.ts", status: "modified" }]));
  assert.throws(() => validateDiffInput(diff.replace("--- a/src/math.ts", "--- a/other.ts"), [file]));
  assert.throws(() => validateDiffInput(diff.replace("@@ -1 +1 @@", "@@ -1,2 +1,2 @@"), [file]));
});

test("additions, deletions, mode-only changes and renames retain their API boundaries", () => {
  const added = "diff --git a/new.ts b/new.ts\nnew file mode 100644\nindex 0000000..2222222\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n";
  const removed = "diff --git a/old.ts b/old.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
  const mode = "diff --git a/script b/script\nold mode 100644\nnew mode 100755\n";
  const rename = "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
  for (const [diff, file] of [[added, { filename: "new.ts", status: "added" }],
    [removed, { filename: "old.ts", status: "removed" }],
    [mode, { filename: "script", status: "modified" }],
    [rename, { filename: "new.ts", previous_filename: "old.ts", status: "renamed" }],
    [rename.replace("100%", "50%") + "index 1111111..2222222 100644\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-old\n+new\n",
      { filename: "new.ts", previous_filename: "old.ts", status: "renamed" }]]) {
    assert.equal(validateDiffInput(diff, [file]).diffBytes, Buffer.byteLength(diff));
    assert.throws(() => validateDiffInput(diff, [{ ...file, status: "unknown" }]));
  }
  assert.throws(() => validateDiffInput(rename, [{ filename: "new.ts", previous_filename: "wrong.ts", status: "renamed" }]));
});

test("quoted paths, whitespace and non-ASCII paths use Git file identity", () => {
  for (const [filename, encoded] of [["space name.ts", "space name.ts"], ["中文.ts", '"\\344\\270\\255\\346\\226\\207.ts"'], ["tab\tname.ts", '"tab\\tname.ts"']]) {
    const prefixed = (prefix) => encoded.startsWith('"') ? `"${prefix}/${encoded.slice(1)}` : `${prefix}/${encoded}`;
    const diff = patch("before", "after").replaceAll("a/src/math.ts", prefixed("a")).replaceAll("b/src/math.ts", prefixed("b"));
    assert.equal(validateDiffInput(diff, [{ filename, status: "modified" }]).diffBytes, Buffer.byteLength(diff));
  }
});
