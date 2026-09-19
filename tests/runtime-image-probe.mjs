import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	sign,
} from "node:crypto";
import { createReadStream } from "node:fs";
import {
	chmod,
	mkdir,
	readdir,
	readFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import {
	ProbeStepFailure,
	probeStep as runProbeStep,
} from "./support/runtime-probe-diagnostics.mjs";

const probeStep = (name, operation, details = () => ({})) =>
	runProbeStep(name, operation, () => ({
		...details(),
		modelRequests: requests.length,
	}));

const credentials = {
	default: `synthetic-${randomBytes(24).toString("hex")}`,
	selected: `synthetic-${randomBytes(24).toString("hex")}`,
};
const serviceToken = `synthetic-${randomBytes(24).toString("hex")}`;
const failureMarker = `failure-${randomBytes(24).toString("hex")}`;
const privatePath = `/synthetic/private/${randomBytes(24).toString("hex")}`;
const expectedConfigVersion = "synthetic-active-v2";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const requests = [];
const processes = new Set();
const toolCallId = "synthetic-runtime-tool";
const toolDeniedPath = "/var/lib/agent-runtime/tool-probe-denied";
const toolExistingPath = "/var/lib/agent-runtime/tool-probe-existing";
// A synthetic sibling Conversation directory beneath the same boundary. The
// platform Landlock domain is the whole Conversation boundary on Linux, so the
// model tool must not read, list or modify it while its own workspace stays
// writable.
const toolBoundaryPath = "/var/lib/agent-runtime/tool-probe/conversations";
const toolSiblingRoot = `${toolBoundaryPath}/${"b".repeat(64)}`;
const toolSiblingFile = `${toolSiblingRoot}/workspace/sibling-control`;
const toolSiblingContent = "sibling-conversation-control";
let toolProbePending = false;
let toolProbeOutput;
let holdNextSelectedResponse = true;
let releaseHeldSelectedResponse;
let stage = "model-substitute";
let startupCode;
let httpStatus;
let responseCode;
let resultStatus;
let isolationFileKind;
const checks = [];

function check(name, condition) {
	assert.ok(condition);
	checks.push(name);
}

function sse(value) {
	return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
}

function syntheticEvents(sequence) {
	const text = "synthetic runtime answer";
	const item = {
		type: "message",
		id: `synthetic-message-${sequence}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	return [
		{
			type: "response.created",
			response: {
				id: `synthetic-response-${sequence}`,
				status: "in_progress",
				output: [],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: `synthetic-response-${sequence}`,
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
}

function syntheticResponse(response, sequence) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of syntheticEvents(sequence)) response.write(sse(event));
	response.end();
}

function syntheticToolResponse(response, sequence) {
	const item = {
		type: "function_call",
		id: `synthetic-tool-${sequence}`,
		call_id: toolCallId,
		name: "exec_command",
		arguments: JSON.stringify({
			cmd: `command -v truncate >/dev/null || exit 11; printf 'runtime-tool-ok\\n'; if printf 'unexpected\\n' > ${toolDeniedPath}; then exit 9; fi; truncate_output=$(truncate -s 0 ${toolExistingPath} 2>&1); truncate_status=$?; if test "$truncate_status" -eq 0; then exit 10; fi; case "$truncate_output" in *'Permission denied'*) printf 'runtime-truncate-denied\\n';; *) exit 12;; esac; test ! -e ${toolDeniedPath} && test -s ${toolExistingPath} || exit 13; printf 'runtime-own-control\\n' > ./runtime-own-control || exit 14; test "$(cat ./runtime-own-control)" = runtime-own-control || exit 15; if cat ${toolSiblingFile} >/dev/null 2>&1; then exit 16; fi; if ls ${toolSiblingRoot} >/dev/null 2>&1; then exit 17; fi; if ls ${toolBoundaryPath} >/dev/null 2>&1; then exit 18; fi; if printf 'unexpected\\n' > ${toolSiblingFile} 2>/dev/null; then exit 19; fi; if cat /proc/self/environ >/dev/null 2>&1; then exit 20; fi; printf 'runtime-sibling-denied\\n'`,
			max_output_tokens: 100,
			yield_time_ms: 1000,
		}),
	};
	const events = [
		{
			type: "response.created",
			response: {
				id: `synthetic-response-${sequence}`,
				status: "in_progress",
				output: [],
			},
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...item, arguments: "" },
		},
		{
			type: "response.function_call_arguments.delta",
			item_id: item.id,
			output_index: 0,
			delta: item.arguments,
		},
		{
			type: "response.function_call_arguments.done",
			item_id: item.id,
			output_index: 0,
			arguments: item.arguments,
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: `synthetic-response-${sequence}`,
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of events) response.write(sse(event));
	response.end();
}

function modelFailure(response, status) {
	response.writeHead(status, {
		"content-type": "application/json",
		location: `${privatePath}/${failureMarker}`,
		"x-private": credentials.default,
	});
	response.end(
		JSON.stringify({
			error: {
				message: `${credentials.default}:${failureMarker}:${privatePath}`,
			},
		}),
	);
}

function streamFailure(response, type) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(
		sse({
			type,
			error: {
				message: `${credentials.default}:${failureMarker}:${privatePath}`,
			},
		}),
	);
}

const model = createServer(async (request, response) => {
	try {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		let bytes = Buffer.concat(chunks);
		if (request.headers["content-encoding"] === "gzip")
			bytes = gunzipSync(bytes);
		if (request.headers["content-encoding"] === "zstd")
			bytes = zstdDecompressSync(bytes);
		const body = JSON.parse(bytes.toString("utf8"));
		const expectedCredential =
			request.url?.startsWith("/approved-selected/") ||
			request.url?.startsWith("/hold-selected/")
				? credentials.selected
				: credentials.default;
		const authenticated =
			request.headers.authorization === `Bearer ${expectedCredential}`;
		let resolveClosed;
		const closedPromise = new Promise((resolve) => {
			resolveClosed = resolve;
		});
		const observed = {
			path: request.url,
			authenticated,
			model: body.model,
			effort: body.reasoning?.effort,
			input: JSON.stringify(body.input).includes("synthetic-runtime-input"),
			history: JSON.stringify(body.input).includes("synthetic runtime answer"),
			closed: false,
			closedPromise,
		};
		requests.push(observed);
		response.once("close", () => {
			observed.closed = true;
			resolveClosed();
		});
		if (!authenticated) {
			modelFailure(response, 401);
			return;
		}
		switch (request.url) {
			case "/approved-default/v1/responses":
			case "/approved-selected/v1/responses":
				if (toolProbePending) {
					assert.ok(body.tools.some((tool) => tool.name === "exec_command"));
					toolProbePending = false;
					syntheticToolResponse(response, requests.length);
					return;
				}
				toolProbeOutput ??= body.input.find(
					(item) =>
						item.type === "function_call_output" && item.call_id === toolCallId,
				)?.output;
				syntheticResponse(response, requests.length);
				return;
			case "/hold-selected/v1/responses":
				if (holdNextSelectedResponse) {
					holdNextSelectedResponse = false;
					releaseHeldSelectedResponse = () =>
						syntheticResponse(response, requests.length);
					return;
				}
				syntheticResponse(response, requests.length);
				return;
			case "/http-403/v1/responses":
				modelFailure(response, 403);
				return;
			case "/http-503/v1/responses":
				modelFailure(response, 503);
				return;
			case "/redirect/v1/responses":
				modelFailure(response, 302);
				return;
			case "/wrong-content-type/v1/responses":
				modelFailure(response, 200);
				return;
			case "/response-failed/v1/responses":
				streamFailure(response, "response.failed");
				return;
			case "/response-incomplete/v1/responses":
				streamFailure(response, "response.incomplete");
				return;
			case "/error-event/v1/responses":
				streamFailure(response, "error");
				return;
			case "/malformed/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end("data: {not-json}\n\n");
				return;
			case "/oversized/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse({
						type: "response.output_text.delta",
						delta: failureMarker.repeat(48_000),
					}),
				);
				return;
			case "/unterminated/v1/responses": {
				const terminal = syntheticEvents(requests.length).at(-1);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(`data: ${JSON.stringify(terminal)}`);
				return;
			}
			case "/post-terminal/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const event of syntheticEvents(requests.length)) {
					response.write(sse(event));
				}
				response.end(
					sse({
						type: "response.output_text.delta",
						delta: `${credentials.default}:${failureMarker}:${privatePath}`,
					}),
				);
				return;
			case "/unknown-event/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse({
						type: `response.private_${failureMarker}`,
						delta: `${credentials.default}:${failureMarker}:${privatePath}`,
					}),
				);
				return;
			case "/wrong-shape/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse({
						type: "response.output_text.delta",
						delta: {
							message: `${credentials.default}:${failureMarker}:${privatePath}`,
						},
					}),
				);
				return;
			case "/extra-error/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse({
						type: "response.output_text.delta",
						delta: "synthetic safe delta",
						error: { message: `${failureMarker}:${privatePath}` },
					}),
				);
				return;
			case "/nested-error/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					sse({
						type: "response.completed",
						response: {
							id: "synthetic-nested-error",
							status: "completed",
							error: { message: `${failureMarker}:${privatePath}` },
						},
					}),
				);
				return;
			case "/credential-echo/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					`${sse({
						type: "response.output_text.delta",
						delta: `prefix:${credentials.default}:suffix`,
					})}${sse(syntheticEvents(requests.length).at(-1))}`,
				);
				return;
			case "/stop/v1/responses":
			case "/cancel/v1/responses":
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.write(
					sse({
						type: "response.created",
						response: { id: "synthetic-cancel", status: "in_progress" },
					}),
				);
				return;
			default:
				modelFailure(response, 503);
		}
	} catch {
		response.writeHead(500);
		response.end();
	}
});

// Only the isolated image probe owns these synthetic identities and signing keys.
export const runtimeProbeWorkerId = "synthetic-worker";
let protocol;

export function createRuntimeProbeProtocol({
	contracts,
	requestDigest,
	privateKey,
	now = Date.now,
}) {
	const schemas = {
		"turn.submit": contracts.RuntimeSubmitTurnRequestV3Schema,
		"turn.stop": contracts.RuntimeStopRequestV3Schema,
		"generation.cancel": contracts.RuntimeGenerationCancelRequestV3Schema,
		"session.status": contracts.RuntimeStatusRequestV3Schema,
		"events.persist": contracts.RuntimeEventPersistRequestV3Schema,
		"events.ack": contracts.RuntimeEventAckRequestV3Schema,
	};
	function signRequest(value, command, reason) {
		const request = {
			...value,
			requestId: `request-${randomBytes(12).toString("hex")}`,
		};
		const issuedAt = now();
		const claims = contracts.RuntimeExecutionGrantClaimsV2Schema.parse({
			schemaVersion: 2,
			issuer: "synthetic-platform",
			audience: "runtime_host",
			workerId: runtimeProbeWorkerId,
			issuedAt,
			expiresAt: issuedAt + contracts.RuntimeExecutionGrantMaximumLifetimeMsV2,
			grantId: `grant-${randomBytes(12).toString("hex")}`,
			principal: request.principal,
			agentId: request.agentId,
			channelId: request.channelId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			sessionGeneration: request.sessionGeneration,
			traceId: request.traceId,
			hostSessionRef: request.hostSessionRef,
			operation: request.operation,
			allowedCommands: [command],
			requestDigest: createHash("sha256")
				.update(contracts.runtimeRequestSigningPayloadV3(request))
				.digest("hex"),
			...(reason
				? {
						purpose: "control",
						controlRecordId: `control-${request.executionId}-${reason}`,
						reason,
					}
				: {
						purpose: "business",
						authorizationRecordId: `authorization-${request.executionId}`,
						attachments: (request.input?.attachments ?? []).map(
							(attachmentId) => ({ attachmentId, operations: ["read"] }),
						),
					}),
			...(command === "events.persist"
				? {
						eventAccess: {
							command,
							consumer: request.consumer,
							afterCursor: request.afterCursor,
						},
					}
				: command === "events.ack"
					? {
							eventAccess: {
								command,
								consumer: request.consumer,
								confirmedCursor: request.confirmedCursor,
							},
						}
					: {}),
		});
		const header = Buffer.from(
			JSON.stringify({
				alg: "EdDSA",
				kid: "synthetic-key",
				typ: "runtime-execution+jws",
			}),
		).toString("base64url");
		const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
		return schemas[command].parse({
			...request,
			grant: {
				schemaVersion: 2,
				format: "runtime-execution-jws",
				token: `${input}.${sign(null, Buffer.from(input), privateKey).toString("base64url")}`,
			},
		});
	}
	function binding(name, overrides = {}) {
		const value = {
			schemaVersion: 3,
			requestId: `request-${name}`,
			agentId: "synthetic-agent",
			principal: { kind: "user", id: "synthetic-actor" },
			channelId: "web",
			conversationId: `conversation-${name}`,
			executionId: `execution-${name}`,
			turnId: `turn-${name}`,
			sessionGeneration: 1,
			hostSessionRef: null,
			traceId: `trace-${name}`,
			...overrides,
		};
		return {
			...value,
			operation: {
				kind: "execution",
				id: value.executionId,
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
		};
	}
	function originalOperationDigest(submit) {
		return requestDigest({
			kind: "submit-turn",
			agentId: submit.agentId,
			conversationId: submit.conversationId,
			executionId: submit.executionId,
			turnId: submit.turnId,
			sessionGeneration: submit.sessionGeneration,
			input: submit.input,
			...(submit.selection ? { selection: submit.selection } : {}),
		});
	}
	return {
		binding,
		signRequest,
		originalOperationDigest,
		status(submitted, reason = "recovery") {
			return signRequest(
				{
					...submitted.lookup,
					originalOperationDigest: submitted.originalOperationDigest,
				},
				"session.status",
				reason,
			);
		},
		parseEvents(text, executionId) {
			return text
				.split("\n")
				.filter((line) => line.startsWith("data: "))
				.map((line) => {
					const event = contracts.RuntimeEventSchema.parse(
						JSON.parse(line.slice(6)),
					);
					assert.equal(event.executionId, executionId);
					return event;
				});
		},
	};
}

function deployment(origin, directory) {
	return {
		PATH: process.env.PATH,
		PORT: "3003",
		HOME: "/tmp/personal",
		CODEX_HOME: "/tmp/personal",
		OPENAI_API_KEY: "synthetic-personal-credential",
		OPENAI_BASE_URL: "http://127.0.0.1:1/forbidden",
		AGENT_INFRA_RUNTIME_DRIVER: "codex",
		AGENT_INFRA_RUNTIME_AGENT_ID: "synthetic-agent",
		AGENT_INFRA_RUNTIME_WORKER_ID: runtimeProbeWorkerId,
		AGENT_INFRA_RUNTIME_DATA_DIR: directory,
		AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "synthetic-key",
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: publicKeyPem,
		AGENT_INFRA_RUNTIME_GRANT_ISSUER: "synthetic-platform",
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: serviceToken,
		AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT: credentials.default,
		AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_SELECTED: credentials.selected,
		AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
			schemaVersion: 2,
			configVersion: expectedConfigVersion,
			defaultModelOptionId: "default-option",
			defaultReasoningLevel: "medium",
			modelOptions: [
				{
					modelOptionId: "default-option",
					endpoint: `${origin}/approved-default/v1`,
					model: "gpt-5.2",
					reasoningLevels: ["medium"],
					credentialEnvironmentVariable:
						"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT",
				},
				{
					modelOptionId: "selected-option",
					endpoint: `${origin}/approved-selected/v1`,
					model: "gpt-5.2",
					reasoningLevels: ["high"],
					credentialEnvironmentVariable:
						"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_SELECTED",
				},
			],
		}),
	};
}

async function launch(environment, rejection) {
	const child = spawn("/bin/sh", ["/app/start-runtime-host.sh"], {
		cwd: "/app",
		env: environment,
		stdio: ["ignore", "pipe", "pipe"],
	});
	processes.add(child);
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.on("data", (chunk) => {
			output += chunk.toString("utf8");
		});
	}
	const exit = new Promise((resolve) =>
		child.once("close", (code) => {
			processes.delete(child);
			resolve(code);
		}),
	);
	for (let attempt = 0; attempt < 200; attempt++) {
		assert.ok(output.length < 65_536);
		startupCode = output.match(/"code":"(RUNTIME_[A-Z_]+)"/)?.[1];
		if (rejection && child.exitCode !== null) {
			assert.notEqual(await exit, 0);
			assert.ok(output.includes(rejection));
			assertRedacted(output);
			return;
		}
		const ready = output
			.split(/\r?\n/)
			.filter(Boolean)
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			})
			.find((entry) => entry?.status === "ready");
		if (ready) {
			assert.ok(!rejection);
			const configuration = JSON.parse(
				environment.AGENT_INFRA_RUNTIME_MODEL_CONFIG,
			);
			assert.equal(ready.configVersion, configuration.configVersion);
			return {
				configVersion: ready.configVersion,
				async stop() {
					child.kill("SIGTERM");
					const result = await Promise.race([
						exit,
						delay(10_000).then(() => "timeout"),
					]);
					assert.equal(result, 0);
					assertRedacted(output);
				},
			};
		}
		assert.equal(child.exitCode, null);
		await delay(100);
	}
	throw new Error("entrypoint unavailable");
}

async function assertUpstreamClosedBeforeConfirmation(
	observed,
	confirmation,
	name,
) {
	let response;
	return probeStep(
		`${name}-close-before-confirmation`,
		async () => {
			const first = await Promise.race([
				observed.closedPromise.then(() => "upstream-closed"),
				confirmation.then((value) => {
					response = value;
					return "http-confirmed";
				}),
			]);
			assert.equal(first, "upstream-closed");
			return confirmation;
		},
		() => ({ httpStatus: response?.status }),
	);
}

async function waitForOpenModelRequest(path) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		for (let index = requests.length - 1; index >= 0; index -= 1) {
			const observed = requests[index];
			if (observed.path === path) {
				assert.equal(observed.closed, false);
				return observed;
			}
		}
		await delay(25);
	}
	assert.fail(`model request did not open: ${path}`);
}

async function waitForModelRequest(path) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (requests.some((observed) => observed.path === path)) return;
		await delay(25);
	}
	assert.fail(`model request did not arrive: ${path}`);
}

function assertRedacted(text) {
	for (const value of [
		...Object.values(credentials),
		failureMarker,
		privatePath,
		"synthetic-personal-credential",
		"native-private-error",
		"/tmp/personal",
		"/var/lib/agent-runtime",
		'"threadId"',
		'"nativeTurnId"',
		"thread/start",
		"turn/start",
	]) {
		assert.ok(!text.includes(value));
	}
}

async function request(path, body, token = serviceToken) {
	const response = await fetch(
		`http://127.0.0.1:3003/internal/runtime/${path}`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		},
	);
	const text = await response.text();
	httpStatus = response.status;
	responseCode = text.match(/"code":"(RUNTIME_[A-Z_]+)"/)?.[1];
	assertRedacted(text);
	return {
		status: response.status,
		text,
		contentType: response.headers.get("content-type"),
	};
}

