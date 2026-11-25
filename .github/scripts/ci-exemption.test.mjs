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
const waiverWorkflow = YAML.parse(await fs.readFile(".github/workflows/ci-waiver.yml", "utf8"));
const notWaived = "needs.ci-exemption.result != 'success' || needs.ci-exemption.outputs.skip != 'true'";
const selector = YAML.parse(await fs.readFile(".github/workflows/ci-runner.yml", "utf8"));
const exemption = selector.jobs.select;
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

test("CI runs only for source events and keeps one validation group per PR (#3935)", () => {
  // Label events never start a CI run, so a newer run without the required
  // check can no longer hide a passing one; ci-waiver.yml handles ci:skip.
  assert.deepEqual(workflow.on.pull_request.types, ["opened", "synchronize", "reopened"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.concurrency, {
    group: "ci-${{ github.event.pull_request.number || github.ref }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  });
  assert.equal(exemption.if, undefined);
  assert.deepEqual(exemption.permissions, { "pull-requests": "read" });
  assert.equal(exemption.outputs.skip, "${{ steps.label.outputs.skip }}");
  assert.equal(workflow.jobs.ci.name, "CI");
  assert.deepEqual(workflow.jobs.ci.needs,
    ["ci-exemption", "changes", "web-tests", "backend-tests", "backend-package-tests", "backend-contracts-tests", "ci_heavy"]);
  assert.equal(workflow.jobs.ci.steps.find((value) => value.name === "Require CI lanes").if,
    `\${{ (${notWaived}) && (needs.ci-exemption.result != 'success' || needs.changes.result != 'success' || needs.ci_heavy.result != 'success' || (needs.changes.outputs.source == 'true' && ((needs.changes.outputs.web == 'true' && needs.web-tests.result != 'success') || needs.backend-tests.result != 'success' || needs.backend-package-tests.result != 'success' || needs.backend-contracts-tests.result != 'success'))) }}`);
  assert.equal(workflow.jobs.ci.if, "${{ always() && !cancelled() }}");
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
    `\${{ !cancelled() && (${notWaived}) && (needs.changes.result != 'success' || github.event_name == 'push' || needs.changes.outputs.workload == 'true') }}`);
  assert.equal(workflow.jobs.changes.name, "Classify changes");
  assert.equal(workflow.jobs["web-tests"].name, "Web validation");
  assert.equal(workflow.jobs["backend-tests"].name, "Backend integration tests");
});

// Evaluate the boolean/format subset used by these workflows against synthetic
// event contexts. GitHub's hosted run selection still needs readback.
function evaluator(github, needs = {}) {
  const evaluate = (expression) => runInNewContext(expression.replace(/\bneeds\.([a-z][a-z0-9_-]*)/g, 'needs["$1"]'), {
    github, needs, always: () => true, cancelled: () => false,
    format: (template, ...values) => template.replace(/\{(\d+)\}/g, (_, index) => values[index]),
  });
  const render = (value) => value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) => String(evaluate(expression.trim())));
  const condition = (value) => value === undefined || evaluate(value.replace(/^\$\{\{|\}\}$/g, "").trim());
  return { evaluate, render, condition };
}

function routeEvent({ event = "pull_request", action = "opened", exemptionResult = "success", liveSkip = "false" } = {}) {
  const github = { event_name: event, event: { action, pull_request: event === "pull_request" ? { number: 3845 } : {} }, ref: "refs/heads/main" };
  const needs = Object.fromEntries(Object.keys(workflow.jobs).map((name) => [name, {
    result: name === "ci-exemption" ? exemptionResult : "success",
    outputs: { skip: liveSkip, source: "true", web: "true", workload: "true" },
  }]));
  const { render, condition } = evaluator(github, needs);
  return {
    group: render(workflow.concurrency.group),
    jobs: Object.entries(workflow.jobs).map(([id, job]) => {
      const run = condition(job.if);
      return { id, name: job.name, run, ...(id === "ci" ? {
        steps: Object.fromEntries(job.steps.map((step) => [step.name, run && condition(step.if)])),
      } : {}) };
    }),
  };
}

