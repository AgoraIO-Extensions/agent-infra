import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { openPaseoNativeSession } from "./paseo-native-session.js";
import { PaseoTransport } from "./paseo-transport.js";
import { PiRuntimeDriver } from "./pi-runtime-driver.js";

const options = {
	url: "ws://127.0.0.1:6767/ws",
	template: "codex" as const,
	cwd: "/workspace",
	model: "model-id",
};

it.each([
	"wss://example.com/ws",
	"ws://localhost.example/ws",
	"ws://127.0.0.1/ws?relay=1",
	"ws://secret@127.0.0.1/ws",
])("rejects a non-local or credential-bearing URL", (url) => {
	expect(() => new PaseoTransport({ ...options, url })).toThrow(
		"binding_mismatch",
	);
});

const messageId = "client-turn-1";

async function sdkServer(
	template: "pi" | "codex" | "opencode" | "claude",
	beforeCommandsReply?: () => Promise<void>,
) {
	const http = createServer();
	const server = new WebSocketServer({ server: http });
	const socketPath = `/tmp/paseo-${randomUUID()}.sock`;
	http.listen(socketPath);
	await once(http, "listening");

	const connect = (codexThread?: {
		expected?: string;
		bind(id: string): Promise<void>;
	}) =>
		new PaseoTransport({
			...options,
			template,
			url: undefined,
			socketPath,
			thinkingOptionId: "high",
			codexThread,
		});
	const requests: Record<string, unknown>[] = [];
	const provider = template === "opencode" ? "agent-infra-opencode" : template;
	const agent = {
		id: "",
		provider,
		cwd: options.cwd,
		model: options.model,
		thinkingOptionId: "high",
		status: "idle",
		activeTurn: null as null | undefined,
		createdAt: "2026-11-24T00:00:00Z",
		updatedAt: "2026-11-24T00:00:00Z",
		lastUserMessageAt: null,
		capabilities: {
			supportsStreaming: true,
			supportsSessionPersistence: true,
			supportsDynamicModes: false,
			supportsMcpServers: false,
			supportsReasoningStream: false,
			supportsToolInvocations: false,
		},
		currentModeId: null as string | null,
		options: {} as Record<string, string>,
		availableModes: [],
		pendingPermissions: [],
		persistence: null as null | { provider: string; sessionId: string },
		title: null,
	};

	let snapshots = 0;
	server.on("connection", (socket) =>
		socket.on("message", async (bytes) => {
			const frame = JSON.parse(bytes.toString());
			const msg = frame.message;
			const reply = (type: string, payload: unknown) =>
				socket.send(
					JSON.stringify({ type: "session", message: { type, payload } }),
				);
			if (frame.type === "hello")
				return reply("status", {
					status: "server_info",
					serverId: "fixture",
					features: {
						ownedSubscriptions: true,
						creationLifecycle: true,
						providersSnapshot: true,
					},
				});
			if (frame.type === "ping")
				return socket.send(JSON.stringify({ type: "pong" }));
			if (!msg) return;
			requests.push(msg);
			const agentId = msg.agentId ?? agent.id;
			const payload = { requestId: msg.requestId, agentId, error: null };
			switch (msg.type) {
				case "agent.timeline.set_subscription.request":
					return reply("agent.timeline.set_subscription.response", {
						...payload,
						subscriptionId: msg.subscriptionId ?? "sub",
						agentIds: [agentId],
					});
				case "subscription.release.request":
					return reply("subscription.release.response", {
						...payload,
						subscriptionId: msg.subscriptionId,
						success: true,
					});
				case "get_providers_snapshot_request":
					return reply("get_providers_snapshot_response", {
						requestId: msg.requestId,
						generatedAt: agent.createdAt,
						entries: [
							{
								provider,
								source: template === "opencode" ? "custom" : "builtin",
								status: snapshots++ === 0 ? "loading" : "ready",
								models: [{ provider, id: options.model, label: "model" }],
							},
						],
					});
				case "fetch_agent_request":
					return reply("fetch_agent_response", {
						...payload,
						agent: agent.id === agentId ? agent : null,
						project: null,
					});
				case "agent.create.request":
					agent.id = msg.agentId;
					return reply("agent.create.response", { ...payload, agent });
				case "list_commands_request":
					await beforeCommandsReply?.();
					return reply("list_commands_response", {
						...payload,
						commands: [
							{ name: "help", description: "Help", argumentHint: "[topic]" },
						],
					});
				case "set_agent_model_request":
					agent.model = msg.modelId;
					return reply("set_agent_model_response", {
						...payload,
						accepted: true,
					});
				case "set_agent_thinking_request":
					agent.thinkingOptionId = msg.thinkingOptionId;
					return reply("set_agent_thinking_response", {
						...payload,
						accepted: true,
					});
				case "send_agent_message_request":
					if (msg.text === "drop after ACK")
						setTimeout(() => socket.close(), 30);
					if (msg.text === "disconnect") return socket.terminate();
					return reply("send_agent_message_response", {
						...payload,
						accepted: true,
					});
				case "cancel_agent_request":
					return reply("cancel_agent_response", { ...payload, agent });
			}
		}),
	);
	return {
		connect,
		requests,
		agent,
		provider,
		close() {
			for (const socket of server.clients) socket.terminate();
			server.close();
			http.close();
		},
	};
}

