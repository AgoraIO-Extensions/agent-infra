import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import YAML from "yaml";

const exec = promisify(execFile);
const workflow = YAML.parse(await fs.readFile(".github/workflows/ci.yml", "utf8"));
const exemption = workflow.jobs["ci-exemption"];
const step = exemption.steps.find((value) => value.id === "label");

async function runLabelStep({ event = "pull_request", liveSkip = false, apiFails = false }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ci-exemption-"));
  try {
    const output = path.join(directory, "output");
    const summary = path.join(directory, "summary");
    const call = path.join(directory, "call");
    const eventPath = path.join(directory, "event.json");
    await Promise.all([
      fs.writeFile(output, ""),
      fs.writeFile(summary, ""),
      fs.writeFile(call, ""),
      // Deliberately stale payload: only the live API result may grant a waiver.
      fs.writeFile(eventPath, JSON.stringify({
        pull_request: { labels: liveSkip ? [] : [{ name: "ci:skip" }] },
      })),
      fs.writeFile(path.join(directory, "gh"), `#!/bin/sh
printf '%s\\n' "$*" > "$CI_SKIP_API_CALL"
if [ "$CI_SKIP_API_FAIL" = true ]; then exit 1; fi
printf '%s\\n' "$CI_SKIP_LIVE_SKIP"
`, { mode: 0o755 }),
    ]);
    let failed = false;
    try {
      await exec("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run], {
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env.PATH}`,
          GH_TOKEN: "fixture",
          GITHUB_EVENT_NAME: event,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "fixture/repository",
          PR_NUMBER: "123",
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          CI_SKIP_API_CALL: call,
          CI_SKIP_API_FAIL: String(apiFails),
          CI_SKIP_LIVE_SKIP: String(liveSkip),
        },
      });
    } catch {
      failed = true;
    }
    return {
      failed,
      output: await fs.readFile(output, "utf8"),
      summary: await fs.readFile(summary, "utf8"),
      call: await fs.readFile(call, "utf8"),
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("CI waiver reads the current exact label and reports tests were not run", async () => {
  const result = await runLabelStep({ liveSkip: true });
  assert.equal(result.failed, false);
  assert.equal(result.output, "skip=true\n");
  assert.match(result.summary, /waived.*ci:skip.*tests did not run/);
  assert.equal(result.call,
    'api repos/fixture/repository/pulls/123 --jq any(.labels[]; .name == "ci:skip")\n');
});

test("removing the label restores CI even when rerunning a labeled event", async () => {
  const result = await runLabelStep({ liveSkip: false });
  assert.equal(result.failed, false);
  assert.equal(result.output, "skip=false\n");
  assert.match(result.summary, /normal checks apply/);
});

test("main push cannot inherit a PR exemption or depend on the labels API", async () => {
  const result = await runLabelStep({ event: "push", liveSkip: true, apiFails: true });
  assert.equal(result.failed, false);
  assert.equal(result.output, "skip=false\n");
  assert.equal(result.call, "");
});

test("a labels API failure falls back to normal checks without failing the workflow", async () => {
  const result = await runLabelStep({ liveSkip: true, apiFails: true });
  assert.equal(result.failed, false);
  assert.equal(result.output, "skip=false\n");
  assert.match(result.summary, /normal checks apply/);
});

test("CI label transitions cancel older PR runs and retain checks on lookup failure", () => {
  assert.deepEqual(workflow.on.pull_request.types,
    ["opened", "synchronize", "reopened", "labeled", "unlabeled"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.concurrency, {
    group: "ci-${{ github.event.pull_request.number || github.run_id }}-${{ github.event.pull_request.head.sha || github.sha }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  assert.deepEqual(exemption.permissions, { "pull-requests": "read" });
  assert.equal(exemption.outputs.skip, "${{ steps.label.outputs.skip }}");
  assert.equal(workflow.jobs.ci.name, "CI");
  for (const name of ["ci", "workload-kind"]) {
    assert.equal(workflow.jobs[name].needs, "ci-exemption");
    assert.equal(workflow.jobs[name].if,
      "${{ !cancelled() && (needs.ci-exemption.result != 'success' || needs.ci-exemption.outputs.skip != 'true') }}");
  }
});
