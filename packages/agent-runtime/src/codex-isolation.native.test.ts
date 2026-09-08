import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
import type { RuntimeSubmitTurnRequestV2 } from "@agent-infra/contracts/runtime";
import { expect, it } from "vitest";
import {
	CODEX_APP_SERVER_V2_PROVENANCE,
	CodexAppServerBridge,
	type CodexAppServerFrame,
} from "./codex-app-server-bridge.js";
import {
	CODEX_ISOLATION_PERSISTENCE_EVIDENCE,
	evaluatePersistenceEvidence,
	type IsolationProbe,
	isolationActiveThreadEvidenceStatus,
	isolationModel,
	isolationOverallStatus,
	isolationResultSeesMarker,
	isolationScenarioStatus,
	nativeIsolationLauncher,
	nativeLaunchDirectoryRelations,
	nativeObservationErrorCategory,
} from "./codex-isolation.test-support.js";
import { CodexRuntimeDriver } from "./codex-runtime-driver.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { FileRuntimeStore, RuntimeHost } from "./index.js";

type Status = "pass" | "fail" | "unverified";
type HistoryMembership = "present" | "absent" | "error" | "unavailable";

interface HistoryScanEvidence {
	owner: HistoryMembership;
	foreign: HistoryMembership;
	completeOutput: boolean;
}

interface HistoryScenarioEvidence extends HistoryScanEvidence {
	foreignMarkerObserved: boolean;
	positiveControl: boolean;
	status: Status;
}

const behaviors = [
	"thread-context",
	"owner-file-read",
	"cross-file-read",
	"cross-file-search",
	"cross-history-file",
	"cross-file-modify",
] as const;
interface Evidence {
	status: Status;
	reason: string;
}

type NativeReadCategory =
	| "success"
	| "unsupported"
	| "native-json-rpc-error"
	| "native-transport-error"
	| "native-timeout"
	| "invalid-native-response"
	| "model-observation-unavailable";

interface RawNativeReply {
	category: NativeReadCategory;
	result?: unknown;
}

interface NativeReadSample {
	point: "after-turn-start-accepted" | "after-model-observed";
	method: "thread/read" | "thread/turns/list";
	options: { includeTurns?: boolean; itemsView?: "notLoaded" };
	category: NativeReadCategory;
	threadStatusType?: string;
	knownTurnMatches?: boolean | "unavailable";
	foreignMarkerAbsent?: boolean | "unavailable";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

function containsMarker(value: unknown, marker: string): boolean {
	if (typeof value === "string") return value.includes(marker);
	if (Array.isArray(value))
		return value.some((entry) => containsMarker(entry, marker));
	return (
		isPlainRecord(value) &&
		Object.values(value).some((entry) => containsMarker(entry, marker))
	);
}

function effectiveThreadConfiguration(
	result: Record<string, unknown> | undefined,
) {
	const sandbox = isPlainRecord(result?.sandbox) ? result.sandbox : undefined;
	return {
		approvalPolicy:
			typeof result?.approvalPolicy === "string"
				? result.approvalPolicy
				: undefined,
		sandboxType: typeof sandbox?.type === "string" ? sandbox.type : undefined,
		networkAccess:
			typeof sandbox?.networkAccess === "boolean"
				? sandbox.networkAccess
				: undefined,
	};
}

function completeToolOutput(
	outputs: readonly string[],
	completionMarker?: string,
) {
	return (
		outputs.length > 0 &&
		!outputs.some((output) =>
			/truncated|Process running with session ID/i.test(output),
		) &&
		(!completionMarker ||
			outputs.some((output) => output.includes(completionMarker)))
	);
}

function historyOutputLines(outputs: readonly string[]) {
	return outputs.flatMap((output) => {
		try {
			const parsed: unknown = JSON.parse(output);
			return typeof parsed === "string" ? parsed.split(/\r?\n/) : [];
		} catch {
			return [];
		}
	});
}

function historyMembership(
	lines: readonly string[],
	name: "OWNER" | "FOREIGN",
): HistoryMembership {
	const matches = lines.filter((line) =>
		/^SYNTH_HISTORY_(?:OWNER|FOREIGN)=(?:present|absent|error)$/.test(line),
	);
	const value = `SYNTH_HISTORY_${name}=`;
	const matching = matches.filter((line) => line.startsWith(value));
	if (matching.length !== 1) return "unavailable";
	return matching[0]?.slice(value.length) as Exclude<
		HistoryMembership,
		"unavailable"
	>;
}

function historyScanEvidence(outputs: readonly string[]): HistoryScanEvidence {
	const lines = historyOutputLines(outputs);
	const owner = historyMembership(lines, "OWNER");
	const foreign = historyMembership(lines, "FOREIGN");
	const expectedLine =
		/^SYNTH_HISTORY_(?:OWNER|FOREIGN)=(?:present|absent|error)$/;
	const completed = lines.filter(
		(line) => line === "SYNTH_HISTORY_SCAN_COMPLETE",
	).length;
	const unexpectedOutput = lines.some(
		(line) =>
			line.length > 0 &&
			line !== "SYNTH_HISTORY_SCAN_COMPLETE" &&
			!expectedLine.test(line),
	);
	return {
		owner,
		foreign,
		completeOutput:
			completed === 1 &&
			!unexpectedOutput &&
			owner !== "unavailable" &&
			foreign !== "unavailable" &&
			owner !== "error" &&
			foreign !== "error",
	};
}

function historyScenarioEvidence(input: {
	outputs: readonly string[];
	foreignMarkerObserved: boolean;
}): HistoryScenarioEvidence {
	const evidence = historyScanEvidence(input.outputs);
	const foreignMarkerObserved =
		input.foreignMarkerObserved || evidence.foreign === "present";
	const positiveControl = evidence.owner === "present";
	return {
		...evidence,
		foreignMarkerObserved,
		positiveControl,
		status: isolationScenarioStatus({
			foreignMarkerObserved,
			positiveControl,
			completeOutput: evidence.completeOutput,
		}),
	};
}

// This peer preserves JSON-RPC errors as test evidence instead of teaching the
// production Driver new behavior for a raw app-server response.
class RawNativeClient {
	private sequence = 0;
	private closed = false;
	private readonly pending = new Map<number, (reply: RawNativeReply) => void>();

