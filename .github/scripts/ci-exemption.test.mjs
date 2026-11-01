import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import YAML from "yaml";
import { imageNames } from "../../deploy/release/image-manifest.mjs";

const exec = promisify(execFile);
const workflow = YAML.parse(await fs.readFile(".github/workflows/ci.yml", "utf8"));
const metadataEvent = "github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled') && github.event.label.name != '' && github.event.label.name != 'ci:skip'";
const guarded = (condition) => `\${{ !(${metadataEvent}) && ${condition} }}`;
const exemption = workflow.jobs["ci-exemption"];
const step = exemption.steps.find((value) => value.id === "label");

async function runScopeStep({
  changedPath = "docs/change.md",
  event = "pull_request",
  invalidHead = false,
  unrelated = false,
} = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ci-scope-"));
  const git = (...args) => exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd: directory });
  try {
    await git("init", "--quiet", "--initial-branch=main");
    await git("config", "user.name", "CI fixture");
    await git("config", "user.email", "ci-fixture@example.invalid");
    await git("config", "core.hooksPath", "/dev/null");
    await fs.mkdir(path.join(directory, "deploy/release"), { recursive: true });
    await fs.copyFile("deploy/release/image-manifest.mjs", path.join(directory, "deploy/release/image-manifest.mjs"));
    await git("add", ".");
    await git("commit", "--quiet", "-m", "common base");
    await git("branch", "pr");
    await fs.mkdir(path.join(directory, "apps/platform-worker"), { recursive: true });
    await fs.writeFile(path.join(directory, "apps/platform-worker/main-only.ts"), "export const mainOnly = true;\n");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "main advances independently");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    if (unrelated) await git("checkout", "--quiet", "--orphan", "unrelated");
    else await git("checkout", "--quiet", "pr");
    await fs.mkdir(path.dirname(path.join(directory, changedPath)), { recursive: true });
    await fs.writeFile(path.join(directory, changedPath), "PR change\n");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "PR change");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const output = path.join(directory, "output");
    const scope = workflow.jobs.changes.steps.find((value) => value.id === "scope");
    const { stdout } = await exec("bash", ["--noprofile", "--norc", "-c", scope.run], {
      cwd: directory,
      env: {
        ...process.env,
        EVENT_NAME: event,
        BASE_SHA: base,
        HEAD_SHA: invalidHead ? "0".repeat(40) : head,
        GITHUB_OUTPUT: output,
      },
    });
    return { stdout, output: await fs.readFile(output, "utf8") };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("PR documentation excludes source changes made only on main", async () => {
  const result = await runScopeStep();
  assert.equal(result.output, "source=false\nweb=false\nruntime=false\nworkload=false\nimages=\n");
});

test("PR Web changes retain their lanes and images without main-only Worker changes", async () => {
  const result = await runScopeStep({ changedPath: "apps/web/pr-change.ts" });
  assert.equal(result.output, "source=true\nweb=true\nruntime=false\nworkload=false\nimages=web,agent-runtime-host\n");
});

test("main pushes retain full validation regardless of PR path scope", async () => {
  const result = await runScopeStep({ event: "push" });
  assert.equal(result.output, `source=true\nweb=true\nruntime=true\nworkload=true\nimages=${imageNames.join(",")}\n`);
});

for (const [name, options] of [
  ["missing commit", { invalidHead: true }],
  ["unrelated histories", { unrelated: true }],
]) {
  test(`PR classification falls back to full validation for ${name}`, async () => {
    const result = await runScopeStep(options);
    assert.match(result.stdout, /Unable to classify changed paths; running full validation/);
    assert.equal(result.output, `source=true\nweb=true\nruntime=true\nworkload=true\nimages=${imageNames.join(",")}\n`);
  });
}

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
    group: `\${{ ${metadataEvent} && format('ci-metadata-{0}', github.run_id) || format('ci-{0}', github.event.pull_request.number || github.ref) }}`,
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  assert.deepEqual(exemption.permissions, { "pull-requests": "read" });
  assert.equal(exemption.outputs.skip, "${{ steps.label.outputs.skip }}");
  assert.equal(workflow.jobs.ci.name, `\${{ ${metadataEvent} && 'CI metadata event ignored' || 'CI' }}`);
  assert.deepEqual(workflow.jobs.ci.needs,
    ["ci-exemption", "changes", "web-tests", "backend-tests", "ci_heavy"]);
	assert.equal(workflow.jobs.ci.steps.find((value) => value.name === "Require CI lanes").if,
		"${{ needs.ci-exemption.result != 'success' || needs.changes.result != 'success' || needs.ci_heavy.result != 'success' || (needs.changes.outputs.source == 'true' && ((needs.changes.outputs.web == 'true' && needs.web-tests.result != 'success') || needs.backend-tests.result != 'success')) }}");
  assert.equal(workflow.jobs.ci.if,
    guarded("always() && !cancelled() && (needs.ci-exemption.result != 'success' || needs.ci-exemption.outputs.skip != 'true')"));
  assert.equal(workflow.jobs["ci_heavy"].name, "CI heavy validation");
  assert.deepEqual(workflow.jobs["ci_heavy"].needs, ["ci-exemption", "changes"]);
	assert.equal(workflow.jobs.changes.outputs.images, "${{ steps.scope.outputs.images }}");
	const classifier = workflow.jobs.changes.steps.find((value) => value.id === "scope").run;
	assert.match(classifier, /all_images=\$\(node --input-type=module -e/);
	assert.match(classifier, /add_image web agent-runtime-host/);
	assert.match(classifier, /add_image agent-runtime-host custom-agent-base platform-worker/);
	const imageBuild = workflow.jobs["ci_heavy"].steps.find((value) => value.id === "images");
	assert.equal(imageBuild.if, "${{ needs.changes.outputs.images != '' }}");
	assert.equal(imageBuild.env.IMAGE_NAMES, "${{ needs.changes.outputs.images }}");
	assert.match(imageBuild.run, /--images=/);
  assert.deepEqual(workflow.jobs["workload-kind"].needs, ["ci-exemption", "changes"]);
  assert.equal(workflow.jobs["workload-kind"].if,
    guarded("!cancelled() && (needs.ci-exemption.result != 'success' || needs.ci-exemption.outputs.skip != 'true') && (needs.changes.result != 'success' || github.event_name == 'push' || needs.changes.outputs.workload == 'true')"));
  assert.equal(workflow.jobs.changes.name, "Classify changes");
  assert.equal(workflow.jobs["web-tests"].name, "Web unit tests");
  assert.equal(workflow.jobs["backend-tests"].name, "Backend integration tests");
});

