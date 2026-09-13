import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
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
	codexConversationKey,
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
	type NativeObservation,
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
// A denied foreign scan is isolation evidence, not an inconclusive error.
type HistoryMembership =
	| "present"
	| "absent"
	| "denied"
	| "error"
	| "unavailable";

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
	error?: unknown;
}

interface RawForeignMarkerControl {
	status: "pass" | "unverified";
	category: NativeReadCategory;
	markerObserved: boolean;
}

interface NativeReadSample {
	point: "after-turn-start-accepted" | "after-model-observed";
	method: "thread/read" | "thread/turns/list";
	options: { includeTurns?: boolean; itemsView?: "notLoaded" };
	category: NativeReadCategory;
	threadStatusType?: string;
	knownTurnMatches?: boolean | "unavailable";
	foreignMarkerAbsent?: boolean | "unavailable";
	foreignTurnAbsent?: boolean | "unavailable";
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

function rawNativeReply(
	frame: CodexAppServerFrame,
): RawNativeReply | undefined {
	if ("error" in frame) {
		const error = frame.error;
		return {
			category:
				isPlainRecord(error) && error.code === -32601
					? "unsupported"
					: "native-json-rpc-error",
			error,
		};
	}
	if ("result" in frame) return { category: "success", result: frame.result };
	return undefined;
}

function receiveRawNativeReply(
	pending: Map<number, (reply: RawNativeReply) => void>,
	frame: CodexAppServerFrame,
) {
	const id = frame.id;
	if (typeof id !== "number") return false;
	const resolve = pending.get(id);
	const reply = rawNativeReply(frame);
	if (!resolve || !reply) return false;
	pending.delete(id);
	resolve(reply);
	return true;
}

function rawForeignMarkerControl(
	sample: NativeReadSample | undefined,
	fallbackCategory: NativeReadCategory = "invalid-native-response",
): RawForeignMarkerControl {
	const markerObserved = sample?.foreignMarkerAbsent === false;
	return {
		status:
			sample?.category === "success" &&
			sample.knownTurnMatches === true &&
			markerObserved
				? "pass"
				: "unverified",
		category: sample?.category ?? fallbackCategory,
		markerObserved,
	};
}

async function waitForRawForeignMarkerControl(
	read: () => Promise<NativeReadSample>,
): Promise<RawForeignMarkerControl> {
	let control = rawForeignMarkerControl(undefined);
	for (let attempt = 0; attempt < 5; attempt += 1) {
		control = rawForeignMarkerControl(await read());
		if (control.status === "pass" || control.category === "unsupported")
			return control;
		if (attempt < 4)
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	return control;
}

function gateRawActiveThreadEvidence(
	evidence: ReturnType<typeof evaluateActiveThreadEvidence>,
	control: Pick<RawForeignMarkerControl, "status">,
): Status {
	if (evidence.status === "fail") return "fail";
	return control.status === "pass" ? evidence.status : "unverified";
}

function nativeThreadId(entry: Pick<NativeObservation, "result">) {
	const thread = isPlainRecord(entry.result) ? entry.result.thread : undefined;
	return isPlainRecord(thread) && typeof thread.id === "string"
		? thread.id
		: undefined;
}

function nativeRestartSessionEvidence(
	observations: readonly NativeObservation[],
	rawThreadIds: ReadonlySet<string>,
) {
	const formalStarts = observations.filter(
		(entry) =>
			entry.method === "thread/start" &&
			!rawThreadIds.has(nativeThreadId(entry) ?? ""),
	);
	const lastStartIndex = observations.lastIndexOf(
		formalStarts.at(-1) as NativeObservation,
	);
	// Every Conversation restarts as its own process, so the boundary is the
	// first launch after the last original Session was started.
	const restartLaunchIndex = observations.findIndex(
		(entry, index) => index > lastStartIndex && entry.method === "launch",
	);
	const resumedAfterRestart =
		restartLaunchIndex < 0
			? []
			: observations
					.slice(restartLaunchIndex)
					.filter((entry) => entry.method === "thread/resume");
	const launchesAfterRestart =
		restartLaunchIndex < 0
			? 0
			: observations
					.slice(restartLaunchIndex)
					.filter((entry) => entry.method === "launch").length;
	const startsBeforeRestart =
		restartLaunchIndex < 0
			? []
			: observations
					.slice(0, restartLaunchIndex)
					.filter((entry) => formalStarts.includes(entry));
	const formalIds = formalStarts.map(nativeThreadId);
	const resumed = formalIds.every(
		(id) =>
			typeof id === "string" &&
			resumedAfterRestart.some(
				(entry) =>
					nativeThreadId(entry) === id && entry.params?.threadId === id,
			),
	);
	return {
		status:
			formalStarts.length > 0 &&
			restartLaunchIndex >= 0 &&
			formalStarts.length === 2 &&
			startsBeforeRestart.length === 2 &&
			launchesAfterRestart === 2 &&
			new Set(formalIds).size === 2 &&
			resumed
				? ("pass" as const)
				: ("unverified" as const),
	};
}

const activeThreadPoints = [
	"after-turn-start-accepted",
	"after-model-observed",
] as const satisfies readonly NativeReadSample["point"][];

function evaluateActiveThreadEvidence(samples: readonly NativeReadSample[]) {
	const activeThreadLeak = samples.some(
		(sample) =>
			sample.foreignMarkerAbsent === false ||
			sample.foreignTurnAbsent === false,
	);
	const pointEvidence = activeThreadPoints.map((point) =>
		samples.some(
			(sample) =>
				sample.point === point &&
				sample.method === "thread/turns/list" &&
				sample.category === "success" &&
				sample.knownTurnMatches === true &&
				sample.foreignMarkerAbsent === true &&
				sample.foreignTurnAbsent === true,
		),
	);
	return {
		activeThreadLeak,
		pointEvidence,
		status: isolationActiveThreadEvidenceStatus({
			activeThreadLeak,
			pointEvidence,
		}),
	};
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

/**
 * The native exec tool wraps command output in a fixed envelope. Evidence uses
 * only the command's own output, and a non-zero or unterminated process is
 * never treated as a classified isolation outcome.
 */
function nativeToolOutput(text: string) {
	const exited = /^Process exited with code (-?\d+)$/m.exec(text);
	const output = /^Output:$/m.exec(text);
	if (!exited || !output || output.index < exited.index)
		return { body: text, exitCode: undefined };
	return {
		body: text.slice(output.index + output[0].length + 1),
		exitCode: Number(exited[1]),
	};
}

function decodedToolOutput(output: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(output);
		return typeof parsed === "string"
			? nativeToolOutput(parsed).body
			: undefined;
	} catch {
		return undefined;
	}
}

function toolExitCodes(outputs: readonly string[]) {
	const codes: (number | undefined)[] = [];
	for (const output of outputs) {
		try {
			const parsed: unknown = JSON.parse(output);
			if (typeof parsed !== "string") return undefined;
			codes.push(nativeToolOutput(parsed).exitCode);
		} catch {
			return undefined;
		}
	}
	return codes;
}

// Mirrors the native exec envelope the runtime returns. Evidence helpers refuse
// output without an observed exit code, so a fixture for a completed native run
// must carry the framing a real run carries.
function nativeExecOutput(body: string) {
	return JSON.stringify(
		[
			"Chunk ID: synthetic",
			"Wall time: 0.0000 seconds",
			"Process exited with code 0",
			"Output:",
			body,
		].join("\n"),
	);
}

function completeToolOutput(
	outputs: readonly string[],
	completionMarker?: string,
) {
	const decoded = outputs.map(decodedToolOutput);
	const exitCodes = toolExitCodes(outputs);
	return (
		decoded.length > 0 &&
		decoded.every((output): output is string => output !== undefined) &&
		// A missing envelope is incomplete evidence, not a successful tool: without
		// an observed exit code the decoded text could be anything.
		exitCodes !== undefined &&
		exitCodes.length === decoded.length &&
		exitCodes.every((code) => code === 0) &&
		!decoded.some((output) =>
			/truncated|Process running with session ID/i.test(output),
		) &&
		(!completionMarker ||
			decoded.some((output) => output.includes(completionMarker)))
	);
}

function crossFileModifyEvidence(input: {
	changed: boolean;
	ownerWriteSucceeded: boolean;
	outcomeMarker: string;
	outputs: readonly string[];
}): Evidence {
	const completeOutput = completeToolOutput(input.outputs);
	if (input.changed) return { status: "fail", reason: "foreign-file-modified" };
	if (!input.ownerWriteSucceeded)
		return { status: "unverified", reason: "owner-write-control-failed" };
	if (!completeOutput)
		return { status: "unverified", reason: "foreign-write-output-incomplete" };
	const outcomes = historyOutputLines(input.outputs).filter(
		(line) => line.length > 0,
	);
	if (
		outcomes.length === 1 &&
		[`${input.outcomeMarker}=EACCES`, `${input.outcomeMarker}=EPERM`].includes(
			outcomes[0] ?? "",
		)
	)
		return { status: "pass", reason: "foreign-write-permission-denied" };
	return { status: "unverified", reason: "foreign-write-denial-unclassified" };
}

function fileReadCommand(input: {
	target: string;
	search: boolean;
	outcomeMarker: string;
}) {
	const script = `const fs = require("node:fs");
const [target, search, marker] = process.argv.slice(1);
let result = "READ";
try {
 const text = fs.readFileSync(target, "utf8");
 console.log(search === "true" ? text.split(/\\r?\\n/).filter(line => line.includes("SYNTH_PRIVATE_")).join("\\n") : text);
} catch (error) { result = error.code === "EACCES" || error.code === "EPERM" ? error.code : "ERROR"; }
console.log(marker + "=" + result);`;
	return [
		process.execPath,
		"-e",
		script,
		input.target,
		String(input.search),
		input.outcomeMarker,
	]
		.map(quote)
		.join(" ");
}

function fileReadOutcome(outputs: readonly string[], marker: string) {
	if (!completeToolOutput(outputs)) return undefined;
	const outcomes = historyOutputLines(outputs).filter((line) =>
		line.startsWith(`${marker}=`),
	);
	return outcomes.length === 1
		? outcomes[0]?.slice(marker.length + 1)
		: undefined;
}

function crossFileReadEvidence(input: {
	foreignMarkerObserved: boolean;
	positiveControl: boolean;
	outputs: readonly string[];
	outcomeMarker: string;
}): Evidence {
	if (input.foreignMarkerObserved)
		return {
			status: "fail",
			reason: "foreign-marker-reached-model-input-or-result",
		};
	if (!input.positiveControl)
		return { status: "unverified", reason: "matching-positive-control-failed" };
	const outcome = fileReadOutcome(input.outputs, input.outcomeMarker);
	const lines = historyOutputLines(input.outputs).filter(
		(line) => line.length > 0,
	);
	return lines.length === 1 && (outcome === "EACCES" || outcome === "EPERM")
		? { status: "pass", reason: "foreign-read-permission-denied" }
		: { status: "unverified", reason: "foreign-read-denial-unclassified" };
}

function foreignWriteCommand(input: {
	mutation: string;
	target: string;
	outcomeMarker: string;
}) {
	// Observe the actual filesystem errno inside the native tool process. Shell
	// redirection failure alone cannot distinguish denial from a missing path.
	const script = `const fs = require("node:fs");
const [target, mutation, marker] = process.argv.slice(1);
let result = "APPLIED";
try { fs.writeFileSync(target, mutation, { flag: "r+" }); }
catch (error) { result = error.code === "EACCES" || error.code === "EPERM" ? error.code : "ERROR"; }
console.log(marker + "=" + result);`;
	return [
		process.execPath,
		"-e",
		script,
		input.target,
		input.mutation,
		input.outcomeMarker,
	]
		.map(quote)
		.join(" ");
}

function historyOutputLines(outputs: readonly string[]) {
	return outputs.flatMap(
		(output) => decodedToolOutput(output)?.split(/\r?\n/) ?? [],
	);
}

function historyMembership(
	lines: readonly string[],
	name: "OWNER" | "FOREIGN",
): HistoryMembership {
	const matches = lines.filter((line) =>
		/^SYNTH_HISTORY_(?:OWNER|FOREIGN)=(?:present|absent|denied|error)$/.test(
			line,
		),
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
		/^SYNTH_HISTORY_(?:OWNER|FOREIGN)=(?:present|absent|denied|error)$/;
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
			completeToolOutput(outputs) &&
			completed === 1 &&
			!unexpectedOutput &&
			owner !== "unavailable" &&
			foreign !== "unavailable" &&
			owner !== "error" &&
			owner !== "denied" &&
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

	static async open(dataDirectory: string, conversationKey: string) {
		const bridge = await CodexAppServerBridge.open({
			dataDirectory,
			conversationKey,
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
		receiveRawNativeReply(this.pending, frame);
	}
}

function nativeReadSample(
	point: NativeReadSample["point"],
	method: NativeReadSample["method"],
	options: NativeReadSample["options"],
	reply: RawNativeReply,
	knownTurnId: string,
	foreignMarker: string,
	foreignTurnId?: string,
): NativeReadSample {
	const markerObserved = containsMarker(
		reply.category === "success" ? reply.result : reply.error,
		foreignMarker,
	);
	const sample: NativeReadSample = {
		point,
		method,
		options,
		category: reply.category,
		foreignTurnAbsent: "unavailable",
		...(markerObserved
			? { foreignMarkerAbsent: false }
			: reply.category === "success"
				? { foreignMarkerAbsent: true }
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
		foreignTurnAbsent:
			typeof foreignTurnId === "string" &&
			foreignTurnId.length > 0 &&
			foreignTurnId !== knownTurnId
				? !data.some((turn) => isPlainRecord(turn) && turn.id === foreignTurnId)
				: "unavailable",
		knownTurnMatches: data.some(
			(turn) => isPlainRecord(turn) && turn.id === knownTurnId,
		),
	};
}

it("requires canonical active-history samples at both lifecycle points", () => {
	const knownTurnId = "synthetic-turn";
	const foreignMarker = "SYNTH_FOREIGN_MARKER";
	const canonical = (point: NativeReadSample["point"], reply: RawNativeReply) =>
		nativeReadSample(
			point,
			"thread/turns/list",
			{ itemsView: "notLoaded" },
			reply,
			knownTurnId,
			foreignMarker,
			"synthetic-foreign-turn",
		);
	const validCanonical = activeThreadPoints.map((point) =>
		canonical(point, {
			category: "success",
			result: { data: [{ id: knownTurnId }] },
		}),
	);
	const supplementalUnavailable = activeThreadPoints.map((point) => ({
		point,
		method: "thread/read" as const,
		options: { includeTurns: false },
		category: "unsupported" as const,
		knownTurnMatches: "unavailable" as const,
		foreignMarkerAbsent: "unavailable" as const,
	}));

	expect(evaluateActiveThreadEvidence(supplementalUnavailable).status).toBe(
		"unverified",
	);
	expect(
		evaluateActiveThreadEvidence([
			...supplementalUnavailable,
			...validCanonical,
		]),
	).toMatchObject({
		activeThreadLeak: false,
		pointEvidence: [true, true],
		status: "pass",
	});
	expect(
		evaluateActiveThreadEvidence([
			canonical("after-turn-start-accepted", {
				category: "success",
				result: { data: [{ id: knownTurnId }] },
			}),
		]).status,
	).toBe("unverified");
});

it("rejects foreign turn IDs even when canonical history omits item contents", () => {
	const targetTurnId = "synthetic-target-turn";
	const foreignTurnId = "synthetic-foreign-turn";
	const samples = (ids: string[], controlId: string | undefined) =>
		activeThreadPoints.map((point) =>
			nativeReadSample(
				point,
				"thread/turns/list",
				{ itemsView: "notLoaded" },
				{ category: "success", result: { data: ids.map((id) => ({ id })) } },
				targetTurnId,
				"SYNTH_FOREIGN_MARKER",
				controlId,
			),
		);
	const clean = samples([targetTurnId], foreignTurnId);
	expect(evaluateActiveThreadEvidence(clean).status).toBe("pass");
	const leaked = samples([targetTurnId, foreignTurnId], foreignTurnId);
	expect(leaked.every((sample) => sample.foreignMarkerAbsent === true)).toBe(
		true,
	);
	expect(evaluateActiveThreadEvidence(leaked).status).toBe("fail");
	for (const controlId of [undefined, "", targetTurnId]) {
		expect(
			evaluateActiveThreadEvidence(samples([targetTurnId], controlId)).status,
		).toBe("unverified");
	}
	expect(JSON.stringify([...clean, ...leaked])).not.toContain(targetTurnId);
	expect(JSON.stringify([...clean, ...leaked])).not.toContain(foreignTurnId);
});

it("fails malformed successful native results that contain a foreign marker", () => {
	const marker = "SYNTH_FOREIGN_MARKER";
	const knownTurnId = "synthetic-turn";
	const malformed = nativeReadSample(
		"after-turn-start-accepted",
		"thread/turns/list",
		{ itemsView: "notLoaded" },
		{ category: "success", result: { unexpected: { marker } } },
		knownTurnId,
		marker,
	);
	const otherwiseHealthy = activeThreadPoints.map((point) =>
		nativeReadSample(
			point,
			"thread/turns/list",
			{ itemsView: "notLoaded" },
			{ category: "success", result: { data: [{ id: knownTurnId }] } },
			knownTurnId,
			marker,
		),
	);
	expect(malformed).toMatchObject({
		category: "invalid-native-response",
		knownTurnMatches: "unavailable",
		foreignMarkerAbsent: false,
	});
	expect(
		evaluateActiveThreadEvidence([...otherwiseHealthy, malformed]).status,
	).toBe("fail");
});

it("waits for raw marker materialization and bounds unavailable control evidence", async () => {
	const sample = (markerObserved: boolean): NativeReadSample => ({
		point: "after-model-observed",
		method: "thread/read",
		options: { includeTurns: true },
		category: "success",
		knownTurnMatches: true,
		foreignMarkerAbsent: !markerObserved,
	});
	let reads = 0;
	expect(
		await waitForRawForeignMarkerControl(async () => sample(++reads === 3)),
	).toMatchObject({ status: "pass", markerObserved: true });
	expect(reads).toBe(3);
	reads = 0;
	expect(
		await waitForRawForeignMarkerControl(async () => {
			reads += 1;
			return sample(false);
		}),
	).toMatchObject({ status: "unverified", markerObserved: false });
	expect(reads).toBe(5);
});

it("requires an observable raw marker control before accepting active history", () => {
	const knownTurnId = "synthetic-turn";
	const foreignMarker = "SYNTH_FOREIGN_MARKER";
	const canonical = (
		point: NativeReadSample["point"],
		result: unknown = { data: [{ id: knownTurnId }] },
	) =>
		nativeReadSample(
			point,
			"thread/turns/list",
			{ itemsView: "notLoaded" },
			{ category: "success", result },
			knownTurnId,
			foreignMarker,
			"synthetic-foreign-turn",
		);
	const targetEvidence = evaluateActiveThreadEvidence(
		activeThreadPoints.map((point) => canonical(point)),
	);
	const observableControl = rawForeignMarkerControl(
		nativeReadSample(
			"after-turn-start-accepted",
			"thread/read",
			{ includeTurns: true },
			{
				category: "success",
				result: {
					thread: {
						status: { type: "active" },
						turns: [{ id: knownTurnId, items: [{ content: foreignMarker }] }],
					},
				},
			},
			knownTurnId,
			foreignMarker,
			"synthetic-foreign-turn",
		),
	);
	expect(gateRawActiveThreadEvidence(targetEvidence, observableControl)).toBe(
		"pass",
	);

	const unavailableControl = rawForeignMarkerControl(
		canonical("after-turn-start-accepted"),
	);
	expect(gateRawActiveThreadEvidence(targetEvidence, unavailableControl)).toBe(
		"unverified",
	);
	const targetLeak = evaluateActiveThreadEvidence([
		...activeThreadPoints.map((point) => canonical(point)),
		canonical("after-model-observed", {
			data: [{ id: knownTurnId, content: foreignMarker }],
		}),
	]);
	expect(gateRawActiveThreadEvidence(targetLeak, unavailableControl)).toBe(
		"fail",
	);
});

it("fails raw active history evidence when JSON-RPC errors contain a foreign marker", () => {
	const knownTurnId = "synthetic-turn";
	const foreignMarker = "SYNTH_FOREIGN_MARKER";
	const receive = (frame: CodexAppServerFrame) => {
		let reply: RawNativeReply | undefined;
		const pending = new Map<number, (value: RawNativeReply) => void>();
		pending.set(42, (value) => {
			reply = value;
		});
		expect(receiveRawNativeReply(pending, frame)).toBe(true);
		if (!reply) throw new Error("Raw reply was not received");
		return reply;
	};
	const healthy = activeThreadPoints.map((point) =>
		nativeReadSample(
			point,
			"thread/turns/list",
			{ itemsView: "notLoaded" },
			{ category: "success", result: { data: [{ id: knownTurnId }] } },
			knownTurnId,
			foreignMarker,
			"synthetic-foreign-turn",
		),
	);
	const control = rawForeignMarkerControl(
		nativeReadSample(
			"after-turn-start-accepted",
			"thread/turns/list",
			{ itemsView: "notLoaded" },
			{
				category: "success",
				result: { data: [{ id: knownTurnId, content: foreignMarker }] },
			},
			knownTurnId,
			foreignMarker,
			"synthetic-foreign-turn",
		),
	);
	for (const error of [
		{ code: -32_000, message: `native failure ${foreignMarker}` },
		{ code: -32_000, data: { observed: foreignMarker } },
	] as const) {
		const sample = nativeReadSample(
			"after-turn-start-accepted",
			"thread/turns/list",
			{ itemsView: "notLoaded" },
			receive({ id: 42, error }),
			knownTurnId,
			foreignMarker,
			"synthetic-foreign-turn",
		);
		const evidence = evaluateActiveThreadEvidence([...healthy, sample]);
		expect(sample.foreignMarkerAbsent).toBe(false);
		expect(gateRawActiveThreadEvidence(evidence, control)).toBe("fail");
		expect(
			isolationOverallStatus({
				activeThreadLeak: evidence.activeThreadLeak,
				persistenceVerified: true,
				scenarioStatuses: [evidence.status],
			}),
		).toBe("fail");
	}
	const ordinaryError = nativeReadSample(
		"after-turn-start-accepted",
		"thread/turns/list",
		{ itemsView: "notLoaded" },
		receive({ id: 42, error: { code: -32_000, message: "native failure" } }),
		knownTurnId,
		foreignMarker,
	);
	const ordinaryEvidence = evaluateActiveThreadEvidence([
		healthy[1] as NativeReadSample,
		ordinaryError,
	]);
	expect(ordinaryError.foreignMarkerAbsent).toBe("unavailable");
	expect(gateRawActiveThreadEvidence(ordinaryEvidence, control)).toBe(
		"unverified",
	);
	expect(
		isolationOverallStatus({
			activeThreadLeak: ordinaryEvidence.activeThreadLeak,
			persistenceVerified: true,
			scenarioStatuses: [ordinaryEvidence.status],
		}),
	).toBe("unverified");
});

it("matches only the two formal sessions after an interleaved raw probe restart", () => {
	const rawThreadIds = new Set(["raw-control", "raw-target"]);
	const threadStart = (id: string): NativeObservation => ({
		method: "thread/start",
		result: { thread: { id } },
	});
	const resumed = (id: string, threadId = id): NativeObservation => ({
		method: "thread/resume",
		params: { threadId },
		result: { thread: { id } },
	});
	// One native process per Conversation: two launches start the original
	// Sessions and two more resume them after the restart.
	const complete = [
		{ method: "launch" },
		threadStart("raw-control"),
		{ method: "launch" },
		threadStart("formal-a"),
		threadStart("raw-target"),
		{ method: "launch" },
		threadStart("formal-b"),
		{ method: "launch" },
		resumed("formal-a"),
		{ method: "launch" },
		resumed("formal-b"),
	] satisfies NativeObservation[];
	expect(nativeRestartSessionEvidence(complete, rawThreadIds).status).toBe(
		"pass",
	);

	for (const observations of [
		// Only one process restarted.
		complete.filter((_entry, index) => index !== 9),
		// No launch separates the original Sessions from the resumes.
		[
			{ method: "launch" },
			threadStart("formal-a"),
			{ method: "launch" },
			threadStart("formal-b"),
			resumed("formal-a"),
			resumed("formal-b"),
		],
		// A Session was started after the restart boundary.
		[
			{ method: "launch" },
			threadStart("formal-a"),
			{ method: "launch" },
			{ method: "launch" },
			threadStart("formal-b"),
			{ method: "launch" },
			resumed("formal-a"),
			resumed("formal-b"),
		],
		// One original Session was never resumed.
		complete.filter((entry) =>
			entry.method === "thread/resume"
				? entry.params?.threadId !== "formal-b"
				: true,
		),
		// A resume names a different native thread.
		complete.map((entry) =>
			entry.method === "thread/resume" && entry.params?.threadId === "formal-b"
				? resumed("formal-b", "different-thread")
				: entry,
		),
		// A third formal Session appeared.
		[
			...complete.slice(0, -2),
			threadStart("formal-c"),
			resumed("formal-a"),
			resumed("formal-b"),
			resumed("formal-c"),
		],
		// No formal Session was ever started.
		[{ method: "launch" }, threadStart("raw-control"), { method: "launch" }],
	])
		expect(
			nativeRestartSessionEvidence(observations, rawThreadIds).status,
		).toBe("unverified");
});

it("retains pending numeric replies through colliding server requests", () => {
	const pending = new Map<number, (value: RawNativeReply) => void>();
	let one: RawNativeReply | undefined;
	let ten: RawNativeReply | undefined;
	let oneCallbacks = 0;
	let tenCallbacks = 0;
	pending.set(1, (value) => {
		oneCallbacks += 1;
		one = value;
	});
	pending.set(10, (value) => {
		tenCallbacks += 1;
		ten = value;
	});
	for (const id of [1, 10]) {
		expect(
			receiveRawNativeReply(pending, {
				id,
				method: "server/request",
				params: {},
			}),
		).toBe(false);
	}
	expect(pending.size).toBe(2);
	expect(
		receiveRawNativeReply(pending, { id: 1, result: { request: "one" } }),
	).toBe(true);
	expect(
		receiveRawNativeReply(pending, {
			id: 10,
			error: { code: -32_000, message: "request ten failed" },
		}),
	).toBe(true);
	expect(oneCallbacks).toBe(1);
	expect(tenCallbacks).toBe(1);
	expect(one).toMatchObject({
		category: "success",
		result: { request: "one" },
	});
	expect(ten).toMatchObject({ category: "native-json-rpc-error" });
	expect(
		receiveRawNativeReply(pending, { id: 1, result: { request: "one" } }),
	).toBe(false);
	expect(
		receiveRawNativeReply(pending, {
			id: 10,
			error: { code: -32_000, message: "request ten failed" },
		}),
	).toBe(false);
	expect(oneCallbacks).toBe(1);
	expect(tenCallbacks).toBe(1);
	expect(pending.size).toBe(0);
});

it("records effective thread settings from the native result root", () => {
	expect(
		effectiveThreadConfiguration({
			approvalPolicy: "on-request",
			sandbox: { type: "workspaceWrite", networkAccess: false },
			thread: {
				approvalPolicy: "nested-value-must-not-be-used",
				sandbox: { type: "nested-value-must-not-be-used", networkAccess: true },
			},
		}),
	).toEqual({
		approvalPolicy: "on-request",
		sandboxType: "workspaceWrite",
		networkAccess: false,
	});
});

it("reads evidence from the native exec envelope without trusting its framing", () => {
	const marker = "SYNTH_ENVELOPE_TEST";
	const envelope = (body: string, exit = "Process exited with code 0") =>
		JSON.stringify(
			[
				"Chunk ID: abc123",
				"Wall time: 0.0000 seconds",
				exit,
				"Original token count: 12",
				"Output:",
				body,
			].join("\n"),
		);

	// The envelope lines are framing, not command output.
	expect(
		crossFileReadEvidence({
			outputs: [envelope(`${marker}=EPERM\n`)],
			outcomeMarker: marker,
			positiveControl: true,
			foreignMarkerObserved: false,
		}),
	).toEqual({ status: "pass", reason: "foreign-read-permission-denied" });
	expect(
		crossFileModifyEvidence({
			outputs: [envelope(`${marker}=EACCES\n`)],
			outcomeMarker: marker,
			ownerWriteSucceeded: true,
			changed: false,
		}),
	).toEqual({ status: "pass", reason: "foreign-write-permission-denied" });
	expect(
		historyScenarioEvidence({
			outputs: [
				envelope(
					"SYNTH_HISTORY_OWNER=present\nSYNTH_HISTORY_FOREIGN=denied\nSYNTH_HISTORY_SCAN_COMPLETE\n",
				),
			],
			foreignMarkerObserved: false,
		}),
	).toMatchObject({ owner: "present", foreign: "denied", status: "pass" });

	// A failed or unterminated native process is never a classified outcome.
	for (const exit of [
		"Process exited with code 1",
		"Process running with session ID abc",
	])
		expect(
			crossFileReadEvidence({
				outputs: [envelope(`${marker}=EPERM\n`, exit)],
				outcomeMarker: marker,
				positiveControl: true,
				foreignMarkerObserved: false,
			}).status,
		).toBe("unverified");

	// Extra command output beside the outcome stays unclassified.
	expect(
		crossFileReadEvidence({
			outputs: [envelope(`unexpected\n${marker}=EPERM\n`)],
			outcomeMarker: marker,
			positiveControl: true,
			foreignMarkerObserved: false,
		}).status,
	).toBe("unverified");
});

it.skipIf(process.platform === "win32")(
	"uses bounded exact membership evidence for the history positive control",
	async () => {
		const owner = "SYNTH_CONTEXT_OWNER_ABC";
		const foreign = "SYNTH_CONTEXT_FOREIGN_DEF";
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-history-"));
		try {
			const ownerSessions = join(directory, "owner", "sessions");
			const foreignSessions = join(directory, "foreign", "sessions");
			await mkdir(ownerSessions, { recursive: true });
			await mkdir(foreignSessions, { recursive: true });
			await writeFile(join(ownerSessions, "owner-history.json"), owner);
			const command = historyScanCommand({
				ownerMarker: owner,
				foreignMarker: foreign,
				ownerDirectory: ownerSessions,
				foreignDirectory: foreignSessions,
			});
			expect(command).not.toContain(owner);
			expect(command).not.toContain(foreign);
			const evidence = historyScenarioEvidence({
				outputs: [
					nativeExecOutput(
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
	},
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
	"accepts a denied foreign history scan beside a successful owner control",
	async () => {
		const owner = "SYNTH_CONTEXT_OWNER_GHI";
		const foreign = "SYNTH_CONTEXT_FOREIGN_JKL";
		const directory = await mkdtemp(join(tmpdir(), "agent-runtime-history-"));
		const foreignSessions = join(directory, "foreign", "sessions");
		try {
			const ownerSessions = join(directory, "owner", "sessions");
			await mkdir(ownerSessions, { recursive: true });
			await mkdir(foreignSessions, { recursive: true });
			await writeFile(join(ownerSessions, "owner-history.json"), owner);
			await writeFile(join(foreignSessions, "foreign-history.json"), foreign);
			await chmod(foreignSessions, 0o000);
			const outputs = [
				nativeExecOutput(
					execFileSync(
						"sh",
						[
							"-c",
							historyScanCommand({
								ownerMarker: owner,
								foreignMarker: foreign,
								ownerDirectory: ownerSessions,
								foreignDirectory: foreignSessions,
							}),
						],
						{ encoding: "utf8" },
					),
				),
			];
			expect(
				historyScenarioEvidence({ outputs, foreignMarkerObserved: false }),
			).toMatchObject({
				owner: "present",
				foreign: "denied",
				completeOutput: true,
				status: "pass",
			});
			// A denied owner control can never stand in for isolation evidence.
			expect(
				historyScenarioEvidence({
					outputs: [JSON.stringify("SYNTH_HISTORY_OWNER=denied\n")].concat(
						JSON.stringify("SYNTH_HISTORY_FOREIGN=denied\n"),
						JSON.stringify("SYNTH_HISTORY_SCAN_COMPLETE\n"),
					),
					foreignMarkerObserved: false,
				}),
			).toMatchObject({ completeOutput: false, status: "unverified" });
		} finally {
			await chmod(foreignSessions, 0o700).catch(() => {});
			await rm(directory, { recursive: true, force: true });
		}
	},
);

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

it("rejects malformed tool frames beside otherwise valid isolation evidence", () => {
	const marker = "SYNTH_FRAME_TEST";
	for (const invalid of [
		"not-json",
		"null",
		"42",
		"{}",
		"[]",
		JSON.stringify({ output: `${marker}=EACCES` }),
	]) {
		const outputs = [JSON.stringify(`${marker}=EACCES`), invalid];
		expect(
			crossFileReadEvidence({
				outputs,
				outcomeMarker: marker,
				positiveControl: true,
				foreignMarkerObserved: false,
			}).status,
		).toBe("unverified");
		expect(
			crossFileModifyEvidence({
				outputs,
				outcomeMarker: marker,
				ownerWriteSucceeded: true,
				changed: false,
			}).status,
		).toBe("unverified");
		expect(
			historyScenarioEvidence({
				outputs: [
					JSON.stringify(
						"SYNTH_HISTORY_OWNER=present\nSYNTH_HISTORY_FOREIGN=absent\nSYNTH_HISTORY_SCAN_COMPLETE",
					),
					invalid,
				],
				foreignMarkerObserved: false,
			}).status,
		).toBe("unverified");
		expect(
			crossFileReadEvidence({
				outputs,
				outcomeMarker: marker,
				positiveControl: true,
				foreignMarkerObserved: true,
			}).status,
		).toBe("fail");
		expect(
			crossFileModifyEvidence({
				outputs,
				outcomeMarker: marker,
				ownerWriteSucceeded: true,
				changed: true,
			}).status,
		).toBe("fail");
	}
	expect(
		completeToolOutput([
			JSON.stringify("Process running with session ID test"),
		]),
	).toBe(false);
	expect(
		completeToolOutput([
			'"Process running with session ID test"'.replace(
				"running",
				"\\u0072unning",
			),
		]),
	).toBe(false);
});

it.skipIf(process.platform === "win32")(
	"requires nonce-bound read denial and the matching successful control",
	async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "agent-runtime-read-errno-"),
		);
		const target = join(directory, "private.txt");
		const marker = "SYNTH_READ_RESULT_TEST";
		try {
			await writeFile(target, "irrelevant\nSYNTH_PRIVATE_TEST\n");
			for (const search of [false, true]) {
				const run = (path: string) =>
					execFileSync(
						"sh",
						[
							"-c",
							fileReadCommand({ target: path, search, outcomeMarker: marker }),
						],
						{ encoding: "utf8" },
					);
				const success = run(target);
				expect(success).toContain("SYNTH_PRIVATE_TEST");
				expect(fileReadOutcome([nativeExecOutput(success)], marker)).toBe(
					"READ",
				);
				if (search) expect(success).not.toContain("irrelevant");
				for (const path of [directory, join(directory, "missing")]) {
					const outputs = [nativeExecOutput(run(path))];
					expect(fileReadOutcome(outputs, marker)).toBe("ERROR");
					expect(
						crossFileReadEvidence({
							outputs,
							outcomeMarker: marker,
							positiveControl: true,
							foreignMarkerObserved: false,
						}).status,
					).toBe("unverified");
				}
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
		const classify = (
			text: string,
			positiveControl = true,
			foreignMarkerObserved = false,
		) =>
			crossFileReadEvidence({
				outputs: [nativeExecOutput(text)],
				outcomeMarker: marker,
				positiveControl,
				foreignMarkerObserved,
			}).status;
		for (const code of ["EACCES", "EPERM"]) {
			expect(classify(`${marker}=${code}`)).toBe("pass");
			expect(classify(`${marker}=${code}`, false)).toBe("unverified");
			expect(classify(`${marker}=${code}`, false, true)).toBe("fail");
		}
		for (const output of [
			"command not found",
			"",
			`${marker}=ERROR`,
			`${marker}=READ`,
			`${marker}=ENOENT`,
			"OTHER=EACCES",
			`prefix ${marker}=EACCES`,
			`${marker}=EACCES\n${marker}=READ`,
			`${marker}=EACCES\n${marker}=EACCES`,
			`${marker}=EACCES\ntruncated`,
			`${marker}=EACCES\nunexpected error`,
			`unexpected data\n${marker}=EPERM`,
			`${marker}=EACCES\nProcess running with session ID test`,
		]) {
			expect(classify(output)).toBe("unverified");
			expect(classify(output, true, true)).toBe("fail");
		}
	},
);

it.skipIf(process.platform === "win32")(
	"classifies real write errno without treating ordinary failures as denial",
	async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "agent-runtime-write-errno-"),
		);
		const target = join(directory, "target.txt");
		const outcomeMarker = "SYNTH_WRITE_RESULT_COMMAND";
		const run = (path: string) =>
			execFileSync(
				"sh",
				[
					"-c",
					foreignWriteCommand({
						mutation: "SYNTH_MUTATION",
						target: path,
						outcomeMarker,
					}),
				],
				{ encoding: "utf8" },
			).trim();
		try {
			await writeFile(target, "original");
			expect(run(target)).toBe(`${outcomeMarker}=APPLIED`);
			expect(await readFile(target, "utf8")).toBe("SYNTH_MUTATION");
			expect(run(directory)).toBe(`${outcomeMarker}=ERROR`);
			expect(run(join(directory, "missing.txt"))).toBe(
				`${outcomeMarker}=ERROR`,
			);
			if (process.getuid?.() !== 0) {
				await chmod(target, 0o400);
				expect(run(target)).toBe(`${outcomeMarker}=EACCES`);
			}
		} finally {
			await chmod(target, 0o600);
			await rm(directory, { recursive: true, force: true });
		}
	},
);

it("accepts only a complete nonce-bound filesystem permission denial", () => {
	const outcomeMarker = "SYNTH_WRITE_RESULT_TEST";
	const evidence = (
		lines: string[],
		changed = false,
		ownerWriteSucceeded = true,
	) =>
		crossFileModifyEvidence({
			changed,
			ownerWriteSucceeded,
			outcomeMarker,
			outputs: [nativeExecOutput(lines.join("\n"))],
		});
	for (const code of ["EACCES", "EPERM"])
		expect(evidence([`${outcomeMarker}=${code}`])).toEqual({
			status: "pass",
			reason: "foreign-write-permission-denied",
		});
	for (const lines of [
		[`${outcomeMarker}=ERROR`],
		[`${outcomeMarker}=APPLIED`],
		[`${outcomeMarker}=ENOENT`],
		["SYNTH_WRITE_RESULT_OTHER=EACCES"],
		[`${outcomeMarker}=EACCES`, `${outcomeMarker}=APPLIED`],
		[`${outcomeMarker}=EACCES`, `${outcomeMarker}=EACCES`],
		[`${outcomeMarker}=EACCES`, "unexpected error"],
		["unexpected data", `${outcomeMarker}=EPERM`],
		[`prefix ${outcomeMarker}=EACCES`],
		[`${outcomeMarker}=EACCES`, "Process running with session ID test"],
	])
		expect(evidence(lines).status).toBe("unverified");
	expect(evidence([`${outcomeMarker}=EACCES`], true).status).toBe("fail");
	expect(evidence([`${outcomeMarker}=EACCES`], false, false).status).toBe(
		"unverified",
	);
});

it.skipIf(process.platform === "win32")(
	"keeps unclassified cross-write outcomes from passing modification isolation",
	async () => {
		const appliedMarker = "SYNTH_FOREIGN_WRITE_APPLIED";
		const outcomeMarker = "SYNTH_FOREIGN_WRITE_RESULT";
		const evidence = (
			input: Partial<Parameters<typeof crossFileModifyEvidence>[0]>,
		) =>
			crossFileModifyEvidence({
				changed: false,
				ownerWriteSucceeded: true,
				outcomeMarker,
				outputs: [],
				...input,
			});
		const directory = await mkdtemp(
			join(tmpdir(), "agent-runtime-cross-write-"),
		);
		let genericFailureOutput = "";
		try {
			const target = join(directory, "not-a-file");
			await mkdir(target);
			genericFailureOutput = execFileSync(
				"sh",
				[
					"-c",
					foreignWriteCommand({
						mutation: "SYNTH_MUTATION",
						target,
						outcomeMarker,
					}),
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
		expect(genericFailureOutput).toContain(`${outcomeMarker}=ERROR`);
		const statuses: Status[] = [];
		for (const [input, expected] of [
			[
				{ changed: true, outputs: [nativeExecOutput(appliedMarker)] },
				{ status: "fail", reason: "foreign-file-modified" },
			],
			[
				{ outputs: [nativeExecOutput(genericFailureOutput)] },
				{ status: "unverified", reason: "foreign-write-denial-unclassified" },
			],
			[
				{ outputs: [] },
				{ status: "unverified", reason: "foreign-write-output-incomplete" },
			],
			[
				{
					outputs: [
						JSON.stringify("Process running with session ID synthetic-session"),
					],
				},
				{ status: "unverified", reason: "foreign-write-output-incomplete" },
			],
			[
				{ outputs: [nativeExecOutput("native command failed")] },
				{ status: "unverified", reason: "foreign-write-denial-unclassified" },
			],
		] as const) {
			const result = evidence(input);
			expect(result).toMatchObject(expected);
			statuses.push(result.status);
			expect(
				isolationOverallStatus({
					activeThreadLeak: false,
					persistenceVerified: true,
					scenarioStatuses: ["pass", result.status],
				}),
			).toBe(result.status === "fail" ? "fail" : result.status);
		}
		expect(statuses).toEqual([
			"fail",
			"unverified",
			"unverified",
			"unverified",
			"unverified",
		]);
	},
);

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
	ownerDirectory: string;
	foreignDirectory: string;
}) {
	// Markers are rebuilt from byte values so no scanned marker text appears in
	// the command, the model input, or the tool arguments.
	const bytes = (value: string) =>
		JSON.stringify([...Buffer.from(value, "utf8")]);
	const script = `const fs = require("node:fs");
const path = require("node:path");
const [ownerDirectory, foreignDirectory, ownerBytes, foreignBytes] = process.argv.slice(1);
const scan = (directory, encoded) => {
 const marker = Buffer.from(JSON.parse(encoded)).toString("utf8");
 const walk = (current) => {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
   const full = path.join(current, entry.name);
   if (entry.isDirectory()) { if (walk(full)) return true; continue; }
   if (!entry.isFile()) continue;
   if (fs.readFileSync(full, "utf8").includes(marker)) return true;
  }
  return false;
 };
 try { return walk(directory) ? "present" : "absent"; }
 catch (error) { return error.code === "EACCES" || error.code === "EPERM" ? "denied" : "error"; }
};
console.log("SYNTH_HISTORY_OWNER=" + scan(ownerDirectory, ownerBytes));
console.log("SYNTH_HISTORY_FOREIGN=" + scan(foreignDirectory, foreignBytes));
console.log("SYNTH_HISTORY_SCAN_COMPLETE");`;
	return [
		process.execPath,
		"-e",
		script,
		input.ownerDirectory,
		input.foreignDirectory,
		bytes(input.ownerMarker),
		bytes(input.foreignMarker),
	]
		.map(quote)
		.join(" ");
}

// A skipped native suite is never isolation acceptance evidence.
// This entry point observes the native launch through a byte-preserving wrapper
// that appends to a file in the harness directory. On Linux the Bridge confines
// the native process to the Conversation boundary, which does not include that
// directory, so the wrapper cannot observe anything there. Linux evidence for the
// same boundary comes from the runtime image probe instead, so this refuses to run
// rather than reporting a boundary as a harness failure.
it.skipIf(!process.env.CODEX_ISOLATION_BINARY || process.platform !== "darwin")(
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
		// One native process per Conversation, so every actor has its own
		// CODEX_HOME and workspace.
		const actorStorage = new Map<
			string,
			{ home: string; codexHome: string; cwd: string }
		>();
		const conversationKeys = new Map(
			users.map((user) => [
				user.id,
				codexConversationKey({
					agentId: "agent-isolation",
					conversationId: `conversation-${user.id}`,
					sessionGeneration: 1,
				}),
			]),
		);
		let rawProbeLaunches = 0;
		let activeDriver: CodexRuntimeDriver | undefined;
		const rawNativeThreadIds = new Set<string>();
		let rawActiveThreadControl = rawForeignMarkerControl(undefined);
		let rawForeignTurnId: string | undefined;
		let stage = "startup";
		const record = (key: string, status: Status, reason: string) => {
			scenarios[key] = { status, reason };
		};
		const storageOf = (user: (typeof users)[number]) => {
			const storage = actorStorage.get(user.id);
			if (!storage) throw new Error("Missing native launch");
			return storage;
		};
		const filePath = (user: (typeof users)[number], name: string) =>
			join(storageOf(user).cwd, name);
		const historyDirectory = (user: (typeof users)[number]) =>
			join(storageOf(user).codexHome, "sessions");
		const features = (nativeHome: string) => {
			if (!launcher) throw new Error("Missing native launcher");
			return launcher.features(nativeHome);
		};
		async function resolveActorStorage() {
			if (!launcher) throw new Error("Missing native launcher");
			const launches = (await launcher.observations()).filter(
				(entry) => entry.method === "launch",
			);
			for (const user of users) {
				const key = conversationKeys.get(user.id);
				if (!key) throw new Error("Missing Conversation key");
				// The launch is matched by the server-derived Conversation key, which
				// also proves the path is bound to the trusted binding.
				const launch = launches.findLast(
					(entry) =>
						typeof entry.cwd === "string" &&
						entry.cwd.includes(`${sep}conversations${sep}${key}${sep}`),
				);
				if (!launch?.cwd || !launch.codexHome || !launch.home)
					throw new Error("Missing native launch");
				actorStorage.set(user.id, {
					home: launch.home,
					codexHome: launch.codexHome,
					cwd: launch.cwd,
				});
			}
		}
		async function open() {
			driver = await CodexRuntimeDriver.open({
				path: join(directory, "driver.json"),
				configVersion: "synthetic-config-1",
				defaultModelOptionId: "synthetic",
				defaultReasoningLevel: "high",
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
					rawForeignTurnId,
				),
			];
		}
		async function sampleRawForeignMarkerControl(
			client: RawNativeClient,
			foreignMarker: string,
			probeId: string,
			modelObserved: Promise<void>,
		): Promise<RawForeignMarkerControl> {
			const threadStarted = await client.request("thread/start", {});
			const thread = isPlainRecord(threadStarted.result)
				? threadStarted.result.thread
				: undefined;
			if (
				threadStarted.category !== "success" ||
				!isPlainRecord(thread) ||
				typeof thread.id !== "string"
			)
				return rawForeignMarkerControl(undefined, threadStarted.category);
			rawNativeThreadIds.add(thread.id);

			const turnStarted = await client.request("turn/start", {
				threadId: thread.id,
				clientUserMessageId: randomUUID(),
				input: [
					{
						type: "text",
						text: `ISOLATION_PROBE:${probeId} ${foreignMarker}`,
					},
				],
				model: "gpt-5.3-codex",
				effort: "high",
			});
			const turn = isPlainRecord(turnStarted.result)
				? turnStarted.result.turn
				: undefined;
			if (
				turnStarted.category !== "success" ||
				!isPlainRecord(turn) ||
				typeof turn.id !== "string"
			)
				return rawForeignMarkerControl(undefined, turnStarted.category);

			const controlTurnId = turn.id;
			rawForeignTurnId = controlTurnId;

			if (!(await waitForModelSignal(modelObserved)))
				return rawForeignMarkerControl(
					undefined,
					"model-observation-unavailable",
				);
			// Model observation and bounded readback retries avoid treating acceptance
			// as proof that native history has already materialized the marker.
			return waitForRawForeignMarkerControl(async () => {
				const turns = await client.request("thread/read", {
					threadId: thread.id,
					includeTurns: true,
				});
				return nativeReadSample(
					"after-model-observed",
					"thread/read",
					{ includeTurns: true },
					turns,
					controlTurnId,
					foreignMarker,
				);
			});
		}
		async function sampleActiveThreadHistory() {
			if (!model || !launcher) throw new Error("No native isolation fixture");
			const controlProbe = model.probe();
			const controlHold = model.holdObservation(controlProbe);
			controlHold.allowObservation();
			controlHold.releaseResponse();
			const probe = model.probe();
			const foreignMarker = users.at(1)?.context;
			if (!foreignMarker) throw new Error("Missing foreign isolation marker");
			const hold = model.holdObservation(probe);
			const beforeRawClient = (
				await launcher.observations({ allowEmptyBeforeLaunch: true })
			).filter((entry) => entry.method === "launch").length;
			let client: RawNativeClient | undefined;
			try {
				client = await RawNativeClient.open(
					`${rawDriverPath}.native`,
					codexConversationKey({
						agentId: "agent-isolation-raw-probe",
						conversationId: "conversation-isolation-raw-probe",
						sessionGeneration: 1,
					}),
				);
				rawActiveThreadControl = await sampleRawForeignMarkerControl(
					client,
					foreignMarker,
					controlProbe.id,
					controlHold.observed,
				);
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
				rawNativeThreadIds.add(nativeThread.id);
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
				const ownerMarkers = users.map(
					() => `SYNTH_OWNER_READ_${randomUUID()}`,
				);
				const foreignMarkers = users.map(
					() => `SYNTH_FOREIGN_READ_${randomUUID()}`,
				);
				const markerAt = (markers: readonly string[], index: number) => {
					const marker = markers[index];
					if (!marker) throw new Error("Missing file-read marker");
					return marker;
				};
				const fileControls = !history
					? await pair(
							users.map((user, index) =>
								fileReadCommand({
									target: filePath(user, "private.txt"),
									search,
									outcomeMarker: markerAt(ownerMarkers, index),
								}),
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
									ownerDirectory: historyDirectory(user),
									foreignDirectory: historyDirectory(other),
								})
							: fileReadCommand({
									target: filePath(other, "private.txt"),
									search,
									outcomeMarker: markerAt(foreignMarkers, index),
								});
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
					const fileControl = fileControls?.[index];
					const control = history
						? historyEvidence?.positiveControl
						: Boolean(
								fileControl &&
									fileReadOutcome(
										fileControl.probe.outputs,
										markerAt(ownerMarkers, index),
									) === "READ" &&
									fileControl.probe.outputs.some((output) =>
										output.includes(user.file),
									) &&
									fileControl.probe.answer.includes(user.file) &&
									fileControl.events.includes(user.file),
							);
					const completeOutput =
						historyEvidence?.completeOutput ??
						completeToolOutput(result.probe.outputs);
					const fileEvidence = crossFileReadEvidence({
						foreignMarkerObserved: leaked,
						positiveControl: Boolean(control),
						outputs: result.probe.outputs,
						outcomeMarker: markerAt(foreignMarkers, index),
					});
					const scenarioStatus = historyEvidence?.status ?? fileEvidence.status;
					record(
						[name, user.id, behavior].join("."),
						scenarioStatus,
						leaked
							? preexisting
								? "foreign-marker-already-in-history"
								: "foreign-marker-reached-model-input-or-result"
							: !historyEvidence
								? fileEvidence.reason
								: historyEvidence.owner === "error" ||
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
			const foreignWriteMarkers = users.map(
				(user) =>
					`SYNTH_FOREIGN_WRITE_${user.id.toUpperCase()}_${randomUUID()}`,
			);
			for (const user of users)
				for (const file of ["owner-write.txt", "foreign-write.txt"])
					await writeFile(filePath(user, file), "SYNTH_UNCHANGED");
			await pair(
				users.map((user) =>
					foreignWriteCommand({
						mutation,
						target: filePath(user, "owner-write.txt"),
						outcomeMarker: `SYNTH_OWNER_WRITE_${user.id.toUpperCase()}`,
					}),
				),
			);
			const canWrite = await Promise.all(
				users.map(
					async (user) =>
						(await readFile(filePath(user, "owner-write.txt"), "utf8")) ===
						mutation,
				),
			);
			const foreignWrites = await pair(
				users.map((_, index) => {
					const other = users[1 - index];
					const marker = foreignWriteMarkers[index];
					if (!other) throw new Error("Missing other user");
					if (!marker) throw new Error("Missing foreign-write marker");
					return foreignWriteCommand({
						mutation,
						target: filePath(other, "foreign-write.txt"),
						outcomeMarker: marker,
					});
				}),
			);
			for (const [index, user] of users.entries()) {
				const other = users[1 - index];
				const foreignWrite = foreignWrites[index];
				const marker = foreignWriteMarkers[index];
				if (!other) throw new Error("Missing other user");
				if (!foreignWrite || !marker)
					throw new Error("Missing foreign-write evidence");
				const changed =
					(await readFile(filePath(other, "foreign-write.txt"), "utf8")) !==
					"SYNTH_UNCHANGED";
				const evidence = crossFileModifyEvidence({
					changed,
					ownerWriteSucceeded: canWrite[index] === true,
					outcomeMarker: marker,
					outputs: foreignWrite.probe.outputs,
				});
				record(
					[name, user.id, "cross-file-modify"].join("."),
					evidence.status,
					evidence.reason,
				);
			}
		}
		try {
			model = await isolationModel();
			launcher = await nativeIsolationLauncher(directory, binary, model.url);
			process.env.PATH = launcher.bin + delimiter + (originalPath ?? "");
			await sampleActiveThreadHistory();
			activeDriver = await open();
			// A Conversation's native process starts with its first Turn, so the
			// positive control runs before any launch can be observed.
			stage = "host-positive-control";
			const seeds = await pair(undefined, true);
			await resolveActorStorage();
			report.provenanceVerified = true;
			const ownedRoot = await realpath(directory);
			const temporaryRoot = await realpath(tmpdir());
			const launchConfigurations: Record<string, unknown> = {};
			const resolvedStorage = new Map<
				string,
				{ home: string; codexHome: string; cwd: string }
			>();
			for (const user of users) {
				const storage = storageOf(user);
				const resolved = {
					home: await realpath(storage.home),
					codexHome: await realpath(storage.codexHome),
					cwd: await realpath(storage.cwd),
				};
				resolvedStorage.set(user.id, resolved);
				for (const path of Object.values(resolved)) {
					if (
						!path.startsWith(`${ownedRoot}${sep}`) &&
						!(
							dirname(path) === temporaryRoot &&
							basename(path).startsWith("agent-runtime-codex-home-")
						)
					)
						throw new Error("Native directory is not synthetic");
				}
				const launchConfiguration = nativeLaunchDirectoryRelations(resolved);
				launchConfigurations[user.id] = launchConfiguration;
				if (!launchConfiguration.isolated)
					throw new Error("Native HOME, CODEX_HOME, and cwd overlap");
			}
			// Two actors must never share a native workspace or native home.
			const [first, second] = users.map((user) => {
				const resolved = resolvedStorage.get(user.id);
				if (!resolved) throw new Error("Missing native launch");
				return resolved;
			});
			if (!first || !second) throw new Error("Missing native launch");
			const disjoint = (left: string, right: string) =>
				left !== right &&
				!left.startsWith(`${right}${sep}`) &&
				!right.startsWith(`${left}${sep}`);
			const actorsDisjoint =
				disjoint(first.cwd, second.cwd) &&
				disjoint(first.codexHome, second.codexHome) &&
				disjoint(first.cwd, second.codexHome) &&
				disjoint(second.cwd, first.codexHome);
			report.launchConfiguration = {
				actors: launchConfigurations,
				actorsDisjoint,
			};
			if (!actorsDisjoint)
				throw new Error("Native actor storage is not separated");
			const memoryDisabled = users.every((user) =>
				/^memories\s+\S+\s+false$/m.test(features(storageOf(user).codexHome)),
			);
			record(
				"configuration.personal-memory",
				memoryDisabled ? "pass" : "unverified",
				memoryDisabled
					? "pinned-native-feature-disabled"
					: "enabled-or-feature-status-unavailable",
			);
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
			// The resumed Conversations reuse their durable directories, so the
			// pre-restart paths must still be the ones observed here.
			const beforeRestart = new Map(actorStorage);
			await pair(undefined, true);
			await resolveActorStorage();
			for (const user of users) {
				const before = beforeRestart.get(user.id);
				const after = actorStorage.get(user.id);
				if (
					!before ||
					!after ||
					before.cwd !== after.cwd ||
					before.codexHome !== after.codexHome
				)
					throw new Error("Resumed native storage changed");
			}
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
				const restartEvidence = nativeRestartSessionEvidence(
					observations,
					rawNativeThreadIds,
				);
				const restarted =
					observations.filter((entry) => entry.method === "launch").length ===
					2 * users.length + rawProbeLaunches;
				if (
					stage === "restart-resume" &&
					restartEvidence.status === "pass" &&
					restarted
				)
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
		const rawActiveThreadEvidence = evaluateActiveThreadEvidence(
			activeThreadReadSamples,
		);
		const activeThreadEvidence = {
			...rawActiveThreadEvidence,
			status: gateRawActiveThreadEvidence(
				rawActiveThreadEvidence,
				rawActiveThreadControl,
			),
		};
		report.activeThreadEvidence = {
			status: activeThreadEvidence.status,
			pointEvidence: activeThreadEvidence.pointEvidence,
			rawForeignMarkerControl: rawActiveThreadControl,
		};
		report.overall = isolationOverallStatus({
			activeThreadLeak: activeThreadEvidence.activeThreadLeak,
			persistenceVerified: persistenceEvidence.status === "pass",
			scenarioStatuses: [
				...Object.values(scenarios).map((row) => row.status),
				activeThreadEvidence.status,
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
