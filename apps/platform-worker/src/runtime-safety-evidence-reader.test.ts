import {
	RuntimePersistedSafetyEvidenceV1Schema,
	type RuntimeSafetyEvidenceWindowV1,
	runtimeSafetyEvidencePrincipalRefV1,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeSafetyEvidenceReaderV1,
	type RuntimeSafetyEvidenceDrainV1,
	type RuntimeSafetyEvidenceOriginalFactsV1,
} from "./runtime-safety-evidence-reader.js";
import {
	readWorkerRuntimeSafetyEvidenceWindowV1,
	workerRuntimeSafetyEvidenceWindowEnvironmentV1,
} from "./runtime-safety-evidence-window.js";

const podUid = "11111111-2222-4333-8444-555555555555";
const principal = { kind: "user" as const, id: "user-1" };
const principalRef = await runtimeSafetyEvidencePrincipalRefV1(principal);

const window: RuntimeSafetyEvidenceWindowV1 = {
	schemaVersion: 1,
	windowRef: "window-1",
	opensAt: "2026-11-22T00:00:00.000Z",
	closesAt: "2026-11-22T02:00:00.000Z",
	agentIds: ["agent-1"],
	principalRefs: [principalRef],
	scenarios: [
		{
			id: "u1-file",
			version: 1,
			resourceClasses: ["file"],
			actionClasses: ["read"],
		},
	],
	producers: [{ kind: "native_helper", version: "u1-helper-1" }],
};

const drain: RuntimeSafetyEvidenceDrainV1 = {
	baseUrl: "http://runtime-session.agents.svc:3003",
	serviceToken: "synthetic-sandbox-token",
	traceId: "trace-1",
	claim: {
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		sessionGeneration: 2,
		executionDeliveryFence: 3,
		authorizationRevision: "identity-8",
	},
	sandboxResource: {
		sandbox: {
			schemaVersion: 1,
			sandboxId: "sandbox-1",
			sessionId: "conversation-1",
			agentId: "agent-1",
			principal,
			channelId: "web",
			generation: 2,
			resourceName: "sandbox-sandbox-1",
			workspaceScope: "sandbox-1",
		},
		resourceFence: 4,
		desiredState: "running",
		status: "ready",
		policy: {
			configurationRevision: 7,
			workloadRevision: 1,
			managementFence: 1,
			imageDigest: `sha256:${"a".repeat(64)}`,
		} as never,
		observation: {
			status: "ready",
			resources: [
				{
					kind: "Pod",
					namespace: "agents",
					name: "sandbox-sandbox-1-0",
					uid: podUid,
					resourceVersion: "1",
				},
			],
		},
	},
};

let next = 0;
function record(change: (value: Record<string, any>) => void = () => {}) {
	next++;
	const value: Record<string, any> = {
		schemaVersion: 1,
		code: "RUNTIME_ISOLATION_EVIDENCE_V1",
		kind: "isolation_observation",
		binding: {
			evidenceId: `evidence-${next}`,
			scenario: { id: "u1-file", version: 1 },
			windowRef: "window-1",
			challengeRef: `challenge-${next}`,
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			operation: { ref: "operation-1", attemptRef: "attempt-1" },
			principalRef,
			purposeRef: "business",
			authorization: { recordId: "auth-1", revision: "identity-8" },
			sessionGeneration: 2,
			executionDeliveryFence: 3,
			sandbox: { ref: "sandbox-1", podUid, resourceFence: 4 },
			host: {
				instanceRef: "host-1",
				startRef: "start-1",
				configurationRevision: "7",
				imageDigest: `sha256:${"a".repeat(64)}`,
			},
			producer: { kind: "native_helper", version: "u1-helper-1" },
			observedAt: "2026-11-22T00:30:00.000Z",
			clockId: "clock-1",
			sequence: next,
		},
		resourceClass: "file",
		actionClass: "read",
		targetScope: "foreign",
		resultClass: "denied",
		nativeObserved: true,
		failureClass: "permission_denied",
	};
	change(value);
	return value;
}

