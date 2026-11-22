import {
	type RuntimeIsolationEvidenceV1,
	RuntimePersistedSafetyEvidenceV1Schema,
} from "@agent-infra/contracts/runtime";
import { describe, expect, it } from "vitest";

import {
	admitIsolationEvidenceV1,
	ingestRuntimeSafetyEvidenceBatchV1,
	type RuntimeSafetyEvidenceScopeV1,
	RuntimeSafetyEvidenceUnsupportedErrorV1,
	type RuntimeSafetyEvidenceWindowV1,
	runtimeSafetyEvidenceReadAuditV1,
} from "./runtime-safety-evidence.js";

const podUid = "11111111-2222-4333-8444-555555555555";
const now = new Date("2026-11-22T00:10:00.000Z");

const record = (change: (value: Record<string, any>) => void = () => {}) => {
	const value: Record<string, any> = {
		schemaVersion: 1,
		code: "RUNTIME_ISOLATION_EVIDENCE_V1",
		kind: "isolation_observation",
		binding: {
			evidenceId: "evidence-1",
			scenario: { id: "u1-file", version: 1 },
			windowRef: "window-1",
			challengeRef: "challenge-1",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			operation: { ref: "operation-1", attemptRef: "attempt-1" },
			principalRef: "principal-1",
			purposeRef: "purpose-business",
			sessionGeneration: 2,
			executionDeliveryFence: 3,
			sandbox: { ref: "sandbox-1", podUid, resourceFence: 4 },
			host: {
				instanceRef: "host-1",
				startRef: "start-1",
				configurationRevision: "config-1",
				imageDigest: `sha256:${"a".repeat(64)}`,
			},
			producer: { kind: "native_helper", version: "u1-helper-1" },
			observedAt: "2026-11-22T00:05:00.000Z",
			clockId: "clock-1",
			sequence: 1,
		},
		resourceClass: "file",
		actionClass: "read",
		targetScope: "foreign",
		resultClass: "denied",
		nativeObserved: true,
		failureClass: "permission_denied",
	};
	change(value);
	return RuntimePersistedSafetyEvidenceV1Schema.parse(value);
};

const window: RuntimeSafetyEvidenceWindowV1 = {
	windowRef: "window-1",
	opensAt: "2026-11-22T00:00:00.000Z",
	closesAt: "2026-11-22T01:00:00.000Z",
	agentIds: ["agent-1"],
	principalRefs: ["principal-1"],
	scenarios: [
		{
			id: "u1-file",
			version: 1,
			resourceClasses: ["file", "workspace", "memory_file"],
			actionClasses: ["read", "write"],
		},
	],
	producers: [{ kind: "native_helper", version: "u1-helper-1" }],
};

const scope = (
	change: Partial<RuntimeSafetyEvidenceScopeV1> = {},
): RuntimeSafetyEvidenceScopeV1 => ({
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	principalRef: "principal-1",
	purposeRef: "purpose-business",
	sessionGeneration: 2,
	executionDeliveryFence: 3,
	operations: [{ ref: "operation-1", attemptRef: "attempt-1" }],
	sandbox: { ref: "sandbox-1", podUid, resourceFence: 4 },
	host: {
		instanceRef: "host-1",
		startRef: "start-1",
		configurationRevision: "config-1",
		imageDigest: `sha256:${"a".repeat(64)}`,
	},
	revoked: false,
	...change,
});

const admit = (
	value: RuntimeIsolationEvidenceV1,
	options: {
		window?: RuntimeSafetyEvidenceWindowV1 | undefined;
		scope?: RuntimeSafetyEvidenceScopeV1 | undefined;
	} = {},
) =>
	admitIsolationEvidenceV1({
		record: value,
		window: "window" in options ? options.window : window,
		scope: "scope" in options ? options.scope : scope(),
		now,
	});

