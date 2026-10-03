import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const script = path.resolve(".github/scripts/validate-claude-review-config.mjs");

function runConfigCheck(overrides = {}) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "configured-api-key",
      ANTHROPIC_BASE_URL: "https://configured.invalid",
      CLAUDE_REVIEW_EFFORT: "high",
      CLAUDE_REVIEW_MODEL: "configured-model",
      ...overrides,
    },
  });
}

test("accepts non-empty Claude Review repository settings", () => {
  const execution = runConfigCheck();
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, "");
});

test("fails closed without printing configured values", () => {
  const execution = runConfigCheck({ CLAUDE_REVIEW_MODEL: "" });
  assert.equal(execution.status, 1);
  assert.match(execution.stderr, /CLAUDE_REVIEW_MODEL must be configured/);
  assert.doesNotMatch(execution.stderr, /configured-api-key|configured\.invalid/);
});

test("rejects missing or unsupported Claude Review effort without printing its value", () => {
  const missing = runConfigCheck({ CLAUDE_REVIEW_EFFORT: "" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CLAUDE_REVIEW_EFFORT must be configured/);

  const unsupported = runConfigCheck({ CLAUDE_REVIEW_EFFORT: "configured-effort" });
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /CLAUDE_REVIEW_EFFORT must be one of/);
  assert.doesNotMatch(unsupported.stderr, /configured-effort/);

  const padded = runConfigCheck({ CLAUDE_REVIEW_EFFORT: "high " });
  assert.equal(padded.status, 1);
  assert.match(padded.stderr, /CLAUDE_REVIEW_EFFORT must be one of/);
});