/** In-memory Host evidence log with the wire of `/internal/runtime/v1/safety-evidence/*`. */
function host(initial: unknown[] = []) {
	let acknowledged = 0;
	let sequence = 0;
	const entries: { sequence: number; record: unknown }[] = [];
	const append = (value: unknown) => {
		sequence++;
		entries.push({ sequence, record: value });
	};
	for (const value of initial) append(value);
	let failAck = false;
	let unavailable = false;
	const calls: { path: string; authorization: string | null; body: any }[] = [];
	const fetcher = vi.fn<typeof fetch>(async (url, init) => {
		const path = new URL(String(url)).pathname;
		const body = JSON.parse(String(init?.body));
		calls.push({
			path: `${new URL(String(url)).origin}${path}`,
			authorization: new Headers(init?.headers).get("authorization"),
			body,
		});
		const error = (status: number, code: string) =>
			Response.json(
				{
					schemaVersion: 1,
					code,
					message: code,
					retryable: true,
					traceId: "t",
				},
				{ status },
			);
		if (unavailable) return error(404, "NOT_FOUND");
		if (path.endsWith("/safety-evidence/read"))
			return Response.json({
				schemaVersion: 1,
				entries: entries
					.filter((entry) => entry.sequence > acknowledged)
					.slice(0, body.limit)
					.map((entry) => ({
						cursor: `se1-${entry.sequence}`,
						record: entry.record,
					})),
			});
		if (path.endsWith("/safety-evidence/ack")) {
			if (failAck) return error(503, "RUNTIME_SAFETY_EVIDENCE_UNAVAILABLE");
			acknowledged = Number(String(body.cursor).slice(4));
			return Response.json({ schemaVersion: 1, acknowledged: body.cursor });
		}
		return error(404, "NOT_FOUND");
	});
	return {
		fetcher,
		calls,
		append,
		pending: () => entries.filter((entry) => entry.sequence > acknowledged),
		failAck: (value: boolean) => {
			failAck = value;
		},
		unavailable: (value: boolean) => {
			unavailable = value;
		},
	};
}

function store() {
	const records = new Map<string, string>();
	const challenges = new Set<string>();
	let failing = false;
	return {
		records,
		fail: (value: boolean) => {
			failing = value;
		},
		recordOnce: vi.fn(
			async (value: {
				binding: Record<string, any>;
			}): Promise<
				| "recorded"
				| "duplicate"
				| "challenge_replay"
				| "evidence_conflict"
				| "revoked"
				| "stale_binding"
				| "scope_mismatch"
			> => {
				if (failing) throw new Error("store down");
				const parsed = RuntimePersistedSafetyEvidenceV1Schema.parse(value);
				const text = JSON.stringify(parsed);
				const existing = records.get(parsed.binding.evidenceId);
				if (existing)
					return existing === text ? "duplicate" : "evidence_conflict";
				if (challenges.has(parsed.binding.challengeRef))
					return "challenge_replay";
				records.set(parsed.binding.evidenceId, text);
				challenges.add(parsed.binding.challengeRef);
				return "recorded";
			},
		),
		/** Committed original binding of each Execution of the Session. */
		readOriginalScope: vi.fn(
			async (input: { conversationId: string; executionId: string }) =>
				input.conversationId === "conversation-1"
					? originalFacts[input.executionId]
					: undefined,
		),
	};
}