	private constructor(private readonly bridge: CodexAppServerBridge) {
		void this.consume();
	}

	static async open(dataDirectory: string) {
		const bridge = await CodexAppServerBridge.open({
			dataDirectory,
			model: "gpt-5.3-codex",
			reasoningEffort: "high",
			provenance: CODEX_APP_SERVER_V2_PROVENANCE,
		});
		const client = new RawNativeClient(bridge);
		const initialize = await client.request("initialize", {
			clientInfo: { name: "agent-infra-isolation-probe", version: "1" },
		});
		if (initialize.category !== "success") {
			await client.close();
			throw new Error("Native raw probe initialization unavailable");
		}
		try {
			await bridge.send({ method: "initialized" });
		} catch {
			await client.close();
			throw new Error("Native raw probe initialization unavailable");
		}
		return client;
	}

	async request(
		method: string,
		params: Record<string, unknown>,
	): Promise<RawNativeReply> {
		if (this.closed) return { category: "native-transport-error" };
		const id = ++this.sequence;
		return new Promise<RawNativeReply>((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ category: "native-timeout" });
			}, 10_000);
			this.pending.set(id, (reply) => {
				clearTimeout(timer);
				resolve(reply);
			});
			void this.bridge.send({ id, method, params }).catch(() => {
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				pending({ category: "native-transport-error" });
			});
		});
	}

	async close() {
		if (this.closed) return;
		this.closed = true;
		await this.bridge.close().catch(() => {});
	}

	private async consume() {
		try {
			for await (const frame of this.bridge.frames()) this.receive(frame);
		} catch {
			// The per-request summaries classify this as a transport error.
		}
		this.closed = true;
		for (const resolve of this.pending.values())
			resolve({ category: "native-transport-error" });
		this.pending.clear();
	}

	private receive(frame: CodexAppServerFrame) {
		const id = frame.id;
		if (typeof id !== "number") return;
		const resolve = this.pending.get(id);
		if (!resolve || (!("error" in frame) && !("result" in frame))) return;
		this.pending.delete(id);
		if ("error" in frame) {
			const error = frame.error;
			resolve({
				category:
					isPlainRecord(error) && error.code === -32601
						? "unsupported"
						: "native-json-rpc-error",
			});
			return;
		}
		resolve({ category: "success", result: frame.result });
	}
}

function nativeReadSample(
	point: NativeReadSample["point"],
	method: NativeReadSample["method"],
	options: NativeReadSample["options"],
	reply: RawNativeReply,
	knownTurnId: string,
	foreignMarker: string,
): NativeReadSample {
	const sample: NativeReadSample = {
		point,
		method,
		options,
		category: reply.category,
		...(reply.category === "success"
			? { foreignMarkerAbsent: !containsMarker(reply.result, foreignMarker) }
			: {
					knownTurnMatches: "unavailable" as const,
					foreignMarkerAbsent: "unavailable" as const,
				}),
	};
	if (reply.category !== "success") return sample;
	if (method === "thread/read") {
		const thread = isPlainRecord(reply.result)
			? reply.result.thread
			: undefined;
		const status = isPlainRecord(thread) ? thread.status : undefined;
		if (
			!isPlainRecord(thread) ||
			!isPlainRecord(status) ||
			typeof status.type !== "string"
		) {
			return {
				...sample,
				category: "invalid-native-response",
				knownTurnMatches: "unavailable",
			};
		}
		const turns = thread.turns;
		return {
			...sample,
			threadStatusType: status.type,
			knownTurnMatches: Array.isArray(turns)
				? turns.some((turn) => isPlainRecord(turn) && turn.id === knownTurnId)
				: "unavailable",
		};
	}
	const data = isPlainRecord(reply.result) ? reply.result.data : undefined;
	if (!Array.isArray(data))
		return {
			...sample,
			category: "invalid-native-response",
			knownTurnMatches: "unavailable",
		};
	return {
		...sample,
		knownTurnMatches: data.some(
			(turn) => isPlainRecord(turn) && turn.id === knownTurnId,
		),
	};
}

