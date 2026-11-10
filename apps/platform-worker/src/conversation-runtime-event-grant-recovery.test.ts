import { createRuntimeExecutionGrantVerifierV2 } from "@agent-infra/agent-runtime";
import { validateRuntimeEventAccessV4 } from "@agent-infra/contracts/runtime";
import {
	type ConversationDispatchStateTransitionV1,
	type ConversationDispatchStorePortV1,
	createConversationDispatchUseCaseV1,
} from "@agent-infra/platform-core";
import { FakeConversationEventsV1 } from "@agent-infra/platform-core/testing";
import { expect, it, vi } from "vitest";
import {
	runtimeV4Harness,
	signingKeys,
	time,
} from "./test-support/runtime-v4.js";

const verify = createRuntimeExecutionGrantVerifierV2(
	new Map([["signing", signingKeys.publicKey]]),
);

it.each([
	["read", "unchanged"],
	["ack", "unchanged"],
	["read", "revoked"],
	["ack", "stopped"],
	["read", "still-refused"],
	["ack", "still-refused"],
] as const)(
	"recovers the original Turn after a V4 event %s Grant refusal with %s authority (#4083)",
	async (refusedCommand, authorityChange) => {
		const h = runtimeV4Harness();
		const events = new FakeConversationEventsV1({
			conversationId: "conversation",
			executionId: "execution",
			sessionGeneration: 1,
			deliveryFence: 2,
		});
		const text = {
			schemaVersion: 1,
			adapterEventKey: "text-event",
			executionId: "execution",
			cursor: "text-cursor",
			occurredAt: "2026-10-02T00:00:00Z",
			type: "text",
			payload: { delta: "original reply" },
		} as const;
		const terminal = {
			...text,
			adapterEventKey: "terminal-event",
			cursor: "terminal-cursor",
			type: "completed",
			payload: { status: "completed" },
		} as const;
		let refused = false;
		let outbox = "processing";
		const applyTransition = ({
			executionStatus,
		}: ConversationDispatchStateTransitionV1) => {
			if (executionStatus) {
				Object.assign(h.state, { executionStatus });
				Object.assign(h.claim, { executionStatus });
			}
		};
		const store: ConversationDispatchStorePortV1 = {
			claim: vi.fn(async () => ({
				outcome: "claimed" as const,
				claim: structuredClone(h.claim),
			})),
			renew: vi.fn(async () => true),
			prepareRuntimeDispatch: vi.fn(async () => true),
			cancelUnaccepted: vi.fn(async () => true),
			recordRuntimeResponse: vi.fn(async ({ transition }) => {
				applyTransition(transition);
				return true;
			}),
			finish: vi.fn(async ({ status, transition }) => {
				outbox = status;
				applyTransition(transition);
				return true;
			}),
			retry: vi.fn(async ({ transition }) => {
				outbox = "retry_scheduled";
				applyTransition(transition);
				return true;
			}),
		};
		const useCase = createConversationDispatchUseCaseV1(
			{
				store,
				authorization: h.runtime.authorization,
				runtimeHost: h.runtime.runtimeHost,
				events: {
					async persist(command) {
						const result = await events.persist(command);
						if (result.outcome !== "stale") {
							Object.assign(h.state, { runtimeCursor: command.runtimeCursor });
							Object.assign(h.claim, { runtimeCursor: command.runtimeCursor });
							if (command.transition) {
								applyTransition(command.transition);
							}
							if (
								command.event.type === "execution.status" &&
								["completed", "failed", "cancelled"].includes(
									command.event.status,
								)
							)
								Object.assign(h.claim, { runtimeTerminalEventSeen: true });
						}
						return result;
					},
				},
			},
			{ retryDelayMs: 0 },
		);
		const originalTransport = h.fetcher.getMockImplementation();
		h.fetcher.mockImplementation(async (url, init) => {
			const path = new URL(String(url)).pathname;
			const body = JSON.parse(init?.body as string);
			if (
				(!refused || authorityChange === "still-refused") &&
				path.endsWith(`/events/${refusedCommand}`) &&
				(refusedCommand === "ack" || body.afterCursor === "text-cursor")
			) {
				refused = true;
				// Replay the observed Host time boundary without changing its checks.
				await expect(
					validateRuntimeEventAccessV4(
						body,
						verify(body.grant),
						h.accepted()?.scope,
						"host",
						{
							expectedIssuer: "platform",
							expectedWorkerId: "transport",
							now: time - 1,
							trustedOperation: body.operation,
						},
					),
				).rejects.toHaveProperty("cause", "claims-issued-in-future");
				return Response.json(
					{
						schemaVersion: 1,
						code: "RUNTIME_GRANT_INVALID",
						message:
							"Runtime authorization is unavailable or does not authorize this operation",
						retryable: false,
						traceId: "trace",
					},
					{ status: 403 },
				);
			}
			if (path.endsWith("/events/read"))
				return Response.json({
					schemaVersion: 4,
					executionId: "execution",
					hostSessionRef: "host",
					events:
						body.afterCursor === "terminal-cursor"
							? []
							: body.afterCursor === "text-cursor"
								? [terminal]
								: [text, ...(refusedCommand === "ack" ? [terminal] : [])],
				});
			if (path.endsWith("/status"))
				return Response.json({
					schemaVersion: 3,
					executionId: "execution",
					hostSessionRef: "host",
					outcome: "found",
					status:
						h.state.executionStatus === "completed" ? "completed" : "running",
				});
			if (!originalTransport) throw new Error("Fixture transport unavailable");
			return originalTransport(url, init);
		});
		const command = {
			schemaVersion: 1 as const,
			itemId: "item",
			workerId: "instance",
		};
		try {
			expect(await useCase.dispatch(command)).toMatchObject({
				outcome: "retry",
				errorCode: "RUNTIME_GRANT_INVALID",
			});
			expect(refused).toBe(true);
			expect(outbox).toBe("retry_scheduled");
			expect(h.claim.executionStatus).not.toBe("failed");
			if (authorityChange === "revoked") h.setUser(null);
			if (authorityChange === "stopped")
				Object.assign(h.state, { stopPending: true });
			const prepared = h.resolveRuntimeHost.mock.calls.length;
			const recovered = await useCase.dispatch(command);
			if (authorityChange === "still-refused") {
				expect(recovered).toMatchObject({
					outcome: "retry",
					errorCode: "RUNTIME_GRANT_INVALID",
				});
				expect(outbox).toBe("retry_scheduled");
				expect(store.finish).not.toHaveBeenCalled();
				expect(h.claim.executionStatus).not.toBe("failed");
			} else {
				expect(recovered).toMatchObject({ outcome: "accepted" });
				expect(outbox).toBe("succeeded");
			}
			expect(
				h.resolveRuntimeHost.mock.calls.length - prepared,
			).toBeGreaterThanOrEqual(3);
			expect(events.snapshot().events.map((event) => event.event)).toEqual([
				{ type: "text.delta", text: "original reply" },
				...(authorityChange === "still-refused" && refusedCommand === "read"
					? []
					: [{ type: "execution.status", status: "completed" }]),
			]);
			expect(h.claim).toMatchObject({
				conversationId: "conversation",
				executionId: "execution",
				turnId: "turn",
				sessionGeneration: 1,
			});
			expect(
				h.fetcher.mock.calls.some(([url]) => String(url).endsWith("/v4/turns")),
			).toBe(false);
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			const cursors = h.fetcher.mock.calls
				.filter(([url]) => String(url).endsWith("/events/read"))
				.map(([, init]) => JSON.parse(init?.body as string).afterCursor);
			expect(cursors.filter((cursor) => cursor === null)).toHaveLength(1);
			if (authorityChange === "revoked" || authorityChange === "stopped") {
				const [, sent] =
					h.fetcher.mock.calls
						.filter(([url]) => String(url).endsWith("/events/ack"))
						.at(-1) ?? [];
				expect(
					verify(JSON.parse(sent?.body as string).grant).claims,
				).toMatchObject({
					purpose: "control",
					reason:
						authorityChange === "revoked" ? "authorization_revoked" : "stop",
				});
			}
		} finally {
			h.runtime.close();
		}
	},
);
