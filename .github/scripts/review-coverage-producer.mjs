import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { githubRequest, requirePrAgentTarget } from "./pr-agent-review.mjs";
import { projectPrAgentReviewOutput } from "./pr-agent-review-output.mjs";

// This initial shadow producer uses the already approved official baseline.
// A derived runtime needs its own reviewed immutable identity before use here.
export const ANALYSIS_IMAGE_DIGEST = "sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6";
export const ANALYSIS_IMAGE = `pragent/pr-agent@${ANALYSIS_IMAGE_DIGEST}`;
const RECORDER_MODULE = new URL("../../packages/review-coverage/dist/index.mjs", import.meta.url);
const MAX_REVIEW_BYTES = 64 * 1024;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const failure = (code) => Object.assign(new Error(code), { code });

function preserveCoverageEvent(line) {
  let record;
  try { record = JSON.parse(line)?.record; } catch { return; }
  if (record?.level?.name !== "INFO") return;
  const tokenDecision = record.name === "pr_agent.algo.pr_processing" && record.function === "get_pr_diff" &&
    /^Tokens: [0-9]+, total tokens (?:under limit: [0-9]+, returning full diff|over limit: [0-9]+, pruning diff)\.$/.test(record.message);
  const omittedTicket = record.name === "pr_agent.tools.ticket_pr_compliance_check" &&
    record.function === "fit_related_tickets_to_prompt_budget" &&
    record.message === "Clipped related tickets to preserve the prompt token budget";
  if (tokenDecision || omittedTicket) {
    // Keep only the native Gate's deterministic event and call site. Logger
    // extras and the top-level rendered text can contain review/source data.
    console.log(JSON.stringify({ record: { message: record.message, name: record.name,
      function: record.function, level: { name: "INFO" } } }));
  }
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !value) throw failure("review-output-missing");
  return value;
}

function positiveInteger(environment, name) {
  const value = Number(required(environment, name));
  if (!Number.isSafeInteger(value) || value < 1) throw failure("review-output-invalid");
  return value;
}

async function boundedRead(path, limit) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    if (size > limit) throw failure("review-output-invalid");
    const bytes = await file.readFile();
    if (bytes.length > limit) throw failure("review-output-invalid");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
}

export async function runContainer(args, environment, workspace) {
  const containerName = `pr-agent-analysis-${randomUUID()}`;
  try {
    await new Promise((resolveRun, reject) => {
      const child = spawn("docker", [args[0], "--name", containerName, ...args.slice(1)], {
        cwd: workspace,
        env: environment,
        // Native CLI prints review text on stdout even with publish_output=false.
        // JSON logger stderr is projected below; GITHUB_OUTPUT is read separately.
        stdio: ["ignore", "ignore", "pipe"],
      });
      let logLine = "";
      let discardLine = false;
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (text) => {
        for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
          if (!discardLine) logLine += part;
          if (Buffer.byteLength(logLine) > 64 * 1024) { logLine = ""; discardLine = true; }
          if (part.endsWith("\n")) {
            if (!discardLine) preserveCoverageEvent(logLine);
            logLine = ""; discardLine = false;
          }
        }
      });
      let aborted = false;
      let forceDeadline;
      const stop = () => {
        if (aborted) return;
        aborted = true;
        child.kill("SIGTERM");
        forceDeadline = setTimeout(() => {
          child.kill("SIGKILL");
          cleanup();
          reject(failure("review-run-failed"));
        }, 5000);
      };
      const deadline = setTimeout(stop, 14 * 60 * 1000);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      const cleanup = () => {
        clearTimeout(deadline);
        clearTimeout(forceDeadline);
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
      };
      child.once("error", () => {
        cleanup();
        reject(failure("review-run-failed"));
      });
      child.once("close", (code) => {
        cleanup();
        if (code === 0 && !aborted) resolveRun();
        else reject(failure("review-run-failed"));
      });
    });
  } catch {
    // Killing the CLI need not stop a daemon-owned container. Remove only this
    // invocation, with a separately bounded cleanup process and no raw logs.
    await promisify(execFile)("docker", ["rm", "--force", containerName], {
      cwd: workspace, env: environment, timeout: 10000, killSignal: "SIGKILL",
    }).catch(() => {});
    throw failure("review-run-failed");
  }
}