it("waits for cold ACP restoration when verifying a command on the original OpenCode agent", async () => {
	const listing = Promise.withResolvers<void>();
	const restored = Promise.withResolvers<void>();
	const server = await sdkServer("opencode", async () => {
		listing.resolve();
		await restored.promise;
	});
	const transport = server.connect();
	const agentId = randomUUID();
	try {
		await transport.ensureAgent(agentId);
		server.agent.status = "closed";
		server.agent.activeTurn = undefined;
		server.agent.persistence = {
			provider: server.provider,
			sessionId: "original-acp",
		};
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const directory = transport.commands(
			agentId,
			undefined,
			async () => {},
			true,
		);
		await Promise.all([
			expect(directory).resolves.toHaveLength(1),
			listing.promise.then(async () => {
				await vi.advanceTimersByTimeAsync(16_000);
				restored.resolve();
			}),
		]);
	} finally {
		restored.resolve();
		vi.useRealTimers();
		await transport.close();
		server.close();
	}
});

it("updates an idle original SDK agent to the saved model and reasoning without creating or prompting", async () => {
	const server = await sdkServer("codex");
	const transport = server.connect();
	const id = "81a25b60-63c2-47b1-9007-fa867c1daba9";
	try {
		await transport.ensureAgent(id);
		server.agent.model = "old-model";
		server.agent.thinkingOptionId = "low";
		await transport.selectAgent(id);
		expect(server.agent).toMatchObject({
			id,
			model: "model-id",
			thinkingOptionId: "high",
		});
		expect(
			server.requests.filter((row) => row.type === "agent.create.request"),
		).toHaveLength(1);
		expect(
			server.requests.filter(
				(row) => row.type === "send_agent_message_request",
			),
		).toHaveLength(0);
		server.agent.cwd = "/foreign";
		await expect(transport.selectAgent(id)).rejects.toMatchObject({
			code: "binding_mismatch",
		});
	} finally {
		await transport.close();
		server.close();
	}
});

it("requires a stored Codex thread handle before selecting a closed SDK agent", async () => {
	const server = await sdkServer("codex");
	const transport = server.connect();
	const id = randomUUID();
	try {
		await transport.ensureAgent(id);
		server.agent.status = "closed";
		server.agent.activeTurn = undefined;
		for (const persistence of [null, { provider: "pi", sessionId: "other" }]) {
			server.agent.persistence = persistence;
			await expect(transport.selectAgent(id)).rejects.toMatchObject({
				code: "binding_mismatch",
			});
		}
		server.agent.persistence = { provider: "codex", sessionId: "original" };
		await transport.selectAgent(id);
		expect(
			server.requests.filter(
				(request) => request.type === "agent.create.request",
			),
		).toHaveLength(1);
	} finally {
		await transport.close();
		server.close();
	}
});

it("checks the original Codex thread before sending or cancelling on a restarted daemon", async () => {
	const server = await sdkServer("codex");
	const id = randomUUID();
	const thread = randomUUID();
	const bind = vi.fn(async (_id: string) => {});
	const first = server.connect({ bind });
	const restarted = server.connect({ expected: thread, bind });
	try {
		await first.ensureAgent(id);
		await first.bindCodexModelThread("paseo-sdk");
		expect(bind).not.toHaveBeenCalled();
		await first.bindCodexModelThread(thread);
		await expect(first.bindCodexModelThread("paseo-sdk")).rejects.toMatchObject(
			{ code: "thread_conflict" },
		);
		expect(bind).toHaveBeenCalledWith(thread);
		await first.close();
		server.agent.status = "closed";
		server.agent.activeTurn = undefined;
		server.agent.persistence = { provider: "codex", sessionId: thread };
		await restarted.selectAgent(id);
		server.agent.persistence.sessionId = randomUUID();
		await expect(restarted.send(id, "one", "one")).rejects.toMatchObject({
			code: "thread_conflict",
		});
		await expect(restarted.cancel(id)).rejects.toMatchObject({
			code: "thread_conflict",
		});
		server.agent.persistence.sessionId = thread;
		await restarted.send(id, "two", "two");
		expect(
			server.requests.filter(
				(row) => row.type === "send_agent_message_request",
			),
		).toMatchObject([{ messageId: "two" }]);
		expect(
			server.requests.filter((row) => row.type === "cancel_agent_request"),
		).toHaveLength(0);
	} finally {
		await first.close();
		await restarted.close();
		server.close();
	}
});

