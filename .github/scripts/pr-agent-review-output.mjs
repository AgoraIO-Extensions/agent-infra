import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parsePrAgentReview } from "./pr-agent-review.mjs";

export function projectPrAgentReviewOutput(raw) {
  return JSON.stringify({ key_issues_to_review: parsePrAgentReview(raw) });
}

async function main() {
  const review = projectPrAgentReviewOutput(process.env.PR_AGENT_REVIEW);
  await appendFile(process.env.GITHUB_OUTPUT, `review=${review}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("PR-Agent review findings output preparation failed");
    process.exitCode = 1;
  });
}