// Called only for a certified full scope. Incremental/unchanged scopes retain
// the existing native Analysis path; they cannot claim a full-PR shadow result.
export async function produceAnalysis({ environment = process.env, request = githubRequest } = {}) {
  const workspace = resolve(required(environment, "GITHUB_WORKSPACE"));
  const repository = required(environment, "GITHUB_REPOSITORY");
  const repositoryId = positiveInteger(environment, "GITHUB_REPOSITORY_ID");
  const scope = JSON.parse(required(environment, "PR_AGENT_REVIEW_SCOPE"));
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || scope.repository !== repository ||
      scope.mode !== "full" || !Number.isSafeInteger(scope.prNumber) || scope.prNumber < 1 ||
      !sha(scope.headSha) || !sha(scope.mergeBaseSha) || scope.fromSha !== scope.mergeBaseSha) {
    throw failure("review-output-invalid");
  }
  const target = { repository, prNumber: scope.prNumber, expectedHead: scope.headSha, request };
  const current = await requirePrAgentTarget(target);
  if (current.base?.repo?.id !== repositoryId || current.base.repo.full_name !== repository ||
      !sha(current.base.sha)) throw failure("review-output-invalid");
  const upstream = new URL(required(environment, "OPENAI__API_BASE"));
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password ||
      upstream.search || upstream.hash) throw failure("review-output-invalid");
  required(environment, "OPENAI__KEY");
  required(environment, "config.model");
  const tokenCap = positiveInteger(environment, "config.max_model_tokens");
  if (tokenCap !== 300000 || Number(environment["config.custom_model_max_tokens"]) !== tokenCap) {
    throw failure("review-output-invalid");
  }
  if (required(environment, "REVIEW_COVERAGE_RUNTIME_KIND") !== "official" ||
      required(environment, "REVIEW_COVERAGE_PROVIDER") !== "pr-agent") throw failure("review-output-invalid");

  const recorder = await import(RECORDER_MODULE.href);
  // The trusted preparation step must fetch these exact Git objects, without
  // checking out PR code. Missing objects fail before the model is invoked.
  const observedInventory = await recorder.observeGitInventory(workspace, current.base.sha, scope.headSha);
  const inventory = observedInventory.inventory;
  if (observedInventory.mergeBaseSha !== scope.mergeBaseSha) throw failure("review-output-invalid");
  const diffPath = join(workspace, ".pr-agent-review-input.diff");
  const diff = await boundedRead(diffPath, 10 * 1024 * 1024);
  if (hash(diff) !== scope.diffSha256 || Buffer.byteLength(diff) !== scope.diffBytes) {
    throw failure("review-output-invalid");
  }
  const identity = {
    reviewer: "pr-agent", runtimeKind: "official", provider: "pr-agent",
    repositoryId, repositoryName: repository, pullRequest: scope.prNumber,
    baseSha: current.base.sha, headSha: scope.headSha, mergeBaseSha: observedInventory.mergeBaseSha,
    diffSha256: scope.diffSha256, diffBytes: scope.diffBytes,
    workflowRunId: positiveInteger(environment, "GITHUB_RUN_ID"),
    runAttempt: positiveInteger(environment, "GITHUB_RUN_ATTEMPT"),
    analysisJobId: required(environment, "REVIEW_COVERAGE_ANALYSIS_JOB_ID"),
    imageDigest: ANALYSIS_IMAGE_DIGEST,
    recorderVersion: `sha256:${hash(await readFile(RECORDER_MODULE))}`,
    templateVersion: "sha256:c08dcdec8b0f81ea8f16e8573af29da22858a0aba11d6aa38ab94aa6391b3ca1",
    transportVersion: "openai-responses-v1", tokenCap,
  };
  const directory = await mkdtemp(join(tmpdir(), "pr-agent-analysis-output-"));
  const nativeOutput = join(directory, "output");
  await writeFile(nativeOutput, "", { mode: 0o600 });
  let proxy;
  try {
    proxy = await recorder.startRecordingProxy({ inventory, observationOnly: true, upstreamBaseUrl: upstream.href });
    const proxyBase = `http://127.0.0.1:${proxy.port}${upstream.pathname.replace(/\/$/, "")}`;
    const runtimeEnvironment = {};
    for (const [key, value] of Object.entries(environment)) {
      if (/^(?:config\.|pr_reviewer\.|litellm\.|github_action_config\.)/.test(key) || key === "related_tickets") {
        runtimeEnvironment[key] = value;
      }
    }
    Object.assign(runtimeEnvironment, {
      OPENAI__KEY: environment.OPENAI__KEY,
      OPENAI__API_BASE: proxyBase,
      "litellm.custom_llm_provider": "openai",
      "litellm.force_streaming_custom_llm_provider": "openai",
      "litellm.force_streaming_api_base_substrings": JSON.stringify([proxyBase]),
      LITELLM_ROUTE_ALL_CHAT_OPENAI_TO_RESPONSES: "true",
      GITHUB_OUTPUT: "/github/analysis-output/output",
      "config.publish_output": "false", "config.publish_output_progress": "false",
      "config.log_level": "INFO", "config.verbosity_level": "0",
      "config.restricted_mode": "true", "config.use_repo_settings_file": "false",
      "config.use_wiki_settings_file": "false", "config.fallback_models": "[]",
      "config.propagate_tool_errors": "true",
      "github_action_config.enable_output": "true",
      "pr_reviewer.persistent_comment": "false", "pr_reviewer.persistent_finding_state": "false",
    });
    if ([workspace, directory].some((path) => /[,\r\n]/.test(path))) throw failure("review-output-invalid");
    const args = ["run", "--rm", "--network", "host", "--entrypoint", "python",
      "--mount", `type=bind,src=${diffPath},dst=/github/workspace/.pr-agent-review-input.diff,readonly`,
      "--mount", `type=bind,src=${directory},dst=/github/analysis-output`];
    for (const key of Object.keys(runtimeEnvironment)) args.push("--env", key);
    args.push(ANALYSIS_IMAGE, "-c",
      "import contextlib, os, sys; os.chdir('/tmp'); from pr_agent.cli import run; from pr_agent.log import LoggingFormat, setup_logger\n" +
      "with contextlib.redirect_stdout(sys.stderr): setup_logger(fmt=LoggingFormat.JSON)\nrun()",
      "--diff-file", "/github/workspace/.pr-agent-review-input.diff", "review");
    await runContainer(args, { ...environment, ...runtimeEnvironment }, workspace);
    await proxy.close();
    if (proxy.transportFailure()) throw failure("review-run-failed");
    const lines = (await boundedRead(nativeOutput, MAX_REVIEW_BYTES + 8)).split("\n").filter(Boolean);
    if (lines.length !== 1 || !lines[0].startsWith("review=")) throw failure("review-output-missing");
    const raw = lines[0].slice("review=".length);
    const review = projectPrAgentReviewOutput(raw);
    // github_action_output writes the inner review object. Rebuild the native
    // envelope from that independently observed output, not a recorder alias.
    const mergedOutput = { review: JSON.parse(raw) };
    const chunks = proxy.results();
    let metadataText;
    let shadowFailure;
    try {
      if (!inventory || proxy.observationFailure()) throw failure("review-coverage-incomplete");
      const failed = proxy.failedChunks();
      const metadata = recorder.buildCoverageMetadata(identity, inventory, chunks, mergedOutput,
        [...chunks, ...failed].map((chunk) => chunk.chunkId), failed);
      metadataText = recorder.serializeMetadata(metadata).trimEnd();
      recorder.verifyShadowMetadata(metadataText, {
        ...identity, mergedOutputSha256: hash(JSON.stringify(mergedOutput)),
        successfulResponseSha256: chunks.map((chunk) => chunk.responseSha256),
      }, inventory);
      await recorder.writeShadowMetadataFile(required(environment, "REVIEW_COVERAGE_METADATA_FILE"), metadataText);
    } catch (error) {
      // Only shadow observation is advisory before activation. The independently
      // read native output/schema and current target checks remain outside.
      metadataText = undefined;
      shadowFailure = error?.code === "review-coverage-incomplete"
        ? "review-coverage-incomplete" : "review-output-invalid";
      console.error(`${shadowFailure}: trusted chunk shadow observation invalid`);
    }
    const finalTarget = await requirePrAgentTarget(target);
    if (finalTarget.base?.sha !== identity.baseSha || finalTarget.base?.repo?.id !== repositoryId) {
      throw failure("review-output-invalid");
    }
    const outputs = {
      review, ...(metadataText === undefined ? {} : { coverage_metadata: metadataText }), coverage_identity: JSON.stringify(identity),
      merged_output_sha256: hash(JSON.stringify(mergedOutput)),
      successful_response_sha256: JSON.stringify(chunks.map((chunk) => chunk.responseSha256)),
    };
    await appendFile(required(environment, "GITHUB_OUTPUT"),
      Object.entries(outputs).map(([name, value]) => `${name}=${value}\n`).join(""));
    return { chunks: chunks.length, inventorySha256: inventory?.digest, shadowFailure };
  } finally {
    if (proxy?.server.listening) await proxy.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  produceAnalysis().catch((error) => {
    const code = ["review-output-invalid", "review-output-missing", "review-coverage-incomplete"].includes(error?.code)
      ? error.code : "review-run-failed";
    console.error(`${code}: Analysis producer failed`);
    process.exitCode = 1;
  });
}
