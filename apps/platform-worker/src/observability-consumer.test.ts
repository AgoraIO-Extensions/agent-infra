import { generateKeyPairSync } from "node:crypto";
import { Writable } from "node:stream";
import { startObservability } from "@agent-infra/observability";
import type {
	ConversationEventCommandV1,
	ConversationEventDecisionV1,
	ConversationEventTransactionPortV1,
	ConversationEventUseCaseV1,
	ConversationEventWritePlanV1,
} from "@agent-infra/platform-core";
import { beforeEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
	events: undefined as ConversationEventUseCaseV1 | undefined,
	persist: vi.fn(),
	closeStore: vi.fn(async () => {}),
	closeEvents: vi.fn(async () => {}),
	closeAuthorization: vi.fn(async () => {}),
	closeLegacy: vi.fn(async () => {}),
	assemblyError: undefined as Error | undefined,
}));

vi.mock("@agent-infra/platform-core", async (importOriginal) => {
	const core =
		await importOriginal<typeof import("@agent-infra/platform-core")>();
	return {
		...core,
		createConversationDispatchUseCaseV1(
			...args: Parameters<typeof core.createConversationDispatchUseCaseV1>
		) {
			boundary.events = args[0].events;
			if (boundary.assemblyError) throw boundary.assemblyError;
			return core.createConversationDispatchUseCaseV1(...args);
		},
	};
});

vi.mock("@agent-infra/platform-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("@agent-infra/platform-store")>()),
	openPostgresConversationDispatchStoreV1: () => ({
		findDispatchable: async () => [],
		close: boundary.closeStore,
	}),
	PostgresConversationEventTransactionV1: class {
		persistEvent: ConversationEventTransactionPortV1["persistEvent"] = (
			...args
		) => boundary.persist(...args);
		close = boundary.closeEvents;
	},
	PostgresTaskAuthorizationStoreV1: class {
		close = boundary.closeAuthorization;
	},
	PostgresLegacyTaskRecoveryReaderV1: class {
		close = boundary.closeLegacy;
	},
}));

import { createPlatformConversationWorkerV2 } from "./conversation-worker.js";
import { createPlatformConversationDispatchWorkerV1 } from "./index.js";

const keys = generateKeyPairSync("ed25519");
const command: ConversationEventCommandV1 = {
	schemaVersion: 1,
	conversationId: "123e4567-e89b-42d3-a456-426614174000",
	executionId: "123e4567-e89b-42d3-a456-426614174001",
	sessionGeneration: 3,
	deliveryFence: 5,
	adapterEventKey: "event-1",
	runtimeCursor: "PRIVATE_CURSOR_SENTINEL",
	occurredAt: "2026-09-29T00:00:00.000Z",
	event: { type: "text.delta", text: "PRIVATE_BODY_SENTINEL" },
};

beforeEach(() => {
	vi.clearAllMocks();
	boundary.events = undefined;
	boundary.assemblyError = undefined;
});

function assemble(
	version: "v1" | "v2",
	telemetry: ReturnType<typeof startObservability>,
) {
	if (version === "v1") {
		const worker = createPlatformConversationDispatchWorkerV1({
			databaseUrl: "postgres://fixture",
			authorization: { authorize: async () => ({ outcome: "denied" }) },
			runtimeHost: {
				baseUrl: "http://runtime.fixture.invalid",
				serviceToken: "fixture",
				fetch: async () => {
					throw new Error("Unexpected Runtime transport");
				},
			},
			telemetry,
		});
		return { close: () => worker.close() };
	}
	const worker = createPlatformConversationWorkerV2({
		databaseUrl: "postgres://fixture",
		workerId: "fixture-worker",
		signing: {
			issuer: "platform",
			workerId: "fixture-worker",
			keyId: "fixture-key",
			privateKey: keys.privateKey,
		},
		directory: { resolveUser: async () => null },
		resolveRuntimeHost: async () => {
			throw new Error("Unexpected Runtime transport");
		},
		log: () => {},
		telemetry,
	});
	return { close: () => worker.stop() };
}

it.each(["v1", "v2"] as const)(
	"%s assembly passes committed events through real Core and closes telemetry",
	async (version) => {
		const lines: string[] = [];
		const telemetry = startObservability({
			service: "platform-worker",
			output: new Writable({
				write(chunk, _encoding, done) {
					lines.push(String(chunk));
					done();
				},
			}),
		});
		const writes: ConversationEventWritePlanV1[] = [];
		let fail = false;
		const persist: ConversationEventTransactionPortV1["persistEvent"] = async (
			request,
			decide,
		) => {
			const existing = writes.find(
				(write) => write.adapterEventKey === request.command.adapterEventKey,
			);
			const latest = writes.at(-1)?.event;
			const plan = decide({
				operationHistory: [],
				conversation: {
					conversationId: command.conversationId,
					sessionGeneration: 3,
					lastConversationCursor: latest?.conversationCursor ?? 0,
				},
				execution: {
					executionId: command.executionId,
					conversationId: command.conversationId,
					sessionGeneration: 3,
					deliveryFence: 5,
					lastSequence: latest?.sequence ?? 0,
				},
				existingEvent: existing
					? { event: existing.event, eventDigest: existing.eventDigest }
					: undefined,
			});
			if ("outcome" in plan) return plan;
			if (fail) throw new Error("PRIVATE_COMMIT_SENTINEL");
			writes.push(structuredClone(plan));
			return {
				outcome: "accepted",
				event: structuredClone(plan.event),
			} satisfies ConversationEventDecisionV1;
		};
		boundary.persist.mockImplementation(persist);
		const worker = assemble(version, telemetry);
		try {
			const events = boundary.events;
			if (!events) throw new Error("Missing assembled events Port");
			const accepted = await events.persist(command);
			expect(accepted.outcome).toBe("accepted");
			expect((await events.persist(command)).outcome).toBe("replayed");
			expect(
				(
					await events.persist({
						...command,
						adapterEventKey: "stale",
						deliveryFence: 4,
					})
				).outcome,
			).toBe("stale");
			expect(writes).toHaveLength(1);
			expect(writes[0]?.runtimeCursor).toBe(command.runtimeCursor);
			expect(lines).toHaveLength(1);
			fail = true;
			await expect(
				events.persist({ ...command, adapterEventKey: "failed" }),
			).rejects.toMatchObject({ code: "unavailable" });
			expect(writes).toHaveLength(1);
			expect(lines.map((line) => JSON.parse(line).outcome)).toEqual([
				"completed",
				"failed",
			]);
			expect(lines.join("")).not.toContain("SENTINEL");
			expect(telemetry.status().enabled).toBe(false);
		} finally {
			await worker.close();
		}
		expect(telemetry.status().state).toBe("closed");
		expect(boundary.closeEvents).toHaveBeenCalledOnce();
		expect(boundary.closeStore).toHaveBeenCalledOnce();
	},
);

it.each(["v1", "v2"] as const)(
	"%s assembly preserves its error and closes the observed Port on startup failure",
	async (version) => {
		const telemetry = startObservability({
			service: "platform-worker",
			output: new Writable({
				write(_chunk, _encoding, done) {
					done();
				},
			}),
		});
		const error = new Error("PRIVATE_ASSEMBLY_SENTINEL");
		boundary.assemblyError = error;
		expect(() => assemble(version, telemetry)).toThrow(error);
		await vi.waitFor(() => {
			expect(telemetry.status().state).toBe("closed");
			expect(boundary.closeEvents).toHaveBeenCalledOnce();
			expect(boundary.closeStore).toHaveBeenCalledOnce();
		});
	},
);