async function submitTurn(name, selection, session = undefined) {
	const base = protocol.binding(
		name,
		session
			? {
					conversationId: session.conversationId,
					hostSessionRef: session.hostSessionRef,
				}
			: {},
	);
	const submit = protocol.signRequest(
		{
			...base,
			input: { text: "synthetic-runtime-input", attachments: [] },
			...(selection ? { selection } : {}),
		},
		"turn.submit",
	);
	const path = "v3/turns";
	let accepted;
	return probeStep(
		`${name}-submit`,
		async () => {
			accepted = await request(path, submit);
			const result = JSON.parse(accepted.text);
			assert.equal(accepted.status, 200);
			assert.equal(result.result.outcome, "accepted");
			const lookup = { ...base, hostSessionRef: result.hostSessionRef };
			return {
				lookup,
				submit,
				path,
				accepted: result,
				originalOperationDigest: protocol.originalOperationDigest(submit),
			};
		},
		() => ({
			httpStatus: accepted?.status,
			resultStatus: accepted
				? JSON.parse(accepted.text).result?.status
				: undefined,
		}),
	);
}

async function turn(
	name,
	selection,
	expectedStatus = "completed",
	session = undefined,
	beforePersist = undefined,
	eventReason = undefined,
) {
	const submitted = await submitTurn(name, selection, session);
	await beforePersist?.(submitted);
	const { lookup } = submitted;
	let events;
	await probeStep(
		`${name}-events`,
		async () => {
			events = await request(
				"v3/events/stream",
				protocol.signRequest(
					{
						...lookup,
						consumer: "platform_worker_persistence",
						afterCursor: null,
					},
					"events.persist",
					eventReason,
				),
			);
			assert.equal(events.status, 200);
			assert.ok(events.contentType.includes("text/event-stream"));
			const frames = protocol.parseEvents(events.text, lookup.executionId);
			assert.ok(
				frames.some(
					(event) =>
						event.type === "completed" &&
						event.payload.status === expectedStatus,
				),
			);
			if (expectedStatus === "completed")
				assert.ok(
					frames.some(
						(event) =>
							event.type === "text" &&
							event.payload.delta.includes("synthetic runtime answer"),
					),
				);
			const confirmedCursor = frames.at(-1).cursor;
			const ack = await request(
				"v3/events/ack",
				protocol.signRequest(
					{
						...lookup,
						consumer: "platform_worker_persistence",
						confirmedCursor,
					},
					"events.ack",
					eventReason,
				),
			);
			assert.equal(ack.status, 200);
			assert.deepEqual(JSON.parse(ack.text), {
				schemaVersion: 3,
				executionId: lookup.executionId,
				confirmedCursor,
			});
		},
		() => ({ httpStatus: events?.status }),
	);
	let status;
	await probeStep(
		`${name}-status`,
		async () => {
			status = await request("v3/status", protocol.status(submitted));
			assert.equal(status.status, 200);
			assert.equal(JSON.parse(status.text).outcome, "found");
			assert.equal(JSON.parse(status.text).status, expectedStatus);
		},
		() => ({
			httpStatus: status?.status,
			resultStatus: status ? JSON.parse(status.text).status : undefined,
		}),
	);
	return submitted;
}