describe("isolation evidence admission (Spec §18.5.1 共同绑定)", () => {
	it("accepts a record bound to the original window, scenario, producer and execution", () => {
		expect(admit(record())).toEqual({ accepted: true });
	});

	it.each([
		[
			"another subject",
			(v: Record<string, any>) => {
				v.binding.principalRef = "principal-2";
			},
			"out_of_window_scope",
		],
		[
			"another Agent",
			(v: Record<string, any>) => {
				v.binding.agentId = "agent-2";
			},
			"out_of_window_scope",
		],
		[
			"another Conversation",
			(v: Record<string, any>) => {
				v.binding.conversationId = "conversation-2";
			},
			"scope_mismatch",
		],
		[
			"another Execution",
			(v: Record<string, any>) => {
				v.binding.executionId = "execution-2";
			},
			"scope_mismatch",
		],
		[
			"another operation",
			(v: Record<string, any>) => {
				v.binding.operation.ref = "operation-2";
			},
			"scope_mismatch",
		],
		[
			"another attempt",
			(v: Record<string, any>) => {
				v.binding.operation.attemptRef = "attempt-2";
			},
			"scope_mismatch",
		],
		[
			"another purpose",
			(v: Record<string, any>) => {
				v.binding.purposeRef = "purpose-eval";
			},
			"scope_mismatch",
		],
		[
			"an authorization revision the scope does not have",
			(v: Record<string, any>) => {
				v.binding.authorization = {
					recordId: "auth-1",
					revision: "identity-1",
				};
			},
			"scope_mismatch",
		],
		[
			"a same-name Pod with another UID",
			(v: Record<string, any>) => {
				v.binding.sandbox.podUid = "99999999-2222-4333-8444-555555555555";
			},
			"stale_binding",
		],
		[
			"an older session generation",
			(v: Record<string, any>) => {
				v.binding.sessionGeneration = 1;
			},
			"stale_binding",
		],
		[
			"an older delivery fence",
			(v: Record<string, any>) => {
				v.binding.executionDeliveryFence = 2;
			},
			"stale_binding",
		],
		[
			"an older resource fence",
			(v: Record<string, any>) => {
				v.binding.sandbox.resourceFence = 3;
			},
			"stale_binding",
		],
		[
			"an executor epoch the Sandbox never had",
			(v: Record<string, any>) => {
				v.binding.sandbox.executorEpoch = "epoch-1";
			},
			"stale_binding",
		],
		[
			"a restarted Host",
			(v: Record<string, any>) => {
				v.binding.host.startRef = "start-2";
			},
			"stale_binding",
		],
		[
			"a Host configuration revision the execution was not bound to",
			(v: Record<string, any>) => {
				v.binding.host.configurationRevision = "config-2";
			},
			"stale_binding",
		],
		[
			"a Host image the execution was not bound to",
			(v: Record<string, any>) => {
				v.binding.host.imageDigest = `sha256:${"b".repeat(64)}`;
			},
			"stale_binding",
		],
		[
			"an observation before the window opened",
			(v: Record<string, any>) => {
				v.binding.observedAt = "2026-11-21T23:59:59.000Z";
			},
			"window_closed",
		],
		[
			"a future observation",
			(v: Record<string, any>) => {
				v.binding.observedAt = "2026-11-22T00:11:00.000Z";
			},
			"future_observation",
		],
		[
			"another window",
			(v: Record<string, any>) => {
				v.binding.windowRef = "window-2";
			},
			"window_closed",
		],
		[
			"a scenario version outside the window",
			(v: Record<string, any>) => {
				v.binding.scenario.version = 2;
			},
			"scenario_mismatch",
		],
		[
			"a resource the scenario does not cover",
			(v: Record<string, any>) => {
				v.resourceClass = "env";
			},
			"scenario_mismatch",
		],
		[
			"an unreviewed producer version",
			(v: Record<string, any>) => {
				v.binding.producer.version = "u1-helper-2";
			},
			"producer_unknown",
		],
	])("rejects %s", (_name, change, reason) => {
		expect(admit(record(change))).toEqual({ accepted: false, reason });
	});

	it("rejects without a window, without a resolvable scope, and after the permission was revoked", () => {
		expect(admit(record(), { window: undefined })).toEqual({
			accepted: false,
			reason: "window_closed",
		});
		expect(admit(record(), { scope: undefined })).toEqual({
			accepted: false,
			reason: "scope_mismatch",
		});
		expect(admit(record(), { scope: scope({ revoked: true }) })).toEqual({
			accepted: false,
			reason: "revoked",
		});
		expect(
			admit(record(), {
				window: { ...window, closesAt: "2026-11-22T00:04:59.000Z" },
			}),
		).toEqual({ accepted: false, reason: "window_closed" });
	});
});

