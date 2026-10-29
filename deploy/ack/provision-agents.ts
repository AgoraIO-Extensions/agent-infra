#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

type Binding = { name: string; agentId: string; ready: boolean };
type Clock = {
	now: () => number;
	wait: (milliseconds: number) => Promise<void>;
};
type Hooks = {
	onBinding?: (binding: Binding) => Promise<void>;
	bindings?: Record<string, string>;
	materials?: Record<string, { token: string; body: unknown }>;
	clock?: Clock;
};
const clock: Clock = {
	now: () => Math.floor(performance.now()),
	wait: (milliseconds) =>
		new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
const creationBudgetMs = 300_000;
const transientCodes = new Set([
	"EAI_AGAIN",
	"ENOTFOUND",
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_SOCKET",
	"REQUEST_TIMEOUT",
]);
function transportCode(error: unknown) {
	const value = error as {
		name?: string;
		code?: string;
		cause?: { code?: string };
	};
	if (value?.name === "TimeoutError") return "REQUEST_TIMEOUT";
	const code = value?.cause?.code ?? value?.code;
	if (typeof code === "string" && transientCodes.has(code)) return code;
	if (
		typeof code === "string" &&
		/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/u.test(code)
	)
		return "TLS_INVALID";
	return "TRANSPORT_UNCLASSIFIED";
}
const diagnostics = () => ({
	attempts: 0,
	transportFailures: [] as string[],
	dependencyUnavailableResponses: 0,
	gatewayTimeoutResponses: 0,
	budgetExhausted: false,
});

async function requestJson(
	url: string,
	init: RequestInit,
	deadline: number,
	attemptLimit: number,
	time: Clock,
	evidence: ReturnType<typeof diagnostics>,
	retry = true,
) {
	for (;;) {
		const remaining = deadline - time.now();
		if (remaining <= 0) {
			evidence.budgetExhausted = true;
			return { response: null, body: null, error: "REQUEST_BUDGET_EXHAUSTED" };
		}
		evidence.attempts++;
		try {
			const response = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(Math.min(attemptLimit, remaining)),
				redirect: "error",
			});
			// Gateway timeout does not tell us whether the API transaction committed.
			if (response.status === 504) {
				await response.body?.cancel().catch(() => undefined);
				evidence.gatewayTimeoutResponses++;
				if (!retry) return { response, body: null, error: "GATEWAY_TIMEOUT" };
				await time.wait(Math.max(0, Math.min(1000, deadline - time.now())));
				continue;
			}
			let body: any;
			try {
				body = await response.json();
			} catch (error) {
				if (error instanceof SyntaxError || ![200, 201].includes(response.status))
					return { response, body: null, error: "RESPONSE_INVALID" };
				throw error;
			}
			if (time.now() >= deadline) {
				evidence.budgetExhausted = true;
				return { response, body: null, error: "REQUEST_BUDGET_EXHAUSTED" };
			}
			if (
				response.status !== 503 ||
				body?.error?.code !== "DEPENDENCY_UNAVAILABLE"
			)
				return { response, body };
			evidence.dependencyUnavailableResponses++;
			if (!retry) return { response, body };
		} catch (error) {
			const code = transportCode(error);
			if (!evidence.transportFailures.includes(code))
				evidence.transportFailures.push(code);
			if (!transientCodes.has(code) || !retry)
				return { response: null, body: null, error: code };
		}
		await time.wait(Math.max(0, Math.min(1000, deadline - time.now())));
	}
}

const digest = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const fail = (message: string): never => {
	throw new Error(message);
};

export async function readPrivateText(
	path: string,
	label: string,
	allowNewlines = false,
) {
	if (!isAbsolute(path) || typeof constants.O_NOFOLLOW !== "number")
		fail(`${label}_FILE_INVALID`);
	const maximum = allowNewlines ? 1024 * 1024 : 8192;
	const handle = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			(stat.mode & 0o077) !== 0 ||
			stat.uid !== process.getuid?.() ||
			stat.size > maximum
		)
			fail(`${label}_FILE_INVALID`);
		const buffer = Buffer.alloc(maximum + 1);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		if (bytesRead > maximum) fail(`${label}_FILE_INVALID`);
		const value = new TextDecoder("utf-8", { fatal: true })
			.decode(buffer.subarray(0, bytesRead))
			.trim();
		if (!value || (!allowNewlines && /[\r\n]/u.test(value)))
			fail(`${label}_FILE_INVALID`);
		return value;
	} finally {
		await handle.close();
	}
}

