#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

type Binding = { name: string; agentId: string; ready: boolean };
type Hooks = {
	onBinding?: (binding: Binding) => Promise<void>;
	bindings?: Record<string, string>;
	materials?: Record<string, { token: string; body: unknown }>;
};

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
) {
	const deadline = Date.now() + waitSeconds * 1000;
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
		const response = await fetch(
			`${origin}/api/v2/agents/${encodeURIComponent(agentId)}/state`,
			{
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(10_000),
				redirect: "error",
			},
		);
		let body: any = null;
		try {
			body = await response!.json();
		} catch {
			body = null;
		}
		if (response.status === 200 && body && typeof body === "object") {
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
				return { pass: true, state: last, timeout: false };
			if (["creation_failed", "disabled"].includes(last.status))
				return { pass: false, state: last, timeout: false };
		}
		if (Date.now() >= deadline)
			return { pass: false, state: last, timeout: true };
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}

export async function provisionAgents(
	input: unknown,
	{ onBinding, bindings = {}, materials = {} }: Hooks = {},
) {
	const parsed = parseInput(input);
	const results = [];
	for (const request of parsed.requests) {
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
			const response = existingId
				? null
				: await fetch(`${parsed.origin}/api/v2/agents`, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
							"Content-Type": "application/json",
							"Idempotency-Key": request.idempotencyKey,
						},
						body: JSON.stringify(body),
						signal: AbortSignal.timeout(30_000),
						redirect: "error",
					});
			let responseBody: any = null;
			try {
				responseBody = existingId
					? { schemaVersion: 1, agentId: existingId }
					: await response!.json();
			} catch {
				responseBody = null;
			}
			const agentId =
				responseBody?.schemaVersion === 1 &&
				typeof responseBody.agentId === "string" &&
				responseBody.agentId.length > 0 &&
				responseBody.agentId.length <= 256
					? responseBody.agentId
					: undefined;
			const created =
				(existingId !== undefined ||
					response?.status === 201 ||
					response?.status === 200) &&
				agentId !== undefined;
			if (created)
				await onBinding?.({ name: request.name, agentId, ready: false });
			const readiness = created
				? await waitForReady(parsed.origin, token, agentId, parsed.waitSeconds)
				: { pass: false, state: undefined, timeout: false };
			if (created && readiness.pass)
				await onBinding?.({ name: request.name, agentId, ready: true });
			results.push({
				name: request.name,
				status: response?.status ?? 200,
				pass: created && readiness.pass,
				...(agentId === undefined ? {} : { agentHash: digest(agentId) }),
				...(readiness.state === undefined ? {} : { state: readiness.state }),
				...(readiness.timeout === true ? { stateTimeout: true } : {}),
			});
		} catch (error) {
			results.push({
				name: request.name,
				status: null,
				pass: false,
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
		}
	}
	return {
		schemaVersion: 1,
		kind: "ack-agent-provision",
		originHash: digest(parsed.origin),
		results,
		pass: results.every((result) => result.pass),
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
