import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { conversationTurns } from "../../tests/local-real-e2e/conversation-turn-plan.ts";
import { privateBytes, privateJson } from "./private-input.ts";
import { assertLoginOutputsCommitted, loginOutputBytes, promoteLoginOutputs, recoverLoginOutputs } from "./login-output-promotion.ts";

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { request } = requireWeb("@playwright/test");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const identityKey = "deployment-identities.json";


export async function loginConfiguration(file: string) {
	const input = await privateJson(file);
	assert(input.schemaVersion === 1 && Object.keys(input).every((k) => ["schemaVersion", "origin", "identityFile", "identitySecretRef", "subjects", "blueprints"].includes(k)));
	const url = new URL(input.origin);
	assert((url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) && url.origin === input.origin && !url.username && !url.password);
	assert(Array.isArray(input.subjects) && input.subjects.length >= 2 && input.subjects.length <= 4);
	assert(input.identitySecretRef?.key === identityKey && /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(input.identitySecretRef.name));
	assert(Array.isArray(input.blueprints) && input.blueprints.length <= 20 && new Set(input.blueprints).size === input.blueprints.length);
	const inputs = [file];
	const outputs = [input.identityFile, ...input.blueprints];
	const names = new Set();
	for (const subject of input.subjects) {
		assert(Object.keys(subject).every((k) => ["name", "loginFile", "passwordFile", "storageStateFile"].includes(k)));
		assert(/^[a-z][a-z0-9_-]{0,31}$/u.test(subject.name) && !["constructor", "prototype"].includes(subject.name) && !names.has(subject.name));
		names.add(subject.name);
		for (const key of ["loginFile", "passwordFile"]) {
			assert(typeof subject[key] === "string" && isAbsolute(subject[key]) && resolve(subject[key]) === subject[key]);
			inputs.push(subject[key]);
		}
		outputs.push(subject.storageStateFile);
	}
	assert(new Set(outputs).size === outputs.length && outputs.every((p) => !inputs.includes(p)), "LOGIN_OUTPUT_ALIAS");
	const before = new Map<string, Buffer | null>();
	for (const file of outputs) before.set(file, await loginOutputBytes(file));
	const subjects = [];
	const logins = new Set();
	for (const subject of input.subjects) {
		const login = new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(subject.loginFile)).trim();
		// A password file may end in one line terminator; spaces are credential bytes.
		const password = new TextDecoder("utf-8", { fatal: true }).decode(await privateBytes(subject.passwordFile)).replace(/\r?\n$/u, "");
		assert(login.length > 0 && login.length <= 320 && password.length > 0 && password.length <= 4096 && !logins.has(login), "LOGIN_SUBJECT_INVALID");
		logins.add(login);
		subjects.push({ ...subject, login, password });
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

function sessionCookie(state: any, origin: string) {
	assert(Array.isArray(state.cookies) && Array.isArray(state.origins) && state.origins.every((e: any) => e.origin === origin));
	const url = new URL(origin);
	const cookies = state.cookies.filter((c: any) => c.name === "__Host-platform-session");
	assert(cookies.length === 1 && cookies[0].domain === url.hostname && cookies[0].path === "/" && cookies[0].httpOnly === true &&
		(url.protocol !== "https:" || cookies[0].secure === true) && cookies[0].sameSite === "Lax" && /^[A-Za-z0-9_-]{43}$/u.test(cookies[0].value), "LOGIN_COOKIE_INVALID");
}

export async function bootstrapLogin(configFile: string, sourceSha: string, expectedOrigin?: string) {
	assert(/^[a-f0-9]{40}$/u.test(sourceSha));
	const config = await loginConfiguration(configFile);
	await assertLoginOutputsCommitted(config.input.identityFile);
	if (expectedOrigin !== undefined) assert.equal(config.input.origin, expectedOrigin, "LOGIN_ORIGIN_MISMATCH");
	const contexts: any[] = [];
	const states = new Map<string, { userId: string; state: any }>();
	try {
		for (const subject of config.subjects) {
			const context = await request.newContext({ baseURL: config.input.origin, storageState: { cookies: [], origins: [] }, ignoreHTTPSErrors: false });
			contexts.push(context);
			const response = await context.post("/auth/login", { data: { login: subject.login, password: subject.password },
				headers: { Origin: config.input.origin }, timeout: 30_000, maxRedirects: 0 });
			assert.equal(response.status(), 204, "LOGIN_AUTHENTICATION_FAILED");
			const userId = await session(context);
			assert(![...states.values()].some((s) => s.userId === userId), "LOGIN_SUBJECTS_NOT_DISTINCT");
			const state = await context.storageState();
			sessionCookie(state, config.input.origin);
			states.set(subject.storageStateFile, { userId, state });
		}
		for (const [index, subject] of config.subjects.entries())
			assert.equal(await session(contexts[index]), states.get(subject.storageStateFile)!.userId, "LOGIN_SESSION_CHANGED");
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
	} finally { await Promise.allSettled(contexts.map((c) => c.dispose())); }
}

export async function verifiedLoginCandidate(configFile: string, sourceSha: string, origin: string) {
	const config = await loginConfiguration(configFile);
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
		sessionCookie(state, origin);
		const context = await request.newContext({ baseURL: origin, storageState: state, ignoreHTTPSErrors: false });
		try { assert.equal(await session(context), userId, "LOGIN_CANDIDATE_SESSION_MISMATCH"); }
		finally { await context.dispose(); }
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
			const result = await bootstrapLogin(process.argv[2], process.env.ACK_SOURCE_SHA, process.env.ACK_PUBLIC_ORIGIN);
			process.stdout.write(`${JSON.stringify(result)}\n`);
		}
	} catch {
		process.stderr.write("ACK_LOGIN_BOOTSTRAP_FAILED\n");
		process.exitCode = 1;
	}
}