function parseInput(value: unknown) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("CONFIGURATION_INVALID");
	const input = value as Record<string, any>;
	if (
		Object.keys(input).some(
			(key) =>
				!["schemaVersion", "origin", "requests", "waitSeconds"].includes(key),
		)
	)
		fail("CONFIGURATION_INVALID");
	if (input.schemaVersion !== 1 || typeof input.origin !== "string")
		fail("CONFIGURATION_INVALID");
	const origin = new URL(input.origin);
	if (
		origin.protocol !== "https:" ||
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/"
	)
		fail("CONFIGURATION_INVALID");
	if (
		!Array.isArray(input.requests) ||
		input.requests.length < 1 ||
		input.requests.length > 20
	)
		fail("CONFIGURATION_INVALID");
	const waitSeconds = input.waitSeconds ?? 300;
	if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 900)
		fail("CONFIGURATION_INVALID");
	const seen = new Set();
	const requests = input.requests.map((request: Record<string, any>) => {
		if (!request || typeof request !== "object" || Array.isArray(request))
			fail("CONFIGURATION_INVALID");
		if (
			Object.keys(request).some(
				(key) =>
					!["name", "bodyFile", "credentialFile", "idempotencyKey"].includes(
						key,
					),
			)
		)
			fail("CONFIGURATION_INVALID");
		const { name, bodyFile, credentialFile, idempotencyKey } = request;
		if (
			typeof name !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name) ||
			typeof bodyFile !== "string" ||
			typeof credentialFile !== "string" ||
			typeof idempotencyKey !== "string" ||
			!/^[\x21-\x7e]{8,256}$/u.test(idempotencyKey) ||
			!isAbsolute(bodyFile) ||
			!isAbsolute(credentialFile) ||
			seen.has(name)
		)
			fail("CONFIGURATION_INVALID");
		seen.add(name);
		return { name, bodyFile, credentialFile, idempotencyKey };
	});
	return { origin: origin.origin, requests, waitSeconds };
}

async function readBody(path: string) {
	const raw = await readPrivateText(path, "BODY", true);
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		fail("BODY_JSON_INVALID");
	}
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("BODY_JSON_INVALID");
	return value;
}

async function waitForReady(
	origin: string,
	token: string,
	agentId: string,
	waitSeconds: number,
	time: Clock,
) {
	const deadline = time.now() + waitSeconds * 1000;
	const evidence = diagnostics();
	let last: { status: string; serviceAvailability: string | null } = {
		status: "unknown",
		serviceAvailability: null,
	};
	const statuses = new Set([
		"creating",
		"available",
		"stopped",
		"creation_failed",
		"disabled",
	]);
	const availability = new Set([
		"ready",
		"starting",
		"updating",
		"unavailable",
	]);
	for (;;) {
		const { response, body, error } = await requestJson(
			`${origin}/api/v2/agents/${encodeURIComponent(agentId)}/state`,
			{ headers: { Authorization: `Bearer ${token}` } },
			waitSeconds === 0 ? time.now() + 10_000 : deadline,
			10_000,
			time,
			evidence,
			waitSeconds !== 0,
		);
		if (error || response?.status !== 200)
			return {
				pass: false,
				state: last,
				timeout: evidence.budgetExhausted,
				error: error ?? "STATE_HTTP_REJECTED",
				evidence,
			};
		if (body && typeof body === "object") {
			if (body.schemaVersion !== 1 || body.agentId !== agentId)
				fail("STATE_BINDING_INVALID");
			last = {
				status:
					typeof body.status === "string" && statuses.has(body.status)
						? body.status
						: "unknown",
				serviceAvailability:
					typeof body.serviceAvailability === "string" &&
					availability.has(body.serviceAvailability)
						? body.serviceAvailability
						: null,
			};
			if (last.status === "available" && last.serviceAvailability === "ready")
				return { pass: true, state: last, timeout: false, evidence };
			if (["creation_failed", "disabled"].includes(last.status))
				return { pass: false, state: last, timeout: false, evidence };
		} else fail("STATE_BINDING_INVALID");
		if (time.now() >= deadline) {
			evidence.budgetExhausted = true;
			return { pass: false, state: last, timeout: true, evidence };
		}
		await time.wait(Math.min(1000, deadline - time.now()));
	}
}

