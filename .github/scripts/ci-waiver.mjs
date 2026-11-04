import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

// GitHub evaluates required checks from the newest CI run of a head, so label
// events must not start CI runs (#3935). A ci:skip change instead cancels the
// current head's active CI run and reruns its latest one; the rerun's
// `Check CI exemption` job reads the live label to waive or validate.
export const WAIVER_LABEL = "ci:skip";
const CI_WORKFLOW = "ci.yml";

export function waiverDecision({ event, pullRequest, repository }) {
  if (!["labeled", "unlabeled"].includes(event?.action)) {
    return { act: false, reason: "unsupported action" };
  }
  if (event.label?.name !== WAIVER_LABEL) {
    return { act: false, reason: "not the CI waiver label" };
  }
  if (pullRequest?.state !== "open") {
    return { act: false, reason: "pull request is not open" };
  }
  if (pullRequest.head?.repo?.full_name !== repository) {
    return { act: false, reason: "pull request head is outside this repository" };
  }
  if (!/^[0-9a-f]{40}$/.test(pullRequest.head?.sha ?? "")) {
    return { act: false, reason: "pull request head SHA is unavailable" };
  }
  return { act: true, headSha: pullRequest.head.sha, number: pullRequest.number };
}

/** Newest pull_request CI run of the head, preferring runs linked to this PR. */
export function latestCiRun(runs, { headSha, number }) {
  const candidates = (runs ?? []).filter(
    (run) => run?.head_sha === headSha && run.event === "pull_request",
  );
  const linked = candidates.filter((run) =>
    run.pull_requests?.some((pullRequest) => pullRequest.number === number),
  );
  return (linked.length ? linked : candidates).reduce(
    (latest, run) => (!latest || run.id > latest.id ? run : latest),
    null,
  );
}

export async function rerunCiForWaiver({
  repository,
  headSha,
  number,
  request,
  sleep,
  pollIntervalMs = 5_000,
  maxPolls = 36,
}) {
  const listing = await request(
    `/repos/${repository}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${headSha}&event=pull_request&per_page=50`,
  );
  const run = latestCiRun(listing?.workflow_runs, { headSha, number });
  // No run yet: the head's first CI run reads the live label itself.
  if (!run) return { result: "no-ci-run" };
  let cancelled = false;
  if (run.status !== "completed") {
    try {
      await request(`/repos/${repository}/actions/runs/${run.id}/cancel`, {
        method: "POST",
      });
      cancelled = true;
    } catch (error) {
      // 409: the run completed between listing and cancel.
      if (error?.status !== 409) throw error;
    }
    let completed = false;
    for (let poll = 0; poll < maxPolls && !completed; poll += 1) {
      await sleep(pollIntervalMs);
      const current = await request(`/repos/${repository}/actions/runs/${run.id}`);
      completed = current?.status === "completed";
    }
    if (!completed) throw new Error(`CI run ${run.id} did not stop before the rerun`);
  }
  await request(`/repos/${repository}/actions/runs/${run.id}/rerun`, {
    method: "POST",
  });
  return { result: cancelled ? "cancelled-and-rerun" : "rerun", runId: run.id };
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(
      `GitHub API ${options.method ?? "GET"} ${path.split("?")[0]}: ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const event = JSON.parse(
    await fs.readFile(requiredEnvironment("GITHUB_EVENT_PATH"), "utf8"),
  );
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const number = event.pull_request?.number;
  if (!number) throw new Error("Pull request event is required");
  // The live PR, not the event payload, decides the head that needs CI.
  const pullRequest = await githubRequest(`/repos/${repository}/pulls/${number}`);
  const decision = waiverDecision({ event, pullRequest, repository });
  if (!decision.act) {
    console.log(`CI waiver: no action (${decision.reason})`);
    return;
  }
  const outcome = await rerunCiForWaiver({
    repository,
    headSha: decision.headSha,
    number: decision.number,
    request: githubRequest,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  });
  console.log(
    `CI waiver: ${outcome.result}${outcome.runId ? ` (run ${outcome.runId})` : ""} for PR #${number}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
