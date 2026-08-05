const required = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_REVIEW_MODEL"];

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} must be configured as a non-empty Actions Secret`);
  }
}