export async function provisionAgents(
	input: unknown,
	{ onBinding, bindings = {}, materials = {}, clock: time = clock }: Hooks = {},
) {
	const parsed = parseInput(input);
	const results = [];
	for (const request of parsed.requests) {
		const creation = diagnostics();
		try {
			const frozen = Object.hasOwn(materials, request.name)
				? materials[request.name]
				: undefined;
			const [token, body] = frozen
				? [frozen.token, frozen.body]
				: await Promise.all([
						readPrivateText(request.credentialFile, "CREDENTIAL"),
						readBody(request.bodyFile),
					]);
			const existingId = Object.hasOwn(bindings, request.name)
				? bindings[request.name]
				: undefined;
			// Freeze the original bytes and key: a disconnected caller cannot know whether creation committed.
			const creationResult = existingId
				? {
						response: null,
						body: { schemaVersion: 1, agentId: existingId },
						error: undefined,
					}
				: await requestJson(
						`${parsed.origin}/api/v2/agents`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
								"Idempotency-Key": request.idempotencyKey,
							},
							body: JSON.stringify(body),
						},
						time.now() + creationBudgetMs,
						creationBudgetMs,
						time,
						creation,
					);
			const { response, body: responseBody } = creationResult;
			const agentId =
				responseBody?.schemaVersion === 1 &&
				typeof responseBody.agentId === "string" &&
				responseBody.agentId.length > 0 &&
				responseBody.agentId.length <= 256
					? responseBody.agentId
					: undefined;
			const created =
				creationResult.error === undefined &&
				(existingId !== undefined ||
					response?.status === 201 ||
					response?.status === 200) &&
				agentId !== undefined;
			if (created)
				await onBinding?.({ name: request.name, agentId, ready: false });
			const readiness = created
				? await waitForReady(
						parsed.origin,
						token,
						agentId,
						parsed.waitSeconds,
						time,
					)
				: {
						pass: false,
						state: undefined,
						timeout: false,
						error: creationResult.error,
						evidence: undefined,
					};
			if (created && readiness.pass)
				await onBinding?.({ name: request.name, agentId, ready: true });
			results.push({
				name: request.name,
				status: response?.status ?? (existingId ? 200 : null),
				pass: created && readiness.pass,
				creation,
				...(readiness.evidence ? { readiness: readiness.evidence } : {}),
				...(readiness.error ? { error: readiness.error } : {}),
				...(agentId === undefined ? {} : { agentHash: digest(agentId) }),
				...(readiness.state === undefined ? {} : { state: readiness.state }),
				...(readiness.timeout === true ? { stateTimeout: true } : {}),
			});
			if (!created || !readiness.pass) break;
		} catch (error) {
			results.push({
				name: request.name,
				status: null,
				pass: false,
				creation,
				error:
					error instanceof Error &&
					new Set([
						"CONFIGURATION_INVALID",
						"BODY_FILE_INVALID",
						"BODY_JSON_INVALID",
						"CREDENTIAL_FILE_INVALID",
						"STATE_BINDING_INVALID",
					]).has(error.message)
						? error.message
						: "REQUEST_FAILED",
			});
			break;
		}
	}
	return {
		schemaVersion: 1,
		kind: "ack-agent-provision",
		originHash: digest(parsed.origin),
		results,
		skippedRequestCount: parsed.requests.length - results.length,
		pass:
			results.length === parsed.requests.length &&
			results.every((result) => result.pass),
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		const path = process.argv[2];
		if (!path) fail("CONFIGURATION_REQUIRED");
		const input = JSON.parse(await readFile(path, "utf8"));
		const result = await provisionAgents(input);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (!result.pass) process.exitCode = 1;
	} catch (error) {
		process.stderr.write(
			error instanceof Error &&
				/^(CONFIGURATION|BODY|CREDENTIAL)/u.test(error.message)
				? `${error.message}\n`
				: "ACK_AGENT_PROVISION_FAILED\n",
		);
		process.exitCode = 1;
	}
}
