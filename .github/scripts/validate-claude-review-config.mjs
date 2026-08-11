const required = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_REVIEW_EFFORT",
  "CLAUDE_REVIEW_MODEL",
];
const allowedEfforts = new Set(["low", "medium", "high", "xhigh", "max"]);

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} must be configured as a non-empty repository setting`);
  }
}

const effort = process.env.CLAUDE_REVIEW_EFFORT;
if (effort !== effort.trim() || !allowedEfforts.has(effort)) {
  throw new Error(
    "CLAUDE_REVIEW_EFFORT must be one of low, medium, high, xhigh, or max",
  );
}
