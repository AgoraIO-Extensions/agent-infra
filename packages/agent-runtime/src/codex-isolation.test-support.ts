import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

export const CODEX_ISOLATION_PERSISTENCE_EVIDENCE = Object.freeze({
	// #403 was squash-merged as #414, so the source commit is not an ancestor.
	sourceCommit: "35d15abe187385672de3ac14bb2a48c37ea8e6bd",
	mergeCommit: "389b2b30890399270c645a32cd21ddf3a81dd41e",
});

export interface PersistenceEvidence {
	status: "pass" | "unverified";
	reason: string;
	sourceCommit: string;
	mergeCommit: string;
}

export function evaluatePersistenceEvidence(input: {
	readonly requiredCommit: string;
	readonly requiredCommitReachable: boolean;
	readonly workingTreeClean: boolean;
}): PersistenceEvidence {
	const { sourceCommit, mergeCommit } = CODEX_ISOLATION_PERSISTENCE_EVIDENCE;
	if (input.requiredCommit !== mergeCommit)
		return {
			status: "unverified",
			reason: "unexpected-persistence-commit",
			sourceCommit,
			mergeCommit,
		};
	if (!input.requiredCommitReachable)
		return {
			status: "unverified",
			reason: "required-403-merge-not-reachable",
			sourceCommit,
			mergeCommit,
		};
	if (!input.workingTreeClean)
		return {
			status: "unverified",
			reason: "acceptance-worktree-dirty",
			sourceCommit,
			mergeCommit,
		};
	return {
		status: "pass",
		reason: "required-403-merge-reachable-clean-head",
		sourceCommit,
		mergeCommit,
	};
}

export interface IsolationProbe {
	id: string;
	command?: string;
	inputs: string[];
	outputs: string[];
	tools: string[];
	answer: string;
	concurrent: boolean;
}

export function isolationResultSeesMarker(input: {
	probe: Pick<IsolationProbe, "inputs" | "outputs" | "answer">;
	events: string;
	marker: string;
}) {
	return (
		input.probe.inputs.some((value) => value.includes(input.marker)) ||
		input.probe.outputs.some((value) => value.includes(input.marker)) ||
		input.probe.answer.includes(input.marker) ||
		input.events.includes(input.marker)
	);
}

export type IsolationEvidenceStatus = "pass" | "fail" | "unverified";

export function isolationScenarioStatus(input: {
	foreignMarkerObserved: boolean;
	positiveControl: boolean;
	completeOutput: boolean;
}): IsolationEvidenceStatus {
	if (input.foreignMarkerObserved) return "fail";
	return input.positiveControl && input.completeOutput ? "pass" : "unverified";
}

export function isolationOverallStatus(input: {
	activeThreadLeak: boolean;
	persistenceVerified: boolean;
	scenarioStatuses: readonly IsolationEvidenceStatus[];
}): IsolationEvidenceStatus {
	if (
		input.activeThreadLeak ||
		input.scenarioStatuses.some((status) => status === "fail")
	)
		return "fail";
	return input.persistenceVerified &&
		input.scenarioStatuses.every((status) => status === "pass")
		? "pass"
		: "unverified";
}

export interface IsolationObservationHold {
	readonly received: Promise<void>;
	readonly observed: Promise<void>;
	readonly responseSent: Promise<void>;
	allowObservation(): void;
	releaseResponse(): void;
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
	const observationHolds = new Map<
		string,
		{
			received: () => void;
			observed: () => void;
			responseSent: () => void;
			waitForObservation: Promise<void>;
			waitForResponse: Promise<void>;
			allowObservation: () => void;
			releaseResponse: () => void;
		}
	>();
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
			const observationHold = observationHolds.get(probe.id);
			if (observationHold) {
				observationHold.received();
				await observationHold.waitForObservation;
			}
			const barrier = barriers.get(probe.id);
			if (barrier) {
				barrier.arrive(probe.id);
				await barrier.wait;
				barriers.delete(probe.id);
			}
			probe.inputs.push(JSON.stringify(body.input));
			observationHold?.observed();
			if (observationHold) await observationHold.waitForResponse;
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
			observationHold?.responseSent();
			observationHolds.delete(probe.id);
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
		holdObservation(probe: IsolationProbe): IsolationObservationHold {
			if (!probes.has(probe.id) || observationHolds.has(probe.id))
				throw new Error("Synthetic observation hold is unavailable");
			let received: () => void = () => {};
			let observed: () => void = () => {};
			let responseSent: () => void = () => {};
			let allowObservation: () => void = () => {};
			let releaseResponse: () => void = () => {};
			const hold = {
				received: new Promise<void>((resolve) => {
					received = resolve;
				}),
				observed: new Promise<void>((resolve) => {
					observed = resolve;
				}),
				responseSent: new Promise<void>((resolve) => {
					responseSent = resolve;
				}),
				waitForObservation: new Promise<void>((resolve) => {
					allowObservation = resolve;
				}),
				waitForResponse: new Promise<void>((resolve) => {
					releaseResponse = resolve;
				}),
				allowObservation,
				releaseResponse,
			};
			observationHolds.set(probe.id, {
				received,
				observed,
				responseSent,
				waitForObservation: hold.waitForObservation,
				waitForResponse: hold.waitForResponse,
				allowObservation,
				releaseResponse,
			});
			return {
				received: hold.received,
				observed: hold.observed,
				responseSent: hold.responseSent,
				allowObservation,
				releaseResponse,
			};
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
			for (const hold of observationHolds.values()) {
				hold.allowObservation();
				hold.releaseResponse();
			}
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

export type NativeObservationErrorCategory =
	| "empty"
	| "incomplete"
	| "invalid-json"
	| "missing"
	| "read-error";

export class NativeObservationError extends Error {
	constructor(readonly category: NativeObservationErrorCategory) {
		super("Native observation unavailable");
	}
}

export function nativeObservationErrorCategory(
	error: unknown,
): NativeObservationErrorCategory {
	if (error instanceof NativeObservationError) return error.category;
	if (error instanceof SyntaxError) return "invalid-json";
	if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
		return "missing";
	return "read-error";
}

export function nativeLaunchDirectoryRelations(input: {
	home: string;
	codexHome: string;
	cwd: string;
}) {
	const homeEqualsCwd = input.home === input.cwd;
	const codexHomeEqualsCwd = input.codexHome === input.cwd;
	const homeEqualsCodexHome = input.home === input.codexHome;
	return {
		homeEqualsCwd,
		codexHomeEqualsCwd,
		homeEqualsCodexHome,
		isolated: !homeEqualsCwd && !codexHomeEqualsCwd && !homeEqualsCodexHome,
	};
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
		async observations(options: { allowEmptyBeforeLaunch?: boolean } = {}) {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				try {
					const content = await readFile(observations, "utf8");
					if (content.length === 0) throw new NativeObservationError("empty");
					if (!content.endsWith("\n"))
						throw new NativeObservationError("incomplete");
					return content
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as NativeObservation);
				} catch (error) {
					if (attempt === 4) {
						if (
							options.allowEmptyBeforeLaunch &&
							(error as NodeJS.ErrnoException).code === "ENOENT"
						)
							return [];
						throw new NativeObservationError(
							nativeObservationErrorCategory(error),
						);
					}
					await new Promise<void>((resolve) => setTimeout(resolve, 20));
				}
			}
			return [];
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