const originalFacts: Record<string, RuntimeSafetyEvidenceOriginalFactsV1> = {
	"execution-1": {
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-1",
		principal,
		authorizationRecordId: "auth-1",
		authorizationRevision: "identity-8",
		revoked: false,
		sessionGeneration: 2,
		executionDeliveryFence: 3,
		sandbox: {
			ref: "sandbox-1",
			resourceFence: 4,
			podUid,
			configurationRevision: 7,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
		operations: [{ ref: "operation-1", attemptRef: "attempt-1" }],
	},
	"execution-2": {
		agentId: "agent-1",
		conversationId: "conversation-1",
		executionId: "execution-2",
		principal,
		authorizationRecordId: "auth-2",
		authorizationRevision: "identity-8",
		revoked: false,
		sessionGeneration: 2,
		executionDeliveryFence: 5,
		sandbox: {
			ref: "sandbox-1",
			resourceFence: 4,
			podUid,
			configurationRevision: 7,
			imageDigest: `sha256:${"a".repeat(64)}`,
		},
		operations: [{ ref: "operation-2", attemptRef: "attempt-2" }],
	},
};

/** A record of the second Execution of the same Session. */
const secondExecution = (value: Record<string, any>) => {
	value.binding.executionId = "execution-2";
	value.binding.authorization = { recordId: "auth-2", revision: "identity-8" };
	value.binding.executionDeliveryFence = 5;
	value.binding.operation = { ref: "operation-2", attemptRef: "attempt-2" };
};
const drainOf = (executionId: "execution-1" | "execution-2") =>
	executionId === "execution-1"
		? drain
		: {
				...drain,
				claim: {
					...drain.claim,
					executionId,
					executionDeliveryFence: 5,
				},
			};

const now = () => new Date("2026-11-22T00:40:00.000Z");

describe("Worker evidence reader (Spec §18.5.1, HLD §8.5.6 step 4)", () => {
	it("stores an in-scope record and confirms the cursor only after the commit", async () => {
		const h = host([record()]);
		const s = store();
		const order: string[] = [];
		s.recordOnce.mockImplementationOnce(async (value) => {
			order.push("commit");
			s.records.set(value.binding.evidenceId, "stored");
			return "recorded";
		});
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: (async (url, init) => {
				if (String(url).endsWith("/ack")) order.push("ack");
				return h.fetcher(url, init);
			}) as typeof fetch,
			now,
		});
		expect(await reader.drain(drain)).toEqual({
			status: "drained",
			recorded: 1,
			duplicates: 0,
			rejected: 0,
		});
		expect(order).toEqual(["commit", "ack"]);
		expect(h.pending()).toEqual([]);
		// The read used the resolved Session route and its sandbox-bound token.
		expect(h.calls[0]).toMatchObject({
			path: "http://runtime-session.agents.svc:3003/internal/runtime/v1/safety-evidence/read",
			authorization: "Bearer synthetic-sandbox-token",
			body: {
				schemaVersion: 1,
				capability: "runtime-safety-evidence-v1",
				after: null,
			},
		});
		await reader.close();
	});

	it("keeps the Host entries when the store fails and stores them once after it recovers", async () => {
		const h = host([record(), record()]);
		const s = store();
		s.fail(true);
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		expect((await reader.drain(drain)).status).toBe("store_unavailable");
		expect(h.pending()).toHaveLength(2);
		expect(h.calls.some((call) => call.path.endsWith("/ack"))).toBe(false);
		s.fail(false);
		expect(await reader.drain(drain)).toMatchObject({
			status: "drained",
			recorded: 2,
		});
		expect(s.records.size).toBe(2);
		expect(h.pending()).toEqual([]);
	});

	it("rereads after a lost ACK or a restart without duplicating stored evidence", async () => {
		const h = host([record()]);
		const s = store();
		h.failAck(true);
		const first = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		expect(await first.drain(drain)).toMatchObject({
			status: "host_unavailable",
			recorded: 1,
		});
		await first.close();
		h.failAck(false);
		// A new reader (a restarted Worker) reads the same unconfirmed entry again.
		const restarted = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		expect(await restarted.drain(drain)).toMatchObject({
			status: "drained",
			recorded: 0,
			duplicates: 1,
		});
		expect(s.records.size).toBe(1);
		expect(h.pending()).toEqual([]);
	});

	it.each([
		[
			"another subject",
			(v: Record<string, any>) => {
				v.binding.principalRef = "p1-other";
			},
		],
		[
			"another Agent",
			(v: Record<string, any>) => {
				v.binding.agentId = "agent-2";
			},
		],
		[
			"another operation",
			(v: Record<string, any>) => {
				v.binding.operation.ref = "operation-2";
			},
		],
		[
			"another attempt",
			(v: Record<string, any>) => {
				v.binding.operation.attemptRef = "attempt-2";
			},
		],
		[
			"an older delivery fence",
			(v: Record<string, any>) => {
				v.binding.executionDeliveryFence = 2;
			},
		],
		[
			"an older session generation",
			(v: Record<string, any>) => {
				v.binding.sessionGeneration = 1;
			},
		],
		[
			"a changed Pod UID",
			(v: Record<string, any>) => {
				v.binding.sandbox.podUid = "99999999-2222-4333-8444-555555555555";
			},
		],
		[
			"another Host image",
			(v: Record<string, any>) => {
				v.binding.host.imageDigest = `sha256:${"b".repeat(64)}`;
			},
		],
		[
			"another authorization revision",
			(v: Record<string, any>) => {
				v.binding.authorization.revision = "identity-7";
			},
		],
		[
			"an observation outside the window",
			(v: Record<string, any>) => {
				v.binding.observedAt = "2026-11-21T23:00:00.000Z";
			},
		],
	])("refuses %s without blocking the log", async (_name, change) => {
		const h = host([record(change), record()]);
		const s = store();
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		expect(await reader.drain(drain)).toEqual({
			status: "drained",
			recorded: 1,
			duplicates: 0,
			rejected: 1,
		});
		expect(s.records.size).toBe(1);
		expect(h.pending()).toEqual([]);
	});

	it("acknowledges a record the store refused after the scope was read (#4358 S1)", async () => {
		const h = host([record()]);
		const s = store();
		s.recordOnce.mockResolvedValueOnce("stale_binding");
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		expect(await reader.drain(drain)).toEqual({
			status: "drained",
			recorded: 0,
			duplicates: 0,
			rejected: 1,
		});
		expect(s.records.size).toBe(0);
		expect(h.pending()).toEqual([]);
	});

	it("stores another Execution's record of the same Session under its own original scope (#4367 MUST 1)", async () => {
		const h = host([record(secondExecution)]);
		const s = store();
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		// The drain was triggered by the first Execution's business ACK.
		expect(await reader.drain(drainOf("execution-1"))).toEqual({
			status: "drained",
			recorded: 1,
			duplicates: 0,
			rejected: 0,
		});
		expect(s.records.size).toBe(1);
		expect(h.pending()).toEqual([]);
	});

	it("keeps the last record of an Execution whose drain was skipped until a later drain stores it (#4367 MUST 1)", async () => {
		const h = host([]);
		const s = store();
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		reader.afterAcknowledge(drainOf("execution-1"));
		await reader.settled();
		h.append(record());
		// Its terminal ACK falls inside the interval; the next drain comes from Execution 2.
		reader.afterAcknowledge(drainOf("execution-1"));
		expect(await reader.drain(drainOf("execution-2"))).toMatchObject({
			recorded: 1,
			rejected: 0,
		});
		expect(s.records.size).toBe(1);
		expect(h.pending()).toEqual([]);
		await reader.close();
	});

	it("runs a trailing drain for an ACK that arrived during the interval", async () => {
		const h = host([]);
		const s = store();
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
			intervalMs: 20,
		});
		reader.afterAcknowledge(drainOf("execution-1"));
		await reader.settled();
		h.append(record());
		reader.afterAcknowledge(drainOf("execution-1"));
		await vi.waitFor(async () => {
			await reader.settled();
			expect(s.records.size).toBe(1);
		});
		expect(h.pending()).toEqual([]);
		await reader.close();
	});

	it.each([
		[
			"an Execution without a committed original binding",
			(v: Record<string, any>) => {
				v.binding.executionId = "execution-9";
			},
		],
		[
			"another Conversation",
			(v: Record<string, any>) => {
				v.binding.conversationId = "conversation-2";
			},
		],
		[
			"another Sandbox",
			(v: Record<string, any>) => {
				v.binding.sandbox.ref = "sandbox-2";
			},
		],
	])(
		"stops before a record of %s and confirms nothing (#4367 MUST 1)",
		async (_name, change) => {
			const h = host([record(change), record()]);
			const s = store();
			const reader = createRuntimeSafetyEvidenceReaderV1({
				window,
				store: s,
				fetch: h.fetcher,
				now,
			});
			expect(await reader.drain(drain)).toEqual({
				status: "unresolved",
				recorded: 0,
				duplicates: 0,
				rejected: 0,
			});
			expect(s.records.size).toBe(0);
			expect(h.pending()).toHaveLength(2);
			expect(h.calls.some((call) => call.path.endsWith("/ack"))).toBe(false);
		},
	);

	it("refuses evidence of a subject revoked in the committed binding", async () => {
		const h = host([record()]);
		const s = store();
		s.readOriginalScope.mockResolvedValueOnce({
			...originalFacts["execution-1"],
			revoked: true,
		} as RuntimeSafetyEvidenceOriginalFactsV1);
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		expect(await reader.drain(drain)).toMatchObject({
			recorded: 0,
			rejected: 1,
		});
		expect(h.pending()).toEqual([]);
	});

	it("stops before a record it does not understand and never drops it", async () => {
		const unknown = { ...record(), kind: "original_admission_check" };
		const h = host([unknown]);
		const s = store();
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: s,
			fetch: h.fetcher,
			now,
		});
		expect((await reader.drain(drain)).status).toBe("unsupported");
		expect(h.pending()).toHaveLength(1);
		h.append(record());
		expect((await reader.drain(drain)).status).toBe("unsupported");
		expect(h.pending()).toHaveLength(2);
	});

	it("treats a Host without the window as unavailable evidence, never as an error", async () => {
		const h = host([record()]);
		h.unavailable(true);
		const observed: unknown[] = [];
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: store(),
			fetch: h.fetcher,
			now,
			intervalMs: 0,
			observe: (outcome) => observed.push(outcome),
		});
		expect((await reader.drain(drain)).status).toBe("host_unavailable");
		expect(() => reader.afterAcknowledge(drain)).not.toThrow();
		await reader.settled();
		await reader.close();
		expect(observed).toEqual([
			{ status: "host_unavailable", recorded: 0, duplicates: 0, rejected: 0 },
		]);
	});

	it("runs one background drain per route and swallows every failure", async () => {
		const h = host([record()]);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetcher = vi.fn<typeof fetch>(async (url, init) => {
			await gate;
			return h.fetcher(url, init);
		});
		const observed: { status: string }[] = [];
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: store(),
			fetch: fetcher,
			now,
			intervalMs: 0,
			observe: (outcome) => observed.push(outcome),
		});
		// Two Executions of the same Session route: one drain at a time, later ACKs coalesce
		// into a single trailing drain.
		reader.afterAcknowledge(drain);
		reader.afterAcknowledge(drain);
		reader.afterAcknowledge({
			...drain,
			claim: { ...drain.claim, executionId: "execution-2" },
		});
		release();
		await vi.waitFor(() => expect(observed).toHaveLength(2));
		await reader.settled();
		expect(observed).toEqual([
			{ status: "drained", recorded: 1, duplicates: 0, rejected: 0 },
			{ status: "drained", recorded: 0, duplicates: 0, rejected: 0 },
		]);
		expect(
			fetcher.mock.calls.filter(([url]) => String(url).endsWith("/read")),
		).toHaveLength(2);
		await reader.close();
		const throwing = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: store(),
			fetch: (() => {
				throw new Error("synchronous failure");
			}) as unknown as typeof fetch,
			now,
		});
		expect(() => throwing.afterAcknowledge(drain)).not.toThrow();
		await throwing.close();
	});

	it("reports only fixed codes and counts", async () => {
		const canary = "canary-evidence-4a1c";
		const h = host([
			record((v) => {
				v.binding.evidenceId = canary;
			}),
		]);
		const observed: unknown[] = [];
		const reader = createRuntimeSafetyEvidenceReaderV1({
			window,
			store: store(),
			fetch: h.fetcher,
			now,
			intervalMs: 0,
			observe: (outcome) => observed.push(outcome),
		});
		reader.afterAcknowledge(drain);
		await reader.settled();
		await reader.close();
		expect(JSON.stringify(observed)).not.toContain(canary);
		expect(observed).toEqual([
			{ status: "drained", recorded: 1, duplicates: 0, rejected: 0 },
		]);
	});
});

describe("Worker window configuration", () => {
	it("is off by default and refuses an invalid document", () => {
		expect(readWorkerRuntimeSafetyEvidenceWindowV1({})).toEqual({
			status: "disabled",
		});
		expect(
			readWorkerRuntimeSafetyEvidenceWindowV1({
				[workerRuntimeSafetyEvidenceWindowEnvironmentV1]: "{",
			}),
		).toEqual({ status: "invalid" });
		expect(
			readWorkerRuntimeSafetyEvidenceWindowV1({
				[workerRuntimeSafetyEvidenceWindowEnvironmentV1]:
					JSON.stringify(window),
			}),
		).toMatchObject({ status: "enabled" });
	});
});
