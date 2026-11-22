import type { SessionSandboxRuntimeStateV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { createConversationRuntimeV2 } from "./conversation-runtime.js";
import {
	createSessionHostSourceRecorderV1,
	type SessionHostSourceConfirmationV1,
	type SessionHostSourceStoreV1,
} from "./session-host-source.js";
import { runtimeV4Harness } from "./test-support/runtime-v4.js";

const podUid = "11111111-2222-4333-8444-555555555555";
const principal = { kind: "user" as const, id: "user" };

function sandbox(
	change: Partial<SessionSandboxRuntimeStateV1> = {},
): SessionSandboxRuntimeStateV1 {
	return {
		sandbox: {
			schemaVersion: 1,
			sandboxId: "sandbox-1",
			sessionId: "conversation",
			agentId: "agent",
			principal,
			channelId: "web",
			generation: 1,
			resourceName: "sandbox-sandbox-1",
			workspaceScope: "sandbox-1",
		},
		resourceFence: 4,
		desiredState: "running",
		status: "ready",
		policy: null,
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
		...change,
	} as SessionSandboxRuntimeStateV1;
}

const confirmation = (
	change: Partial<SessionHostSourceConfirmationV1> = {},
): SessionHostSourceConfirmationV1 => ({
	baseUrl: "http://sandbox-sandbox-1.agents.svc:3003",
	serviceToken: "synthetic-sandbox-token",
	traceId: "trace",
	agentId: "agent",
	conversationId: "conversation",
	sessionGeneration: 1,
	principal,
	hostSessionRef: "host",
	sandboxResource: sandbox(),
	...change,
});

function host(answer: (body: Record<string, unknown>) => Response) {
	return vi.fn<typeof fetch>(async (_url, init) =>
		answer(JSON.parse(String(init?.body))),
	);
}

const echo = (body: Record<string, unknown>) =>
	Response.json({
		...body,
		host: { instanceRef: "hi1-instance", startRef: "hs1-start" },
	});

function store() {
	return {
		recordSessionSandboxHostSourceV1: vi.fn<
			SessionHostSourceStoreV1["recordSessionSandboxHostSourceV1"]
		>(async () => "recorded"),
	};
}

describe("Worker Host source confirmation (Spec §18.5.1, #4358 I3b1)", () => {
	it("confirms on the Session route bound to the observed Pod UID and writes through the committed fence", async () => {
		const fetcher = host(echo);
		const s = store();
		const recorder = createSessionHostSourceRecorderV1({
			store: s,
			fetch: fetcher,
		});
		await expect(recorder.confirm(confirmation())).resolves.toBe("recorded");
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"http://sandbox-sandbox-1.agents.svc:3003/internal/runtime/v1/host-source/read",
		);
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer synthetic-sandbox-token",
		);
		expect(JSON.parse(String(init?.body))).toEqual({
			schemaVersion: 1,
			podUid,
			agentId: "agent",
			conversationId: "conversation",
			hostSessionRef: "host",
			sessionGeneration: 1,
		});
		expect(s.recordSessionSandboxHostSourceV1).toHaveBeenCalledWith({
			sandboxId: "sandbox-1",
			conversationId: "conversation",
			agentId: "agent",
			principal,
			sessionGeneration: 1,
			resourceFence: 4,
			hostSource: {
				schemaVersion: 1,
				podUid,
				instanceRef: "hi1-instance",
				startRef: "hs1-start",
				hostSessionRef: "host",
				sessionGeneration: 1,
			},
		});
		await recorder.close();
	});

	it("carries the verified executor epoch only for an independent executor", async () => {
		const s = store();
		const recorder = createSessionHostSourceRecorderV1({
			store: s,
			fetch: host(echo),
		});
		const executor = sandbox();
		await recorder.confirm(
			confirmation({
				sandboxResource: {
					...executor,
					observation: {
						...(executor.observation as NonNullable<
							typeof executor.observation
						>),
						executorDrainRequired: true,
						executorInstance: {
							attemptId: "attempt-1",
							startupRef: "startup-1",
							podUid,
							epoch: "epoch-1",
						},
					},
				},
			}),
		);
		expect(s.recordSessionSandboxHostSourceV1.mock.calls[0]?.[0]).toMatchObject(
			{ hostSource: { epoch: "epoch-1" } },
		);
		await recorder.close();
	});

	it.each([
		[
			"another subject",
			confirmation({ principal: { kind: "user", id: "other" } }),
		],
		["another Agent", confirmation({ agentId: "agent-other" })],
		[
			"another Conversation",
			confirmation({ conversationId: "conversation-other" }),
		],
		["another Session generation", confirmation({ sessionGeneration: 2 })],
		[
			"a Sandbox that is not ready",
			confirmation({ sandboxResource: sandbox({ status: "unknown" }) }),
		],
		[
			"no observed Pod",
			confirmation({
				sandboxResource: sandbox({
					observation: { status: "ready", resources: [] },
				}),
			}),
		],
		[
			"a Pod already confirmed",
			confirmation({
				sandboxResource: sandbox({
					observation: {
						...(sandbox().observation as NonNullable<
							SessionSandboxRuntimeStateV1["observation"]
						>),
						hostSource: {
							schemaVersion: 1,
							podUid,
							instanceRef: "hi1-instance",
							startRef: "hs1-start",
							hostSessionRef: "host",
							sessionGeneration: 1,
						},
					},
				}),
			}),
		],
	])("never asks the Host or writes for %s", async (_name, input) => {
		const fetcher = host(echo);
		const s = store();
		const recorder = createSessionHostSourceRecorderV1({
			store: s,
			fetch: fetcher,
		});
		await expect(recorder.confirm(input)).resolves.toBe("skipped");
		expect(fetcher).not.toHaveBeenCalled();
		expect(s.recordSessionSandboxHostSourceV1).not.toHaveBeenCalled();
		await recorder.close();
	});

	it.each([
		[
			"a Host that refuses the binding",
			() =>
				Response.json(
					{
						schemaVersion: 1,
						code: "RUNTIME_HOST_SOURCE_MISMATCH",
						message: "mismatch",
						retryable: false,
						traceId: "t",
					},
					{ status: 409 },
				),
		],
		[
			"a Host without the route",
			() =>
				Response.json(
					{
						schemaVersion: 1,
						code: "NOT_FOUND",
						message: "not found",
						retryable: false,
						traceId: "t",
					},
					{ status: 404 },
				),
		],
		[
			"an answer for another Pod",
			(body: Record<string, unknown>) =>
				echo({ ...body, podUid: "99999999-2222-4333-8444-555555555555" }),
		],
		[
			"an answer for another Host Session",
			(body: Record<string, unknown>) =>
				echo({ ...body, hostSessionRef: "host-other" }),
		],
		[
			"a self-reported field it was not asked for",
			(body: Record<string, unknown>) =>
				Response.json({
					...body,
					host: {
						instanceRef: "hi1-instance",
						startRef: "hs1-start",
						podUid,
					},
				}),
		],
	])("writes nothing for %s", async (_name, answer) => {
		const s = store();
		const recorder = createSessionHostSourceRecorderV1({
			store: s,
			fetch: host(answer as (body: Record<string, unknown>) => Response),
		});
		await expect(recorder.confirm(confirmation())).resolves.toBe(
			"host_unavailable",
		);
		expect(s.recordSessionSandboxHostSourceV1).not.toHaveBeenCalled();
		await recorder.close();
	});

	it("runs once per Sandbox and Pod UID in the background, spaces retries and swallows failures", async () => {
		let now = 0;
		const fetcher = host(echo);
		const s = store();
		s.recordSessionSandboxHostSourceV1.mockRejectedValueOnce(
			new Error("store down"),
		);
		const observe = vi.fn();
		const recorder = createSessionHostSourceRecorderV1({
			store: s,
			fetch: fetcher,
			now: () => now,
			retryIntervalMs: 60_000,
			observe,
		});
		expect(() => recorder.afterAcknowledge(confirmation())).not.toThrow();
		recorder.afterAcknowledge(confirmation());
		await recorder.settled();
		expect(observe.mock.calls.map(([outcome]) => outcome)).toEqual([
			"store_unavailable",
		]);
		// Within the retry interval nothing is asked again.
		now = 30_000;
		recorder.afterAcknowledge(confirmation());
		await recorder.settled();
		expect(fetcher).toHaveBeenCalledTimes(1);
		now = 61_000;
		recorder.afterAcknowledge(confirmation());
		await recorder.settled();
		expect(observe.mock.calls.at(-1)?.[0]).toBe("recorded");
		// A confirmed Pod is never asked again; a new Pod UID is.
		now = 200_000;
		recorder.afterAcknowledge(confirmation());
		await recorder.settled();
		expect(fetcher).toHaveBeenCalledTimes(2);
		const replaced = sandbox();
		recorder.afterAcknowledge(
			confirmation({
				sandboxResource: {
					...replaced,
					observation: {
						status: "ready",
						resources: [
							{
								kind: "Pod",
								namespace: "agents",
								name: "sandbox-sandbox-1-0",
								uid: "99999999-2222-4333-8444-555555555555",
								resourceVersion: "2",
							},
						],
					},
				},
			}),
		);
		await recorder.settled();
		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)).podUid).toBe(
			"99999999-2222-4333-8444-555555555555",
		);
		await recorder.close();
		recorder.afterAcknowledge(confirmation());
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it("is asked after a business event ACK of a Session Sandbox and never changes the ACK", async () => {
		const h = runtimeV4Harness();
		const afterAcknowledge = vi.fn(() => {
			throw new Error("synthetic recorder failure");
		});
		const runtime = createConversationRuntimeV2({
			...h.options,
			hostSource: { afterAcknowledge },
		});
		try {
			const decision = await runtime.authorization.authorize({
				...h.claim,
				claim: h.claim,
			});
			if (decision.outcome !== "allowed") throw new Error("Expected authority");
			const grant = decision.authority.runtimeGrant;
			h.fetcher.mockImplementation(async (_url, init) => {
				const body = JSON.parse(init?.body as string);
				return Response.json({
					schemaVersion: 4,
					executionId: "execution",
					confirmedCursor: body.confirmedCursor,
				});
			});
			// No Session Sandbox: nothing to confirm.
			Object.assign(h.state, { runtimeCursor: "model-cursor" });
			await runtime.runtimeHost.acknowledge?.({
				...h.events(grant),
				confirmedCursor: "model-cursor",
			});
			expect(afterAcknowledge).not.toHaveBeenCalled();
			Object.assign(h.state, { sandboxResource: sandbox() });
			await expect(
				runtime.runtimeHost.acknowledge?.({
					...h.events(grant),
					confirmedCursor: "model-cursor",
				}),
			).resolves.toBeUndefined();
			expect(afterAcknowledge).toHaveBeenCalledTimes(1);
			expect(afterAcknowledge).toHaveBeenCalledWith(
				expect.objectContaining({
					agentId: "agent",
					conversationId: "conversation",
					sessionGeneration: 1,
					principal,
					hostSessionRef: "host",
					sandboxResource: expect.objectContaining({
						resourceFence: 4,
					}),
				}),
			);
		} finally {
			runtime.close();
			h.runtime.close();
		}
	});
});
