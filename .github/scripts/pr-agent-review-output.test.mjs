import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { projectPrAgentReviewOutput } from "./pr-agent-review-output.mjs";

const finding = {
  relevant_file: "src/task.ts",
  issue_header: "Preserve the finding",
  issue_content: 'Line 1\r\nLine 2: "中文 😀" \\ %0A &',
  start_line: 1,
  end_line: 2,
  extra: "first value",
  EXTRA: "second value",
  metadata: { id: "lower", ID: "upper", values: [null, true, 3] },
};

test("projects only findings while preserving their full fields, strings and order", () => {
  const findings = [finding, { ...finding, issue_header: "Second finding" }];
  const raw = JSON.stringify({ key_issues_to_review: findings, unused: "synthetic-mask-1102" });
  const output = projectPrAgentReviewOutput(raw);
  assert.deepEqual(JSON.parse(output), { key_issues_to_review: findings });
  assert.ok(!output.includes("synthetic-mask-1102"));
  assert.ok(!output.includes("\r") && !output.includes("\n"));
});

test("keeps a mask value anywhere inside a finding for the runner to filter", () => {
  for (const replacement of [
    { issue_content: "synthetic-mask-1102" },
    { extra: "synthetic-mask-1102" },
    { metadata: { nested: "synthetic-mask-1102" } },
  ]) {
    const findings = [{ ...finding, ...replacement }];
    const output = projectPrAgentReviewOutput(JSON.stringify({ key_issues_to_review: findings }));
    assert.deepEqual(JSON.parse(output).key_issues_to_review, findings);
    assert.ok(output.includes("synthetic-mask-1102"));
  }
});

test("accepts only an explicit empty findings array as a zero-finding result", () => {
  assert.equal(projectPrAgentReviewOutput('{"key_issues_to_review":[],"unused":"note"}'), '{"key_issues_to_review":[]}');
  for (const raw of [undefined, "", "{", "null", "{}", '{"KEY_ISSUES_TO_REVIEW":[]}', '{"key_issues_to_review":null}', '{"key_issues_to_review":"[]"}', '{"key_issues_to_review":{}}']) {
    assert.throws(() => projectPrAgentReviewOutput(raw));
  }
});

test("retains the Publisher's input size and finding schema rejection", () => {
  for (const value of [
    { key_issues_to_review: [finding], unused: "x".repeat(64 * 1024) },
    { key_issues_to_review: [{}] },
    { key_issues_to_review: [{ ...finding, start_line: 0 }] },
    { key_issues_to_review: Array(11).fill(finding) },
  ]) assert.throws(() => projectPrAgentReviewOutput(JSON.stringify(value)));
});

test("rejects finding numbers changed by JSON serialization at any depth", () => {
  for (const number of ["1e400", "-1e400", "-0"]) {
    for (const value of [number, `{"nested":[${number}]}`]) {
      const raw = `{"key_issues_to_review":[${JSON.stringify(finding).slice(0, -1)},"numeric":${value}}]}`;
      assert.throws(() => projectPrAgentReviewOutput(raw), /cannot be preserved in JSON/);
    }
  }
  const findings = [{ ...finding, numeric: { nested: [0, -1.5, Number.MAX_VALUE, Number.MIN_VALUE] } }];
  assert.deepEqual(JSON.parse(projectPrAgentReviewOutput(JSON.stringify({ key_issues_to_review: findings }))).key_issues_to_review, findings);
});

test("CLI writes only valid findings and never explicitly logs the raw input", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pr-agent-review-output-"));
  const outputPath = path.join(directory, "output");
  const raw = JSON.stringify({ key_issues_to_review: [finding], unused: "synthetic-input-do-not-log" });
  const command = [path.resolve(".github/scripts/pr-agent-review-output.mjs")];
  const run = promisify(execFile);
  try {
    const result = await run(process.execPath, command, { env: { PR_AGENT_REVIEW: raw, GITHUB_OUTPUT: outputPath } });
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(await readFile(outputPath, "utf8"), `review=${projectPrAgentReviewOutput(raw)}\n`);
    await writeFile(outputPath, "unchanged\n");
    for (const invalid of ["synthetic-invalid-do-not-log", `{"key_issues_to_review":[${JSON.stringify(finding).slice(0, -1)},"numeric":1e400}]}`]) {
      await assert.rejects(run(process.execPath, command, { env: { PR_AGENT_REVIEW: invalid, GITHUB_OUTPUT: outputPath } }), (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.equal(error.stderr, "PR-Agent review findings output preparation failed\n");
        return true;
      });
      assert.equal(await readFile(outputPath, "utf8"), "unchanged\n");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