// Evaluate the boolean/format subset used by this workflow against synthetic event
// contexts. GitHub's hosted concurrency and check publication still need readback.
function routeEvent({ event = "pull_request", action = "opened", label, runId = 1, exemptionResult = "success", liveSkip = "false" } = {}) {
  const github = { event_name: event, event: { action, label: { name: label ?? "" }, pull_request: event === "pull_request" ? { number: 3845 } : {} }, ref: "refs/heads/main", run_id: runId };
  const needs = Object.fromEntries(Object.keys(workflow.jobs).map((name) => [name, {
    result: name === "ci-exemption" ? exemptionResult : "success",
    outputs: { skip: liveSkip, source: "true", web: "true", workload: "true" },
  }]));
  const evaluate = (expression) => runInNewContext(expression.replace(/\bneeds\.([a-z][a-z0-9-]*)/g, 'needs["$1"]'), {
    github, needs, always: () => true, cancelled: () => false,
    format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index]),
  });
  const render = (value) => value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => String(evaluate(expression.trim())));
  return {
    group: render(workflow.concurrency.group),
    jobs: Object.entries(workflow.jobs).map(([id, job]) => ({
      id, name: render(job.name), run: job.if === undefined || evaluate(job.if.slice(3, -2).trim()),
    })),
  };
}

test("ordinary label events cannot replace pending/running CI or publish the required CI check", () => {
  const validation = routeEvent();
  for (const action of ["labeled", "unlabeled"]) {
    for (const label of ["agent:codex", "ready-for-human", "priority:P1"]) {
      const ignored = routeEvent({ action, label, runId: 2 });
      assert.notEqual(ignored.group, validation.group);
      assert.notEqual(ignored.group, routeEvent({ action, label, runId: 3 }).group);
      assert(ignored.jobs.every((job) => !job.run), `${action} ${label} must not run jobs`);
      assert(ignored.jobs.every((job) => job.name !== "CI"), "skipped metadata jobs must not publish CI");
      assert.equal(ignored.jobs.find((job) => job.id === "ci").name, "CI metadata event ignored");
      for (const previous of [undefined, "failure", "pending", "in_progress"]) {
        const checks = new Map(previous ? [["CI", previous]] : []);
        for (const job of ignored.jobs) checks.set(job.name, "skipped");
        assert.equal(checks.get("CI"), previous, "metadata must not replace missing/failed or live CI");
      }
    }
  }
});

test("source events, waiver transitions and missing label metadata retain real CI routing", () => {
  for (const input of [
    { action: "opened" }, { action: "synchronize" }, { action: "reopened" },
    { action: "labeled", label: "ci:skip" }, { action: "unlabeled", label: "ci:skip" },
    { action: "labeled" }, { action: "unlabeled", label: "" },
    { action: "labeled", label: "ci:skip", exemptionResult: "failure" },
    { event: "push", action: "labeled", label: "agent:codex" },
  ]) {
    const route = routeEvent(input);
    assert.equal(route.group, input.event === "push" ? "ci-refs/heads/main" : "ci-3845");
    assert(route.jobs.find((job) => job.id === "ci-exemption").run);
    assert(route.jobs.find((job) => job.id === "ci_heavy").run);
    assert.deepEqual(route.jobs.find((job) => job.id === "ci"), { id: "ci", name: "CI", run: true });
  }
  const waived = routeEvent({ action: "labeled", label: "ci:skip", liveSkip: "true" });
  assert.equal(waived.group, "ci-3845");
  assert.deepEqual(waived.jobs.find((job) => job.id === "ci"), { id: "ci", name: "CI", run: false });
});
