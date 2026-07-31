import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateClaudeConfig } from "./validate-claude-config.mjs";

test("accepts a bounded HTTPS Base URL and model identifier", () => {
  assert.deepEqual(
    validateClaudeConfig({
      ANTHROPIC_BASE_URL: "https://gateway.example.test/anthropic",
      CLAUDE_REVIEW_MODEL: "claude-sonnet-4-5:review/v1",
    }),
    {
      baseUrl: "https://gateway.example.test/anthropic",
      model: "claude-sonnet-4-5:review/v1",
    },
  );
});

test("rejects missing, non-HTTPS, injected, and oversized configuration", () => {
  const cases = [
    [{}, /ANTHROPIC_BASE_URL is required/],
    [{ ANTHROPIC_BASE_URL: "https://gateway.test" }, /model identifier/],
    [
      { ANTHROPIC_BASE_URL: "http://gateway.test", CLAUDE_REVIEW_MODEL: "model" },
      /HTTPS URL/,
    ],
    [
      {
        ANTHROPIC_BASE_URL: "https://gateway.test\nSECOND=value",
        CLAUDE_REVIEW_MODEL: "model",
      },
      /HTTPS URL/,
    ],
    [
      { ANTHROPIC_BASE_URL: "https://gateway.test", CLAUDE_REVIEW_MODEL: "-flag" },
      /model identifier/,
    ],
    [
      {
        ANTHROPIC_BASE_URL: `https://${"x".repeat(500)}.test`,
        CLAUDE_REVIEW_MODEL: "model",
      },
      /at most 500 bytes/,
    ],
  ];
  for (const [env, pattern] of cases) {
    assert.throws(() => validateClaudeConfig(env), pattern);
  }
});

test("CLI reports only generic status and never echoes configuration", () => {
  const script = fileURLToPath(new URL("./validate-claude-config.mjs", import.meta.url));
  const valid = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ANTHROPIC_BASE_URL: "https://sensitive-gateway.example.test/anthropic",
      CLAUDE_REVIEW_MODEL: "sensitive-model-name",
    },
  });
  assert.equal(valid.status, 0);
  assert.equal(valid.stdout, "Claude configuration is valid\n");
  assert.equal(valid.stderr, "");

  const invalid = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ANTHROPIC_BASE_URL: "not-a-secret-url-value",
      CLAUDE_REVIEW_MODEL: "sensitive-model-name",
    },
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "Claude configuration is invalid\n");
});
