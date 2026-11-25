import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { conversationTurns } from "../../tests/local-real-e2e/conversation-turn-plan.ts";
import { templateValidationContextV1Schema } from "../../packages/model-catalog/dist/index.mjs";
import { privateBytes, privateJson } from "./private-input.ts";
import { assertLoginOutputsCommitted, loginOutputBytes, promoteLoginOutputs, recoverLoginOutputs } from "./login-output-promotion.ts";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { request } = requireWeb("@playwright/test");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const identityKey = "deployment-identities.json";

function externalServiceTrial(target: unknown, sourceSha?: string) {
	if (target === undefined) return false;
	const context = templateValidationContextV1Schema.parse(target);
	assert(context.namespace === "agent-infra-ext4425" &&
		(sourceSha === undefined || context.sourceCommit === sourceSha), "LOGIN_TRIAL_TARGET_INVALID");
	return true;
}

export async function loginConfiguration(file: string, trialTarget?: unknown, sourceSha?: string) {
	const singleOwnerAllowed = externalServiceTrial(trialTarget, sourceSha);
	const input = await privateJson(file);
	assert(input.schemaVersion === 1 && Object.keys(input).every((k) => ["schemaVersion", "origin", "identityFile", "identitySecretRef", "subjects", "blueprints"].includes(k)));
	const url = new URL(input.origin);
	assert((url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) && url.origin === input.origin && !url.username && !url.password);
	assert(Array.isArray(input.subjects) && input.subjects.length >= (singleOwnerAllowed ? 1 : 2) && input.subjects.length <= 4);
	assert(input.identitySecretRef?.key === identityKey && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(input.identitySecretRef.name));
	assert(Array.isArray(input.blueprints) && input.blueprints.length <= 20 && new Set(input.blueprints).size === input.blueprints.length);
	if (input.subjects.length === 1) assert(input.subjects[0]?.name === "owner" && input.blueprints.length === 0, "LOGIN_SINGLE_OWNER_INVALID");
	const inputs = [file];
	const outputs = [input.identityFile, ...input.blueprints];
	const names = new Set();
	for (const subject of input.subjects) {
		assert(Object.keys(subject).every((k) => ["name", "oidcStorageStateFile", "storageStateFile"].includes(k)));
		assert(/^[a-z][a-z0-9_-]{0,31}$/u.test(subject.name) && !["constructor", "prototype"].includes(subject.name) && !names.has(subject.name));
		names.add(subject.name);
		const source = subject.oidcStorageStateFile;
		assert(typeof source === "string" && isAbsolute(source) && resolve(source) === source && !inputs.includes(source), "LOGIN_SUBJECT_INVALID");
		inputs.push(source);
		outputs.push(subject.storageStateFile);
	}
	assert(new Set(outputs).size === outputs.length && outputs.every((p) => !inputs.includes(p)), "LOGIN_OUTPUT_ALIAS");
	const before = new Map<string, Buffer | null>();
	for (const file of outputs) before.set(file, await loginOutputBytes(file));
	const subjects = [];
	const tokens = new Set();
	for (const subject of input.subjects) {
		const state = platformState(await privateJson(subject.oidcStorageStateFile), input.origin);
		const token = state.cookies[0].value;
		assert(!tokens.has(token), "LOGIN_SUBJECTS_NOT_DISTINCT");
		tokens.add(token);
		subjects.push({ ...subject, state });
	}
	const stateFiles = new Set(subjects.map((s) => s.storageStateFile));
	const blueprints = [];
	for (const file of input.blueprints) {
		const value = await privateJson(file);
		assert(value.origin === input.origin && value.owner && value.other && value.owner.stateFile !== value.other.stateFile);
		assert(stateFiles.has(value.owner.stateFile) && stateFiles.has(value.other.stateFile), "LOGIN_BLUEPRINT_SUBJECT_UNKNOWN");
		conversationTurns(value);
		blueprints.push({ file, value });
	}
	return { input, before, subjects, blueprints };
}

