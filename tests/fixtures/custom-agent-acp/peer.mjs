import { createServer } from "node:http";
import { createInterface } from "node:readline";

const sessionId = "controlled-custom-acp-image-v1";
let count = 0;
let model = "fixture/custom-model";
let effort = "high";

const configOptions = () => [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: model,
		options: [{ value: "fixture/custom-model", name: "Controlled Custom ACP" }],
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

const reply = (id, result) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

const notify = (session, text) =>
	process.stdout.write(
		`${JSON.stringify({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: session,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text },
				},
			},
		})}\n`,
	);

createServer((request, response) => {
	if (request.url !== "/healthz") {
		response.writeHead(404).end();
		return;
	}
	response.writeHead(200, { "content-type": "application/json" });
	response.end(
		JSON.stringify({
			status: "ready",
			interactionMode: "platform-adapter",
			protocol: "acp",
			peer: "controlled-custom-acp-image-v1",
		}),
	);
}).listen(3003, "0.0.0.0");

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	let request;
	try {
		request = JSON.parse(line);
	} catch {
		return;
	}
	if (request.method === "initialize") {
		reply(request.id, {
			protocolVersion: 1,
			agentCapabilities: { loadSession: true },
			agentInfo: { name: "controlled-custom-acp-image", version: "1" },
		});
	} else if (request.method === "session/new") {
		reply(request.id, { sessionId, configOptions: configOptions() });
	} else if (request.method === "session/load") {
		reply(request.id, { configOptions: configOptions() });
	} else if (request.method === "session/set_config_option") {
		if (request.params?.configId === "model") model = request.params.value;
		if (request.params?.configId === "effort") effort = request.params.value;
		reply(request.id, { configOptions: configOptions() });
	} else if (request.method === "session/prompt") {
		count += 1;
		notify(
			request.params?.sessionId ?? sessionId,
			`controlled custom ACP image result ${count}`,
		);
		reply(request.id, { stopReason: "end_turn" });
	} else if (request.method === "session/cancel") {
		reply(request.id, {});
	}
});
