import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
	type CodexSessionExecutorBindingV1,
	type ExecutorIdentityV1,
	executorControlRequestV1,
	executorHostControlOriginV1,
	probeCodexSessionExecutorStartupV1,
	signExecutorControlV1,
	verifyExecutorControlV1,
} from "@agent-infra/agent-runtime";
import { WebSocket, WebSocketServer } from "ws";
import {
	executorIdentityConsumedV1,
	executorIdentityDeliveryRemovedV1,
} from "./executor-identity-startup.js";
import {
	continueExecutorProcessGroupV1,
	type ExecutorProcessGroupV1,
	executorChildrenV1,
	executorProcessStartTicksV1,
	terminateExecutorDescendantsV1,
	trackExecutorDescendantsV1,
	waitForExecutorDescendantsExitV1,
	waitForExecutorProcessGroupExitV1,
	waitForExecutorProcessGroupV1,
} from "./executor-process-group.js";
import { openPrivateExecutorV1 } from "./executor-stdio.js";

function record(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
	return input as Record<string, unknown>;
}

function identifier(input: unknown) {
	if (typeof input !== "string" || !/^[\x21-\x7e]{1,256}$/.test(input))
		throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
	return input;
}

async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > 524_288) throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
		chunks.push(bytes);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

interface RejectedStart {
	readonly rejection: { code: number; occurredAt: number };
	readonly parent: number;
	readonly parentStartTicks: string;
}

interface Attachment {
	readonly executionId: string;
	readonly protocolSession: string;
	readonly token: string;
	readonly groups: Map<string, ExecutorProcessGroupV1 | RejectedStart | null>;
	readonly backend: ReturnType<typeof openPrivateExecutorV1>;
	connected: boolean;
	sealed: boolean;
	drained: boolean;
	stop?: { id: string; fence: number };
}

