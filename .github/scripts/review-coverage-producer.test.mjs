import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { before, test } from "node:test";
import { ANALYSIS_IMAGE, produceAnalysis } from "./review-coverage-producer.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const hash = (text) => createHash("sha256").update(text).digest("hex");
before(() => {
  // Standalone workflow tests run before Turbo's build/test tasks on a fresh CI checkout.
  execFileSync("pnpm", ["--filter", "@agent-infra/review-coverage", "build"], { cwd: root, stdio: "pipe" });
});

// A real child process stands in for Docker in this controlled integration test.
// It exercises the executable/HTTP/native-output boundary, not an actual image run.
const childSource = `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n');
if (!args.includes(process.env.FIXTURE_IMAGE) || !args.includes('host')) process.exit(2);
if (args.includes(process.env.OPENAI__KEY)) process.exit(3);
if (process.env['litellm.custom_llm_provider'] !== 'openai' ||
    process.env['litellm.force_streaming_custom_llm_provider'] !== 'openai' ||
    !JSON.parse(process.env['litellm.force_streaming_api_base_substrings']).includes(process.env.OPENAI__API_BASE)) process.exit(5);
const mount = args.find(value => value.startsWith('type=bind,src=') && value.endsWith('dst=/github/analysis-output'));
const output = mount.slice('type=bind,src='.length, mount.indexOf(',dst=')) + '/output';
for (const prompt of JSON.parse(readFileSync(process.env.FIXTURE_PROMPTS, 'utf8'))) {
  const result = await fetch(process.env.OPENAI__API_BASE + '/responses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI__KEY },
    body: JSON.stringify({ model: process.env['config.model'], stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] })
  });
  const wire = await result.text();
  if (result.status !== 200 || !wire.includes('response.completed')) {
    console.error('Controlled fixture response:', result.status, wire);
    process.exit(4);
  }
}
if (process.env.FIXTURE_MODE !== 'missing') {
  const findings = process.env.FIXTURE_MODE === 'tampered' ? [{ relevant_file: 'a.txt', issue_header: 'Wrong',
    issue_content: 'This finding was never returned by a chunk', start_line: 1, end_line: 1 }] : [];
  writeFileSync(output, 'review=' + JSON.stringify({ key_issues_to_review: process.env.FIXTURE_MODE === 'invalid' ? 'invalid' : findings }) + '\\n');
}
`;

