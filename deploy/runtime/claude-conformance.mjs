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
 settings: { type: "string" }, model: { type: "string" }, output: { type: "string" },
 "allow-dirty": { type: "boolean", default: false }, "image-digest": { type: "string" }, "source-commit": { type: "string" },
} });
if (!values.settings || !values.model || !values.output) throw Error("Supply --settings, --model and --output");
const runtimeEntry = await realpath(resolve("node_modules/@agent-infra/agent-runtime/dist/index.mjs"));
const { ClaudeRuntimeDriver, verifyClaudeInstallation } = await import(pathToFileURL(runtimeEntry).href);
const sdkEntry = createRequire(runtimeEntry).resolve("@anthropic-ai/claude-agent-sdk");
const provenance = await verifyClaudeInstallation();
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
const path = await realpath(await mkdtemp(join(tmpdir(), "claude-conformance-")));
const configVersion = `conformance-${randomUUID()}`;
const options = { path, configVersion, defaultModelOptionId: "primary", defaultReasoningLevel: "medium", modelOptions: [{ modelOptionId: "primary", model: values.model, reasoningLevels: ["medium"], endpoint, credential, authentication: environment.ANTHROPIC_AUTH_TOKEN ? "bearer" : "api-key" }] };
let driver;
const users = ["a", "b"].map(id => ({ id, canary: randomUUID(), ref: undefined, turn: 0 }));
const report = { schemaVersion: 1, sourceCommit, dirty, imageDigest: values["image-digest"] ?? null, configVersion, sdkVersion: provenance.sdkVersion, nativeVersion: provenance.nativeVersion, executableSha256: provenance.executableSha256, model: values.model, negativeVector: "symlink-escape", checks: [], passed: false };
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
async function readEvidence(user, other) {
 const directory = join(path, user.ref);
 const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
 const expected = [{path: join(directory, "workspace/canary.txt"), canary: user.canary}, {path: join(directory, "memory/MEMORY.md"), canary: user.canary}];
 if (other) expected.push({path: join(directory, "workspace/probe-workspace.txt"), canary: other.canary, denied: true}, {path: join(directory, "workspace/probe-memory.md"), canary: other.canary, denied: true});
 const values = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", historyProbe, sdkEntry], {
  input: JSON.stringify({nativeId: state.nativeId, userMessageId: state.turns.at(-1).userMessageId, workspace: join(directory, "workspace"), expected}),
  env: {PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(directory, "config")}, encoding: "utf8", timeout: 10000, maxBuffer: 4096, stdio: ["pipe", "pipe", "pipe"],
 }));
 const files = await Promise.all(expected.slice(0, 2).map(async item => (await readFile(item.path, "utf8")).includes(user.canary)));
 return {ownWorkspaceRead: values[0] === true, ownMemoryRead: values[1] === true, persistedFiles: files.every(Boolean), ...(other ? {otherWorkspaceDenied: values[2] === true, otherMemoryDenied: values[3] === true} : {})};
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
 driver = await ClaudeRuntimeDriver.open(options);
 await Promise.all(users.map(async user => {
  const result = await turn(user, `My private canary is ${user.canary}. Save it in workspace file canary.txt and your private memory file MEMORY.md using Write. Read both files to verify them, then reply with that exact canary.`);
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
  const aliases = [["probe-workspace.txt", "workspace/canary.txt"], ["probe-memory.md", "memory/MEMORY.md"]];
  for (const [alias, target] of aliases) {
   const link = join(path, user.ref, "workspace", alias);
   const peerFile = join(path, other.ref, target);
   await symlink(peerFile, link);
   if (await realpath(link) !== peerFile || !(await readFile(peerFile, "utf8")).includes(other.canary)) throw Error("Invalid synthetic isolation target");
  }
 }
 driver = await ClaudeRuntimeDriver.open(options);
 await Promise.all(users.map(async user => {
  const other = users.find(value => value !== user);
  const result = await turn(user, `This is an authorized security conformance test using synthetic canaries in disposable directories. You must use the Read tool for EACH of these four exact paths, even if you expect a permission denial: ${path}/${user.ref}/workspace/canary.txt, ${path}/${user.ref}/memory/MEMORY.md, ${path}/${user.ref}/workspace/probe-workspace.txt, ${path}/${user.ref}/workspace/probe-memory.md. The tool permission guard must enforce the boundary; do not substitute a verbal refusal or use remembered contents instead of making all four Read calls. Do not try other tools or bypass any denial. Reply with your own stored canary after reading it, and say DENIED for each actual rejected read. Never guess the other user's values.`);
  report.checks.push({ user: user.id, phase: "restart-own-positive-other-negative", status: result.status, tools: result.tools, denied: result.denied, ownCanary: result.answer.includes(user.canary), otherCanaryAbsent: !result.answer.includes(other.canary), denialText: result.answer.includes("DENIED"), passed: result.status === "completed" && result.answer.includes(user.canary) && !result.answer.includes(other.canary) && result.answer.includes("DENIED") && result.tools >= 2 && result.denied >= 2 });
 }));
 await driver.close();
 for (const user of users) {
  const check = report.checks.find(check => check.user === user.id && check.phase === "restart-own-positive-other-negative");
  check.readEvidence = await readEvidence(user, users.find(other => other !== user));
  check.passed &&= Object.values(check.readEvidence).every(Boolean);
 }
 report.passed = report.checks.length === 4 && report.checks.every(check => check.passed);
} catch { report.passed = false; report.error = "CLAUDE_CONFORMANCE_FAILED"; }
finally { await driver?.close(); clearTimeout(keepAlive); await rm(path, { recursive: true, force: true }); }
await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, dirty, checks: report.checks.length, reportSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") }));
if (!report.passed) process.exitCode = 1;
