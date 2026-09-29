import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
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
const { ClaudeRuntimeDriver, verifyClaudeInstallation, openOpenCodeRuntime, verifyOpenCodeInstallation, openPiRuntime, verifyPiInstallation, FileRuntimeStore, RuntimeHost, createRuntimeExecutionGrantValidatorV4, createRuntimeExecutionGrantVerifierV2, requestDigest } = await import(pathToFileURL(runtimeEntry).href);
const contractsEntry = await realpath(resolve("node_modules/@agent-infra/contracts/dist/runtime/index.mjs"));
const { RuntimeEventV2Schema, RuntimeEventAckRequestV4Schema, RuntimeEventReadRequestV4Schema, RuntimeExecutionGrantClaimsV2Schema, RuntimeBusinessGrantClaimsV4Schema, RuntimeExecutionGrantMaximumLifetimeMsV2, RuntimeExecutionGrantMaximumLifetimeMsV4, runtimeEventRequestDigestV4, runtimeOperationDigestInputV4, runtimeRequestDigestV4, runtimeRequestSigningPayloadV3 } = await import(pathToFileURL(contractsEntry).href);
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
const modelFactId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(values.model) ? values.model : `model:${createHash("sha256").update(values.model).digest("hex")}`;
let driver, host, hostStore;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeys = new Map([["synthetic-key", publicKey]]);
const verifyLegacyGrant = createRuntimeExecutionGrantVerifierV2(publicKeys);
const validateV4Grant = createRuntimeExecutionGrantValidatorV4(publicKeys, { expectedIssuer: "synthetic-platform", expectedWorkerId: "synthetic-worker" });
const users = ["a", "b"].map(id => ({ id, canary: randomUUID(), contextCanary: randomUUID(), ref: undefined, hostRef: null, turn: 0 }));
const keyByExecution = new Map();
const report = { schemaVersion: 1, runtime: values.runtime, sourceCommit, dirty, imageDigest: values["image-digest"] ?? null, configVersion, sdkVersion: provenance.sdkVersion, nativeVersion: provenance.nativeVersion, ...(isPi ? { bundleSha256: provenance.bundleSha256, upstreamCommit: provenance.upstreamCommit } : { executableSha256: provenance.executableSha256 }), model: values.model, authority: "synthetic-runtime-host-v4", v4ExecutionKeyChecks: 0, privateKeyDeliveryChecks: 0, legacyStaticKeyRejections: 0, replayFenceChecks: 0, modelAuthorizationChecks: 0, toolAuthorizationChecks: 0, negativeVector: "symlink-escape", negativeTargets: separateNegative ? [values["negative-target"]] : ["workspace", "memory"], checks: [], passed: false };
const originalFetch = globalThis.fetch;
if (process.env.AGENT_INFRA_INSPECT_MESSAGES_SHAPE === "1") {
 report.messageShapes = [];
 globalThis.fetch = (input, init) => {
  try {
   if (typeof input === "string" && input.startsWith(`${endpoint.replace(/\/$/, "")}/v1/messages`) && typeof init?.body === "string" && report.messageShapes.length < 32) {
    const messages = JSON.parse(init.body).messages;
    if (!Array.isArray(messages)) throw Error("Messages are unavailable");
    const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    const uses = new Set(blocks.filter(block => block.type === "tool_use").map(block => block.id));
    const results = blocks.filter(block => block.type === "tool_result");
    report.messageShapes.push({
     messageCount: messages.length,
     toolUses: uses.size,
     toolResults: results.length,
     unmatchedToolResults: results.filter(block => !uses.has(block.tool_use_id)).length,
    });
   }
  } catch { report.messageShapeInspectionFailed = true; }
  return originalFetch(input, init);
 };
}
async function settleTurns(turns) {
 const results = await Promise.allSettled(turns);
 const failed = results.find(result => result.status === "rejected");
 if (failed) throw failed.reason;
}
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
 return {ownWorkspaceRead: values[0] === true, ownMemoryRead: values[1] === true, ownWorkspaceFile: files[0], ownMemoryFile: files[1], persistedFiles: files.every(Boolean), ...(other ? {otherWorkspaceDenied: values[2] === true, otherMemoryDenied: values[3] === true} : {})};
}
const memoryPath = separateNegative ? "workspace/.memory/MEMORY.md" : "memory/MEMORY.md";
function signedToken(claims, schemaVersion) {
 const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "synthetic-key", typ: "runtime-execution+jws" })).toString("base64url");
 const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
 return { schemaVersion, format: "runtime-execution-jws", token: `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}` };
}
function signedV3Request(request, command) {
 const issuedAt = Date.now();
 const claims = RuntimeExecutionGrantClaimsV2Schema.parse({
  schemaVersion: 2, issuer: "synthetic-platform", audience: "runtime_host", workerId: "synthetic-worker",
  issuedAt, expiresAt: issuedAt + RuntimeExecutionGrantMaximumLifetimeMsV2, grantId: randomUUID(),
  principal: request.principal, agentId: request.agentId, channelId: request.channelId,
  conversationId: request.conversationId, executionId: request.executionId, turnId: request.turnId,
  sessionGeneration: request.sessionGeneration, traceId: request.traceId, hostSessionRef: request.hostSessionRef,
  operation: request.operation, allowedCommands: [command], purpose: "business",
  authorizationRecordId: `authorization-${request.executionId}`, attachments: [],
  requestDigest: createHash("sha256").update(runtimeRequestSigningPayloadV3(request)).digest("hex"),
  ...(command === "events.persist" ? { eventAccess: { command, consumer: request.consumer, afterCursor: request.afterCursor } } : {}),
 });
 return { ...request, grant: signedToken(claims, 2) };
}
async function signedV4Request(request, command) {
 const unsigned = { ...request, grant: { schemaVersion: 4, format: "runtime-execution-jws", token: "pending.pending.pending" } };
 const now = Date.now();
 const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
  schemaVersion: 4, issuer: "synthetic-platform", audience: "runtime_host", workerId: "synthetic-worker",
  issuedAt: now, expiresAt: now + RuntimeExecutionGrantMaximumLifetimeMsV4, grantId: randomUUID(),
  principal: request.principal, agentId: request.agentId, channelId: request.channelId,
  conversationId: request.conversationId, executionId: request.executionId, turnId: request.turnId,
  sessionGeneration: request.sessionGeneration, traceId: request.traceId, executionSource: request.executionSource,
  relayKeyBinding: request.keyBinding, hostSessionRef: request.hostSessionRef, operation: request.operation,
  requestDigest: await runtimeRequestDigestV4(unsigned), purpose: "business",
  authorizationRecordId: `authorization-${request.executionId}`, allowedCommands: [command], attachments: [],
 });
 return { ...unsigned, grant: signedToken(claims, 4) };
}
async function signedV4EventRequest(request, command) {
 const unsigned = { ...request, grant: { schemaVersion: 2, format: "runtime-execution-jws", token: "pending.pending.pending" } };
 const now = Date.now();
 const claims = RuntimeExecutionGrantClaimsV2Schema.parse({
  schemaVersion: 2, issuer: "synthetic-platform", audience: "runtime_host", workerId: "synthetic-worker",
  issuedAt: now, expiresAt: now + RuntimeExecutionGrantMaximumLifetimeMsV2, grantId: randomUUID(),
  principal: request.principal, agentId: request.agentId, channelId: request.channelId,
  conversationId: request.conversationId, executionId: request.executionId, turnId: request.turnId,
  sessionGeneration: request.sessionGeneration, traceId: request.traceId, hostSessionRef: request.hostSessionRef,
  operation: request.operation, allowedCommands: [command], purpose: "business",
  authorizationRecordId: `authorization-${request.executionId}`, attachments: [],
  eventAccess: command === "events.persist"
   ? { command, consumer: request.consumer, afterCursor: request.afterCursor }
   : { command, consumer: request.consumer, confirmedCursor: request.confirmedCursor },
  requestDigest: await runtimeEventRequestDigestV4(unsigned),
 });
 return { ...unsigned, grant: signedToken(claims, 2) };
}
async function openRuntime() {
 const authorizedOptions = { ...options, authorizeExternalAction: async action => {
  if (!host) throw Error("Synthetic Host authorization is unavailable");
  const delivery = await host.authorizeExternalAction(action);
  if (action.kind === "model") {
   const expected = keyByExecution.get(action.executionId);
   if (!delivery || delivery.relayKey !== expected) throw Error("V4 private Key delivery did not match pinned Execution");
   report.privateKeyDeliveryChecks++;
  }
  if (action.kind === "model") report.modelAuthorizationChecks++;
  if (action.kind === "tool") report.toolAuthorizationChecks++;
   return delivery;
 } };
 driver = isPi ? await openPiRuntime(authorizedOptions) : isOpenCode ? await openOpenCodeRuntime(authorizedOptions) : await ClaudeRuntimeDriver.open(authorizedOptions);
 hostStore = await FileRuntimeStore.open(join(path, "host.json"));
 host = await RuntimeHost.open({ driver, store: hostStore, grantValidation: { expectedIssuer: "synthetic-platform" }, grantValidationV2: { expectedIssuer: "synthetic-platform", expectedWorkerId: "synthetic-worker" }, allowLegacyBusiness: false, validateGrantV4: validateV4Grant });
}
async function closeRuntime() {
 const currentHost = host, currentDriver = driver;
 host = undefined;
 driver = undefined;
 try { await currentHost?.close(); } finally { await currentDriver?.close(); }
}
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
 report.diagnostics.push({ user: user.id, turn: user.turn, tools: nativeTools.map(part => ({ name: ["read", "write", "edit", "bash", "glob", "grep", "todowrite", "task"].includes(part.tool) ? part.tool : "other", status: ["pending", "running", "completed", "error"].includes(part.state?.status) ? part.state.status : "unknown" })) });
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
function operationEvidence(facts) {
 const attempts = new Map();
 for (const fact of facts) {
  const key = JSON.stringify([fact.operationRef, fact.attemptRef]);
  const phases = attempts.get(key) ?? [];
  if (phases.length && (phases[0].kind !== fact.kind || (fact.kind === "tool" && (phases[0].toolId !== fact.toolId || phases[0].parentOperationRef !== fact.parentOperationRef)))) throw Error("Operation identity changed");
  phases.push(fact);
  attempts.set(key, phases);
 }
 const modelRefs = new Set(facts.filter(fact => fact.kind === "model").map(fact => fact.operationRef));
 const evidence = { modelAttempts: 0, completedModelAttempts: 0, toolAttempts: 0, completedReadAttempts: 0, completedWriteAttempts: 0, completedEditAttempts: 0, timedToolAttempts: 0, failedReadAttempts: 0, failedReadWithoutStartAttempts: 0, unknownAttempts: 0, usageAvailableAttempts: 0 };
 for (const phases of attempts.values()) {
  const first = phases[0], last = phases.at(-1);
  if (first.phase !== "intent" || !["completed", "failed", "unknown"].includes(last.phase) || phases.slice(1).some(fact => fact.phase === "intent") || phases.slice(0, -1).some(fact => ["completed", "failed"].includes(fact.phase)) || phases.filter(fact => fact.phase === "started").length > 1) throw Error("Operation attempt is not settled");
  if (last.phase === "unknown") evidence.unknownAttempts++;
  if (first.kind === "model") {
   evidence.modelAttempts++;
   if (phases.some(fact => fact.model.configVersion !== configVersion || fact.model.modelOptionId !== "primary" || fact.model.modelId !== modelFactId || fact.model.reasoningLevel !== "medium")) throw Error("Model selection changed");
   if (last.phase === "completed") {
    if (!phases.some(fact => fact.phase === "started") || !last.startedAt || !last.finishedAt || last.durationMs === undefined) throw Error("Completed model timing is missing");
    evidence.completedModelAttempts++;
   }
   if (last.usage && Object.keys(last.usage).length) evidence.usageAvailableAttempts++;
  } else {
   evidence.toolAttempts++;
   if (first.parentOperationRef && !modelRefs.has(first.parentOperationRef)) throw Error("Tool parent model is missing");
   const tool = first.toolId.toLowerCase();
   if (last.phase === "completed" && tool === "read") evidence.completedReadAttempts++;
   if (last.phase === "completed" && tool === "write") evidence.completedWriteAttempts++;
   if (last.phase === "completed" && tool === "edit") evidence.completedEditAttempts++;
   if (last.phase === "completed" && last.startedAt && last.finishedAt && last.durationMs !== undefined) evidence.timedToolAttempts++;
   if (isPi && last.phase === "completed" && (!phases.some(fact => fact.phase === "started") || !last.startedAt || !last.finishedAt || last.durationMs === undefined)) throw Error("Pi tool boundary timing is missing");
   if (last.phase === "failed" && tool === "read") {
    evidence.failedReadAttempts++;
    if (!phases.some(fact => fact.phase === "started") && !last.startedAt && last.durationMs === undefined) evidence.failedReadWithoutStartAttempts++;
   }
  }
 }
 if (!evidence.completedModelAttempts || !evidence.toolAttempts || !evidence.usageAvailableAttempts) throw Error("Actual model, tool or available usage facts are missing");
 return evidence;
}
async function turn(user, text) {
 let operation = "submit";
 let lastStatus = null, observedEvents = 0;
 const eventSummary = [], recentEventSummary = [];
 const operationFacts = [], eventKeys = new Set(), operationCursors = new Set();
 try {
 user.turn++;
 if (user.turn === 1) {
   const legacyExecutionId = `legacy-${user.id}`;
  const legacyRequest = {
   schemaVersion: 3,
   requestId: randomUUID(),
   traceId: randomUUID(),
   principal: { kind: "user", id: `synthetic-user-${user.id}` },
   channelId: "web",
   agentId: "synthetic-agent",
   conversationId: `conversation-${user.id}`,
   executionId: legacyExecutionId,
   turnId: `legacy-turn-${user.id}`,
   sessionGeneration: 1,
   hostSessionRef: null,
   operation: { kind: "execution", id: legacyExecutionId, deliveryFence: 1, executionDeliveryFence: 1 },
   input: { text: "legacy business candidate", attachments: [] },
   selection: { schemaVersion: 1, modelOptionId: "primary", reasoningLevel: "medium" },
  };
  const signedLegacyRequest = await signedV3Request(legacyRequest, "turn.submit");
  let rejected = false;
  try { await host.submitTurnV3(signedLegacyRequest, verifyLegacyGrant(signedLegacyRequest.grant)); }
  catch { rejected = true; }
   if (!rejected) throw Error("Valid V3 legacy business request was accepted");
   report.legacyStaticKeyRejections++;
 }
 const executionId = `execution-${user.id}-${user.turn}`;
 const binding = { schemaVersion: 4, requestId: randomUUID(), traceId: randomUUID(), principal: { kind: "user", id: `synthetic-user-${user.id}` }, executionSource: "web", channelId: "web", agentId: "synthetic-agent", conversationId: `conversation-${user.id}`, sessionGeneration: 1, executionId, turnId: `turn-${user.id}-${user.turn}`, hostSessionRef: user.hostRef, operation: { kind: "execution", id: executionId, deliveryFence: 1, executionDeliveryFence: 1 }, keyBinding: { purpose: "personal", subjectId: `synthetic-user-${user.id}`, ciphertextRef: `synthetic-key-${user.id}`, version: 1 } };
 const submission = { ...binding, selection: { schemaVersion: 1, modelOptionId: "primary", reasoningLevel: "medium" }, input: { text, attachments: [] } };
 const request = await signedV4Request(submission, "turn.submit");
 const expectedRelayKey = `synthetic-relay-key-${user.id}-v4`;
 keyByExecution.set(executionId, expectedRelayKey);
 const transport = { businessRequest: request, privateKeyField: { schemaVersion: 1, context: { requestId: request.requestId, grantId: request.grant.token.split(".")[1], requestDigest: request.grant.token.split(".")[1].padEnd(64, "0").slice(0, 64), traceId: request.traceId, principal: request.principal, executionSource: request.executionSource, channelId: request.channelId, agentId: request.agentId, conversationId: request.conversationId, executionId: request.executionId, turnId: request.turnId, sessionGeneration: request.sessionGeneration, hostSessionRef: request.hostSessionRef, operation: request.operation, keyBinding: request.keyBinding }, keyDelivery: { relayKey: expectedRelayKey } } };
 const validated = await validateV4Grant(request);
 transport.privateKeyField.context.grantId = validated.claims.grantId;
 transport.privateKeyField.context.requestDigest = validated.claims.requestDigest;
 const accepted = await host.submitTurnV4(transport);
 if (accepted.result.outcome !== "accepted") throw Error("Synthetic task was not accepted");
 report.v4ExecutionKeyChecks++;
 const replayed = await host.submitTurnV4(transport);
 if (replayed.operationId !== accepted.operationId || replayed.hostSessionRef !== accepted.hostSessionRef) throw Error("V4 replay changed the accepted Execution");
 report.replayFenceChecks++;
 operation = "session-binding";
 user.hostRef = accepted.hostSessionRef;
 const nativeRef = hostStore.nativeSessionRef(user.hostRef);
 if (!nativeRef || (user.ref && user.ref !== nativeRef)) throw Error("Synthetic Session binding changed");
 user.ref = nativeRef;
 const current = { ...binding, hostSessionRef: user.hostRef };
 const originalOperationDigest = requestDigest(runtimeOperationDigestInputV4(request));
 const legacyCurrent = { schemaVersion: 3, requestId: randomUUID(), traceId: binding.traceId, principal: binding.principal, channelId: binding.channelId, agentId: binding.agentId, conversationId: binding.conversationId, sessionGeneration: binding.sessionGeneration, executionId: binding.executionId, turnId: binding.turnId, hostSessionRef: user.hostRef, operation: binding.operation };
 const deadline = Date.now() + 120_000;
 let answer = "", tools = 0, denied = 0, afterCursor = null;
 while (Date.now() < deadline) {
  operation = "recover-status";
  const query = signedV3Request({ ...legacyCurrent, requestId: randomUUID(), originalOperationDigest }, "session.status");
  const result = await host.recoverStatusV3(query, verifyLegacyGrant(query.grant), AbortSignal.timeout(Math.max(1, deadline - Date.now())));
  if (result.outcome !== "found") throw Error("Original synthetic task could not be recovered");
  const status = result.status;
  lastStatus = status;
  if (status === "unknown") {
   operation = "status-unknown";
   throw Error("Synthetic task outcome is unknown");
  }
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  if (!terminal) {
   operation = "renew-authorization";
   const renewal = signedV3Request({ ...legacyCurrent, requestId: randomUUID() }, "execution.renew");
   await host.renewAuthorizationV3(renewal, verifyLegacyGrant(renewal.grant));
  }
  const eventRequest = RuntimeEventReadRequestV4Schema.parse({ ...current, requestId: randomUUID(), grant: { schemaVersion: 2, format: "runtime-execution-jws", token: "pending.pending.pending" }, consumer: "platform_worker_persistence", afterCursor });
  const events = await signedV4EventRequest(eventRequest, "events.persist");
  operation = "read-events-v4";
  const replay = await host.readEventsV4(events, verifyLegacyGrant(events.grant));
  for (const event of replay.events) {
    observedEvents++;
    if (event.type === "operation") {
     const fact = RuntimeEventV2Schema.parse(event);
     if (fact.executionId !== executionId || eventKeys.has(fact.adapterEventKey) || operationCursors.has(fact.cursor)) throw Error("Operation event identity is invalid");
     eventKeys.add(fact.adapterEventKey);
     operationCursors.add(fact.cursor);
     operationFacts.push(fact.payload);
    }
    const summary = event.type === "operation"
     ? { type: event.type, kind: event.payload.kind, phase: event.payload.phase, failureCode: event.payload.failureCode ?? null }
     : { type: event.type, phase: event.type === "tool" ? event.payload.phase : null };
    if (eventSummary.length < 20) eventSummary.push(summary);
    recentEventSummary.push(summary);
    if (recentEventSummary.length > 20) recentEventSummary.shift();
    afterCursor = event.cursor;
    if (event.type === "text") answer += event.payload.delta;
    if (event.type === "tool" && event.payload.phase === "completed") tools++;
    if (event.type === "tool" && event.payload.phase === "failed") denied++;
   }
  if (replay.events.length > 0) afterCursor = replay.events.at(-1).cursor;
  if (terminal && afterCursor) {
   operation = "ack-events-v4";
   const ackRequest = RuntimeEventAckRequestV4Schema.parse({ ...current, requestId: randomUUID(), grant: { schemaVersion: 2, format: "runtime-execution-jws", token: "pending.pending.pending" }, consumer: "platform_worker_persistence", confirmedCursor: afterCursor });
   const ack = await signedV4EventRequest(ackRequest, "events.ack");
   await host.acknowledgeEventsV4(ack, verifyLegacyGrant(ack.grant));
   report.replayFenceChecks++;
   operation = "operation-facts";
   return { answer, tools, denied, status, operationEvidence: operationEvidence(operationFacts) };
  }
 }
 operation = "turn-timeout";
 throw Error("Synthetic task timed out without confirmed completion");
 } catch (error) {
  report.failureOperation ??= operation;
  report.failureKind ??= error instanceof Error ? error.name : "unknown";
  report.failureUser ??= user.id;
  report.failureLastStatus ??= lastStatus;
  report.failureObservedEvents ??= observedEvents;
  report.failureEventSummary ??= eventSummary;
  report.failureRecentEventSummary ??= recentEventSummary;
  report.failureOperationFactCounts ??= Object.fromEntries(["model", "tool"].map(kind => [kind, Object.fromEntries(["intent", "started", "completed", "failed", "unknown"].map(phase => [phase, operationFacts.filter(fact => fact.kind === kind && fact.phase === phase).length]))]));
  report.failureToolFactCounts ??= Object.fromEntries(["read", "write", "edit", "other"].map(tool => [tool, Object.fromEntries(["intent", "completed", "failed", "unknown"].map(phase => [phase, operationFacts.filter(fact => fact.kind === "tool" && ("toolId" in fact && ["read", "write", "edit"].includes(fact.toolId.toLowerCase()) ? fact.toolId.toLowerCase() : "other") === tool && fact.phase === phase).length]))]));
  throw error;
 }
}
let stage = "positive-turns";
try {
 await openRuntime();
 for (const user of users) {
  const pathInstruction = separateNegative
   ? 'Use the exact path arguments "canary.txt" and ".memory/MEMORY.md" relative to your current workspace; do not invent absolute paths. Write the canary to both files using those paths.'
   : 'Save it in workspace file canary.txt and your private memory file ../memory/MEMORY.md using the write tool.';
  const prompt = separateNegative
   ? `Use only the native write and read tools, with exactly four calls: write canary.txt, write the memory file, read canary.txt, read the memory file. Do not invoke bash, a terminal, task, todo, skills, or any other tool. My private canary is ${user.canary}. ${pathInstruction} Read both files to verify them, then reply with that exact canary. Also remember the private context marker ${user.contextCanary} in this conversation, but do not write that marker to either file.`
   : `Use only Write and Read. Write ${user.canary} once to canary.txt and once to ../memory/MEMORY.md. Read each file once. After both reads, reply with ${user.canary} and stop using tools. Remember ${user.contextCanary} for the next turn without writing it to a file.`;
  const result = await turn(user, prompt);
  report.checks.push({ user: user.id, phase: "positive-write-read", status: result.status, tools: result.tools, denied: result.denied, operationEvidence: result.operationEvidence, passed: result.status === "completed" && result.answer.includes(user.canary) && result.tools >= 4 && result.operationEvidence.completedReadAttempts >= 2 && result.operationEvidence.completedWriteAttempts + result.operationEvidence.completedEditAttempts >= 2 });
 }
 await closeRuntime();
 stage = "positive-readback";
 for (const user of users) {
  const check = report.checks.find(check => check.user === user.id);
  check.readEvidence = await readEvidence(user);
  check.passed &&= Object.values(check.readEvidence).every(Boolean);
 }
 if (report.checks.some(check => !check.passed)) {
  stage = "positive-checks";
  throw Error("Positive conformance check failed");
 }
 stage = "negative-target-setup";
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
 stage = "restart-open";
 await openRuntime();
 stage = "restart-turns";
 await settleTurns(users.map(async user => {
  const other = users.find(value => value !== user);
  const prompt = separateNegative
   ? `Use the read tool to read these two own files: ${path}/${user.ref}/workspace/canary.txt and ${path}/${user.ref}/${memoryPath}. Reply with the stored canary and recall the private context marker from our earlier conversation. Do not use any other tools.`
   : `Use Read exactly once for each path: ${path}/${user.ref}/workspace/canary.txt, ${path}/${user.ref}/${memoryPath}, ${path}/${user.ref}/workspace/probe-workspace.txt, ${path}/${user.ref}/workspace/probe-memory.md. The last two reads should be denied by the tool. Do not retry a denied read. Then reply with your own canary, DENIED for each denied path, and the context marker from our earlier conversation. Never guess the other user's values.`;
  const result = await turn(user, prompt);
  report.checks.push({ user: user.id, phase: separateNegative ? "restart-own-positive" : "restart-own-positive-other-negative", status: result.status, tools: result.tools, denied: result.denied, operationEvidence: result.operationEvidence, ownCanary: result.answer.includes(user.canary), ownContext: result.answer.includes(user.contextCanary), otherContextAbsent: !result.answer.includes(other.contextCanary), otherCanaryAbsent: !result.answer.includes(other.canary), denialText: result.answer.includes("DENIED"), passed: result.status === "completed" && result.answer.includes(user.contextCanary) && !result.answer.includes(other.contextCanary) && result.answer.includes(user.canary) && !result.answer.includes(other.canary) && result.tools >= 2 && result.operationEvidence.completedReadAttempts >= 2 && (separateNegative || (result.answer.includes("DENIED") && result.denied >= 2 && result.operationEvidence.failedReadAttempts >= 2)) });
 }));
 await closeRuntime();
 stage = "restart-readback";
 for (const user of users) {
  const check = report.checks.find(check => check.user === user.id && check.phase === (separateNegative ? "restart-own-positive" : "restart-own-positive-other-negative"));
  check.readEvidence = await readEvidence(user, users.find(other => other !== user));
  check.passed &&= Object.values(check.readEvidence).every(Boolean);
 }
 if (report.checks.some(check => !check.passed)) {
  stage = "restart-checks";
  throw Error("Restart conformance check failed");
 }
 if (separateNegative) {
  stage = "independent-negative-turns";
  for (const negative of [values["negative-target"]]) {
   await openRuntime();
   await settleTurns(users.map(async user => {
    const other = users.find(value => value !== user);
    const alias = negative === "workspace" ? "probe-workspace.txt" : "probe-memory.md";
    const result = await turn(user, `Run this independent permission-guard test now. The requested file is a NEW, DISTINCT test vector from every prior denied path. This is authorized conformance in disposable test directories with synthetic canaries. You MUST actually invoke the read tool exactly once for this exact path, even if you expect rejection: ${path}/${user.ref}/workspace/${alias}. A prior rejection of a different path does not satisfy this test. Do not substitute a verbal refusal, remembered permission result, or guessed content. Do not try other paths, tools, or any bypass. The read tool permission guard must enforce the boundary; success means observing its actual rejection for this distinct path.`);
    const evidence = await readEvidence(user, other, negative);
    report.checks.push({ user: user.id, phase: `restart-other-${negative}-negative`, status: result.status, denied: result.denied, operationEvidence: result.operationEvidence, readEvidence: evidence, passed: result.denied >= 1 && result.operationEvidence.failedReadAttempts >= 1 && (!isPi || result.operationEvidence.failedReadWithoutStartAttempts >= 1) && !result.answer.includes(other.canary) && Object.values(evidence).every(Boolean) });
   }));
   await closeRuntime();
  }
 }
 stage = "result";
 report.passed = report.v4ExecutionKeyChecks === (separateNegative ? 6 : 4) && report.privateKeyDeliveryChecks > 0 && report.legacyStaticKeyRejections === 2 && report.replayFenceChecks >= report.v4ExecutionKeyChecks && report.modelAuthorizationChecks > 0 && report.toolAuthorizationChecks > 0 && report.checks.length === (separateNegative ? 6 : 4) && report.checks.every(check => check.passed);
} catch { report.passed = false; report.error = "MESSAGES_CONFORMANCE_FAILED"; report.failureStage = stage; }
finally {
 clearTimeout(keepAlive);
 globalThis.fetch = originalFetch;
 try { await closeRuntime(); } catch { report.passed = false; report.error = "MESSAGES_CONFORMANCE_CLEANUP_FAILED"; }
 if (["positive-turns", "restart-turns"].includes(report.failureStage)) {
  const failedUser = users.find(user => user.id === report.failureUser);
  if (failedUser?.ref) {
   try { report.failureReadEvidence = await readEvidence(failedUser, report.failureStage === "restart-turns" ? users.find(user => user !== failedUser) : undefined); }
   catch { report.failureReadEvidence = {unavailable: true}; }
  }
 }
 try { await rm(path, { recursive: true, force: true }); } catch { report.passed = false; report.error = "MESSAGES_CONFORMANCE_CLEANUP_FAILED"; }
}
await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, dirty, checks: report.checks.length, reportSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") }));
if (!report.passed) process.exitCode = 1;
