import { afterEach, expect, it } from "vitest";
import {
	type IsolationProbe,
	isolationModel,
} from "./codex-isolation.test-support.js";

const servers: Awaited<ReturnType<typeof isolationModel>>[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function model() {
	const server = await isolationModel();
	servers.push(server);
	return server;
}

async function submit(
	server: Awaited<ReturnType<typeof isolationModel>>,
	probe: IsolationProbe,
	input: unknown[] = [],
	tools: unknown[] = [],
) {
	const response = await fetch(`${server.url}/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: `ISOLATION_PROBE:${probe.id}` },
					],
				},
				...input,
			],
			tools,
		}),
	});
	return { status: response.status, body: await response.text() };
}

it("never copies one probe's synthetic context to the other model response", async () => {
	const server = await model();
	const first = server.probe();
	const second = server.probe();
	server.synchronize([first, second]);
	const responses = await Promise.all([
		submit(server, first, [
			{ role: "assistant", content: [{ text: "SYNTH_CONTEXT_A_PRIVATE" }] },
		]),
		submit(server, second),
	]);
	expect(responses.map((response) => response.status)).toEqual([200, 200]);
	expect(first.answer).toContain("SYNTH_CONTEXT_A_PRIVATE");
	expect(second.answer).toBe("NO_CONTEXT_MARKER");
	expect(second.inputs.join("")).not.toContain("SYNTH_CONTEXT_A_PRIVATE");
	expect(first.concurrent && second.concurrent).toBe(true);
});

it("returns the native tool output only after the matching tool call completes", async () => {
	const server = await model();
	const probe = server.probe("cat synthetic-private.txt");
	const tools = [{ type: "function", name: "exec_command" }];
	const call = await submit(server, probe, [], tools);
	expect(call.status).toBe(200);
	expect(call.body).toContain("function_call");
	expect(probe.outputs).toEqual([]);
	expect(probe.answer).toBe("");
	const complete = await submit(
		server,
		probe,
		[
			{
				type: "function_call_output",
				call_id: probe.id,
				output: "SYNTH_PRIVATE_FROM_NATIVE_TOOL",
			},
		],
		tools,
	);
	expect(complete.status).toBe(200);
	expect(probe.outputs).toEqual(['"SYNTH_PRIVATE_FROM_NATIVE_TOOL"']);
	expect(complete.body).toContain("SYNTH_PRIVATE_FROM_NATIVE_TOOL");
});

it("fails the model probe when native command tools are unavailable", async () => {
	const server = await model();
	const probe = server.probe("cat synthetic-private.txt");
	expect((await submit(server, probe)).status).toBe(500);
	expect(probe.outputs).toEqual([]);
	expect(probe.answer).toBe("");
});
