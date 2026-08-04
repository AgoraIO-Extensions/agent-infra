#!/usr/bin/env bash

set -euo pipefail

: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY is required}"
: "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL is required}"
: "${CLAUDE_DIRECT_STARTED_MS:?CLAUDE_DIRECT_STARTED_MS is required}"
: "${CLAUDE_REVIEW_MAX_TURNS:?CLAUDE_REVIEW_MAX_TURNS is required}"
: "${CLAUDE_REVIEW_MODEL:?CLAUDE_REVIEW_MODEL is required}"
: "${CLAUDE_REVIEW_PROMPT:?CLAUDE_REVIEW_PROMPT is required}"
: "${CLAUDE_REVIEW_SCHEMA:?CLAUDE_REVIEW_SCHEMA is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"

result_file="$(mktemp)"
error_file="$(mktemp)"
trap 'rm -f "$result_file" "$error_file"' EXIT

set +e
claude --bare -p "$CLAUDE_REVIEW_PROMPT" \
  --output-format json \
  --model "$CLAUDE_REVIEW_MODEL" \
  --max-turns "$CLAUDE_REVIEW_MAX_TURNS" \
  --no-session-persistence \
  --add-dir pr-head \
  --allowedTools "Read,Grep,Glob,Bash(gh pr diff:*),Bash(gh pr view:*)" \
  --json-schema "$CLAUDE_REVIEW_SCHEMA" \
  >"$result_file" 2>"$error_file"
cli_status=$?
set -e

CLAUDE_METRICS_FORMAT=cli \
CLAUDE_METRICS_ERROR_FILE="$error_file" \
CLAUDE_METRICS_RESULT_FILE="$result_file" \
CLAUDE_METRICS_STARTED_MS="$CLAUDE_DIRECT_STARTED_MS" \
CLAUDE_METRICS_STATUS="$cli_status" \
CLAUDE_METRICS_REQUIRE_VALID=true \
  node .github/scripts/summarize-claude-review.mjs
