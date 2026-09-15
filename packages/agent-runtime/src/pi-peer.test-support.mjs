import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

// Exercise native peers that remain alive after their Host closes stdin.
if (process.env.NATIVE_PEER_KEEP_ALIVE === "true") setInterval(() => {}, 1000);

const mode = process.env.PI_PEER_MODE;
const sessionFile = process.argv[process.argv.indexOf("--session") + 1];
let header;
let entries = [];
try {
	entries = (await readFile(sessionFile, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	header = entries[0];
} catch {
	header = {
		type: "session",
		version: 3,
		id: randomUUID(),
		cwd: process.cwd(),
	};
}
if (!entries.length)
	await writeFile(sessionFile, `${JSON.stringify(header)}\n`);
let model = { provider: "configured", id: "model" };
let thinkingLevel = "high";
let isStreaming = false;
const messages = entries
	.filter((e) => e.type === "message")
	.map((e) => e.message);
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const finish = async (stopReason) => {
	if (!isStreaming) return;
	send({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", delta: "synthetic result" },
	});
	messages.push({
		role: "assistant",
		content: [{ type: "text", text: "synthetic result" }],
		stopReason,
	});
	const persistedMessages = structuredClone(messages);
	if (mode === "missing-history") persistedMessages.pop();
	if (mode === "changed-history")
		persistedMessages.at(-1).content = [{ type: "text", text: "other result" }];
	await writeFile(
		sessionFile,
		`${[
			header,
			...persistedMessages.map((message, index) => ({
				type: "message",
				id: String(index),
				parentId: index ? String(index - 1) : null,
				message,
			})),
		]
			.map((e) => JSON.stringify(e))
			.join("\n")}\n`,
	);
	isStreaming = false;
	send({ type: "agent_end" });
	// Queued duplicates and unknown vendor frames must not create a second terminal.
	send({ type: "agent_end" });
	send({ type: "unrecognized_vendor_event", data: "sensitive-vendor-canary" });
};
if (mode !== "missing-policy")
	send({
		type: "extension_ui_request",
		method: "setTitle",
		title: "agent-infra-policy-v1",
	});
for await (const line of createInterface({ input: process.stdin })) {
	const command = JSON.parse(line);
	const ack = (data) =>
		send({
			type: "response",
			command: command.type,
			id: command.id,
			success: true,
			data,
		});
	if (command.type === "get_state")
		ack({
			model,
			thinkingLevel,
			isStreaming,
			pendingMessageCount: 0,
			sessionId: header.id,
			sessionFile,
		});
	if (command.type === "set_model") {
		model = { provider: command.provider, id: command.modelId };
		ack(model);
	}
	if (command.type === "set_thinking_level") {
		thinkingLevel = command.level;
		ack();
	}
	if (command.type === "get_messages") ack({ messages });
	if (command.type === "prompt") {
		if (mode === "stale-terminal") {
			ack();
			send({ type: "agent_start" });
			send({ type: "agent_end" });
			continue;
		}
		isStreaming = true;
		messages.push({
			role: "user",
			content: [{ type: "text", text: command.message }],
		});
		if (mode === "wrong-response") {
			send({
				type: "response",
				command: "abort",
				id: command.id,
				success: true,
			});
			continue;
		}
		ack();
		send({
			type: "response",
			command: "prompt",
			id: "unknown-id",
			success: true,
		});
		send({ type: "agent_start" });
		if (mode === "malformed") {
			setTimeout(() => process.stdout.write("sensitive-vendor-canary\n"), 30);
			continue;
		}
		if (mode === "exit") {
			setTimeout(() => process.exit(1), 30);
			continue;
		}
		if (mode === "abort-only" || mode === "cancel") continue;
		setTimeout(() => finish("stop"), 250);
	}
	if (command.type === "abort") {
		ack();
		if (mode === "cancel") finish("aborted");
	}
}
