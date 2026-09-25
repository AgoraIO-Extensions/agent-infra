import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

let sessionId;
let count = 0;
let model = "provider/model";
let effort = "high";
let finishPrompt;
const configOptions = () => [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: model,
		options:
			process.env.ACP_TEST_MODE === "grouped-models"
				? [
						{
							group: "models",
							name: "Models",
							options: (model === "provider/model"
								? ["provider/model", "provider/other"]
								: ["provider/other"]
							).map((value) => ({ value, name: value })),
						},
					]
				: [{ value: "provider/model", name: "Synthetic model" }],
	},
	{
		id: "effort",
		name: "Effort",
		category: "thought_level",
		type: "select",
		currentValue: effort,
		options: [{ value: "high", name: "High" }],
	},
];
const connection = new AgentSideConnection(
	() => ({
		initialize: async () => ({
			protocolVersion: 1,
			agentCapabilities: { loadSession: true },
		}),
		newSession: async () => {
			sessionId = randomUUID();
			await writeFile(
				join(process.cwd(), "session.json"),
				JSON.stringify({ sessionId, count }),
			);
			return { sessionId, configOptions: configOptions() };
		},
		loadSession: async (params) => {
			const saved = JSON.parse(
				await readFile(join(process.cwd(), "session.json"), "utf8"),
			);
			if (params.sessionId !== saved.sessionId)
				throw new Error("Session unavailable");
			({ sessionId, count } = saved);
			return { configOptions: configOptions() };
		},
		setSessionConfigOption: async ({ configId, value }) => {
			if (configId === "model") model = value;
			if (configId === "effort") {
				effort = value;
				if (process.env.ACP_TEST_MODE === "changed-model")
					model = "provider/other";
			}
			return { configOptions: configOptions() };
		},
		prompt: async () => {
			count++;
			if (process.env.ACP_TEST_MODE === "prompt-reject")
				throw new Error("synthetic prompt rejected before model send");
			if (process.env.ACP_TEST_MODE === "foreign-notifications") {
				for (const update of [
					{
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "foreign-session-canary" },
					},
					{
						sessionUpdate: "tool_call",
						toolCallId: "foreign-tool",
						title: "Foreign tool",
						kind: "read",
						status: "completed",
					},
				])
					await connection.sessionUpdate({
						sessionId: "foreign-session",
						update,
					});
			}
			if (process.env.ACP_TEST_MODE === "malformed") {
				for (const frame of [
					{ private: "synthetic-secret-marker" },
					{ jsonrpc: "2.0", id: "synthetic-secret-marker", result: {} },
					{
						jsonrpc: "2.0",
						method: "session/update",
						params: { private: "synthetic-secret-marker" },
					},
				])
					process.stdout.write(`${JSON.stringify(frame)}\n`);
			}
			if (process.env.ACP_TEST_MODE === "tool-permission") {
				await connection.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tool-permission",
						kind: "read",
						status: "pending",
					},
				});
				const permission = await connection.requestPermission({
					sessionId,
					toolCall: {
						toolCallId: "tool-permission",
						kind: "read",
						status: "pending",
						title: "Read synthetic file",
					},
					options: [
						{ optionId: "allow", name: "Allow", kind: "allow_once" },
						{ optionId: "reject", name: "Reject", kind: "reject_once" },
					],
				});
				const allowed =
					permission.outcome?.outcome === "selected" &&
					permission.outcome.optionId === "allow";
				if (allowed)
					await connection.sessionUpdate({
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "tool-permission",
							kind: "read",
							status: "in_progress",
						},
					});
				await connection.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tool-permission",
						kind: "read",
						status: allowed ? "completed" : "failed",
					},
				});
			}
			await writeFile(
				join(process.cwd(), "session.json"),
				JSON.stringify({ sessionId, count }),
			);
			await connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: `synthetic result ${count}` },
				},
			});
			if (
				["tool", "tool-hold", "tool-completed-hold"].includes(
					process.env.ACP_TEST_MODE,
				)
			) {
				await connection.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tool-1",
						kind: "read",
						status: "pending",
					},
				});
				await connection.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tool-1",
						kind: "read",
						status: "in_progress",
					},
				});
				if (process.env.ACP_TEST_MODE === "tool-hold")
					await new Promise((resolve) => {
						finishPrompt = resolve;
					});
				await connection.sessionUpdate({
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tool-1",
						kind: "read",
						status: "completed",
					},
				});
				if (process.env.ACP_TEST_MODE === "tool-completed-hold")
					await new Promise((resolve) => {
						finishPrompt = resolve;
					});
			}
			if (
				["hold", "ignore-cancel", "delayed-cancel"].includes(
					process.env.ACP_TEST_MODE,
				)
			)
				return new Promise((resolve) => {
					finishPrompt = resolve;
				});
			return {
				stopReason:
					process.env.ACP_TEST_MODE === "limit" ? "max_tokens" : "end_turn",
			};
		},
		cancel: async () => {
			if (process.env.ACP_TEST_MODE === "ignore-cancel") return;
			if (process.env.ACP_TEST_MODE === "delayed-cancel")
				setTimeout(() => finishPrompt?.({ stopReason: "cancelled" }), 2200);
			else finishPrompt?.({ stopReason: "cancelled" });
		},
	}),
	ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
);

// Exercise native peers that remain alive after their Host closes stdin.
if (process.env.NATIVE_PEER_KEEP_ALIVE === "true") setInterval(() => {}, 1000);