describe("evidence log ingestion (Spec §18.5.1 载体与版本)", () => {
	const parse = (value: unknown) => {
		const result = RuntimePersistedSafetyEvidenceV1Schema.safeParse(value);
		return result.success ? result.data : undefined;
	};
	const memory = () => {
		const stored = new Map<string, string>();
		return {
			stored,
			store: {
				async recordOnce(value: RuntimeIsolationEvidenceV1) {
					const text = JSON.stringify(value);
					const existing = stored.get(value.binding.evidenceId);
					if (existing === undefined) {
						stored.set(value.binding.evidenceId, text);
						return "recorded" as const;
					}
					if (existing !== text) return "evidence_conflict" as const;
					return "duplicate" as const;
				},
			},
		};
	};

	it("stores admitted records, acknowledges rejected ones without storing, and returns duplicates", async () => {
		const { stored, store } = memory();
		const foreign = record((v) => {
			v.binding.evidenceId = "evidence-2";
			v.binding.challengeRef = "challenge-2";
			v.binding.principalRef = "principal-2";
		});
		const result = await ingestRuntimeSafetyEvidenceBatchV1({
			entries: [
				{ cursor: "c1", record: record() },
				{ cursor: "c2", record: foreign },
				{ cursor: "c3", record: record() },
			],
			parse,
			window,
			resolveScope: async () => scope(),
			store,
			now: () => now,
		});
		expect(result).toEqual({
			ackCursor: "c3",
			recorded: 1,
			duplicates: 1,
			rejected: [{ cursor: "c2", reason: "out_of_window_scope" }],
		});
		expect([...stored.keys()]).toEqual(["evidence-1"]);
	});

	it("stops before a record whose own scope cannot be resolved and confirms nothing after it (#4367)", async () => {
		const { stored, store } = memory();
		const outside = record((v) => {
			v.binding.evidenceId = "evidence-0";
			v.binding.challengeRef = "challenge-0";
			v.binding.agentId = "agent-2";
		});
		const unresolved = record((v) => {
			v.binding.evidenceId = "evidence-2";
			v.binding.challengeRef = "challenge-2";
			v.binding.executionId = "execution-2";
		});
		const result = await ingestRuntimeSafetyEvidenceBatchV1({
			entries: [
				{ cursor: "c0", record: outside },
				{ cursor: "c1", record: record() },
				{ cursor: "c2", record: unresolved },
				{ cursor: "c3", record: record() },
			],
			parse,
			window,
			resolveScope: async (value) =>
				value.binding.executionId === "execution-1" ? scope() : undefined,
			store,
			now: () => now,
		});
		expect(result).toEqual({
			ackCursor: "c1",
			recorded: 1,
			duplicates: 0,
			rejected: [{ cursor: "c0", reason: "out_of_window_scope" }],
			stopped: "unresolved",
		});
		expect([...stored.keys()]).toEqual(["evidence-1"]);
	});

	it("acknowledges a record the store refused because the original binding changed in between (#4358 S1)", async () => {
		for (const reason of [
			"revoked",
			"stale_binding",
			"scope_mismatch",
		] as const) {
			const result = await ingestRuntimeSafetyEvidenceBatchV1({
				entries: [{ cursor: "c1", record: record() }],
				parse,
				window,
				resolveScope: async () => scope(),
				store: { recordOnce: async () => reason },
				now: () => now,
			});
			expect(result).toEqual({
				ackCursor: "c1",
				recorded: 0,
				duplicates: 0,
				rejected: [{ cursor: "c1", reason }],
			});
		}
	});

	it("acknowledges a challenge replay or a conflicting record under an existing ID without storing it", async () => {
		const result = await ingestRuntimeSafetyEvidenceBatchV1({
			entries: [
				{ cursor: "c1", record: record() },
				{ cursor: "c2", record: record() },
			],
			parse,
			window,
			resolveScope: async () => scope(),
			store: {
				recordOnce: async () => "challenge_replay" as const,
			},
			now: () => now,
		});
		expect(result.ackCursor).toBe("c2");
		expect(result.rejected).toEqual([
			{ cursor: "c1", reason: "challenge_replay" },
			{ cursor: "c2", reason: "challenge_replay" },
		]);
		const { store } = memory();
		await store.recordOnce(record());
		const conflict = await ingestRuntimeSafetyEvidenceBatchV1({
			entries: [
				{
					cursor: "c3",
					record: record((v) => {
						v.failureClass = "policy_denied";
					}),
				},
			],
			parse,
			window,
			resolveScope: async () => scope(),
			store,
			now: () => now,
		});
		expect(conflict.rejected).toEqual([
			{ cursor: "c3", reason: "evidence_conflict" },
		]);
	});

	it("stops before an unknown kind instead of dropping it", async () => {
		const { stored, store } = memory();
		const unknown = { ...record(), kind: "original_admission_check" };
		await expect(
			ingestRuntimeSafetyEvidenceBatchV1({
				entries: [{ cursor: "c1", record: unknown }],
				parse,
				window,
				resolveScope: async () => scope(),
				store,
				now: () => now,
			}),
		).rejects.toBeInstanceOf(RuntimeSafetyEvidenceUnsupportedErrorV1);
		const partial = await ingestRuntimeSafetyEvidenceBatchV1({
			entries: [
				{ cursor: "c1", record: record() },
				{ cursor: "c2", record: unknown },
				{
					cursor: "c3",
					record: record((v) => {
						v.binding.evidenceId = "evidence-3";
						v.binding.challengeRef = "challenge-3";
					}),
				},
			],
			parse,
			window,
			resolveScope: async () => scope(),
			store,
			now: () => now,
		});
		expect(partial.ackCursor).toBe("c1");
		expect([...stored.keys()]).toEqual(["evidence-1"]);
	});

	it("does not advance the cursor when storing fails, so the Host keeps the entry", async () => {
		await expect(
			ingestRuntimeSafetyEvidenceBatchV1({
				entries: [{ cursor: "c1", record: record() }],
				parse,
				window,
				resolveScope: async () => scope(),
				store: {
					recordOnce: async () => {
						throw new Error("database unavailable");
					},
				},
				now: () => now,
			}),
		).rejects.toThrow("database unavailable");
	});

	it("rejects a record whose original scope changed while it was in flight", async () => {
		const { stored, store } = memory();
		const result = await ingestRuntimeSafetyEvidenceBatchV1({
			entries: [{ cursor: "c1", record: record() }],
			parse,
			window,
			resolveScope: async () => scope({ sessionGeneration: 3 }),
			store,
			now: () => now,
		});
		expect(result.rejected).toEqual([
			{ cursor: "c1", reason: "stale_binding" },
		]);
		expect(stored.size).toBe(0);
	});
});

