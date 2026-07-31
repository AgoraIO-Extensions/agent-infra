import { pathToFileURL } from "node:url";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function validateClaudeConfig(env) {
  const baseUrl = env?.ANTHROPIC_BASE_URL;
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("ANTHROPIC_BASE_URL is required");
  }
  if (Buffer.byteLength(baseUrl, "utf8") > 500) {
    throw new Error("ANTHROPIC_BASE_URL must be at most 500 bytes");
  }
  if (/\s/.test(baseUrl) || !baseUrl.startsWith("https://")) {
    throw new Error("ANTHROPIC_BASE_URL must be an HTTPS URL");
  }
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
      throw new Error("invalid URL");
    }
  } catch {
    throw new Error("ANTHROPIC_BASE_URL must be an HTTPS URL");
  }

  const model = env?.CLAUDE_REVIEW_MODEL;
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    throw new Error("CLAUDE_REVIEW_MODEL must be a valid model identifier");
  }
  return { baseUrl, model };
}

function main() {
  try {
    validateClaudeConfig(process.env);
    console.log("Claude configuration is valid");
  } catch {
    console.error("Claude configuration is invalid");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