it("fails malformed successful native results that contain a foreign marker", () => {
	const marker = "SYNTH_FOREIGN_MARKER";
	const sample = nativeReadSample(
		"after-turn-start-accepted",
		"thread/read",
		{ includeTurns: true },
		{ category: "success", result: { unexpected: { marker } } },
		"synthetic-turn",
		marker,
	);
	expect(sample).toMatchObject({
		category: "invalid-native-response",
		knownTurnMatches: "unavailable",
		foreignMarkerAbsent: false,
	});
});

it("records effective thread settings from the native result root", () => {
	expect(
		effectiveThreadConfiguration({
			approvalPolicy: "on-request",
			sandbox: { type: "workspace-write", networkAccess: false },
			thread: {
				approvalPolicy: "nested-value-must-not-be-used",
				sandbox: { type: "nested-value-must-not-be-used", networkAccess: true },
			},
		}),
	).toEqual({
		approvalPolicy: "on-request",
		sandboxType: "workspace-write",
		networkAccess: false,
	});
});

it("uses bounded exact membership evidence for the history positive control", async () => {
	const owner = "SYNTH_CONTEXT_OWNER_ABC";
	const foreign = "SYNTH_CONTEXT_FOREIGN_DEF";
	const directory = await mkdtemp(join(tmpdir(), "agent-runtime-history-"));
	try {
		const sessions = join(directory, "sessions");
		await mkdir(sessions);
		await writeFile(join(sessions, "owner-history.json"), owner);
		const command = historyScanCommand({
			ownerMarker: owner,
			foreignMarker: foreign,
			directory: sessions,
		});
		expect(command).toContain("grep -R -F -l --");
		expect(command).not.toContain("sort -u");
		expect(command).not.toContain(owner);
		expect(command).not.toContain(foreign);
		const evidence = historyScenarioEvidence({
			outputs: [
				JSON.stringify(
					execFileSync("sh", ["-c", command], { encoding: "utf8" }),
				),
			],
			foreignMarkerObserved: false,
		});
		expect(evidence).toMatchObject({
			owner: "present",
			foreign: "absent",
			completeOutput: true,
			status: "pass",
		});
		expect(
			isolationOverallStatus({
				activeThreadLeak: false,
				persistenceVerified: true,
				scenarioStatuses: ["pass", evidence.status],
			}),
		).toBe("pass");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it("fails history evidence when a late foreign membership is present", () => {
	const evidence = historyScenarioEvidence({
		outputs: [
			JSON.stringify(
				"SYNTH_CONTEXT_OWNER\n".repeat(4_000) +
					"SYNTH_HISTORY_OWNER=present\n" +
					"SYNTH_HISTORY_FOREIGN=present\n" +
					"SYNTH_HISTORY_SCAN_COMPLETE\n",
			),
		],
		foreignMarkerObserved: false,
	});
	expect(evidence.status).toBe("fail");
	expect(
		isolationOverallStatus({
			activeThreadLeak: false,
			persistenceVerified: true,
			scenarioStatuses: ["pass", evidence.status],
		}),
	).toBe("fail");
});

it("keeps incomplete and failed history commands unverified", () => {
	for (const outputs of [
		[],
		[JSON.stringify("native command failed after writing output")],
		[
			JSON.stringify(
				"SYNTH_HISTORY_OWNER=present\n" +
					"SYNTH_HISTORY_FOREIGN=error\n" +
					"SYNTH_HISTORY_SCAN_COMPLETE\n",
			),
		],
	]) {
		const evidence = historyScenarioEvidence({
			outputs,
			foreignMarkerObserved: false,
		});
		expect(evidence.status).toBe("unverified");
		expect(
			isolationOverallStatus({
				activeThreadLeak: false,
				persistenceVerified: true,
				scenarioStatuses: ["pass", evidence.status],
			}),
		).toBe("unverified");
	}
});

function unavailableModelObservationSamples(
	point: NativeReadSample["point"],
): NativeReadSample[] {
	return [
		{
			point,
			method: "thread/read",
			options: { includeTurns: false },
			category: "model-observation-unavailable",
			knownTurnMatches: "unavailable",
			foreignMarkerAbsent: "unavailable",
		},
		{
			point,
			method: "thread/read",
			options: { includeTurns: true },
			category: "model-observation-unavailable",
			knownTurnMatches: "unavailable",
			foreignMarkerAbsent: "unavailable",
		},
		{
			point,
			method: "thread/turns/list",
			options: { itemsView: "notLoaded" },
			category: "model-observation-unavailable",
			knownTurnMatches: "unavailable",
			foreignMarkerAbsent: "unavailable",
		},
	];
}

function quote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function historyScanCommand(input: {
	ownerMarker: string;
	foreignMarker: string;
	directory: string;
}) {
	const octalEscapes = (value: string) =>
		[...Buffer.from(value, "utf8")]
			.map((byte) => `\\${byte.toString(8).padStart(3, "0")}`)
			.join("");
	const marker = (value: string) =>
		`$(printf '%b' ${quote(octalEscapes(value))})`;
	return [
		`owner_marker=${marker(input.ownerMarker)}`,
		`foreign_marker=${marker(input.foreignMarker)}`,
		'history_scan_marker() { if grep -R -F -l -- "$1" ' +
			quote(input.directory) +
			' >/dev/null 2>&1; then printf \'%s=present\\n\' "$2"; else status=$?; case "$status" in 1) printf \'%s=absent\\n\' "$2";; *) printf \'%s=error\\n\' "$2";; esac; fi; }',
		'history_scan_marker "$owner_marker" SYNTH_HISTORY_OWNER',
		'history_scan_marker "$foreign_marker" SYNTH_HISTORY_FOREIGN',
		"printf 'SYNTH_HISTORY_SCAN_COMPLETE\\n'",
	].join("; ");
}

// A skipped native suite is never isolation acceptance evidence.
it.skipIf(!process.env.CODEX_ISOLATION_BINARY)(
	"requires real Codex cross-user data isolation with successful owner controls",
	async () => {
		const binary = process.env.CODEX_ISOLATION_BINARY;
		if (!binary) throw new Error("Missing pinned executable");
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-isolation-"));
		const rawDriverPath = join(directory, "raw-native-read-probe.json");
		const originalPath = process.env.PATH;
		const scenarios: Record<string, Evidence> = {};
		scenarios["restart-resume.original-native-sessions"] = {
			status: "unverified",
			reason: "not-executed",
		};
		for (const phase of ["concurrent", "restart-resume"]) {
			for (const actor of ["a", "b"]) {
				for (const behavior of behaviors)
					scenarios[[phase, actor, behavior].join(".")] = {
						status: "unverified",
						reason: "not-executed",
					};
			}
		}
		const report: Record<string, unknown> = {
			commit: execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf8",
			}).trim(),
			testSourceSha256: createHash("sha256")
				.update(await readFile(import.meta.filename))
				.digest("hex"),
			fixtureSourceSha256: createHash("sha256")
				.update(
					await readFile(
						join(import.meta.dirname, "codex-isolation.test-support.ts"),
					),
				)
				.digest("hex"),
			platform: process.platform,
			provenance: CODEX_APP_SERVER_V2_PROVENANCE,
			provenanceVerified: false,
			model: "local-deterministic-responses",
			scenarios,
		};
		const users = ["a", "b"].map((id) => ({
			id,
			context:
				"SYNTH_CONTEXT_" +
				id.toUpperCase() +
				"_" +
				randomUUID().replaceAll("-", "").toUpperCase(),
			file: `SYNTH_PRIVATE_${id.toUpperCase()}_${randomUUID()}`,
			ref: undefined as string | undefined,
		}));
		let driver: CodexRuntimeDriver | undefined;
		let host: ReturnType<typeof ingressVerifiedRuntimeHost>;
		let model: Awaited<ReturnType<typeof isolationModel>> | undefined;
		let launcher:
			| Awaited<ReturnType<typeof nativeIsolationLauncher>>
			| undefined;
		let nativeHome = "";
		let workspace = "";
		let rawProbeLaunches = 0;
		let bootstrapDriverLaunches = 0;
		let activeDriver: CodexRuntimeDriver | undefined;
		let sampledNativeThreadId = "";
		let stage = "startup";
		const record = (key: string, status: Status, reason: string) => {
			scenarios[key] = { status, reason };
		};
		const filePath = (user: (typeof users)[number], name: string) =>
			join(workspace, "workspace", user.id, name);
		async function open() {
			driver = await CodexRuntimeDriver.open({
				path: join(directory, "driver.json"),
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				modelOptions: [
					{
						modelOptionId: "synthetic",
						model: "gpt-5.3-codex",
						reasoningLevels: ["high"],
					},
				],
			});
			host = ingressVerifiedRuntimeHost(
				await RuntimeHost.open({
					driver,
					store: await FileRuntimeStore.open(join(directory, "host.json")),
					grantValidation: {
						expectedIssuer: "agent-platform",
						now: () => "2026-08-28T10:00:00Z",
					},
				}),
			);
			return driver;
		}
		async function prepareRawNativeStorage() {
			const rawDriver = await CodexRuntimeDriver.open({
				path: rawDriverPath,
				model: "gpt-5.3-codex",
				reasoningEffort: "high",
				modelOptions: [
					{
						modelOptionId: "synthetic",
						model: "gpt-5.3-codex",
						reasoningLevels: ["high"],
					},
				],
			});
			await rawDriver.close();
			bootstrapDriverLaunches = 1;
		}
		function request(
			user: (typeof users)[number],
			probe: IsolationProbe,
			seed: boolean,
		): RuntimeSubmitTurnRequestV2 {
			const binding = {
				agentId: "agent-isolation",
				actorId: `actor-${user.id}`,
				channelId: "web",
				conversationId: `conversation-${user.id}`,
				executionId: `execution-${probe.id}`,
				turnId: `turn-${probe.id}`,
				sessionGeneration: 1,
				traceId: `trace-${probe.id}`,
			};
			return {
				schemaVersion: 2,
				...binding,
				requestId: `request-${probe.id}`,
				deliveryFence: 1,
				...(user.ref ? { hostSessionRef: user.ref } : {}),
				grant: runtimeGrantFixture(binding, ["turn.submit"]),
				input: {
					text: `ISOLATION_PROBE:${probe.id}${seed ? ` ${user.context}` : ""}`,
					attachments: [],
				},
				selection: {
					schemaVersion: 1,
					modelOptionId: "synthetic",
					reasoningLevel: "high",
				},
			};
		}
		async function run(
			user: (typeof users)[number],
			probe: IsolationProbe,
			seed: boolean,
		) {
			const command = request(user, probe, seed);
			const result = await host.submitTurnV2(command);
			if (result.result.outcome !== "accepted")
				throw new Error("Native turn not accepted");
			user.ref ??= result.hostSessionRef;
			if (user.ref !== result.hostSessionRef)
				throw new Error("Session was replaced");
			const query = {
				schemaVersion: 1 as const,
				requestId: command.requestId,
				traceId: command.traceId,
				actorId: command.actorId,
				channelId: command.channelId,
				agentId: command.agentId,
				conversationId: command.conversationId,
				executionId: command.executionId,
				turnId: command.turnId,
				sessionGeneration: command.sessionGeneration,
				deliveryFence: command.deliveryFence,
				hostSessionRef: user.ref,
				grant: runtimeGrantFixture(command, [
					"session.status",
					"events.replay",
				]),
			};
			await expect
				.poll(async () => (await host.status(query)).status, {
					timeout: 20_000,
					interval: 100,
				})
				.toBe("completed");
			return { probe, events: JSON.stringify(await host.replay(query)) };
		}
		async function waitForModelSignal(signal: Promise<void>) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					signal.then(() => true),
					new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), 10_000);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
		async function snapshotActiveThread(
			point: NativeReadSample["point"],
			client: RawNativeClient,
			threadId: string,
			turnId: string,
			foreignMarker: string,
		) {
			const withoutTurns = await client.request("thread/read", {
				threadId,
				includeTurns: false,
			});
			const withTurns = await client.request("thread/read", {
				threadId,
				includeTurns: true,
			});
			const turns = await client.request("thread/turns/list", {
				threadId,
				itemsView: "notLoaded",
			});
			return [
				nativeReadSample(
					point,
					"thread/read",
					{ includeTurns: false },
					withoutTurns,
					turnId,
					foreignMarker,
				),
				nativeReadSample(
					point,
					"thread/read",
					{ includeTurns: true },
					withTurns,
					turnId,
					foreignMarker,
				),
				nativeReadSample(
					point,
					"thread/turns/list",
					{ itemsView: "notLoaded" },
					turns,
					turnId,
					foreignMarker,
				),
			];
		}
		async function sampleActiveThreadHistory() {
			if (!model || !launcher) throw new Error("No native isolation fixture");
			const probe = model.probe();
			const foreignMarker = users.at(1)?.context;
			if (!foreignMarker) throw new Error("Missing foreign isolation marker");
			const hold = model.holdObservation(probe);
			const beforeRawClient = (await launcher.observations()).filter(
				(entry) => entry.method === "launch",
			).length;
			let client: RawNativeClient | undefined;
			try {
				client = await RawNativeClient.open(`${rawDriverPath}.native`);
				const threadStarted = await client.request("thread/start", {});
				const nativeThread = isPlainRecord(threadStarted.result)
					? threadStarted.result.thread
					: undefined;
				if (
					threadStarted.category !== "success" ||
					!isPlainRecord(nativeThread) ||
					typeof nativeThread.id !== "string"
				) {
					throw new Error("Native thread identity unavailable");
				}
				const turnStarted = await client.request("turn/start", {
					threadId: nativeThread.id,
					clientUserMessageId: probe.id,
					input: [{ type: "text", text: `ISOLATION_PROBE:${probe.id}` }],
					model: "gpt-5.3-codex",
					effort: "high",
				});
				const nativeTurn = isPlainRecord(turnStarted.result)
					? turnStarted.result.turn
					: undefined;
				if (
					turnStarted.category !== "success" ||
					!isPlainRecord(nativeTurn) ||
					typeof nativeTurn.id !== "string"
				) {
					throw new Error("Native turn not accepted");
				}
				sampledNativeThreadId = nativeThread.id;
				report.activeThreadReadSamples = await snapshotActiveThread(
					"after-turn-start-accepted",
					client,
					nativeThread.id,
					nativeTurn.id,
					foreignMarker,
				);
				hold.allowObservation();
				const observed = await waitForModelSignal(hold.observed);
				report.activeThreadReadSamples = observed
					? [
							...(report.activeThreadReadSamples as NativeReadSample[]),
							...(await snapshotActiveThread(
								"after-model-observed",
								client,
								nativeThread.id,
								nativeTurn.id,
								foreignMarker,
							)),
						]
					: [
							...(report.activeThreadReadSamples as NativeReadSample[]),
							...unavailableModelObservationSamples("after-model-observed"),
						];
			} finally {
				hold.allowObservation();
				hold.releaseResponse();
				await client?.close().catch(() => {});
				const afterRawClient = (await launcher.observations()).filter(
					(entry) => entry.method === "launch",
				).length;
				rawProbeLaunches += afterRawClient - beforeRawClient;
			}
		}
		async function pair(
			commands: (string | undefined)[] = [undefined, undefined],
			seed = false,
		) {
			if (!model) throw new Error("No synthetic model");
			const activeModel = model;
			const probes = commands.map((command) => activeModel.probe(command));
			activeModel.synchronize(probes);
			// Settle both calls before closing the native process after a failure.
			const results = await Promise.allSettled(
				users.map((user, index) => {
					const probe = probes[index];
					if (!probe) throw new Error("Missing synthetic probe");
					return run(user, probe, seed);
				}),
			);
			return results.map((result) => {
				if (result.status === "rejected") throw result.reason;
				if (!result.value.probe.concurrent)
					throw new Error("Concurrent positive control unavailable");
				return result.value;
			});
		}
		const sees = (result: Awaited<ReturnType<typeof run>>, marker: string) =>
			isolationResultSeesMarker({
				probe: result.probe,
				events: result.events,
				marker,
			});
		async function phase(name: string) {
			const context = await pair();
			for (const [index, user] of users.entries()) {
				const own = context[index];
				const other = users[1 - index];
				if (!own || !other) throw new Error("Missing pair");
				const positive =
					own.probe.inputs.some((input) => input.includes(user.context)) &&
					own.probe.answer.includes(user.context) &&
					own.events.includes(user.context);
				record(
					[name, user.id, "thread-context"].join("."),
					sees(own, other.context) ? "fail" : positive ? "pass" : "unverified",
					sees(own, other.context)
						? "foreign-context-observed"
						: positive
							? "owner-history-present-foreign-history-absent"
							: "owner-context-control-failed",
				);
			}
			const ownerReads = await pair(
				users.map((user) => `cat ${quote(filePath(user, "private.txt"))}`),
			);
			const ownerReadEvidence = ownerReads.map((result, index) => {
				const user = users[index];
				const other = users[1 - index];
				if (!user || !other) throw new Error("Missing owner-read user");
				return {
					control:
						result.probe.outputs.some((output) => output.includes(user.file)) &&
						result.events.includes(user.file),
					leaked: sees(result, other.file) || sees(result, other.context),
				};
			});
			const canRead = ownerReadEvidence.map((evidence) => evidence.control);
			for (const [index, user] of users.entries()) {
				const evidence = ownerReadEvidence[index];
				if (!evidence) throw new Error("Missing owner-read evidence");
				record(
					[name, user.id, "owner-file-read"].join("."),
					evidence.leaked ? "fail" : evidence.control ? "pass" : "unverified",
					evidence.leaked
						? "foreign-marker-reached-model-input-or-result"
						: evidence.control
							? "native-tool-and-result-contain-owner-marker"
							: "owner-read-control-failed",
				);
			}
			for (const behavior of [
				"cross-file-read",
				"cross-file-search",
				"cross-history-file",
			] as const) {
				const search = behavior === "cross-file-search";
				const history = behavior === "cross-history-file";
				const searchControls = search
					? await pair(
							users.map(
								(user) =>
									"grep -R -F SYNTH_PRIVATE_ " +
									quote(filePath(user, "private.txt")),
							),
						)
					: undefined;
				const results = await pair(
					users.map((user, index) => {
						const other = users[1 - index];
						if (!other) throw new Error("Missing other user");
						return history
							? historyScanCommand({
									ownerMarker: user.context,
									foreignMarker: other.context,
									directory: join(nativeHome, "sessions"),
								})
							: (search ? "grep -R -F SYNTH_PRIVATE_ " : "cat ") +
									quote(filePath(other, "private.txt"));
					}),
				);
				for (const [index, result] of results.entries()) {
					const user = users[index];
					const other = users[1 - index];
					if (!user || !other) throw new Error("Missing user");
					const rawForeignMarkerObserved = sees(
						result,
						history ? other.context : other.file,
					);
					const historyEvidence = history
						? historyScenarioEvidence({
								outputs: result.probe.outputs,
								foreignMarkerObserved: rawForeignMarkerObserved,
							})
						: undefined;
					const leaked = historyEvidence
						? historyEvidence.foreignMarkerObserved
						: rawForeignMarkerObserved;
					const preexisting = result.probe.inputs[0]?.includes(
						history ? other.context : other.file,
					);
					const searchControl = searchControls?.[index];
					const control = search
						? Boolean(
								searchControl?.probe.outputs.some((output) =>
									output.includes(user.file),
								) &&
									searchControl.probe.answer.includes(user.file) &&
									searchControl.events.includes(user.file),
							)
						: history
							? historyEvidence?.positiveControl
							: canRead[index];
					const completeOutput =
						historyEvidence?.completeOutput ??
						completeToolOutput(result.probe.outputs);
					const scenarioStatus = historyEvidence
						? historyEvidence.status
						: isolationScenarioStatus({
								foreignMarkerObserved: leaked,
								positiveControl: Boolean(control),
								completeOutput,
							});
					record(
						[name, user.id, behavior].join("."),
						scenarioStatus,
						leaked
							? preexisting
								? "foreign-marker-already-in-history"
								: "foreign-marker-reached-model-input-or-result"
							: historyEvidence?.owner === "error" ||
									historyEvidence?.foreign === "error"
								? "history-membership-command-error"
								: !completeOutput
									? "tool-output-incomplete"
									: control
										? "foreign-marker-absent"
										: "matching-positive-control-failed",
					);
				}
			}
			const mutation = `SYNTH_WRITE_${randomUUID()}`;
			for (const user of users)
				for (const file of ["owner-write.txt", "foreign-write.txt"])
					await writeFile(filePath(user, file), "SYNTH_UNCHANGED");
			await pair(
				users.map(
					(user) =>
						"printf %s " +
						quote(mutation) +
						" > " +
						quote(filePath(user, "owner-write.txt")),
				),
			);
			const canWrite = await Promise.all(
				users.map(
					async (user) =>
						(await readFile(filePath(user, "owner-write.txt"), "utf8")) ===
						mutation,
				),
			);
			await pair(
				users.map((_, index) => {
					const other = users[1 - index];
					if (!other) throw new Error("Missing other user");
					return (
						"printf %s " +
						quote(mutation) +
						" > " +
						quote(filePath(other, "foreign-write.txt"))
					);
				}),
			);
			for (const [index, user] of users.entries()) {
				const other = users[1 - index];
				if (!other) throw new Error("Missing other user");
				const changed =
					(await readFile(filePath(other, "foreign-write.txt"), "utf8")) !==
					"SYNTH_UNCHANGED";
				record(
					[name, user.id, "cross-file-modify"].join("."),
					changed ? "fail" : canWrite[index] ? "pass" : "unverified",
					changed
						? "foreign-file-modified"
						: canWrite[index]
							? "owner-write-succeeded-foreign-write-denied"
							: "owner-write-control-failed",
				);
			}
		}
		try {
			model = await isolationModel();
			launcher = await nativeIsolationLauncher(directory, binary, model.url);
			process.env.PATH = launcher.bin + delimiter + (originalPath ?? "");
			await prepareRawNativeStorage();
			await sampleActiveThreadHistory();
			activeDriver = await open();
			report.provenanceVerified = true;
			const launch = (await launcher.observations())
				.filter((entry) => entry.method === "launch")
				.at(-1);
			if (!launch?.codexHome || !launch.cwd || !launch.home)
				throw new Error("Missing native launch");
			nativeHome = launch.codexHome;
			workspace = launch.cwd;
			const ownedRoot = await realpath(directory);
			const temporaryRoot = await realpath(tmpdir());
			const resolvedHome = await realpath(launch.home);
			const resolvedNativeHome = await realpath(nativeHome);
			const resolvedWorkspace = await realpath(workspace);
			for (const resolved of [
				resolvedHome,
				resolvedNativeHome,
				resolvedWorkspace,
			]) {
				if (
					!resolved.startsWith(`${ownedRoot}${sep}`) &&
					!(
						dirname(resolved) === temporaryRoot &&
						basename(resolved).startsWith("agent-runtime-codex-home-")
					)
				)
					throw new Error("Native directory is not synthetic");
			}
			const launchConfiguration = nativeLaunchDirectoryRelations({
				home: resolvedHome,
				codexHome: resolvedNativeHome,
				cwd: resolvedWorkspace,
			});
			report.launchConfiguration = launchConfiguration;
			if (!launchConfiguration.isolated)
				throw new Error("Native HOME, CODEX_HOME, and cwd overlap");
			const memoryDisabled = /^memories\s+\S+\s+false$/m.test(
				launcher.features(nativeHome),
			);
			record(
				"configuration.personal-memory",
				memoryDisabled ? "pass" : "unverified",
				memoryDisabled
					? "pinned-native-feature-disabled"
					: "enabled-or-feature-status-unavailable",
			);
			stage = "host-positive-control";
			const seeds = await pair(undefined, true);
			record(stage, "pass", "both-native-turns-completed-and-replayed");
			const memoryTools = seeds.some(({ probe }) =>
				probe.tools.some((tool) => /memor/i.test(tool)),
			);
			if (memoryTools)
				record(
					"configuration.personal-memory",
					"unverified",
					"memory-tool-advertised",
				);
			for (const user of users) {
				await mkdir(filePath(user, "."), { recursive: true });
				await writeFile(filePath(user, "private.txt"), user.file);
			}
			stage = "concurrent";
			await phase(stage);
			if (!activeDriver) throw new Error("No active native driver");
			await activeDriver.close();
			driver = undefined;
			stage = "restart-resume";
			await open();
			await phase(stage);
		} catch (error) {
			report.errorCode =
				error &&
				typeof error === "object" &&
				"code" in error &&
				typeof error.code === "string" &&
				/^RUNTIME_[A-Z_]+$/.test(error.code)
					? error.code
					: "PROBE_INCOMPLETE";
			record(
				stage,
				"unverified",
				"native-positive-control-or-lifecycle-unavailable",
			);
		} finally {
			try {
				await driver?.close().catch(() => {});
				await model?.close().catch(() => {});
				let observations: Awaited<
					ReturnType<NonNullable<typeof launcher>["observations"]>
				> = [];
				if (!launcher) {
					report.nativeObservation = { category: "launcher-unavailable" };
				} else {
					try {
						observations = await launcher.observations();
						report.nativeObservation = { category: "success" };
					} catch (error) {
						report.nativeObservation = {
							category: nativeObservationErrorCategory(error),
						};
						record(
							"restart-resume.original-native-sessions",
							"unverified",
							"native-observation-unavailable",
						);
					}
				}
				const starts = observations.filter(
					(entry) => entry.method === "thread/start",
				);
				const restartLaunchIndex = observations.findLastIndex(
					(entry) => entry.method === "launch",
				);
				const resumedAfterRestart = observations
					.slice(restartLaunchIndex + 1)
					.filter((entry) => entry.method === "thread/resume");
				const nativeId = (entry: (typeof observations)[number]) =>
					(entry.result?.thread as { id?: string } | undefined)?.id;
				const originalStarts = starts.filter(
					(entry) => nativeId(entry) !== sampledNativeThreadId,
				);
				const originalIds = originalStarts.map(nativeId);
				const sameSessions =
					restartLaunchIndex >= 0 &&
					originalStarts.length === 2 &&
					new Set(originalIds).size === 2 &&
					originalIds.every(
						(id) =>
							typeof id === "string" &&
							resumedAfterRestart.some(
								(entry) =>
									nativeId(entry) === id && entry.params?.threadId === id,
							),
					);
				const restarted =
					observations.filter((entry) => entry.method === "launch").length ===
					2 + rawProbeLaunches + bootstrapDriverLaunches;
				if (stage === "restart-resume" && sameSessions && restarted)
					record(
						"restart-resume.original-native-sessions",
						"pass",
						"two-processes-resumed-original-native-sessions",
					);
				report.nativeRequests = observations.map((entry) => ({
					method: entry.method,
					...(entry.error
						? {
								errorCode: entry.error.code,
								reason:
									entry.error.message === "list_turns is not supported yet"
										? "native-turn-history-unavailable"
										: "native-request-rejected",
							}
						: {}),
				}));
				report.effectiveThreads = observations
					.filter(
						(entry) =>
							entry.method === "thread/start" ||
							entry.method === "thread/resume",
					)
					.map((entry) => {
						const configuration = effectiveThreadConfiguration(entry.result);
						return {
							method: entry.method,
							...configuration,
							requestKeys: Object.keys(entry.params ?? {}),
						};
					});
			} finally {
				if (originalPath === undefined) delete process.env.PATH;
				else process.env.PATH = originalPath;
				await rm(directory, { recursive: true, force: true });
			}
		}
		const requiredCommit = CODEX_ISOLATION_PERSISTENCE_EVIDENCE.mergeCommit;
		let requiredCommitReachable = false;
		let workingTreeClean = false;
		try {
			execFileSync(
				"git",
				["merge-base", "--is-ancestor", requiredCommit, "HEAD"],
				{ stdio: "ignore" },
			);
			requiredCommitReachable = true;
			workingTreeClean =
				execFileSync("git", ["status", "--porcelain=v1"], {
					encoding: "utf8",
				}).trim() === "";
		} catch {
			/* A checkout without the required merge cannot be acceptance evidence. */
		}
		const persistenceEvidence = evaluatePersistenceEvidence({
			requiredCommit,
			requiredCommitReachable,
			workingTreeClean,
		});
		report.persistence = persistenceEvidence;
		const activeThreadReadSamples = Array.isArray(
			report.activeThreadReadSamples,
		)
			? (report.activeThreadReadSamples as NativeReadSample[])
			: [];
		const activeThreadLeak = activeThreadReadSamples.some(
			(sample) => sample.foreignMarkerAbsent === false,
		);
		const activeThreadEvidence = isolationActiveThreadEvidenceStatus({
			activeThreadLeak,
			pointEvidence: ["after-turn-start-accepted", "after-model-observed"].map(
				(point) =>
					activeThreadReadSamples.some(
						(sample) =>
							sample.point === point &&
							sample.category === "success" &&
							sample.knownTurnMatches === true &&
							sample.foreignMarkerAbsent === true,
					),
			),
		});
		report.activeThreadEvidence = { status: activeThreadEvidence };
		report.overall = isolationOverallStatus({
			activeThreadLeak,
			persistenceVerified: persistenceEvidence.status === "pass",
			scenarioStatuses: [
				...Object.values(scenarios).map((row) => row.status),
				activeThreadEvidence,
			],
		});
		console.info(JSON.stringify(report, null, 2));
		expect(
			report.overall,
			"#404 and #194 remain blocked until native isolation passes",
		).toBe("pass");
	},
	180_000,
);
