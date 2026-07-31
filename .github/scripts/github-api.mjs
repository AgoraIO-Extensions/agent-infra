import { appendFile } from "node:fs/promises";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateRepository(repository) {
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) {
    throw new Error("repository must contain a valid owner and repository name");
  }
  return repository;
}

export function validateApiUrl(apiUrl) {
  if (typeof apiUrl !== "string" || !/^https:\/\/[^\s]+$/.test(apiUrl)) {
    throw new Error("GitHub API URL must use HTTPS");
  }
  return apiUrl.replace(/\/$/, "");
}

export function requireEnv(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function isBot(actor) {
  return (
    actor?.type === "Bot" ||
    (typeof actor?.login === "string" && actor.login.endsWith("[bot]"))
  );
}

export function hasWritePermission(permission) {
  return new Set(["write", "maintain", "admin"]).has(permission);
}

export function safeMarkdown(value) {
  if (typeof value !== "string") {
    throw new Error("Markdown value must be a string");
  }
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/\\/g, "&#92;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "&#64;")
    .replace(/!/g, "&#33;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/`/g, "&#96;");
}

export async function githubRequest({
  apiUrl,
  token,
  path,
  method = "GET",
  body,
  fetchImpl = fetch,
}) {
  const baseUrl = validateApiUrl(apiUrl);
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("a GitHub token is required");
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new Error("GitHub API path must be repository-relative");
  }

  const response = await fetchImpl(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "agent-infra-claude-workflows",
      "x-github-api-version": "2022-11-28",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${path} returned ${response.status}`);
  }
  if (response.status === 204) {
    return { data: null, headers: response.headers };
  }

  try {
    return { data: await response.json(), headers: response.headers };
  } catch {
    throw new Error(`GitHub API ${method} ${path} returned invalid JSON`);
  }
}

export async function paginate({
  apiUrl,
  token,
  path,
  maxItems,
  fetchImpl = fetch,
}) {
  if (!Number.isInteger(maxItems) || maxItems < 1) {
    throw new Error("maxItems must be a positive integer");
  }

  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await githubRequest({
      apiUrl,
      token,
      path: `${path}${separator}per_page=100&page=${page}`,
      fetchImpl,
    });
    if (!Array.isArray(data)) {
      throw new Error(`GitHub API ${path} did not return an array`);
    }
    items.push(...data);
    if (items.length > maxItems) {
      throw new Error(`GitHub API ${path} exceeded the ${maxItems} item limit`);
    }
    if (data.length < 100) {
      return items;
    }
  }
}

export async function writeOutputs(outputPath, values) {
  const lines = [];
  for (const [name, value] of Object.entries(values)) {
    const text = String(value ?? "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /[\r\n]/.test(text)) {
      throw new Error("GitHub output names and values must be single-line values");
    }
    lines.push(`${name}=${text}`);
  }
  await appendFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

export async function setOutput(outputPath, name, value) {
  await writeOutputs(outputPath, { [name]: value });
}
