import { pathToFileURL } from "node:url";

import {
  githubRequest,
  requireEnv,
  safeMarkdown,
  validateRepository,
} from "./github-api.mjs";

export const ASSISTANT_MARKER = "<!-- agent-infra:claude-assistant -->";

const BOT_LOGIN = "github-actions[bot]";
const RESULT_FIELDS = ["completed", "entity_number", "head_sha", "response"];
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[0-9]+$/;

function boundedString(value, name, max) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > max
  ) {
    throw new Error(`${name} must be a non-empty string of at most ${max} bytes`);
  }
  return value;
}

function exactResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("structured output must be a JSON object");
  }
  for (const key of Object.keys(value)) {
    if (!RESULT_FIELDS.includes(key)) {
      throw new Error(`structured output contains unexpected field ${key}`);
    }
  }
  for (const field of RESULT_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw new Error(`structured output is missing field ${field}`);
    }
  }
}

export function parseAssistantResult(raw, { entityNumber, headSha }) {
  if (!Number.isSafeInteger(entityNumber) || entityNumber < 1) {
    throw new Error("expected entity number must be a positive integer");
  }
  if (headSha !== "" && !SHA_PATTERN.test(headSha)) {
    throw new Error("expected PR head must be empty or a lowercase 40-character SHA");
  }
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > 16_384
  ) {
    throw new Error("structured output must be a non-empty bounded string");
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("structured output must be valid JSON");
  }
  exactResult(parsed);
  if (parsed.completed !== true) {
    throw new Error("completed must be true");
  }
  if (parsed.entity_number !== entityNumber) {
    throw new Error("structured output does not match the current Issue or PR");
  }
  if (parsed.head_sha !== headSha) {
    throw new Error("structured output does not match the current PR head");
  }
  return {
    completed: true,
    entity_number: entityNumber,
    head_sha: headSha,
    response: boundedString(parsed.response, "response", 8_000),
  };
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a safe integer`);
  }
  return number;
}

function httpsUrl(value) {
  if (!/^https:\/\/[^\s]+$/.test(value ?? "")) {
    throw new Error("GITHUB_API_URL must use HTTPS");
  }
  return value.replace(/\/$/, "");
}

async function validateEntity({
  apiUrl,
  token,
  repository,
  entityType,
  entityNumber,
  headSha,
  fetchImpl,
}) {
  if (entityType === "pull_request") {
    const { data: pullRequest } = await githubRequest({
      apiUrl,
      token,
      path: `/repos/${repository}/pulls/${entityNumber}`,
      fetchImpl,
    });
    if (pullRequest?.number !== entityNumber || pullRequest?.state !== "open") {
      throw new Error("Assistant PR is no longer open");
    }
    if (pullRequest?.draft !== false) {
      throw new Error("Assistant PR became a Draft");
    }
    if (pullRequest?.head?.repo?.full_name !== repository) {
      throw new Error("Assistant PR is not from the base repository");
    }
    if (pullRequest?.head?.sha !== headSha) {
      throw new Error("Assistant PR head changed before publication");
    }
    return;
  }
  if (entityType !== "issue" || headSha !== "") {
    throw new Error("Assistant entity type and head are inconsistent");
  }
  const { data: issue } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/issues/${entityNumber}`,
    fetchImpl,
  });
  if (issue?.number !== entityNumber) {
    throw new Error("Assistant Issue identity changed before publication");
  }
  if (issue?.pull_request) {
    throw new Error("Assistant Issue unexpectedly resolved to a PR");
  }
}

export async function publishAssistant({ env = process.env, fetchImpl = fetch } = {}) {
  if (
    env.ELIGIBLE === "false" ||
    (env.ELIGIBLE === "" && env.ANALYSIS_RESULT === "skipped")
  ) {
    return { published: false, reason: "ineligible" };
  }
  if (env.ELIGIBLE !== "true") {
    throw new Error("ELIGIBLE must be true or false");
  }
  if (env.ANALYSIS_RESULT !== "success") {
    return { published: false, reason: "analysis-failure" };
  }

  const repository = validateRepository(requireEnv(env, "GITHUB_REPOSITORY"));
  const entityType = requireEnv(env, "ENTITY_TYPE");
  const entityNumber = positiveInteger(
    requireEnv(env, "ENTITY_NUMBER"),
    "ENTITY_NUMBER",
  );
  const headSha = env.EXPECTED_HEAD_SHA ?? "";
  if (entityType === "pull_request" && !SHA_PATTERN.test(headSha)) {
    throw new Error("EXPECTED_HEAD_SHA must identify the Assistant PR head");
  }
  const apiUrl = httpsUrl(requireEnv(env, "GITHUB_API_URL"));
  const token = requireEnv(env, "GITHUB_TOKEN");
  const runId = requireEnv(env, "GITHUB_RUN_ID");
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error("GITHUB_RUN_ID must be numeric");
  }
  const result = parseAssistantResult(requireEnv(env, "STRUCTURED_OUTPUT"), {
    entityNumber,
    headSha,
  });

  await validateEntity({
    apiUrl,
    token,
    repository,
    entityType,
    entityNumber,
    headSha,
    fetchImpl,
  });
  const body = `${ASSISTANT_MARKER}
## Claude Assistant

${safeMarkdown(result.response)}

Response run: \`${runId}\`
`;
  const { data: published } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/issues/${entityNumber}/comments`,
    method: "POST",
    body: { body },
    fetchImpl,
  });
  if (!Number.isSafeInteger(published?.id) || published.id < 1) {
    throw new Error("GitHub Assistant comment creation did not return a valid ID");
  }
  const { data: readBack } = await githubRequest({
    apiUrl,
    token,
    path: `/repos/${repository}/issues/comments/${published.id}`,
    fetchImpl,
  });
  if (
    readBack?.id !== published.id ||
    readBack?.body !== body ||
    readBack?.user?.login !== BOT_LOGIN ||
    readBack?.user?.type !== "Bot"
  ) {
    throw new Error("Claude Assistant response read-back did not match publication");
  }
  return { commentId: published.id, entityNumber, published: true };
}

async function main() {
  try {
    const result = await publishAssistant();
    if (result.published) {
      console.log(`Claude Assistant response verified for entity ${result.entityNumber}`);
    } else {
      console.log(`Claude Assistant publication skipped: ${result.reason}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Claude Assistant publication failed: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