test("label events never start CI; only ci:skip on a same-repository PR reaches the waiver rerun (#3935)", () => {
  for (const action of ["labeled", "unlabeled", "edited", "ready_for_review"])
    assert(!workflow.on.pull_request.types.includes(action), `${action} must not start a CI run`);
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push"]);
  assert.deepEqual(waiverWorkflow.on, { pull_request_target: { types: ["labeled", "unlabeled"] } });
  const job = waiverWorkflow.jobs.rerun;
  for (const [label, repository, expected] of [
    ["ci:skip", "fixture/repository", true],
    ["ci:self-hosted", "fixture/repository", true],
    ["ci:self-hosted", "outside/fork", false],
    ["agent:codex", "fixture/repository", false],
    ["ready-for-human", "fixture/repository", false],
    ["", "fixture/repository", false],
    ["ci:skip", "outside/fork", false],
  ]) {
    const github = {
      repository: "fixture/repository",
      event: { label: { name: label }, pull_request: { head: { repo: { full_name: repository } } } },
    };
    assert.equal(evaluator(github).evaluate(job.if), expected, `${label} from ${repository}`);
  }
  // The waiver never checks out or runs PR code and holds no other write scope.
  assert.deepEqual(job.permissions, { actions: "write", contents: "read" });
  assert.equal(job.steps[0].with.ref, "${{ github.event.repository.default_branch }}");
  assert.equal(job.steps[0].with["persist-credentials"], false);
});

test("source events and the live waiver keep the real CI routing", () => {
  for (const input of [
    { action: "opened" }, { action: "synchronize" }, { action: "reopened" },
    { action: "opened", exemptionResult: "failure" },
    { event: "push", action: "push" },
  ]) {
    const route = routeEvent(input);
    assert.equal(route.group, input.event === "push" ? "ci-refs/heads/main" : "ci-3845");
    assert(route.jobs.find((job) => job.id === "ci-exemption").run);
    assert(route.jobs.find((job) => job.id === "ci_heavy").run);
    const aggregate = route.jobs.find((job) => job.id === "ci");
    assert.equal(aggregate.name, "CI");
    assert.equal(aggregate.run, true);
    assert.equal(aggregate.steps["Report CI waiver"], false);
    assert.equal(aggregate.steps["Require CI lanes"], input.exemptionResult === "failure");
  }
  const waived = routeEvent({ action: "synchronize", liveSkip: "true" });
  assert.equal(waived.group, "ci-3845");
  assert.deepEqual(waived.jobs.find((job) => job.id === "ci"), {
    id: "ci", name: "CI", run: true, steps: {
      "Require CI lanes": false, "Report completed CI lanes": false, "Report CI waiver": true,
    },
  });
  assert(waived.jobs.filter((job) => ["web-tests", "backend-tests", "ci_heavy", "workload-kind"].includes(job.id)).every((job) => !job.run));
  const lookupFailed = routeEvent({ action: "synchronize", liveSkip: "true", exemptionResult: "failure" }).jobs.find((job) => job.id === "ci");
  assert.equal(lookupFailed.name, "CI");
  assert.equal(lookupFailed.steps["Require CI lanes"], true);
  assert.equal(lookupFailed.steps["Report CI waiver"], false);
});

test("runner selection uses live same-repository labels and independent main policy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-route-"));
  const route = exemption.steps.find((value) => value.id === "route");
  try {
    await fs.writeFile(path.join(dir, "gh"), '#!/bin/sh\nprintf "%s" "$LIVE"\n', { mode: 0o755 });
    const pr = { head: { sha: "abc", repo: { full_name: "o/r" } }, labels: [{ name: "ci:self-hosted" }] };
    for (const [event, repo, sha, live, main, self] of [
      ["pull_request", "o/r", "abc", pr, "", true],
      ["pull_request", "o/r", "abc", { ...pr, labels: [] }, "self-hosted", false],
      ["pull_request", "fork/r", "abc", pr, "", false],
      ["pull_request", "o/r", "old", pr, "", false],
      ["pull_request", "o/r", "abc", null, "", false],
      ["push", "", "", null, "self-hosted", true],
      ["push", "", "", null, "github-hosted", false],
    ]) {
      const output = path.join(dir, "output");
      await fs.writeFile(output, "");
      await exec("bash", ["-c", route.run], { env: {
        ...process.env, PATH: dir + ":" + process.env.PATH, LIVE: JSON.stringify(live),
        GITHUB_OUTPUT: output, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main",
        HEAD_REPO: repo, HEAD_SHA: sha, PR_NUMBER: "1", GITHUB_REPOSITORY: "o/r", MAIN_MODE: main,
      } });
      assert.equal(await fs.readFile(output, "utf8"), self
        ? "linux=ack-eci\n" : "linux=ubuntu-24.04\n");
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Docker and kind run on hosted Ubuntu in both routing modes", () => {
  for (const id of ["ci_heavy", "workload-kind", "backend-tests", "backend-package-tests"]) {
    assert.equal(workflow.jobs[id]["runs-on"], "ubuntu-24.04");
  }
});

