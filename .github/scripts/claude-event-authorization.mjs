import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const TRUSTED_ASSOCIATIONS = new Set(["MEMBER", "OWNER", "COLLABORATOR"]);

function isTrustedMention(value) {
  return (
    TRUSTED_ASSOCIATIONS.has(value?.author_association) &&
    value?.body?.includes("@claude") === true
  );
}

export function authorizeClaudeEvent(eventName, event) {
  if (eventName === "issues") {
    if (event.action === "opened") {
      return TRUSTED_ASSOCIATIONS.has(event.issue?.author_association);
    }
    return event.action === "labeled" && event.label?.name === "claude";
  }

  if (eventName === "issue_comment" || eventName === "pull_request_review_comment") {
    return isTrustedMention(event.comment);
  }
  if (eventName === "pull_request_review") {
    return isTrustedMention(event.review);
  }
  return false;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const event = JSON.parse(
    await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"),
  );
  const allowed = authorizeClaudeEvent(requiredEnvironment("GITHUB_EVENT_NAME"), event);
  await fs.appendFile(requiredEnvironment("GITHUB_OUTPUT"), `allowed=${allowed}\n`);
  console.log(allowed ? "Claude event authorized" : "Claude event not authorized");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