/** The actual native exec-server is reachable only through the runner's pipes. */
export async function startExecutorDrainGatewayV1(options: {
	readonly binding: CodexSessionExecutorBindingV1;
	readonly identity: ExecutorIdentityV1;
	readonly epoch: string;
	readonly nativeHome: string;
}) {
	const { binding, identity, epoch, nativeHome } = options;
	const startup =
		"instance" in identity
			? {
					schemaVersion: 2 as const,
					attemptId: identity.instance.attemptId,
					startupRef: identity.startupRef,
					recordRef: identity.instance.recordRef,
					factDigest: identity.factDigest,
				}
			: undefined;
	trackExecutorDescendantsV1();
	if ((await executorChildrenV1(process.pid)).size)
		throw new Error("CODEX_EXECUTOR_DESCENDANTS_UNAVAILABLE");
	const startupProbe = openPrivateExecutorV1(binding.workspaceRoot, nativeHome);
	try {
		await startupProbe.initialize();
		await startupProbe.requireLaunchIsolation();
		await probeCodexSessionExecutorStartupV1(binding, {
			async request(method, params) {
				const response = await startupProbe.request(method, params);
				if (response.error) throw new Error("CODEX_EXECUTOR_STARTUP_FAILED");
				return response.result;
			},
			close: startupProbe.close,
		});
	} finally {
		startupProbe.close();
	}
	let attachment: Attachment | undefined;
	let closed = false;
	let actions: Promise<unknown> = Promise.resolve();
	const nonces = new Map<string, number>();
	function serialize<T>(work: () => Promise<T>) {
		const next = actions.then(work);
		actions = next.catch(() => undefined);
		return next;
	}
	async function persistRejection(
		current: Attachment,
		handle: string,
		rejected: RejectedStart,
	) {
		await executorControlRequestV1(
			identity,
			executorHostControlOriginV1,
			"/control/start-rejected",
			{
				epoch,
				executionId: current.executionId,
				protocolSession: current.protocolSession,
				handle,
				generation: binding.sessionGeneration,
				resourceFence: binding.resourceFence,
				...rejected.rejection,
			},
		);
	}
	async function route(path: string, raw: unknown) {
		const request = verifyExecutorControlV1(identity, path, raw);
		if (!request) throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
		for (const [nonce, deadline] of nonces) {
			if (deadline <= Date.now()) nonces.delete(nonce);
		}
		if (nonces.size >= 4_096 || nonces.has(request.requestId))
			throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
		nonces.set(request.requestId, request.deadline);
		const input = record(request.contents);
		if (
			closed ||
			input.resourceFence !== binding.resourceFence ||
			input.generation !== binding.sessionGeneration ||
			(path !== "/control/status" && input.epoch !== epoch)
		)
			throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
		let result: unknown;
		if (path === "/control/status") {
			result = { epoch };
		} else if (path === "/control/session-instance/read") {
			result = {
				epoch,
				runnerIdentityConsumed: executorIdentityConsumedV1(identity),
				deliveryFilesRemoved: await executorIdentityDeliveryRemovedV1(identity),
				executorReady:
					!closed && (await executorChildrenV1(process.pid)).size === 0,
				emptyBusinessState: attachment === undefined,
			};
		} else if (path === "/control/attach") {
			const executionId = identifier(input.executionId);
			if (!attachment || attachment.executionId !== executionId) {
				if (attachment && !attachment.drained)
					throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
				attachment?.backend.close();
				attachment = {
					executionId,
					protocolSession: randomUUID(),
					token: randomUUID(),
					groups: new Map(),
					backend: openPrivateExecutorV1(binding.workspaceRoot, nativeHome),
					connected: false,
					sealed: false,
					drained: false,
				};
			}
			if (attachment.sealed || (attachment.connected && !attachment.drained))
				throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
			result = {
				endpoint: `ws://127.0.0.1:8068/native/${attachment.token}`,
				protocolSession: attachment.protocolSession,
			};
		} else if (path === "/control/drain") {
			const current = attachment;
			if (!current || current.executionId !== input.executionId)
				throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
			const digest = identifier(input.digest);
			const stopRequestId = identifier(input.stopRequestId);
			if (
				!Number.isSafeInteger(input.stopFence) ||
				!Array.isArray(input.attempts) ||
				(input.terminate === true &&
					(typeof input.authorizedUntil !== "number" ||
						!Number.isSafeInteger(input.authorizedUntil) ||
						input.authorizedUntil <= Date.now() ||
						input.authorizedUntil > request.deadline))
			)
				throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
			const stopFence = Number(input.stopFence);
			if (
				stopFence < 1 ||
				(current.stop &&
					(current.stop.id !== stopRequestId || current.stop.fence > stopFence))
			)
				throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
			if (input.terminate === true)
				current.stop = { id: stopRequestId, fence: stopFence };
			current.sealed = true;
			const handles = new Set<string>();
			const rejectedStarts: { id: string; rejectedAt: number }[] = [];
			const rejectedScopes: RejectedStart[] = [];
			for (const rawAttempt of input.attempts) {
				const attempt = record(rawAttempt);
				if (attempt.protocolSession !== current.protocolSession)
					throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
				const handle = identifier(attempt.handle);
				if (handles.has(handle))
					throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
				handles.add(handle);
				const pending = current.groups.get(handle);
				if (pending && "rejection" in pending) {
					// An interrupted acknowledgement retries the same fact, never process/start.
					await persistRejection(current, handle, pending);
					const rejection = record(attempt.rejection);
					if (
						rejection.code !== pending.rejection.code ||
						rejection.occurredAt !== pending.rejection.occurredAt ||
						typeof rejection.id !== "string" ||
						!/^[a-f0-9]{64}$/.test(rejection.id)
					)
						throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
					rejectedStarts.push({
						id: rejection.id,
						rejectedAt: pending.rejection.occurredAt,
					});
					rejectedScopes.push(pending);
				} else if (attempt.rejection !== undefined) {
					throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
				}
			}
			if (handles.size !== current.groups.size)
				throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
			const deadline = Math.min(
				request.deadline,
				typeof input.authorizedUntil === "number"
					? input.authorizedUntil
					: request.deadline,
				Date.now() + 1_000,
			);
			const groups = [...handles].flatMap((handle) => {
				const group = current.groups.get(handle);
				if (!group) throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
				if ("rejection" in group) return [];
				const id = createHash("sha256")
					.update(
						JSON.stringify([
							epoch,
							current.protocolSession,
							handle,
							group.leader,
							group.startTicks,
						]),
					)
					.digest("hex");
				return [{ handle, group, id }];
			});
			if (input.terminate === true) {
				// Materialize the registered groups before asking the backend to stop.
				process.stdout.write(
					`${JSON.stringify({
						schemaVersion: 1,
						code: "CODEX_EXECUTOR_DRAIN_SEALED",
						podUid: identity.podUid,
						executionId: current.executionId,
						stopRequestId,
						generation: binding.sessionGeneration,
						resourceFence: binding.resourceFence,
						epoch,
						stopFence,
						digest,
						groupIds: groups.map(({ id }) => id),
						...(startup ? { startup } : {}),
						...(rejectedStarts.length ? { rejectedStarts } : {}),
					})}\n`,
				);
			}
			if (input.terminate === true) {
				await Promise.all(
					groups.map(({ handle }) =>
						current.backend
							.request("process/terminate", { processId: handle }, 500)
							.catch(() => undefined),
					),
				);
				if (!current.backend.pid)
					throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
				await terminateExecutorDescendantsV1(current.backend.pid, deadline);
			}
			const exited = await Promise.all(
				groups.map(async ({ group, id }) => {
					if (!(await waitForExecutorProcessGroupExitV1(group, deadline)))
						return null;
					return { id, exitedAt: Date.now() };
				}),
			);
			const rejectedExited = await Promise.all(
				rejectedScopes.map((scope) =>
					waitForExecutorDescendantsExitV1(
						scope.parent,
						scope.parentStartTicks,
						deadline,
					),
				),
			);
			if (
				exited.some((result) => !result) ||
				rejectedExited.some((exited) => !exited)
			)
				throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
			current.drained = true;
			// Keep the original native queries alive until the Driver retires this
			// connection. The execution stays sealed to any further launches.
			result = {
				epoch,
				digest,
				stopRequestId,
				stopFence: input.stopFence,
				groups: exited,
				...(rejectedStarts.length ? { rejectedStarts } : {}),
			};
		} else {
			throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
		}
		return signExecutorControlV1(
			identity,
			`${path}/result`,
			result,
			request.requestId,
			request.deadline,
		);
	}

	const server = createServer((request, response) => {
		if (
			request.method === "GET" &&
			["/status", "/lifetime"].includes(request.url ?? "")
		) {
			const status = JSON.stringify({
				schemaVersion: 1,
				podUid: identity.podUid,
				bindingDigest: identity.bindingDigest,
				epoch,
				ready: !closed,
			});
			response.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			if (request.url === "/status") {
				response.end(status);
			} else {
				response.write(`${status}\n`);
				const timer = setInterval(
					() =>
						response.writableLength > 4096
							? response.destroy()
							: response.write(`${status}\n`),
					250,
				);
				timer.unref();
				response.once("close", () => clearInterval(timer));
			}
			return;
		}
		if (request.method !== "POST") {
			response.writeHead(404).end();
			return;
		}
		void body(request)
			.then((raw) => serialize(() => route(request.url ?? "", raw)))
			.then(
				(result) =>
					response
						.writeHead(200, { "content-type": "application/json" })
						.end(JSON.stringify(result)),
				() => response.writeHead(503).end(),
			);
	});
	const sockets = new WebSocketServer({
		noServer: true,
		maxPayload: 64 * 1024 * 1024,
	});
	server.on("upgrade", (request, socket, head) => {
		const current = attachment;
		if (
			closed ||
			!current ||
			current.connected ||
			current.sealed ||
			request.headers.origin !== undefined ||
			request.url !== `/native/${current.token}`
		) {
			socket.destroy();
			return;
		}
		current.connected = true;
		sockets.handleUpgrade(request, socket, head, (client) => {
			const emit = (frame: unknown) => {
				if (client.readyState === WebSocket.OPEN)
					client.send(JSON.stringify(frame));
			};
			current.backend.notifications.add(emit);
			client.once("close", () => current.backend.notifications.delete(emit));
			client.on("error", () => client.terminate());
			client.on("message", (message, binary) => {
				let frame: Record<string, unknown>;
				try {
					if (binary) throw new Error();
					frame = record(JSON.parse(message.toString()));
				} catch {
					client.terminate();
					return;
				}
				void serialize(async () => {
					const method = identifier(frame.method);
					if (
						closed ||
						current !== attachment ||
						(current.sealed && method === "process/start")
					)
						throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
					if (frame.id === undefined) {
						if (method === "process/start")
							throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
						current.backend.notification(method, frame.params);
						return;
					}
					if (method !== "process/start") {
						let timeoutMs = 2000;
						if (method === "process/read") {
							const value = record(frame.params).waitMs;
							const waitMs = value === undefined ? 0 : value;
							if (
								typeof waitMs !== "number" ||
								!Number.isSafeInteger(waitMs) ||
								waitMs < 0 ||
								waitMs > 30000
							)
								throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
							timeoutMs += waitMs;
						}
						const response = await current.backend.request(
							method,
							frame.params,
							timeoutMs,
						);
						emit({ ...response, id: frame.id });
						return;
					}
					const params = record(frame.params);
					const handle = identifier(params.processId);
					if (
						current.groups.size >= 4_096 ||
						current.groups.has(handle) ||
						!Array.isArray(params.argv) ||
						params.argv.length === 0 ||
						!params.argv.every((argument) => typeof argument === "string") ||
						(params.arg0 != null && typeof params.arg0 !== "string")
					)
						throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
					await current.backend.requireLaunchIsolation();
					const admitted = record(
						await executorControlRequestV1(
							identity,
							executorHostControlOriginV1,
							"/control/register",
							{
								epoch,
								executionId: current.executionId,
								protocolSession: current.protocolSession,
								handle,
								generation: binding.sessionGeneration,
								resourceFence: binding.resourceFence,
							},
						),
					);
					if (admitted.admitted !== true)
						throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
					current.groups.set(handle, null);
					const parent = current.backend.pid;
					if (!parent) throw new Error("CODEX_EXECUTOR_TRANSPORT_UNAVAILABLE");
					const parentStartTicks = await executorProcessStartTicksV1(parent);
					const before = await executorChildrenV1(parent);
					const { CODEX_EXEC_SERVER_URL: _executorUrl, ...environment } =
						record(params.env);
					const response = await current.backend.request(method, {
						...params,
						arg0: null,
						env: environment,
						argv:
							typeof params.arg0 === "string"
								? [
										"/bin/bash",
										"-c",
										'kill -STOP "$$"; name=$1; shift; exec -a "$name" "$@"',
										"agent-infra-executor",
										params.arg0,
										...params.argv,
									]
								: [
										"/bin/sh",
										"-c",
										'kill -STOP "$$"; exec "$@"',
										"agent-infra-executor",
										...params.argv,
									],
					});
					if (response.error) {
						const error = record(response.error);
						// Transport closure synthesizes an error without a native response id.
						if (
							typeof response.id === "number" &&
							Number.isSafeInteger(response.id) &&
							Number.isSafeInteger(error.code) &&
							response.result === undefined
						) {
							const rejected: RejectedStart = {
								parent,
								parentStartTicks,
								rejection: {
									code: error.code as number,
									occurredAt: Date.now(),
								},
							};
							current.groups.set(handle, rejected);
							await persistRejection(current, handle, rejected);
						}
						emit({ ...response, id: frame.id });
						return;
					}
					const group = await waitForExecutorProcessGroupV1(
						parent,
						before,
						Date.now() + 1_000,
						parentStartTicks,
					);
					if (!group)
						throw new Error("CODEX_EXECUTOR_PROCESS_IDENTITY_INVALID");
					current.groups.set(handle, group);
					await continueExecutorProcessGroupV1(parent, group);
					emit({ ...response, id: frame.id });
				}).catch(() =>
					emit({
						id: frame.id,
						error: { code: -32000, message: "Executor request unavailable" },
					}),
				);
			});
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(8068, "127.0.0.1", resolve);
	});
	return {
		async close() {
			closed = true;
			for (const socket of sockets.clients) socket.terminate();
			sockets.close();
			attachment?.backend.close();
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
