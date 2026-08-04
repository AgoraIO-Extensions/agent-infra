import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.resolve(".github/scripts/summarize-claude-review.mjs");
const head = "a".repeat(40);

async function runSummary({ format, result, status, requireValid = false }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-review-metrics-"));
  const resultFile = path.join(directory, "result.json");
  const summaryFile = path.join(directory, "summary.md");
  await fs.writeFile(resultFile, JSON.stringify(result));

  const execution = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_METRICS_FORMAT: format,
      CLAUDE_METRICS_RESULT_FILE: resultFile,
      CLAUDE_METRICS_REQUIRE_VALID: String(requireValid),
      CLAUDE_METRICS_STARTED_MS: String(Date.now() - 500),
      CLAUDE_METRICS_STATUS: status,
      EXPECTED_HEAD_SHA: head,
      GITHUB_STEP_SUMMARY: summaryFile,
    },
  });
  const summary = await fs.readFile(summaryFile, "utf8");
  await fs.rm(directory, { recursive: true, force: true });
  return { execution, summary };
}

test("summarizes direct CLI metrics without exposing model text", async () => {
  const { execution, summary } = await runSummary({
    format: "cli",
    status: "0",
    requireValid: true,
    result: {
      duration_ms: 321,
      num_turns: 4,
      result: "sensitive model text",
      structured_output: { completed: true, head_sha: head },
    },
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(summary, /Direct Claude CLI canary/);
  assert.match(summary, /Model duration: 321 ms/);
  assert.match(summary, /Turns: 4/);
  assert.match(summary, /Structured output valid: true/);
  assert.doesNotMatch(summary, /sensitive model text/);
});

test("reads the Action result message with the same metric fields", async () => {
  const { execution, summary } = await runSummary({
    format: "action",
    status: "success",
    result: [
      { type: "assistant", message: "sensitive model text" },
      {
        type: "result",
        duration_ms: 654,
        num_turns: 7,
        structured_output: { completed: true, head_sha: head },
      },
    ],
  });

  assert.equal(execution.status, 0, execution.stderr);
  assert.match(summary, /Official Claude Action/);
  assert.match(summary, /Model duration: 654 ms/);
  assert.match(summary, /Turns: 7/);
  assert.match(summary, /Structured output valid: true/);
  assert.doesNotMatch(summary, /sensitive model text/);
});

test("fails a required direct CLI metric check for invalid structured output", async () => {
  const { execution, summary } = await runSummary({
    format: "cli",
    status: "0",
    requireValid: true,
    result: { duration_ms: 12, num_turns: 1, structured_output: {} },
  });

  assert.equal(execution.status, 1);
  assert.match(summary, /Structured output valid: false/);
});
