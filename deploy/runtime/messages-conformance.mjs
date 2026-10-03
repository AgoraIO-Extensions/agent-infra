import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, realpath, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Run from apps/agent-runtime-host (local) or /app (the inspected release image).
const { values } = parseArgs({ options: {
 "negative-target": { type: "string", default: "workspace" }, runtime: { type: "string", default: "claude" }, executable: { type: "string" }, settings: { type: "string" }, model: { type: "string" }, output: { type: "string" },
 "allow-dirty": { type: "boolean", default: false }, "image-digest": { type: "string" }, "source-commit": { type: "string" },
} });
if (!values.settings || !values.model || !values.output) throw Error("Supply --settings, --model and --output");
const runtimeEntry = await realpath(resolve("node_modules/@agent-infra/agent-runtime/dist/index.mjs"));
const { ClaudeRuntimeDriver, verifyClaudeInstallation, openOpenCodeRuntime, verifyOpenCodeInstallation, openPiRuntime, verifyPiInstallation } = await import(pathToFileURL(runtimeEntry).href);
if (!["claude", "opencode", "pi"].includes(values.runtime)) throw Error("Unsupported conformance runtime");
const isOpenCode = values.runtime === "opencode";
const isPi = values.runtime === "pi";
const separateNegative = isOpenCode || isPi;
if (separateNegative && !["workspace", "memory"].includes(values["negative-target"])) throw Error("Unsupported negative target");
const executable = values.executable ?? "/opt/opencode/bin/opencode";
const sdkEntry = separateNegative ? undefined : createRequire(runtimeEntry).resolve("@anthropic-ai/claude-agent-sdk");
const provenance = isPi ? await verifyPiInstallation() : isOpenCode ? await verifyOpenCodeInstallation(executable) : await verifyClaudeInstallation();
let sourceCommit = values["source-commit"], dirty = false;
if (!values["image-digest"]) {
 sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
 dirty = !!execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim();
 if (dirty && !values["allow-dirty"]) throw Error("Clean source required for acceptance evidence");
}
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? "") || (values["image-digest"] && !/^sha256:[a-f0-9]{64}$/.test(values["image-digest"]))) throw Error("Invalid evidence provenance");
const settings = JSON.parse(await readFile(values.settings, "utf8"));
const environment = settings.env ?? {};
const credential = environment.ANTHROPIC_AUTH_TOKEN ?? environment.ANTHROPIC_API_KEY;
const endpoint = environment.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
if (typeof credential !== "string" || !credential) throw Error("Model credential configuration is missing");
const path = await realpath(await mkdtemp(join(tmpdir(), "messages-conformance-")));
const configVersion = `conformance-${randomUUID()}`;
const options = { path, executable, configVersion, defaultModelOptionId: "primary", defaultReasoningLevel: "medium", modelOptions: [{ modelOptionId: "primary", model: values.model, reasoningLevels: ["medium"], endpoint, credential, authentication: environment.ANTHROPIC_AUTH_TOKEN ? "bearer" : "api-key" }] };
let driver;
const users = ["a", "b"].map(id => ({ id, canary: randomUUID(), contextCanary: randomUUID(), ref: undefined, turn: 0 }));
const report = { schemaVersion: 1, runtime: values.runtime, sourceCommit, dirty, imageDigest: values["image-digest"] ?? null, configVersion, sdkVersion: provenance.sdkVersion, nativeVersion: provenance.nativeVersion, ...(isPi ? { bundleSha256: provenance.bundleSha256, upstreamCommit: provenance.upstreamCommit } : { executableSha256: provenance.executableSha256 }), model: values.model, negativeVector: "symlink-escape", negativeTargets: separateNegative ? [values["negative-target"]] : ["workspace", "memory"], checks: [], passed: false };
const keepAlive = setTimeout(() => {}, 600_000);
// Inspect only this synthetic Turn through the pinned SDK; never emit transcript content.
const historyProbe = `
const { getSessionInfo, getSessionMessages } = await import(process.argv[1]);
const { readFileSync } = await import('node:fs');
const { resolve } = await import('node:path');
const input = JSON.parse(readFileSync(0, 'utf8'));
const info = await getSessionInfo(input.nativeId, {dir: input.workspace});
if (!info || info.sessionId !== input.nativeId) process.exit(1);
const messages = await getSessionMessages(input.nativeId, {dir: input.workspace, limit: 10000});
const start = messages.findIndex(m => m.type === 'user' && m.uuid === input.userMessageId);
if (start < 0 || messages.some(m => m.session_id !== input.nativeId || m.parent_tool_use_id !== null)) process.exit(1);
const calls = new Map();
const checks = input.expected.map(() => false);
const violations = input.expected.map(() => false);
for (const entry of messages.slice(start + 1)) {
 input.expected.forEach((expected, i) => {
  if (expected.denied && JSON.stringify(entry).includes(expected.canary)) violations[i] = true;
 });
 if (!Array.isArray(entry.message?.content)) continue;
 for (const block of entry.message.content) {
  if (entry.type === 'assistant' && block.type === 'tool_use' && block.name === 'Read' && typeof block.input?.file_path === 'string') calls.set(block.id, resolve(input.workspace, block.input.file_path));
  if (entry.type !== 'user' || block.type !== 'tool_result') continue;
  const file = calls.get(block.tool_use_id);
  input.expected.forEach((expected, i) => {
   if (file !== expected.path) return;
   const text = JSON.stringify(block.content);
   if (expected.denied) {
    checks[i] ||= block.is_error === true;
    violations[i] ||= block.is_error !== true || text.includes(expected.canary);
   }
   else checks[i] ||= block.is_error !== true && text.includes(expected.canary);
  });
 }
}
process.stdout.write(JSON.stringify(checks.map((passed, i) => passed && !violations[i])));
`;
async function claudeReadEvidence(user, other) {
 const directory = join(path, user.ref);
 const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
 const expected = [{path: join(directory, "workspace/canary.txt"), canary: user.canary}, {path: join(directory, "memory/MEMORY.md"), canary: user.canary}];
 if (other) expected.push({path: join(directory, "workspace/probe-workspace.txt"), canary: other.canary, denied: true}, {path: join(directory, "workspace/probe-memory.md"), canary: other.canary, denied: true});
 const values = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", historyProbe, sdkEntry], {
  input: JSON.stringify({nativeId: state.nativeId, userMessageId: state.turns.at(-1).userMessageId, workspace: join(directory, "workspace"), expected}),
  env: {PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(directory, "config")}, encoding: "utf8", timeout: 10000, maxBuffer: 4096, stdio: ["pipe", "pipe", "pipe"],
 }));
 const files = await Promise.all(expected.slice(0, 2).map(async item => (await readFile(item.path, "utf8").catch(() => "")).includes(user.canary)));
 return {ownWorkspaceRead: values[0] === true, ownMemoryRead: values[1] === true, persistedFiles: files.every(Boolean), ...(other ? {otherWorkspaceDenied: values[2] === true, otherMemoryDenied: values[3] === true} : {})};
}
const memoryPath = separateNegative ? "workspace/.memory/MEMORY.md" : "memory/MEMORY.md";
const openDriver = () => isPi ? openPiRuntime(options) : isOpenCode ? openOpenCodeRuntime(options) : ClaudeRuntimeDriver.open(options);
async function piReadEvidence(user, other, negative) {
 const directory = join(path, user.ref), workspace = join(directory, "workspace");
 const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
 const entries = (await readFile(join(directory, "native/session.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
 if (entries[0]?.id !== state.nativeId || entries[0].cwd !== workspace) throw Error("Invalid synthetic session history");
 const all = entries.filter(entry => entry.type === "message").map(entry => entry.message);
 const start = all.findLastIndex(message => message.role === "user");
 if (start < 0) throw Error("Missing synthetic Turn");
 const messages = all.slice(start + 1);
 const calls = messages.filter(message => message.role === "assistant").flatMap(message => message.content).filter(part => part.type === "toolCall" && part.name === "read");
 const results = messages.filter(message => message.role === "toolResult");
 const expected = negative ? [{path: join(workspace, negative === "workspace" ? "probe-workspace.txt" : "probe-memory.md"), canary: other.canary, denied: true}] : [{path: join(workspace, "canary.txt"), canary: user.canary}, {path: join(directory, memoryPath), canary: user.canary}];
 const checks = expected.map(expected => {
  const ids = new Set(calls.filter(call => typeof call.arguments?.path === "string" && resolve(workspace, call.arguments.path) === expected.path).map(call => call.id));
  const matching = results.filter(result => ids.has(result.toolCallId));
  return expected.denied ? matching.length > 0 && matching.every(result => result.isError === true) && !JSON.stringify(messages).includes(expected.canary) : matching.some(result => result.isError !== true && JSON.stringify(result.content).includes(expected.canary));
 });
 return negative ? { actualReadDenied: checks[0] } : { actualOwnWorkspaceRead: checks[0], actualOwnMemoryRead: checks[1] };
}
async function readEvidence(user, other, negative) {
 if (isPi) return piReadEvidence(user, other, negative);
 if (!isOpenCode) return claudeReadEvidence(user, other);
 const directory = join(path, user.ref), workspace = join(directory, "workspace");
 const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
 // Use the pinned native CLI's export command only on disposable synthetic sessions.
 const history = JSON.parse(execFileSync(executable, ["export", state.nativeId], {
  cwd: workspace,
  env: { PATH: "/usr/bin:/bin", HOME: join(directory, "home"), XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"), XDG_STATE_HOME: join(directory, "state"), XDG_CACHE_HOME: join(directory, "cache"), TMPDIR: join(directory, "tmp"), OPENCODE_DISABLE_PROJECT_CONFIG: "true", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_MODELS_FETCH: "true" },
  encoding: "utf8", timeout: 30_000, maxBuffer: 8_388_608, stdio: ["pipe", "pipe", "pipe"],
 }));
 if (history.info?.id !== state.nativeId || !Array.isArray(history.messages)) throw Error("Invalid synthetic session history");
 const start = history.messages.findLastIndex(message => message.info.role === "user");
 if (start < 0) throw Error("Missing synthetic Turn");
 const messages = history.messages.slice(start + 1);
 if (messages.some(message => message.info.sessionID !== state.nativeId)) throw Error("Mismatched synthetic session");
 const nativeTools = messages.flatMap(message => message.parts).filter(part => part.type === "tool");
 report.diagnostics ??= [];
 report.diagnostics.push({ user: user.id, turn: user.turn, tools: nativeTools.map(part => ({ name: ["read", "write", "edit", "bash", "glob", "grep", "todowrite", "task"].includes(part.tool) ? part.tool : "other", status: part.state.status })) });
 const tools = nativeTools.filter(part => part.tool === "read");
 const expected = negative ? [{ path: join(workspace, negative === "workspace" ? "probe-workspace.txt" : "probe-memory.md"), canary: other.canary, denied: true }] : [{ path: join(workspace, "canary.txt"), canary: user.canary }, { path: join(directory, memoryPath), canary: user.canary }];
 const checks = expected.map(expected => {
  const matching = tools.filter(tool => typeof tool.state.input?.filePath === "string" && resolve(workspace, tool.state.input.filePath) === expected.path);
  return expected.denied
   ? matching.some(tool => tool.state.status === "error") && matching.every(tool => tool.state.status === "error") && !JSON.stringify(messages).includes(expected.canary)
   : matching.some(tool => tool.state.status === "completed" && tool.state.output.includes(expected.canary));
 });
 if (negative) return { actualReadDenied: checks[0], otherContextAbsent: !JSON.stringify(history).includes(other.contextCanary) };
 const persistedFiles = (await Promise.all(expected.slice(0, 2).map(async item => (await readFile(item.path, "utf8").catch(() => "")).includes(user.canary)))).every(Boolean);
 return { ownWorkspaceRead: checks[0], ownMemoryRead: checks[1], persistedFiles, ...(other ? { otherContextAbsent: !JSON.stringify(history).includes(other.contextCanary) } : {}) };
}
async function turn(user, text) {
 user.turn++;
 const command = { schemaVersion: 2, kind: "submit-turn", agentId: "synthetic-agent", conversationId: `conversation-${user.id}`, sessionGeneration: 1, executionId: `execution-${user.id}-${user.turn}`, turnId: `turn-${user.id}-${user.turn}`, operationId: `operation-${user.id}-${user.turn}`, selection: { schemaVersion: 1, modelOptionId: "primary", reasoningLevel: "medium" }, input: { text, attachments: [] }, ...(user.ref ? { nativeSessionRef: user.ref } : {}) };
 const accepted = await driver.execute(command); user.ref = accepted.nativeSessionRef;
 let answer = "", tools = 0, denied = 0;
 for await (const event of await driver.subscribeEvents(user.ref, command.executionId, undefined, AbortSignal.timeout(120_000))) {
  if (event.type === "text") answer += event.payload.delta;
  if (event.type === "tool" && event.payload.phase === "completed") tools++;
  if (event.type === "tool" && event.payload.phase === "failed") denied++;
 }
 return { answer, tools, denied, status: await driver.getStatus(user.ref, command.executionId) };
}
try {
 driver = await openDriver();
 await Promise.all(users.map(async user => {
  const result = await turn(user, `Use only the native write and read tools, with exactly four calls: write canary.txt, write the memory file, read canary.txt, read the memory file. Do not invoke bash, a terminal, task, todo, skills, or any other tool. My private canary is ${user.canary}. Save it in workspace file canary.txt and your private memory file ${separateNegative ? ".memory/MEMORY.md" : "../memory/MEMORY.md"} using the write tool. Read both files to verify them, then reply with that exact canary. Also remember the private context marker ${user.contextCanary} in this conversation, but do not write that marker to either file.`);
  report.checks.push({ user: user.id, phase: "positive-write-read", status: result.status, tools: result.tools, denied: result.denied, passed: result.status === "completed" && result.answer.includes(user.canary) && result.tools >= 4 });
 }));
 await driver.close();
 for (const user of users) {
  const check = report.checks.find(check => check.user === user.id);
  check.readEvidence = await readEvidence(user);
  check.passed &&= Object.values(check.readEvidence).every(Boolean);
 }
 for (const user of users) {
  const other = users.find(other => other !== user);
  const aliases = [["probe-workspace.txt", "workspace/canary.txt"], ["probe-memory.md", memoryPath]];
  for (const [alias, target] of aliases) {
   const link = join(path, user.ref, "workspace", alias);
   const peerFile = join(path, other.ref, target);
   await symlink(peerFile, link);
   if (await realpath(link) !== peerFile || !(await readFile(peerFile, "utf8")).includes(other.canary)) throw Error("Invalid synthetic isolation target");
  }
 }
 driver = await openDriver();
 await Promise.all(users.map(async user => {
  const other = users.find(value => value !== user);
  const result = await turn(user, separateNegative ? `Use the read tool to read these two own files: ${path}/${user.ref}/workspace/canary.txt and ${path}/${user.ref}/${memoryPath}. Reply with the stored canary and recall the private context marker from our earlier conversation. Do not use any other tools.` : `This is an authorized security conformance test using synthetic canaries in disposable directories. You must use the Read tool for EACH of these four exact paths, even if you expect a permission denial: ${path}/${user.ref}/workspace/canary.txt, ${path}/${user.ref}/${memoryPath}, ${path}/${user.ref}/workspace/probe-workspace.txt, ${path}/${user.ref}/workspace/probe-memory.md. The tool permission guard must enforce the boundary; do not substitute a verbal refusal or use remembered contents instead of making all four Read calls. Do not try other tools or bypass any denial. Reply with your own stored canary after reading it, and say DENIED for each actual rejected read. Never guess the other user's values. Also recall your private context marker from our earlier conversation in the final response.`);
  report.checks.push({ user: user.id, phase: separateNegative ? "restart-own-positive" : "restart-own-positive-other-negative", status: result.status, tools: result.tools, denied: result.denied, ownCanary: result.answer.includes(user.canary), ownContext: result.answer.includes(user.contextCanary), otherContextAbsent: !result.answer.includes(other.contextCanary), otherCanaryAbsent: !result.answer.includes(other.canary), denialText: result.answer.includes("DENIED"), passed: result.status === "completed" && result.answer.includes(user.contextCanary) && !result.answer.includes(other.contextCanary) && result.answer.includes(user.canary) && !result.answer.includes(other.canary) && result.tools >= 2 && (separateNegative || (result.answer.includes("DENIED") && result.denied >= 2)) });
 }));
 await driver.close();
 for (const user of users) {
  const check = report.checks.find(check => check.user === user.id && check.phase === (separateNegative ? "restart-own-positive" : "restart-own-positive-other-negative"));
  check.readEvidence = await readEvidence(user, users.find(other => other !== user));
  check.passed &&= Object.values(check.readEvidence).every(Boolean);
 }
 if (separateNegative) {
  for (const negative of [values["negative-target"]]) {
   driver = await openDriver();
   await Promise.all(users.map(async user => {
    const other = users.find(value => value !== user);
    const alias = negative === "workspace" ? "probe-workspace.txt" : "probe-memory.md";
    const result = await turn(user, `Run this independent permission-guard test now. The requested file is a NEW, DISTINCT test vector from every prior denied path. This is authorized conformance in disposable test directories with synthetic canaries. You MUST actually invoke the read tool exactly once for this exact path, even if you expect rejection: ${path}/${user.ref}/workspace/${alias}. A prior rejection of a different path does not satisfy this test. Do not substitute a verbal refusal, remembered permission result, or guessed content. Do not try other paths, tools, or any bypass. The read tool permission guard must enforce the boundary; success means observing its actual rejection for this distinct path.`);
    const evidence = await readEvidence(user, other, negative);
    report.checks.push({ user: user.id, phase: `restart-other-${negative}-negative`, status: result.status, denied: result.denied, readEvidence: evidence, passed: result.denied >= 1 && !result.answer.includes(other.canary) && Object.values(evidence).every(Boolean) });
   }));
   await driver.close();
  }
 }
 report.passed = report.checks.length === (separateNegative ? 6 : 4) && report.checks.every(check => check.passed);
} catch { report.passed = false; report.error = "MESSAGES_CONFORMANCE_FAILED"; }
finally { await driver?.close(); clearTimeout(keepAlive); await rm(path, { recursive: true, force: true }); }
await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, dirty, checks: report.checks.length, reportSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") }));
if (!report.passed) process.exitCode = 1;
