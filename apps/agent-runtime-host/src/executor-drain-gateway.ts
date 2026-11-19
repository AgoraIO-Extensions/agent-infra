import { randomUUID } from "node:crypto";
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
	continueExecutorProcessGroupV1,
	type ExecutorProcessGroupV1,
	executorChildrenV1,
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

interface Attachment {
	readonly executionId: string;
	readonly protocolSession: string;
	readonly token: string;
	readonly groups: Map<string, ExecutorProcessGroupV1 | null>;
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
	const startupProbe = openPrivateExecutorV1(binding.workspaceRoot, nativeHome);
	try {
		await startupProbe.initialize();
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
			for (const rawAttempt of input.attempts) {
				const attempt = record(rawAttempt);
				if (attempt.protocolSession !== current.protocolSession)
					throw new Error("CODEX_EXECUTOR_CONTROL_REJECTED");
				handles.add(identifier(attempt.handle));
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
			const groups = [...handles].map((handle) => {
				const group = current.groups.get(handle);
				if (!group) throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
				return { handle, group };
			});
			const exited = await Promise.all(
				groups.map(async ({ handle, group }) => {
					if (input.terminate === true)
						await current.backend
							.request("process/terminate", { processId: handle }, 500)
							.catch(() => undefined);
					return waitForExecutorProcessGroupExitV1(group, deadline);
				}),
			);
			if (exited.some((result) => !result))
				throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
			current.drained = true;
			// Keep the original native queries alive until the Driver retires this
			// connection. The execution stays sealed to any further launches.
			result = { epoch, digest, stopRequestId, stopFence: input.stopFence };
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
						current.backend.notification(method, frame.params);
						return;
					}
					if (method !== "process/start") {
						const response = await current.backend.request(
							method,
							frame.params,
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
						emit({ ...response, id: frame.id });
						return;
					}
					const group = await waitForExecutorProcessGroupV1(
						parent,
						before,
						Date.now() + 1_000,
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