async function fixture(t, { mode = "ok", staleBase = false, invalidResponse = false, unsupported = false, badPrompt = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "review-producer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
    { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(directory, "a.txt"), "old-a\nsame-a\n");
  await writeFile(join(directory, "b.txt"), "old-b\nsame-b\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  await writeFile(join(directory, "a.txt"), unsupported ? Buffer.from([0, 1, 2]) : "new-a-never-persist\nsame-a\n");
  await writeFile(join(directory, "b.txt"), "new-b-never-persist\nsame-b\n");
  git("add", "."); git("commit", "-qm", "head");
  const head = git("rev-parse", "HEAD").trim();
  const diff = git("diff", "--unified=3", "--full-index", base, head);
  await writeFile(join(directory, ".pr-agent-review-input.diff"), diff);
  const executable = join(directory, "docker");
  await writeFile(executable, childSource);
  await chmod(executable, 0o700);
  // Captured formatter shape from pinned source layer 68a027dc..., function
  // decouple_and_convert_to_hunks_with_lines_numbers; both files are modifications.
  const prompts = ["a", "b"].map((name) =>
    `The PR code diff:\n======\n\n## File: '${name}.txt'\n\n@@ -1,2 +1,2 @@\n__new hunk__\n1 +new-${name}-never-persist\n2  same-${name}\n__old hunk__\n-old-${name}\n same-${name}\n======`);
  const promptPath = join(directory, "prompts.json");
  await writeFile(promptPath, JSON.stringify(badPrompt ? ["unsupported prompt"] : prompts));
  const metadataDirectory = await mkdtemp(join(tmpdir(), "review-producer-metadata-"));
  t.after(() => rm(metadataDirectory, { recursive: true, force: true }));
  const output = join(directory, "job-output");
  await writeFile(output, "");
  const calls = join(directory, "calls");
  await writeFile(calls, "");
  const observations = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const bytes of request) body += bytes;
    observations.push({ path: request.url, headers: request.headers, body });
    const yaml = "review:\n  key_issues_to_review: []\n";
    const terminal = { type: invalidResponse ? "response.incomplete" : "response.completed", sequence_number: 2, response: {
      id: "resp_fixture", object: "response", created_at: 1, model: "gpt-4.1",
      status: invalidResponse ? "incomplete" : "completed", error: null,
      incomplete_details: invalidResponse ? { reason: "max_output_tokens" } : null,
      output: [{ id: "msg_fixture", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: yaml, annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    } };
    const delta = { type: "response.output_text.delta", sequence_number: 1,
      item_id: "msg_fixture", output_index: 0, content_index: 0, delta: yaml };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`event: response.output_text.delta\ndata: ${JSON.stringify(delta)}\n\nevent: ${terminal.type}\ndata: ${JSON.stringify(terminal)}\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const environment = {
    ...process.env, PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH}`,
    GITHUB_WORKSPACE: directory, GITHUB_REPOSITORY: "fixture/repository", GITHUB_REPOSITORY_ID: "42",
    REVIEW_COVERAGE_METADATA_FILE: join(metadataDirectory, "coverage.json"),
    GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "2", GITHUB_OUTPUT: output,
    REVIEW_COVERAGE_ANALYSIS_JOB_ID: "200", REVIEW_COVERAGE_RUNTIME_KIND: "official", REVIEW_COVERAGE_PROVIDER: "pr-agent",
    OPENAI__API_BASE: `http://127.0.0.1:${upstream.address().port}/v1`, OPENAI__KEY: "fixture-upstream-key",
    // LiteLLM 1.99.0 marks unknown model names as non-streaming and removes
    // stream=true. Use a known streaming model against this local-only server.
    "config.model": "gpt-4.1", "config.max_model_tokens": "300000", "config.custom_model_max_tokens": "300000",
    "litellm.custom_llm_provider": "openai", "litellm.force_streaming_custom_llm_provider": "openai",
    "litellm.force_streaming_api_base_substrings": '["https://"]',
    PR_AGENT_REVIEW_SCOPE: JSON.stringify({ version: 1, repository: "fixture/repository", prNumber: 1,
      mode: "full", fromSha: base, mergeBaseSha: base, headSha: head, diffSha256: hash(diff), diffBytes: Buffer.byteLength(diff) }),
    FIXTURE_MODE: mode, FIXTURE_CALLS: calls, FIXTURE_PROMPTS: promptPath, FIXTURE_IMAGE: ANALYSIS_IMAGE,
  };
  let reads = 0;
  const request = async (path) => {
    assert.equal(path, "/repos/fixture/repository/pulls/1");
    reads++;
    return { state: "open", draft: false, head: { sha: head, repo: { full_name: "fixture/repository" } },
      base: { sha: staleBase && reads > 1 ? "f".repeat(40) : base, repo: { id: 42, full_name: "fixture/repository" } } };
  };
  return { environment, request, output, observations, calls, directory, reads: () => reads };
}

test("producer observes two native-format HTTP chunks and independently reads child output", async (t) => {
  const f = await fixture(t);
  const result = await produceAnalysis(f);
  assert.equal(result.chunks, 2);
  assert.equal(f.observations.length, 2);
  for (const observed of f.observations) {
    assert.equal(observed.path, "/v1/responses");
    assert.equal(observed.headers.authorization, "Bearer fixture-upstream-key");
    assert.equal(observed.headers["x-review-chunk-id"], undefined);
    assert.equal(JSON.parse(observed.body).stream, true);
    assert.match(JSON.parse(observed.body).input[0].content[0].text, /__new hunk__/);
  }
  const output = await readFile(f.output, "utf8");
  const values = Object.fromEntries(output.trimEnd().split("\n").map((line) => {
    const delimiter = line.indexOf("=");
    return [line.slice(0, delimiter), line.slice(delimiter + 1)];
  }));
  const metadata = JSON.parse(values.coverage_metadata);
  const scope = JSON.parse(f.environment.PR_AGENT_REVIEW_SCOPE);
  assert.equal(await readFile(f.environment.REVIEW_COVERAGE_METADATA_FILE, "utf8"), values.coverage_metadata);
  assert.equal((await stat(f.environment.REVIEW_COVERAGE_METADATA_FILE)).mode & 0o777, 0o600);
  assert.equal(metadata.diffSha256, scope.diffSha256);
  assert.equal(metadata.diffBytes, scope.diffBytes);
  assert.equal(metadata.chunks.length, 2);
  assert.equal(metadata.mergedOutputSha256, hash(JSON.stringify({ review: { key_issues_to_review: [] } })));
  assert.equal(values.merged_output_sha256, metadata.mergedOutputSha256);
  assert.deepEqual(JSON.parse(values.review), { key_issues_to_review: [] });
  assert.equal(Buffer.byteLength(values.coverage_metadata) <= 256 * 1024, true);
  assert.doesNotMatch(output, /never-persist|fixture-upstream-key|input_text|__new hunk__/);
  const args = JSON.parse((await readFile(f.calls, "utf8")).trim());
  assert.equal(args.includes(ANALYSIS_IMAGE), true);
  assert.equal(args.includes("fixture-upstream-key"), false);
  const nativeMount = args.find((value) => value.endsWith("dst=/github/analysis-output"));
  const temporaryDirectory = nativeMount.slice("type=bind,src=".length, nativeMount.indexOf(",dst="));
  await assert.rejects(readFile(join(temporaryDirectory, "output")), { code: "ENOENT" });
});

for (const options of [{ mode: "missing" }, { mode: "invalid" }, { staleBase: true }, { invalidResponse: true }]) {
  test(`producer rejects missing, altered, stale or incomplete evidence: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    const code = options.mode === "missing" ? "review-output-missing"
      : options.invalidResponse ? "review-run-failed" : "review-output-invalid";
    await assert.rejects(produceAnalysis(f), options.mode === "invalid" ? /review findings are invalid/ : { code });
    // Shadow validation never retries the real native model call.
    assert.equal(f.observations.length, options.invalidResponse ? 1 : 2);
    if (options.staleBase) assert.equal(f.reads(), 2);
    assert.equal(await readFile(f.output, "utf8"), "");
  });
}


for (const options of [{ mode: "tampered" }, { unsupported: true }, { badPrompt: true }]) {
  test(`shadow invalid preserves independently valid native review: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    const result = await produceAnalysis(f);
    assert.ok(result.shadowFailure);
    assert.equal(f.observations.length, options.badPrompt ? 1 : 2);
    assert.match(await readFile(f.output, "utf8"), /^review=/m);
    assert.doesNotMatch(await readFile(f.output, "utf8"), /^coverage_metadata=/m);
    await assert.rejects(readFile(f.environment.REVIEW_COVERAGE_METADATA_FILE), { code: "ENOENT" });
  });
}

test("metadata write failure is advisory but missing native output still fails", async (t) => {
  const f = await fixture(t);
  f.environment.REVIEW_COVERAGE_METADATA_FILE = join(f.directory, "absent", "coverage.json");
  assert.ok((await produceAnalysis(f)).shadowFailure);
  assert.match(await readFile(f.output, "utf8"), /^review=/m);
  const missing = await fixture(t, { mode: "missing", badPrompt: true });
  await assert.rejects(produceAnalysis(missing), { code: "review-output-missing" });
});

test("shadow file transport is bounded, exclusive and rejects symlinks and invalid UTF-8", async (t) => {
  const { writeShadowMetadataFile, readShadowMetadataFile } = await import("../../packages/review-coverage/dist/index.mjs");
  const directory = await mkdtemp(join(tmpdir(), "review-shadow-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "coverage.json");
  const text = JSON.stringify({ value: "x".repeat(256 * 1024 - 12) });
  await writeShadowMetadataFile(path, text);
  assert.equal(await readShadowMetadataFile(path), text);
  await assert.rejects(writeShadowMetadataFile(path, text), { code: "EEXIST" });
  await symlink(path, join(directory, "link"));
  await assert.rejects(readShadowMetadataFile(join(directory, "link")));
  await assert.rejects(readShadowMetadataFile(directory));
  await assert.rejects(readShadowMetadataFile(join(directory, "missing")));
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(256 * 1024 + 1), Buffer.from([0xc0, 0xaf])]) {
    await writeFile(path, bytes);
    await assert.rejects(readShadowMetadataFile(path));
  }
});

test("producer rejects modified certified input and a different provider before invocation", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, ".pr-agent-review-input.diff"), "tampered\n");
  await assert.rejects(produceAnalysis(f), { code: "review-output-invalid" });
  f.environment.REVIEW_COVERAGE_RUNTIME_KIND = "derived";
  await assert.rejects(produceAnalysis(f), { code: "review-output-invalid" });
  assert.equal(f.observations.length, 0);
  assert.equal(await readFile(f.calls, "utf8"), "");
});