describe("evidence read audit event (Spec §18.3, §18.5.1)", () => {
	const base = {
		traceId: "trace-1",
		requestId: "request-1",
		principal: { kind: "user" as const, id: "user-1" },
	};

	it("records the confirmed original scope only on success", () => {
		expect(
			runtimeSafetyEvidenceReadAuditV1({
				...base,
				outcome: "succeeded",
				target: {
					evidenceRef: "evidence-1",
					agentId: "agent-1",
					conversationId: "conversation-1",
					executionId: "execution-1",
				},
			}),
		).toEqual({
			action: "runtime_evidence.read",
			...base,
			outcome: "succeeded",
			target: {
				evidenceRef: "evidence-1",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "execution-1",
			},
		});
		expect(
			runtimeSafetyEvidenceReadAuditV1({ ...base, outcome: "rejected" }),
		).toEqual({
			action: "runtime_evidence.read",
			...base,
			outcome: "rejected",
			target: null,
			reason: "RESOURCE_UNAVAILABLE",
		});
		expect(
			runtimeSafetyEvidenceReadAuditV1({ ...base, outcome: "failed" }),
		).toMatchObject({ target: null, reason: "DEPENDENCY_UNAVAILABLE" });
	});

	it("refuses a success without a confirmed target and an untrusted principal", () => {
		expect(() =>
			runtimeSafetyEvidenceReadAuditV1({
				...base,
				outcome: "succeeded",
			} as never),
		).toThrow(TypeError);
		expect(() =>
			runtimeSafetyEvidenceReadAuditV1({
				...base,
				principal: { kind: "owner", id: "user-1" } as never,
				outcome: "rejected",
			}),
		).toThrow(TypeError);
	});
});