async function session(context: any) {
	const response = await context.get("/api/v1/session", { timeout: 30_000, maxRedirects: 0 });
	assert.equal(response.status(), 200, "LOGIN_SESSION_READ_FAILED");
	const value = await response.json();
	assert(value.schemaVersion === 1 && uuid.test(value.user?.userId), "LOGIN_SESSION_INVALID");
	return value.user.userId as string;
}

/** Only the host-bound Platform session may leave the operator-supplied browser state. */
function platformState(state: any, origin: string) {
	const url = new URL(origin);
	assert(Array.isArray(state?.cookies) && Array.isArray(state.origins), "LOGIN_COOKIE_INVALID");
	const matches = state.cookies.filter((c: any) => c?.name === "__Host-platform-session" && c.domain === url.hostname);
	assert(matches.length === 1, "LOGIN_COOKIE_INVALID");
	const {name, domain, path, httpOnly, secure, sameSite, value, expires, partitionKey} = matches[0];
	assert(path === "/" && httpOnly === true && typeof secure === "boolean" && (url.protocol !== "https:" || secure) &&
		sameSite === "Lax" && typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value) && partitionKey === undefined &&
		Number.isFinite(expires) && (expires === -1 || expires > Date.now() / 1000), "LOGIN_COOKIE_INVALID");
	return {cookies: [{name, domain, path, httpOnly, secure, sameSite, value, expires}], origins: []};
}

async function readSession(origin: string, state: any) {
	const context = await request.newContext({baseURL:origin,storageState:platformState(state,origin),ignoreHTTPSErrors:false});
	try { return await session(context); } finally { await context.dispose(); }
}

async function verifiedInputStates(config: Awaited<ReturnType<typeof loginConfiguration>>) {
	const states = new Map<string, { userId: string; state: any }>();
	const ids = new Set<string>();
	for (const subject of config.subjects) {
		const userId = await readSession(config.input.origin, subject.state);
		assert(!ids.has(userId), "LOGIN_SUBJECTS_NOT_DISTINCT");
		ids.add(userId);
		states.set(subject.storageStateFile,{userId,state:subject.state});
	}
	for (const {userId,state} of states.values())
		assert.equal(await readSession(config.input.origin, state), userId, "LOGIN_SESSION_CHANGED");
	return states;
}

export async function bootstrapLogin(configFile: string, sourceSha: string, expectedOrigin?: string, trialTarget?: unknown) {
	assert(/^[a-f0-9]{40}$/u.test(sourceSha));
	const config = await loginConfiguration(configFile, trialTarget, sourceSha);
	await assertLoginOutputsCommitted(config.input.identityFile);
	if (expectedOrigin !== undefined) assert.equal(config.input.origin, expectedOrigin, "LOGIN_ORIGIN_MISMATCH");
	const states = await verifiedInputStates(config);
	const subjects: Record<string, { userId: string }> = Object.fromEntries(config.subjects.map((s) => [s.name, { userId: states.get(s.storageStateFile)!.userId }]));
	const candidate = { schemaVersion: 1, sourceSha, origin: config.input.origin, createdAt: Date.now(), subjects };
	const outputs = new Map<string, any>([[config.input.identityFile, candidate]]);
	for (const [file, value] of states) outputs.set(file, value.state);
	for (const { file, value } of config.blueprints) outputs.set(file, { ...value,
		owner: { ...value.owner, userId: states.get(value.owner.stateFile)!.userId },
		other: { ...value.other, userId: states.get(value.other.stateFile)!.userId } });
	await promoteLoginOutputs(config.input.identityFile, config.before, outputs);
	return { schemaVersion: 1, kind: "ack-bootstrap-login", subjectCount: states.size, blueprintCount: config.blueprints.length,
		originHash: hash(config.input.origin), subjects: Object.values(candidate.subjects).map((s) => ({ userHash: hash(s.userId) })), loginVerified: true, businessVerified: false };
}