test("container deadline kills an unresponsive child, removes only its container and suppresses native logs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-producer-lifecycle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = join(directory, "calls");
  const executable = join(directory, "docker");
  await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'run') process.on('SIGTERM', () => {});
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n');
console.log('native-source-never-persist');
console.error('native-review-never-persist');
if (args[0] === 'run') {
  const record = { message: 'Tokens: 100, total tokens over limit: 50, pruning diff.',
    name: 'pr_agent.algo.pr_processing', function: 'get_pr_diff', level: { name: 'INFO' },
    extra: { source: 'logger-extra-never-persist' } };
  console.error(JSON.stringify({ text: 'rendered-native-review-never-persist', record }));
  console.log(JSON.stringify({ record: { ...record, message: 'Tokens: 1, total tokens under limit: 50, returning full diff.' } }));
  setInterval(() => {}, 1000);
}
`);
  await chmod(executable, 0o700);
  // Accelerate only the two fixed producer deadlines in an isolated parent.
  // The actual child ignores TERM and must be forcibly killed.
  const runner = join(directory, "runner.mjs");
  await writeFile(runner, `
import { runContainer } from ${JSON.stringify(new URL("./review-coverage-producer.mjs", import.meta.url).href)};
import { existsSync } from 'node:fs';
const original = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => {
  if (delay !== 840000) return original(fn, delay === 5000 ? 100 : delay, ...args);
  const ready = () => existsSync(process.env.FIXTURE_CALLS) ? fn(...args) : original(ready, 10);
  return original(ready, 10);
};
try { await runContainer(['run', '--rm'], process.env, process.cwd()); process.exitCode = 1; }
catch (error) { console.log(error.code); }
`);
  const result = await promisify(execFile)(process.execPath, [runner], {
    cwd: directory, timeout: 15000,
    env: { ...process.env, PATH: `${directory}:${dirname(process.execPath)}:${process.env.PATH}`, FIXTURE_CALLS: calls },
  });
  const outputLines = result.stdout.trim().split("\n");
  assert.equal(outputLines.length, 2);
  assert.deepEqual(JSON.parse(outputLines[0]), { record: {
    message: "Tokens: 100, total tokens over limit: 50, pruning diff.",
    name: "pr_agent.algo.pr_processing", function: "get_pr_diff", level: { name: "INFO" },
  } });
  assert.equal(outputLines[1], "review-run-failed");
  assert.doesNotMatch(result.stdout + result.stderr, /never-persist|returning full diff/);
  assert.equal(result.stderr, "");
  const invocations = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(invocations.length, 2, JSON.stringify(invocations));
  assert.deepEqual(invocations[1], ["rm", "--force", invocations[0][2]]);
  assert.match(invocations[0][2], /^pr-agent-analysis-[a-f0-9-]+$/);
});

test("pinned native image sends its actual Analysis request through the producer", {
  // Production uses Linux host networking. The process/HTTP tests above remain
  // runnable on macOS; the pinned-image test is required in Linux CI.
  skip: process.platform !== "linux",
  timeout: 8 * 60 * 1000,
}, async (t) => {
  const f = await fixture(t);
  f.environment.PATH = process.env.PATH;
  const result = await produceAnalysis(f);
  assert.equal(result.chunks >= 1 && result.chunks <= 3, true);
  assert.equal(f.observations.length, result.chunks);
  for (const observed of f.observations) assert.equal(JSON.parse(observed.body).stream, true);
  assert.equal(await readFile(f.calls, "utf8"), "");
  const observedText = f.observations.map((entry) => entry.body).join("\n");
  assert.match(observedText, /__new hunk__/);
  assert.match(observedText, /new-a-never-persist/);
  assert.match(observedText, /new-b-never-persist/);
  const output = await readFile(f.output, "utf8");
  assert.match(output, /^coverage_metadata=/m);
  assert.doesNotMatch(output, /never-persist|fixture-upstream-key/);
});