test("ECI web jobs consume the locked browser from their run before launching Playwright", () => {
  const prepare = workflow.jobs["prepare-web-browser"];
  const web = workflow.jobs["web-tests"];
  assert.equal(prepare["runs-on"], "ubuntu-24.04");
  assert(web.needs.includes("prepare-web-browser"));
  const download = web.steps.find(s => s.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with["artifact-ids"], "${{ needs.prepare-web-browser.outputs.artifact }}");
  assert.equal(download.if, "runner.environment == 'self-hosted'");
  assert(web.steps.findIndex(s => s === download) < web.steps.findIndex(s => s.name === "Validate Web management journeys"));
});

test("ECI Web validation restores the event commit offline into a reused workspace", async (t) => {
  const prepare = workflow.jobs["prepare-web-browser"];
  const web = workflow.jobs["web-tests"];
  const checkout = web.steps.find(s => s.uses?.startsWith("actions/checkout@"));
  const pack = prepare.steps.find(s => s.name === "Pack the Web source commit");
  const restore = web.steps.find(s => s.name === "Restore the Web source commit");
  const download = web.steps.find(s => s.id === "inputs");
  assert.equal(checkout.if, "runner.environment != 'self-hosted'");
  assert.equal(prepare.steps.find(s => s.uses?.startsWith("actions/checkout@")).with.ref, checkout.with.ref);
  assert(download.uses.startsWith("actions/download-artifact@"));
  assert.equal(restore.if, "runner.environment == 'self-hosted'");
  assert.equal(restore.env.SOURCE_SHA, checkout.with.ref);
  assert.equal(restore.env.INPUT_DIR, "${{ steps.inputs.outputs.download-path }}");
  assert(web.steps.indexOf(download) < web.steps.indexOf(restore));
  assert(web.steps.indexOf(restore) < web.steps.findIndex(s => s.name === "Set up pnpm"));
  assert(prepare.steps.find(s => s.id === "upload").with.path.includes("source.pack"));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eci-web-source-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const producer = path.join(dir, "producer");
  const consumer = path.join(dir, "consumer");
  const inputs = path.join(dir, "inputs");
  for (const folder of [producer, consumer, inputs]) await fs.mkdir(folder);
  const env = {
    ...process.env,
    GIT_ALLOW_PROTOCOL: "",
    RUNNER_TEMP: inputs,
    INPUT_DIR: inputs,
    GITHUB_WORKSPACE: consumer,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "owner/repo",
  };
  const git = async (cwd, ...args) =>
    (await exec("git", ["-c", "commit.gpgsign=false", ...args], { cwd, env })).stdout.trim();
  await git(producer, "init", "--quiet");
  await git(producer, "config", "user.name", "CI fixture");
  await git(producer, "config", "user.email", "ci@example.invalid");
  await fs.writeFile(path.join(producer, ".tracked"), "first\n");
  await git(producer, "add", ".");
  await git(producer, "commit", "-qm", "parent");
  const parent = await git(producer, "rev-parse", "HEAD");
  await fs.writeFile(path.join(producer, "executable"), "#!/bin/sh\n", { mode: 0o755 });
  await fs.symlink(".tracked", path.join(producer, "link"));
  await git(producer, "add", ".");
  await git(producer, "commit", "-qm", "head");
  const head = await git(producer, "rev-parse", "HEAD");
  const tree = await git(producer, "rev-parse", "HEAD^{tree}");
  await fs.writeFile(path.join(producer, "untracked"), "outside the commit");
  await exec("bash", ["-eo", "pipefail", "-c", pack.run], { cwd: producer, env });
  const checkoutOffline = sha => exec("bash", ["-eo", "pipefail", "-c", restore.run], {
    cwd: consumer, env: { ...env, SOURCE_SHA: sha },
  });
  await checkoutOffline(head);
  await fs.writeFile(path.join(consumer, "old-report"), "previous run");
  await git(consumer, "config", "previous.job", "stale");
  await checkoutOffline(head);
  assert.equal(await git(consumer, "rev-parse", "HEAD"), head);
  assert.equal(await git(consumer, "rev-parse", "HEAD^{tree}"), tree);
  assert.equal(await git(consumer, "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(await git(consumer, "status", "--porcelain"), "");
  assert.equal(await fs.readlink(path.join(consumer, "link")), ".tracked");
  assert((await fs.stat(path.join(consumer, "executable"))).mode & 0o100);
  await assert.rejects(git(consumer, "config", "--get", "previous.job"));
  await assert.rejects(checkoutOffline(parent));
  await fs.truncate(path.join(inputs, "source.pack"), 16);
  await assert.rejects(checkoutOffline(head));
});
