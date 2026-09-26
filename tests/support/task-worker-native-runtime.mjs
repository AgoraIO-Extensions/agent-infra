// Container-only test fixture. It never admits tasks, signs grants or dispatches work.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: container-only fixture, never a cached Turbo task.
const configuration = JSON.parse(process.env.TASK_NATIVE_CONFIGURATION ?? "{}");
let sequence = 0;
let holding = false;
let closed = 0;
const pending = new Set();
let host;
let ready = false;
let startupCode;

function answer(response, id) {
	const text = "synthetic native task answer";
	const item = {
		type: "message",
		id: `synthetic-message-${id}`,
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	for (const event of [
		{
			type: "response.created",
			response: {
				id: `synthetic-response-${id}`,
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
				id: `synthetic-response-${id}`,
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	])
		response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	response.end();
}

const model = createServer(async (request, response) => {
	// Consume without saving native input, prompt, credentials or identifiers.
	for await (const _chunk of request) {
		/* discard */
	}
	if (
		request.url !== "/v1/responses" ||
		request.headers.authorization !== "Bearer synthetic-native-model"
	) {
		response.writeHead(401).end();
		return;
	}
	const id = ++sequence;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.flushHeaders();
	const held = { response, id };
	response.once("close", () => {
		closed++;
		pending.delete(held);
	});
	if (holding) pending.add(held);
	else answer(response, id);
});
await new Promise((resolve) => model.listen(3005, "127.0.0.1", resolve));

function launch() {
	ready = false;
	startupCode = undefined;
	host = spawn("/bin/sh", ["/app/start-runtime-host.sh"], {
		cwd: "/app",
		env: {
			PATH: "/usr/local/bin:/usr/bin:/bin",
			HOME: "/tmp/native-home",
			PORT: "3003",
			AGENT_INFRA_RUNTIME_DRIVER: "codex",
			AGENT_INFRA_RUNTIME_AGENT_ID: configuration.agentId,
			AGENT_INFRA_RUNTIME_WORKER_ID: configuration.workerId,
			AGENT_INFRA_RUNTIME_DATA_DIR: "/var/lib/agent-runtime",
			AGENT_INFRA_RUNTIME_GRANT_KEY_ID: configuration.keyId,
			AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: configuration.publicKey,
			AGENT_INFRA_RUNTIME_GRANT_ISSUER: configuration.issuer,
			AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "synthetic-runtime-token",
			AGENT_INFRA_RUNTIME_READINESS_BINDING: JSON.stringify(
				configuration.readinessBinding,
			),
			AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_DEFAULT: "synthetic-native-model",
			AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify(
				configuration.modelConfiguration,
			),
			...Object.fromEntries(
				configuration.modelConfiguration.modelOptions.map((option) => [
					option.credentialEnvironmentVariable,
					"synthetic-native-model",
				]),
			),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Retain only finite launcher status; never forward arbitrary process logs.
	for (const stream of [host.stdout, host.stderr]) {
		let line = "";
		stream.on("data", (chunk) => {
			line += chunk.toString("utf8");
			const lines = line.split(/\r?\n/);
			line = lines.pop()?.slice(-4096) ?? "";
			for (const entry of lines) {
				try {
					const value = JSON.parse(entry);
					if (value.status === "ready") ready = true;
					if (/^RUNTIME_[A-Z_]+$/.test(value.code)) startupCode = value.code;
				} catch {
					/* native output is deliberately discarded */
				}
			}
		});
	}
}
launch();

const control = createServer(async (request, response) => {
	if (request.method === "POST" && request.url === "/hold") holding = true;
	else if (request.method === "POST" && request.url === "/release") {
		holding = false;
		for (const { response: held, id } of pending) answer(held, id);
		pending.clear();
	} else if (request.method === "POST" && request.url === "/restart") {
		if (host.exitCode === null && host.signalCode === null) {
			host.kill("SIGTERM");
			await new Promise((resolve) => host.once("exit", resolve));
		}
		launch();
	} else if (request.url !== "/stats") {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { "content-type": "application/json" });
	response.end(
		JSON.stringify({
			requests: sequence,
			pending: pending.size,
			closed,
			ready,
			startupCode,
			exitCode: host.exitCode,
			signalCode: host.signalCode,
		}),
	);
});
await new Promise((resolve) => control.listen(3004, "0.0.0.0", resolve));

process.once("SIGTERM", () => {
	host.kill("SIGTERM");
	model.closeAllConnections();
	control.closeAllConnections();
	model.close();
	control.close();
});