it("pins a retained SDK thread on the first selection of an older Host journal", async () => {
	const server = await sdkServer("codex");
	const id = randomUUID();
	const thread = randomUUID();
	const bind = vi.fn(async (_id: string) => {});
	const client = server.connect({ bind });
	try {
		server.agent.id = id;
		server.agent.persistence = { provider: "codex", sessionId: thread };
		await client.selectAgent(id);
		expect(bind).toHaveBeenCalledExactlyOnceWith(thread);
		await expect(
			client.bindCodexModelThread(randomUUID()),
		).rejects.toMatchObject({ code: "thread_conflict" });
		server.agent.id = randomUUID();
		await expect(client.send(id, "missing", "probe")).rejects.toMatchObject({
			code: "thread_conflict",
		});
		expect(
			server.requests.filter(
				(row) => row.type === "send_agent_message_request",
			),
		).toHaveLength(0);
	} finally {
		await client.close();
		server.close();
	}
});

it("remembers the native thread on the first SDK refresh that includes it", async () => {
	const server = await sdkServer("codex");
	const id = randomUUID();
	const thread = randomUUID();
	const bind = vi.fn(async (_id: string) => {});
	const client = server.connect({ bind });
	try {
		await client.ensureAgent(id);
		await client.bindCodexModelThread("paseo-sdk");
		server.agent.persistence = { provider: "codex", sessionId: thread };
		await client.refetchAgent(id);
		expect(bind).toHaveBeenCalledExactlyOnceWith(thread);
		server.agent.persistence.sessionId = randomUUID();
		await expect(client.send(id, "another", "read")).rejects.toMatchObject({
			code: "thread_conflict",
		});
	} finally {
		await client.close();
		server.close();
	}
});
it("refuses a Codex turn with contradictory provider permissions before submission and still permits cancellation", async () => {
	const server = await sdkServer("codex");
	const transport = server.connect();
	const id = randomUUID();
	try {
		await transport.ensureAgent(id);
		server.agent.currentModeId = "full-access";
		for (const options of [
			{ sandbox_mode: "workspace-write" },
			{ approval_policy: "on-request" },
		] as Record<string, string>[]) {
			server.agent.options = options;
			await expect(
				transport.send(id, messageId, "hello"),
			).rejects.toMatchObject({ code: "permission_conflict" });
		}
		expect(
			server.requests.filter(
				(row) => row.type === "send_agent_message_request",
			),
		).toHaveLength(0);
		await transport.cancel(id);
		expect(
			server.requests.filter((row) => row.type === "cancel_agent_request"),
		).toHaveLength(1);
	} finally {
		await transport.close();
		server.close();
	}
});

it("refuses retained Full Access or an explicit unrestricted sandbox on the shared companion", async () => {
	const server = await sdkServer("codex");
	const transport = server.connect();
	const id = randomUUID();
	try {
		await transport.ensureAgent(id);
		for (const [mode, options] of [
			["full-access", {}],
			["auto", { sandbox_mode: "danger-full-access" }],
		] as const) {
			server.agent.currentModeId = mode;
			server.agent.options = { ...options };
			await expect(transport.selectAgent(id)).rejects.toMatchObject({
				code: "permission_conflict",
			});
			await expect(
				transport.send(id, messageId, "hello"),
			).rejects.toMatchObject({ code: "permission_conflict" });
			expect(await transport.refetchAgent(id)).toBe(true);
		}
		expect(
			server.requests.filter(
				(row) => row.type === "send_agent_message_request",
			),
		).toHaveLength(0);
	} finally {
		await transport.close();
		server.close();
	}
});

