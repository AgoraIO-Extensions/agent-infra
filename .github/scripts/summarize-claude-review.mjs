import fs from "node:fs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : "unavailable";
}

function classifyError(status, errorFile) {
  if (status === "0" || status === "success") return "none";
  if (!errorFile) return "unavailable";

  let errorText;
  try {
    errorText = fs.readFileSync(errorFile, "utf8");
  } catch {
    return "unavailable";
  }
  if (/\b(?:401|403|authentication|unauthorized|api[ -]?key)\b/i.test(errorText)) {
    return "authentication";
  }
  if (/\b(?:429|rate[ -]?limit)\b/i.test(errorText)) return "rate_limit";
  if (
    /\b(?:network|connect(?:ion)?|timed? ?out|dns|socket|fetch failed|econn\w*)\b/i.test(
      errorText,
    )
  ) {
    return "network";
  }
  if (/\b(?:unknown|unrecognized|invalid) (?:argument|option|flag)\b/i.test(errorText)) {
    return "invalid_arguments";
  }
  return "other";
}

const format = requiredEnvironment("CLAUDE_METRICS_FORMAT");
if (!new Set(["action", "cli"]).has(format)) {
  throw new Error("CLAUDE_METRICS_FORMAT must be action or cli");
}
const label = format === "action" ? "Official Claude Action" : "Direct Claude CLI canary";
const resultFile = process.env.CLAUDE_METRICS_RESULT_FILE;
const startedMs = Number(requiredEnvironment("CLAUDE_METRICS_STARTED_MS"));
const status = requiredEnvironment("CLAUDE_METRICS_STATUS");
const expectedHead = requiredEnvironment("EXPECTED_HEAD_SHA");
const summaryFile = requiredEnvironment("GITHUB_STEP_SUMMARY");

let result = {};
try {
  const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  if (format === "action" && Array.isArray(parsed)) {
    result = parsed.filter((message) => message?.type === "result").at(-1) ?? {};
  } else if (format === "cli" && parsed && !Array.isArray(parsed)) {
    result = parsed;
  }
} catch {
  // Missing or malformed model output is represented only as unavailable metrics.
}

const structuredOutput = result.structured_output;
const structuredOutputValid =
  structuredOutput?.completed === true && structuredOutput?.head_sha === expectedHead;
const errorCategory = classifyError(status, process.env.CLAUDE_METRICS_ERROR_FILE);
const wallMs =
  Number.isFinite(startedMs) && startedMs > 0 ? Math.max(0, Date.now() - startedMs) : "unavailable";

fs.appendFileSync(
  summaryFile,
  [
    `## ${label}`,
    "",
    `- Execution status: ${status}`,
    `- Error category: ${errorCategory}`,
    `- Total time: ${wallMs === "unavailable" ? wallMs : `${wallMs} ms`}`,
    `- Model duration: ${safeMetric(result.duration_ms)}${typeof result.duration_ms === "number" ? " ms" : ""}`,
    `- Turns: ${safeMetric(result.num_turns)}`,
    `- Structured output valid: ${structuredOutputValid}`,
    "",
  ].join("\n"),
);

if (
  process.env.CLAUDE_METRICS_REQUIRE_VALID === "true" &&
  (status !== "0" || !structuredOutputValid)
) {
  process.exitCode = 1;
}