async function assertNoSensitiveDataOnDisk(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await assertNoSensitiveDataOnDisk(path);
		else if (entry.isFile()) {
			const bytes = await readFile(path);
			if (
				[...Object.values(credentials), failureMarker, privatePath].some(
					(marker) => bytes.includes(Buffer.from(marker)),
				)
			) {
				isolationFileKind = entry.name.endsWith(".jsonl")
					? "native-history"
					: entry.name.includes("sqlite")
						? "native-database"
						: "other";
				if (entry.name.endsWith(".jsonl")) {
					isolationFileKind += entry.name.startsWith("rollout-")
						? ":rollout"
						: ":other-jsonl";
				}
				assert.fail("sensitive model failure data retained");
			}
		}
	}
}

async function runImageProbe() {
	// These are the deployed Host dependencies, never a source checkout fallback.
	const contracts = await import(
		"/app/node_modules/@agent-infra/contracts/dist/runtime/index.mjs"
	);
	const { requestDigest } = await import(
		"/app/node_modules/@agent-infra/agent-runtime/dist/index.mjs"
	);
	protocol = createRuntimeProbeProtocol({
		contracts,
		requestDigest,
		privateKey,
	});
	await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
	const origin = `http://127.0.0.1:${model.address().port}`;
	await mkdir("/tmp/personal", { recursive: true });
	const personalConfig =
		'model="synthetic-personal-model"\n[mcp_servers.personal]\ncommand="/synthetic/forbidden"\n';
	await writeFile("/tmp/personal/config.toml", personalConfig);
	const env = deployment(origin, "/var/lib/agent-runtime/success");
	if (process.argv[2] === "--provenance-rejection") {
		stage = "provenance-rejection";
		await launch(env, "RUNTIME_CODEX_PROVENANCE_MISMATCH");
		assert.equal(requests.length, 0);
		console.info(
			JSON.stringify({ status: "passed", check: "provenance-fail-closed" }),
		);
	} else {
		stage = "entrypoint-configuration-rejections";
		for (const patch of [
			{ AGENT_INFRA_RUNTIME_DRIVER: "arbitrary-driver" },
			{ AGENT_INFRA_RUNTIME_MODEL_CONFIG: "{}" },
			{ AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT: "" },
		])
			await launch({ ...env, ...patch }, "RUNTIME_CONFIGURATION_INVALID");
		checks.push("configuration-fail-closed");
		stage = "default-turn";
		let runtime = await launch(env);
		const observedConfigVersion = runtime.configVersion;
		const defaultTurn = await turn("default");
		check(
			"native-active-default-model",
			requests.length === 1 &&
				requests[0].authenticated &&
				requests[0].path === "/approved-default/v1/responses" &&
				requests[0].model === "gpt-5.2" &&
				requests[0].effort === "medium" &&
				requests[0].input,
		);
		stage = "execution-selection";
		const selected = await turn(
			"selected",
			{
				schemaVersion: 1,
				modelOptionId: "selected-option",
				reasoningLevel: "high",
			},
			"completed",
			defaultTurn.lookup,
			async (selected) => {
				await waitForModelRequest("/approved-selected/v1/responses");
				const replayed = await request(
					selected.path,
					protocol.signRequest(selected.submit, "turn.submit"),
				);
				check(
					"submit-idempotency",
					replayed.status === 200 && requests.length === 2,
				);
				const conflicting = await request(
					selected.path,
					protocol.signRequest(
						{
							...selected.submit,
							selection: {
								schemaVersion: 1,
								modelOptionId: "default-option",
								reasoningLevel: "medium",
							},
						},
						"turn.submit",
					),
				);
				check(
					"selection-conflict",
					conflicting.status === 409 && requests.length === 2,
				);
			},
		);
		check(
			"native-execution-selection",
			requests.length === 2 &&
				requests[1].path === "/approved-selected/v1/responses" &&
				requests[1].model === "gpt-5.2" &&
				requests[1].effort === "high" &&
				requests[1].authenticated,
		);
		stage = "grant-rejections";
		const freshSubmission = protocol.signRequest(
			selected.submit,
			"turn.submit",
		);
		const invalid = await request(selected.path, {
			...freshSubmission,
			grant: {
				...freshSubmission.grant,
				token: `${freshSubmission.grant.token.split(".").slice(0, 2).join(".")}.${randomBytes(64).toString("base64url")}`,
			},
		});
		const other = protocol.binding("other", { agentId: "other-agent" });
		const wrongAgent = await request(
			"v3/turns",
			protocol.signRequest(
				{
					...other,
					input: selected.submit.input,
				},
				"turn.submit",
			),
		);
		const unauthorized = await request(
			selected.path,
			selected.submit,
			"synthetic-invalid-token",
		);
		check(
			"grant-and-agent-binding",
			invalid.status === 403 &&
				wrongAgent.status === 403 &&
				unauthorized.status === 401 &&
				requests.length === 2,
		);
		stage = "process-restart";
		await runtime.stop();
		runtime = await launch(env);
		const restored = await request("v3/status", protocol.status(selected));
		await turn(
			"resumed",
			selected.submit.selection,
			"completed",
			selected.lookup,
			undefined,
			"recovery",
		);
		check(
			"persistent-runtime-restart",
			restored.status === 200 &&
				JSON.parse(restored.text).status === "completed" &&
				requests.length === 2,
		);
		await runtime.stop();
		for (const [name, changes] of [
			[
				"http-401",
				{
					AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT:
						"synthetic-unusable-credential",
				},
			],
			...["http-403", "http-503", "redirect", "wrong-content-type"].map(
				(name) => [
					name,
					{
						AGENT_INFRA_RUNTIME_MODEL_CONFIG:
							env.AGENT_INFRA_RUNTIME_MODEL_CONFIG.replace(
								"/approved-default/v1",
								`/${name}/v1`,
							),
					},
				],
			),
		]) {
			stage = `${name}-failure`;
			runtime = await launch({
				...env,
				...changes,
				AGENT_INFRA_RUNTIME_DATA_DIR: `/var/lib/agent-runtime/${name}`,
			});
			await turn(name, undefined, "failed");
			await runtime.stop();
		}
		checks.push("http-failures-redacted");

		for (const name of [
			"response-failed",
			"response-incomplete",
			"error-event",
			"malformed",
			"oversized",
			"unterminated",
			"post-terminal",
			"unknown-event",
			"wrong-shape",
			"extra-error",
			"nested-error",
			"credential-echo",
		]) {
			stage = `${name}-stream-failure`;
			runtime = await launch({
				...env,
				AGENT_INFRA_RUNTIME_DATA_DIR: `/var/lib/agent-runtime/${name}`,
				AGENT_INFRA_RUNTIME_MODEL_CONFIG:
					env.AGENT_INFRA_RUNTIME_MODEL_CONFIG.replace(
						"/approved-default/v1",
						`/${name}/v1`,
					),
			});
			await turn(name, undefined, "failed");
			await runtime.stop();
		}
		checks.push("stream-failures-redacted");

		stage = "model-stop";
		runtime = await launch({
			...env,
			AGENT_INFRA_RUNTIME_DATA_DIR: "/var/lib/agent-runtime/stop",
			AGENT_INFRA_RUNTIME_MODEL_CONFIG:
				env.AGENT_INFRA_RUNTIME_MODEL_CONFIG.replace(
					"/approved-default/v1",
					"/stop/v1",
				).replace("/approved-selected/v1", "/hold-selected/v1"),
		});
		const stopped = await submitTurn("stop");
		const stopRequest = await waitForOpenModelRequest("/stop/v1/responses");
		stage = "model-stop-request";
		const independentTurn = turn("stop-independent", {
			schemaVersion: 1,
			modelOptionId: "selected-option",
			reasoningLevel: "high",
		}).then(
			(value) => ({ value }),
			(error) => ({ error }),
		);
		const independentRequest = await probeStep("model-stop-request", () =>
			waitForOpenModelRequest("/hold-selected/v1/responses"),
		);
		await probeStep(
			"model-stop-target-open",
			() => {
				assert.equal(stopRequest.closed, false);
			},
			() => ({ authenticated: stopRequest.authenticated }),
		);
		await probeStep(
			"model-stop-independent-open",
			() => {
				assert.equal(independentRequest.closed, false);
			},
			() => ({ authenticated: independentRequest.authenticated }),
		);
		const stopConfirmation = request(
			"v3/stops",
			protocol.signRequest(
				{
					...stopped.lookup,
					operation: {
						...stopped.lookup.operation,
						kind: "stop",
						id: "stop-generation-synthetic",
					},
				},
				"turn.stop",
				"stop",
			),
		);
		const stopResult = await assertUpstreamClosedBeforeConfirmation(
			stopRequest,
			stopConfirmation,
			"model-stop",
		);
		await probeStep(
			"model-stop-result",
			() => {
				assert.equal(stopResult.status, 200);
				assert.deepEqual(JSON.parse(stopResult.text).result, {
					outcome: "accepted",
					status: "cancelled",
				});
			},
			() => ({
				httpStatus: stopResult.status,
				resultStatus: JSON.parse(stopResult.text).result?.status,
			}),
		);
		await probeStep(
			"model-stop-independent-closed",
			() => {
				assert.equal(independentRequest.closed, false);
			},
			() => ({ authenticated: independentRequest.authenticated }),
		);
		await probeStep(
			"model-stop-independent-release",
			() => {
				assert.ok(releaseHeldSelectedResponse);
			},
			() => ({ authenticated: independentRequest.authenticated }),
		);
		releaseHeldSelectedResponse();
		releaseHeldSelectedResponse = undefined;
		const independentResult = await independentTurn;
		if (independentResult.error) throw independentResult.error;
		await turn(
			"stop-follow-up",
			{
				schemaVersion: 1,
				modelOptionId: "selected-option",
				reasoningLevel: "high",
			},
			"completed",
			stopped.lookup,
		);
		await runtime.stop();

		stage = "model-cancellation";
		const cancellationEnvironment = {
			...env,
			AGENT_INFRA_RUNTIME_DATA_DIR: "/var/lib/agent-runtime/cancel",
			AGENT_INFRA_RUNTIME_MODEL_CONFIG:
				env.AGENT_INFRA_RUNTIME_MODEL_CONFIG.replace(
					"/approved-default/v1",
					"/cancel/v1",
				),
		};
		runtime = await launch(cancellationEnvironment);
		const cancellation = await submitTurn("cancel");
		const cancellationRequest = await waitForOpenModelRequest(
			"/cancel/v1/responses",
		);
		stage = "model-cancellation-request";
		await probeStep(
			"model-cancellation-request-closed",
			() => assert.equal(cancellationRequest.closed, false),
			() => ({ authenticated: cancellationRequest.authenticated }),
		);
		httpStatus = undefined;
		responseCode = undefined;
		stage = "model-cancellation-close-before-confirmation";
		const cancelConfirmation = request(
			"v3/generations/cancel",
			protocol.signRequest(
				{
					...cancellation.lookup,
					operation: {
						...cancellation.lookup.operation,
						kind: "generation",
						id: "generation-cancel-synthetic",
					},
				},
				"generation.cancel",
				"generation_isolation",
			),
		);
		const cancelResult = await assertUpstreamClosedBeforeConfirmation(
			cancellationRequest,
			cancelConfirmation,
			"model-cancellation",
		);
		await probeStep(
			"model-cancellation-result",
			() => {
				assert.equal(cancelResult.status, 200);
				const cancellationResult = JSON.parse(cancelResult.text).result;
				if (
					["running", "completed", "failed", "cancelled"].includes(
						cancellationResult?.status,
					)
				)
					resultStatus = cancellationResult.status;
				assert.deepEqual(cancellationResult, {
					outcome: "accepted",
					status: "cancelled",
				});
			},
			() => ({
				httpStatus: cancelResult.status,
				resultStatus: JSON.parse(cancelResult.text).result?.status,
			}),
		);
		stage = "model-cancellation-status";
		const cancelledStatus = await request(
			"v3/status",
			protocol.status(cancellation, "generation_isolation"),
		);
		const cancelledReplay = await request(
			cancellation.path,
			protocol.signRequest(cancellation.submit, "turn.submit"),
		);
		await runtime.stop();
		stage = "model-cancellation-restart";
		runtime = await launch(cancellationEnvironment);
		const restartedCancelledStatus = await request(
			"v3/status",
			protocol.status(cancellation, "generation_isolation"),
		);
		const restartedCancelledReplay = await request(
			cancellation.path,
			protocol.signRequest(cancellation.submit, "turn.submit"),
		);
		check(
			"cancellation-aborts-upstream",
			stopRequest.closed &&
				cancellationRequest.closed &&
				cancelledStatus.status === 200 &&
				JSON.parse(cancelledStatus.text).outcome === "found" &&
				JSON.parse(cancelledStatus.text).status === "cancelled" &&
				restartedCancelledStatus.status === 200 &&
				JSON.parse(restartedCancelledStatus.text).outcome === "found" &&
				JSON.parse(restartedCancelledStatus.text).status === "cancelled" &&
				cancelledReplay.status === 409 &&
				JSON.parse(cancelledReplay.text).code ===
					"RUNTIME_GENERATION_CANCELLED" &&
				restartedCancelledReplay.status === 409 &&
				JSON.parse(restartedCancelledReplay.text).code ===
					"RUNTIME_GENERATION_CANCELLED",
		);
		await runtime.stop();

		stage = "native-sandboxed-tool-execution";
		await writeFile(toolDeniedPath, "owner-write-control");
		await unlink(toolDeniedPath);
		await writeFile(toolExistingPath, "owner-truncate-control");
		execFileSync("truncate", ["-s", "0", toolExistingPath], {
			timeout: 5_000,
			stdio: "ignore",
		});
		assert.equal(await readFile(toolExistingPath, "utf8"), "");
		await writeFile(toolExistingPath, "owner-truncate-control");
		// The sibling Conversation directory exists before the owning process
		// starts, so the boundary is the only reason the tool cannot reach it.
		await mkdir(`${toolSiblingRoot}/workspace`, {
			recursive: true,
			mode: 0o700,
		});
		for (const directory of [
			toolBoundaryPath,
			toolSiblingRoot,
			`${toolSiblingRoot}/workspace`,
		]) {
			await chmod(directory, 0o700);
		}
		await writeFile(toolSiblingFile, toolSiblingContent);
		runtime = await launch(
			deployment(origin, "/var/lib/agent-runtime/tool-probe"),
		);
		toolProbePending = true;
		await turn("tool-probe");
		check(
			"native-sandboxed-tool-execution",
			typeof toolProbeOutput === "string" &&
				toolProbeOutput.includes("Process exited with code 0") &&
				toolProbeOutput.includes("runtime-tool-ok") &&
				toolProbeOutput.includes("runtime-truncate-denied") &&
				toolProbeOutput.includes("Permission denied"),
		);
		// The same marker also covers the process environment channel: a readable
		// `/proc` would let a model tool lift the model credential straight out of
		// a native process's environment.
		check(
			"native-sibling-conversation-denied",
			typeof toolProbeOutput === "string" &&
				toolProbeOutput.includes("runtime-sibling-denied"),
		);
		assert.equal(await readFile(toolSiblingFile, "utf8"), toolSiblingContent);
		await assert.rejects(readFile(toolDeniedPath), { code: "ENOENT" });
		assert.equal(
			await readFile(toolExistingPath, "utf8"),
			"owner-truncate-control",
		);
		await runtime.stop();

		stage = "recursive-native-storage-redaction";
		await assertNoSensitiveDataOnDisk("/var/lib/agent-runtime");
		checks.push("recursive-native-storage-redacted");
		check(
			"personal-configuration-isolated",
			(await readFile("/tmp/personal/config.toml", "utf8")) === personalConfig,
		);
		stage = "installed-codex-identity";
		const releaseBytes = await readFile("/opt/codex/share/release.json");
		const release = JSON.parse(releaseBytes.toString("utf8"));
		let derivedIdentity;
		if (release.schemaVersion === 2) {
			assert.equal(release.distribution.kind, "derived");
			const artifact = release.artifacts[process.arch];
			assert.ok(artifact?.target);
			const candidateBytes = await readFile("/opt/codex/share/candidate.json");
			const binaries = {};
			for (const [name, path] of Object.entries({
				codex: "bin/codex",
				"codex-code-mode-host": "codex-resources/codex-code-mode-host",
				"codex-responses-api-proxy": "bin/codex-responses-api-proxy",
				bwrap: "codex-resources/bwrap",
			})) {
				const hash = createHash("sha256");
				for await (const chunk of createReadStream(join("/opt/codex", path)))
					hash.update(chunk);
				binaries[name] = `sha256:${hash.digest("hex")}`;
			}
			derivedIdentity = {
				protocolVersion: release.provenance.protocolVersion,
				distribution: {
					...release.distribution,
					target: artifact.target,
					releaseSha256: `sha256:${createHash("sha256").update(releaseBytes).digest("hex")}`,
					candidateManifestSha256: `sha256:${createHash("sha256").update(candidateBytes).digest("hex")}`,
					binaries,
				},
			};
		}
		console.info(
			JSON.stringify({
				schemaVersion: derivedIdentity ? 2 : 1,
				status: "passed",
				codexVersion: release.provenance.codexVersion,
				configurationSchemaVersion: 2,
				configVersion: observedConfigVersion,
				checks,
				...derivedIdentity,
			}),
		);
	}
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
	try {
		await runImageProbe();
	} catch (error) {
		console.error(
			JSON.stringify(
				error instanceof ProbeStepFailure
					? error.diagnostic
					: {
							status: "failed",
							stage,
							startupCode,
							httpStatus,
							responseCode,
							resultStatus,
							isolationFileKind,
							modelRequests: requests.length,
						},
			),
		);
		process.exitCode = 1;
	} finally {
		for (const child of processes) child.kill("SIGKILL");
		model.closeAllConnections();
		await new Promise((resolve) => model.close(resolve));
	}
}