it.each(["codex", "claude", "pi", "opencode"] as const)(
	"uses the public SDK to create and reattach the selected %s agent",
	async (template) => {
		const agentId = "81a25b60-63c2-47b1-9007-fa867c1daba9";
		const { agent, provider, connect, requests, close } =
			await sdkServer(template);
		const transport = connect();
		try {
			expect(await transport.refetchAgent(agentId)).toBe(false);
			await expect(transport.commands(agentId)).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(requests.some((r) => r.type === "agent.create.request")).toBe(
				false,
			);
			await transport.ensureAgent(agentId);
			await transport.ensureAgent(agentId);
			expect(
				requests.filter((r) => r.type === "agent.create.request"),
			).toMatchObject([
				{
					agentId,
					idempotencyKey: agentId,
					config: {
						provider,
						model: "model-id",
						cwd: "/workspace",
						thinkingOptionId: "high",
					},
				},
			]);
			await expect(
				transport.commands(agentId, undefined, async () => {
					throw new Error("revoked");
				}),
			).rejects.toThrow("revoked");
			expect(
				requests.filter((r) => r.type === "list_commands_request"),
			).toHaveLength(0);
			expect(await transport.commands(agentId)).toEqual([
				{ name: "help", description: "Help", argumentHint: "[topic]" },
			]);
			agent.activeTurn = undefined;
			await expect(transport.commands(agentId)).rejects.toMatchObject({
				code: "unavailable",
			});
			expect(
				requests.filter((r) => r.type === "list_commands_request"),
			).toHaveLength(1);
			if (template === "opencode") {
				agent.status = "closed";
				agent.persistence = { provider, sessionId: "original-acp" };
				await expect(transport.commands(agentId)).rejects.toMatchObject({
					code: "unavailable",
				});
				expect(
					await transport.commands(agentId, undefined, async () => {}, true),
				).toHaveLength(1);
				agent.status = "idle";
			}
			agent.activeTurn = null;
			const release = await transport.subscribe(agentId, () => {});
			await transport.send(agentId, messageId, "hello");
			await release();
			expect(
				requests.filter((r) => r.type === "send_agent_message_request"),
			).toMatchObject([{ agentId, messageId, text: "hello" }]);
			await transport.cancel(agentId);
			expect(
				requests.filter((r) => r.type === "cancel_agent_request"),
			).toHaveLength(1);
			agent.model = "changed";
			await expect(
				transport.send(agentId, "wrong", "ignored"),
			).rejects.toMatchObject({ code: "binding_mismatch" });
			agent.model = options.model;
			await expect(
				transport.send(agentId, "uncertain", "disconnect"),
			).rejects.toMatchObject({
				message: "acceptance_unknown",
				code: "acceptance_unknown",
			});
			expect(
				requests.filter((r) => r.type === "send_agent_message_request"),
			).toHaveLength(2);
		} finally {
			close();
			await transport.close();
		}
	},
);
it("rejects unsupported Pi input before submission and retains an acknowledged turn as unknown after socket loss", async () => {
	const { connect, requests, close } = await sdkServer("pi");
	const path = await mkdtemp(join(tmpdir(), "paseo-sdk-driver-"));
	const openDriver = () =>
		PiRuntimeDriver.open({
			path,
			configVersion: "configuration-a",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					nativeModelId: options.model,
					reasoningLevels: ["high"],
				},
			],
			paseoSdk: true,
			launch: vi.fn(async () => {
				throw new Error("unexpected fallback");
			}),
			openPaseoSession: async (session) => {
				const transport = connect();
				return openPaseoNativeSession({
					session,
					transport,
					model: options.model,
					hasConfirmedModelTurn: () => false,
					close: () => transport.close(),
				});
			},
		});
	let driver = await openDriver();
	const command = {
		schemaVersion: 2 as const,
		kind: "submit-turn" as const,
		agentId: "pi",
		conversationId: "conv",
		sessionGeneration: 1,
		executionId: "acked",
		turnId: "turn-a",
		operationId: "op-a",
		input: { text: "drop after ACK", attachments: [] },
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "primary",
			reasoningLevel: "high",
		},
	};
	try {
		for (const input of [
			{ text: "   /clear", attachments: [] },
			{ text: "text", attachments: ["file-input"] },
		]) {
			const unsupported = { ...command, input };
			await expect(driver.execute(unsupported)).rejects.toMatchObject({
				code: "RUNTIME_TURN_NOT_SUBMITTED",
			});
			expect(await driver.lookupOperation(unsupported)).toEqual({
				state: "missing",
			});
		}
		const { selection: _selection, ...legacy } = command;
		await expect(
			driver.execute({
				...legacy,
				schemaVersion: 1,
				input: { text: "/clear", attachments: [] },
			}),
		).rejects.toMatchObject({ code: "RUNTIME_NATIVE_SESSION_UNAVAILABLE" });
		expect(requests).toHaveLength(0);
		const result = await driver.execute(command);
		expect(result.result.outcome).toBe("unknown");
		expect(
			await driver.replayEvents(result.nativeSessionRef, command.executionId),
		).toMatchObject([{ type: "status", payload: { status: "unknown" } }]);
		await driver.close();
		driver = await openDriver();
		expect(
			await driver.getStatus(result.nativeSessionRef, command.executionId),
		).toBe("unknown");
		expect((await driver.execute(command)).result.outcome).toBe("unknown");
		expect(requests.filter((r) => r.messageId === "acked")).toHaveLength(1);
	} finally {
		await driver.close();
		close();
		await rm(path, { recursive: true, force: true });
	}
});
