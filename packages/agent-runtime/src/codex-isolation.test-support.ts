import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

export interface IsolationProbe {
	id: string;
	command?: string;
	inputs: string[];
	outputs: string[];
	tools: string[];
	answer: string;
	concurrent: boolean;
}

interface ModelRequest {
	input: {
		type?: string;
		role?: string;
		call_id?: string;
		output?: unknown;
		content?: { text?: string }[];
	}[];
	tools?: { name?: string; type?: string }[];
}

// Only the model endpoint is substituted. Codex executes every requested tool.
export async function isolationModel() {
	const probes = new Map<string, IsolationProbe>();
	const barriers = new Map<
		string,
		{ wait: Promise<void>; arrive: (id: string) => void; cancel: () => void }
	>();
	const server = createServer(async (request, response) => {
		try {
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
			const text = body.input
				.filter((item) => item.role === "user")
				.at(-1)
				?.content?.map((item) => item.text ?? "")
				.join("");
			const id = text?.match(/ISOLATION_PROBE:([a-z0-9-]+)/)?.[1];
			const probe = id ? probes.get(id) : undefined;
			if (!probe) throw new Error("Unknown synthetic probe");
			if (probe.inputs.length >= 4) throw new Error("Synthetic request limit");
			const barrier = barriers.get(probe.id);
			if (barrier) {
				barrier.arrive(probe.id);
				await barrier.wait;
				barriers.delete(probe.id);
			}
			probe.inputs.push(JSON.stringify(body.input));
			probe.tools = (body.tools ?? []).flatMap((tool) =>
				tool.name ? [tool.name] : [],
			);
			const output = body.input.find(
				(item) =>
					item.type === "function_call_output" && item.call_id === probe.id,
			);
			const responseId = `response-${randomUUID()}`;
			let item: Record<string, unknown>;
			if (probe.command && !output) {
				if (!probe.tools.includes("exec_command"))
					throw new Error("Native command tool unavailable");
				item = {
					type: "function_call",
					call_id: probe.id,
					name: "exec_command",
					arguments: JSON.stringify({
						cmd: probe.command,
						login: false,
						yield_time_ms: 1000,
						max_output_tokens: 2000,
					}),
				};
			} else {
				if (output) probe.outputs.push(JSON.stringify(output.output));
				// Echo only observed context: never inject another probe's marker.
				probe.answer = probe.command
					? (probe.outputs.at(-1) ?? "NO_TOOL_OUTPUT")
					: [
							...(probe.inputs.at(-1) ?? "").matchAll(
								/SYNTH_CONTEXT_[A-Z0-9_]+/g,
							),
						]
							.map((match) => match[0])
							.join(" ") || "NO_CONTEXT_MARKER";
				item = {
					type: "message",
					role: "assistant",
					id: `message-${probe.id}`,
					content: [{ type: "output_text", text: probe.answer }],
				};
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{ type: "response.created", response: { id: responseId } },
				...(item.type === "message"
					? [
							{
								type: "response.output_text.delta",
								item_id: item.id,
								output_index: 0,
								content_index: 0,
								delta: probe.answer,
							},
						]
					: []),
				{ type: "response.output_item.done", item },
				{
					type: "response.completed",
					response: {
						id: responseId,
						usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
					},
				},
			]) {
				response.write(
					`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
				);
			}
			response.end();
		} catch {
			response.writeHead(500).end("Synthetic model request invalid");
		}
	});
	await new Promise<void>((accept, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", accept);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No local model");
	return {
		url: `http://127.0.0.1:${address.port}/v1`,
		probe(command?: string): IsolationProbe {
			const probe = {
				id: randomUUID(),
				command,
				inputs: [],
				outputs: [],
				tools: [],
				answer: "",
				concurrent: false,
			};
			probes.set(probe.id, probe);
			return probe;
		},
		synchronize(pair: IsolationProbe[]) {
			const arrivals = new Set<string>();
			let release: () => void = () => {};
			let fail: () => void = () => {};
			const wait = new Promise<void>((resolve, reject) => {
				release = resolve;
				fail = () =>
					reject(new Error("Concurrent native requests unavailable"));
			});
			void wait.catch(() => {});
			const timer = setTimeout(fail, 10_000);
			const barrier = {
				wait,
				arrive(id: string) {
					arrivals.add(id);
					if (arrivals.size === pair.length) {
						clearTimeout(timer);
						for (const probe of pair) probe.concurrent = true;
						release();
					}
				},
				cancel() {
					clearTimeout(timer);
					fail();
				},
			};
			for (const probe of pair) barriers.set(probe.id, barrier);
		},
		async close() {
			for (const barrier of barriers.values()) barrier.cancel();
			server.closeAllConnections();
			await new Promise<void>((accept, reject) =>
				server.close((error) => (error ? reject(error) : accept())),
			);
		},
	};
}

export interface NativeObservation {
	method: string;
	params?: Record<string, unknown>;
	result?: Record<string, unknown>;
	cwd?: string;
	home?: string;
	codexHome?: string;
	error?: { code: number; message: string };
}

export async function nativeIsolationLauncher(
	directory: string,
	executable: string,
	modelUrl: string,
) {
	const binary = resolve(executable);
	const bin = join(directory, "bin");
	const observations = join(directory, "observations.jsonl");
	await mkdir(bin);
	const overrides = [
		'model_provider="isolation_fixture"',
		`model_providers.isolation_fixture={name="isolation_fixture",base_url=${JSON.stringify(modelUrl)},wire_api="responses",requires_openai_auth=false}`,
	];
	// A byte-preserving observer around the actual executable, not a Bridge mock.
	await writeFile(
		join(bin, "codex"),
		`#!${process.execPath}
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const serving = args[0] === "app-server" && args[1] !== "generate-json-schema";
const observe = (value) => appendFileSync(${JSON.stringify(observations)}, JSON.stringify(value) + "\\n");
if (serving) observe({ method: "launch", cwd: process.cwd(), home: process.env.HOME, codexHome: process.env.CODEX_HOME });
const child = spawn(${JSON.stringify(binary)}, [...args, ...(serving ? ${JSON.stringify(overrides.flatMap((value) => ["--config", value]))} : [])], { stdio: ["pipe", "pipe", "pipe"], env: process.env, cwd: process.cwd() });
const pending = new Map();
let input = "", output = "";
process.stdin.on("data", (chunk) => {
  if (serving) {
    input += chunk.toString();
    let newline;
    while ((newline = input.indexOf("\\n")) >= 0) {
      const line = input.slice(0, newline); input = input.slice(newline + 1);
      try { const frame = JSON.parse(line); if (frame.id !== undefined && frame.method) pending.set(frame.id, frame); } catch {}
    }
  }
});
child.stdout.on("data", (chunk) => {
  if (serving) {
    output += chunk.toString();
    let newline;
    while ((newline = output.indexOf("\\n")) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      try { const frame = JSON.parse(line); const sent = pending.get(frame.id); if (sent) { observe({ method: sent.method, params: sent.params, result: frame.result, error: frame.error }); pending.delete(frame.id); } } catch {}
    }
  }
});
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.stdin.on("error", () => {});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("close", (code) => process.exit(code ?? 1));
`,
	);
	await chmod(join(bin, "codex"), 0o700);
	return {
		bin,
		async observations(): Promise<NativeObservation[]> {
			return (await readFile(observations, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as NativeObservation);
		},
		features(nativeHome: string) {
			return execFileSync(binary, ["features", "list"], {
				cwd: nativeHome,
				env: {
					HOME: nativeHome,
					CODEX_HOME: nativeHome,
					PATH: process.env.PATH,
				},
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "ignore"],
			});
		},
	};
}