/** Independently re-read the published output sessions and operator-supplied input sessions after rollout. */
export async function verifyLoginAfterRollout(configFile: string, sourceSha: string, origin: string, expectedCandidate: Buffer, trialTarget?: unknown) {
	const current = await verifiedLoginCandidate(configFile, sourceSha, origin, trialTarget);
	assert(current.bytes.equals(expectedCandidate), "LOGIN_CANDIDATE_CHANGED");
	const candidate = JSON.parse(expectedCandidate.toString("utf8"));
	const config = await loginConfiguration(configFile, trialTarget, sourceSha);
	assert(config.input.origin === origin, "LOGIN_ORIGIN_MISMATCH");
	assert((await privateBytes(config.input.identityFile)).equals(expectedCandidate), "LOGIN_CANDIDATE_CHANGED");
	const states = await verifiedInputStates(config);
	for (const subject of config.subjects)
		assert(states.get(subject.storageStateFile)?.userId === candidate.subjects[subject.name]?.userId, "LOGIN_CANDIDATE_SESSION_MISMATCH");
	await assertLoginOutputsCommitted(config.input.identityFile);
	for (const [file, before] of config.before) assert.deepEqual(await loginOutputBytes(file), before, "LOGIN_OUTPUT_CHANGED");
	return { loginVerified: true, sessionVerified: true, subjectCount: states.size };
}

export async function verifiedLoginCandidate(configFile: string, sourceSha: string, origin: string, trialTarget?: unknown) {
	const config = await loginConfiguration(configFile, trialTarget, sourceSha);
	await assertLoginOutputsCommitted(config.input.identityFile);
	const bytes = await privateBytes(config.input.identityFile);
	const value = JSON.parse(bytes.toString("utf8"));
	assert(config.input.origin === origin && value.schemaVersion === 1 && value.sourceSha === sourceSha && value.origin === origin &&
		Object.keys(value).every((key) => ["schemaVersion", "sourceSha", "origin", "createdAt", "subjects"].includes(key)) &&
		Number.isSafeInteger(value.createdAt) && value.createdAt <= Date.now() && value.createdAt > Date.now() - 600_000 &&
		Object.keys(value.subjects).length === config.subjects.length, "LOGIN_CANDIDATE_INVALID");
	const ids = new Set();
	for (const subject of config.subjects) {
		const userId = value.subjects[subject.name]?.userId;
		assert(uuid.test(userId) && !ids.has(userId) && Object.keys(value.subjects[subject.name]).length === 1, "LOGIN_CANDIDATE_INVALID");
		ids.add(userId);
		const state = await privateJson(subject.storageStateFile);
		assert.equal(await readSession(origin,state),userId,"LOGIN_CANDIDATE_SESSION_MISMATCH");
	}
	await assertLoginOutputsCommitted(config.input.identityFile);
	for (const [file, before] of config.before) assert.deepEqual(await loginOutputBytes(file), before, "LOGIN_OUTPUT_CHANGED");
	return { bytes, secretRef: config.input.identitySecretRef };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv[2] === "recover") {
			const input = await privateJson(process.argv[3]);
			await recoverLoginOutputs(input.identityFile, [input.identityFile, ...input.subjects.map((s: any) => s.storageStateFile), ...input.blueprints]);
			process.stdout.write("{\"schemaVersion\":1,\"recovered\":true}\n");
		} else {
			assert(process.env.ACK_SOURCE_SHA && process.env.ACK_PUBLIC_ORIGIN);
			assert(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === "--external-service-trial"));
			let trialTarget;
			if (process.argv[3]) {
				assert(process.env.ACK_TRUSTED_TRIAL_TARGET_FILE, "LOGIN_TRIAL_TARGET_INVALID");
				trialTarget = await privateJson(process.env.ACK_TRUSTED_TRIAL_TARGET_FILE);
			}
			const result = await bootstrapLogin(process.argv[2], process.env.ACK_SOURCE_SHA, process.env.ACK_PUBLIC_ORIGIN, trialTarget);
			process.stdout.write(`${JSON.stringify(result)}\n`);
		}
	} catch {
		process.stderr.write("ACK_LOGIN_BOOTSTRAP_FAILED\n");
		process.exitCode = 1;
	}
}
