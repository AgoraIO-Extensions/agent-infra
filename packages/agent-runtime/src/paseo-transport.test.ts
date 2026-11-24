import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { PaseoTransport } from "./paseo-transport.js";

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

const agentId = "81a25b60-63c2-47b1-9007-fa867c1daba9";
const messageId = "client-turn-1";

it.each(["codex", "claude", "pi", "opencode"] as const)(
	"uses the public SDK to create and reattach the selected %s agent",
	async (template) => {
		const http = createServer();
		const server = new WebSocketServer({ server: http });
		const socketPath = `/tmp/paseo-${randomUUID()}.sock`;
		http.listen(socketPath);
		await once(http, "listening");

		const transport = new PaseoTransport({
			...options,
			template,
			url: undefined,
			socketPath,
			thinkingOptionId: "high",
		});
		const requests: Record<string, unknown>[] = [];
		const provider =
			template === "opencode" ? "agent-infra-opencode" : template;
		const agent = {
			id: agentId,
			provider,
			cwd: options.cwd,
			model: options.model,
			thinkingOptionId: "high",
			status: "idle",
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
			currentModeId: null,
			availableModes: [],
			pendingPermissions: [],
			persistence: null,
			title: null,
		};
		let exists = false;
		let snapshots = 0;
		server.on("connection", (socket) =>
			socket.on("message", (bytes) => {
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
							agent: exists ? agent : null,
							project: null,
						});
					case "agent.create.request":
						exists = true;
						return reply("agent.create.response", { ...payload, agent });
					case "list_commands_request":
						return reply("list_commands_response", {
							...payload,
							commands: [
								{ name: "help", description: "Help", argumentHint: "" },
							],
						});
					case "send_agent_message_request":
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
			expect(await transport.commands(agentId)).toEqual([
				{ name: "help", description: "Help", argumentHint: "" },
			]);
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
			for (const socket of server.clients) socket.terminate();
			server.close();
			http.close();
			await transport.close();
		}
	},
);
