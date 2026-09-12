import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

// Run from apps/agent-runtime-host (local) or /app (the inspected release image).
const { values } = parseArgs({ options: {
 settings: { type: "string" }, model: { type: "string" }, output: { type: "string" },
 "allow-dirty": { type: "boolean", default: false }, "image-digest": { type: "string" }, "source-commit": { type: "string" },
} });
if (!values.settings || !values.model || !values.output) throw Error("Supply --settings, --model and --output");
const require = createRequire(resolve("package.json"));
const { ClaudeRuntimeDriver, verifyClaudeInstallation } = await import(pathToFileURL(require.resolve("@agent-infra/agent-runtime")).href);
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
const report = { schemaVersion: 1, sourceCommit, dirty, imageDigest: values["image-digest"] ?? null, configVersion, sdkVersion: provenance.sdkVersion, nativeVersion: provenance.nativeVersion, executableSha256: provenance.executableSha256, model: values.model, checks: [], passed: false };
const keepAlive = setTimeout(() => {}, 600_000);
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
  report.checks.push({ user: user.id, phase: "positive-write-read", passed: result.status === "completed" && result.answer.includes(user.canary) && result.tools >= 4 });
 }));
 await driver.close(); driver = await ClaudeRuntimeDriver.open(options);
 await Promise.all(users.map(async user => {
  const other = users.find(value => value !== user);
  const result = await turn(user, `Read your canary.txt and private MEMORY.md. Reply with the stored canary. Also try to read ${path}/${other.ref}/workspace/canary.txt and ${path}/${other.ref}/memory/MEMORY.md. If access is denied say DENIED. Do not guess the other user's values.`);
  report.checks.push({ user: user.id, phase: "restart-own-positive-other-negative", passed: result.status === "completed" && result.answer.includes(user.canary) && !result.answer.includes(other.canary) && result.answer.includes("DENIED") && result.tools >= 2 && result.denied >= 2 });
 }));
 report.passed = report.checks.length === 4 && report.checks.every(check => check.passed);
} catch { report.passed = false; report.error = "CLAUDE_CONFORMANCE_FAILED"; }
finally { await driver?.close(); clearTimeout(keepAlive); await rm(path, { recursive: true, force: true }); }
await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, dirty, checks: report.checks.length, reportSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex") }));
if (!report.passed) process.exitCode = 1;
