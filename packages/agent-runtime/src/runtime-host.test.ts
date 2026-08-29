import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExecutionGrantCommandV1,
	ExecutionGrantV1,
	RuntimeSubmitTurnRequestV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	runtimeDriverConformanceTable,
} from "./index.js";

const directories: string[] = [];

async function runtimeDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "agent-runtime-conformance-"));
	directories.push(directory);
	return directory;
}

function grant(
	request: Pick<
		RuntimeSubmitTurnRequestV1,
		| "agentId"
		| "actorId"
		| "channelId"
		| "conversationId"
		| "executionId"
		| "turnId"
		| "sessionGeneration"
		| "traceId"
	>,
	operations: ExecutionGrantCommandV1[],
): ExecutionGrantV1 {
	return runtimeGrantFixture(request, operations, {
		actionSetVersion: "actions-conformance",
	});
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-conformance",
		actorId: "actor-conformance",
		channelId: "web",
		conversationId: "conversation-conformance",
		executionId: "execution-conformance-1",
		turnId: "turn-conformance-1",
		sessionGeneration: 1,
		traceId: "trace-conformance",
	};
	return {
		schemaVersion: 1,
		requestId: "request-conformance-1",
		...binding,
		deliveryFence: 1,
		grant: grant(binding, ["turn.submit"]),
		input: { text: "synthetic-conformance-input", attachments: [] },
	};
}

function host(store: FileRuntimeStore, driver: FakeRuntimeDriver) {
	return RuntimeHost.open({
		store,
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
	}).then(ingressVerifiedRuntimeHost);
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("RuntimeHost durable Session", () => {
	it("accepts only ingress-verified canonical Grants before Driver side effects", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await RuntimeHost.open({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const request = {
			...submitRequest(),
			actorId: "actor-conformance",
			channelId: "web",
			traceId: "trace-conformance",
			grant: {
				schemaVersion: 1,
				format: "compact-jws",
				token: "header.payload.signature",
			},
		} as const;
		const claims = {
			schemaVersion: 1,
			issuer: "agent-platform",
			audience: ["runtime_host"],
			issuedAt: "2026-08-28T09:59:00Z",
			expiresAt: "2026-08-28T10:01:00Z",
			grantId: "grant-canonical",
			agentId: request.agentId,
			actorId: request.actorId,
			channelId: request.channelId,
			conversationId: request.conversationId,
			turnId: request.turnId,
			executionId: request.executionId,
			sessionGeneration: request.sessionGeneration,
			allowedCommands: ["turn.submit"],
			attachments: [],
			actionSetVersion: "actions-conformance",
			actionIds: [],
			traceId: request.traceId,
		} as const;

		expect(
			await runtimeHost.submitTurn(request, {
				token: request.grant.token,
				claims,
			}),
		).toMatchObject({ result: { outcome: "accepted" } });
		expect(await driver.sideEffectCount()).toBe(1);

		for (const verification of [
			{ token: "other.payload.signature", claims },
			{
				token: request.grant.token,
				claims: { ...claims, audience: ["connection_api"] },
			},
			{
				token: request.grant.token,
				claims: { ...claims, allowedCommands: ["session.status"] },
			},
			...(
				[
					"agentId",
					"actorId",
					"channelId",
					"conversationId",
					"turnId",
					"executionId",
					"traceId",
				] as const
			).map((binding) => ({
				token: request.grant.token,
				claims: { ...claims, [binding]: `other-${binding}` },
			})),
			{
				token: request.grant.token,
				claims: { ...claims, sessionGeneration: 2 },
			},
		]) {
			await expect(
				runtimeHost.submitTurn(request, verification),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		}
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("recovers the same opaque Host Session after Host and Driver restart", async () => {
		const directory = await runtimeDirectory();
		const firstHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			await FakeRuntimeDriver.open(join(directory, "driver.json")),
		);
		const submitted = await firstHost.submitTurn(submitRequest());

		expect(submitted).toMatchObject({
			schemaVersion: 1,
			operationId: "execution-conformance-1",
			result: { outcome: "accepted", status: "running" },
		});
		expect(submitted.hostSessionRef).not.toContain("native");
		expect(JSON.stringify(submitted)).not.toMatch(
			/native|vendor|stdio|protocol/i,
		);

		const restartedHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			await FakeRuntimeDriver.open(join(directory, "driver.json")),
		);
		const binding = submitRequest();
		const status = await restartedHost.status({
			schemaVersion: 1,
			requestId: "request-conformance-status",
			traceId: binding.traceId,
			actorId: binding.actorId,
			channelId: binding.channelId,
			agentId: binding.agentId,
			conversationId: binding.conversationId,
			executionId: binding.executionId,
			turnId: binding.turnId,
			sessionGeneration: binding.sessionGeneration,
			deliveryFence: binding.deliveryFence,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(binding, ["session.status"]),
		});

		expect(status).toEqual({
			schemaVersion: 1,
			hostSessionRef: submitted.hostSessionRef,
			executionId: "execution-conformance-1",
			status: "running",
		});
	});

	it("passes the Session, Turn, event, stop, status, and capability conformance table", async () => {
		const directory = await runtimeDirectory();
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const runtimeHost = await host(
			await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
		);
		const submittedRequest = submitRequest();
		const submitted = await runtimeHost.submitTurn(submittedRequest);
		const base = {
			schemaVersion: 1 as const,
			traceId: submittedRequest.traceId,
			actorId: submittedRequest.actorId,
			channelId: submittedRequest.channelId,
			agentId: submittedRequest.agentId,
			conversationId: submittedRequest.conversationId,
			executionId: submittedRequest.executionId,
			turnId: submittedRequest.turnId,
			sessionGeneration: submittedRequest.sessionGeneration,
		};

		const capabilities = await runtimeHost.capabilities({
			...base,
			requestId: "request-capabilities",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["capabilities.read"]),
		});
		expect(capabilities.capabilities).toMatchObject({
			attachments: true,
			supplementaryInstruction: true,
		});

		const initialReplay = await runtimeHost.replay({
			...base,
			requestId: "request-replay-1",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["events.replay"]),
		});
		expect(initialReplay.events).toEqual([
			expect.objectContaining({
				adapterEventKey: "fake-event-1",
				type: "status",
				payload: { status: "running" },
			}),
		]);

		const supplemented = await runtimeHost.supplement({
			...base,
			requestId: "request-supplement-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-supplement-1",
			grant: grant(base, ["turn.supplement"]),
			input: { text: "synthetic-supplement", attachments: [] },
		});
		expect(supplemented.result).toEqual({
			outcome: "accepted",
			status: "running",
		});

		const replayed = await runtimeHost.replay({
			...base,
			requestId: "request-replay-2",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			afterCursor: initialReplay.events[0]?.cursor,
			grant: grant(base, ["events.replay"]),
		});
		expect(replayed.events).toEqual([
			expect.objectContaining({
				type: "text",
				payload: { delta: "synthetic-supplement-accepted" },
			}),
		]);

		const secondBinding = {
			...base,
			executionId: "execution-conformance-2",
			turnId: "turn-conformance-2",
		};
		const busy = await runtimeHost.submitTurn({
			...secondBinding,
			requestId: "request-busy",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(secondBinding, ["turn.submit"]),
			input: { text: "synthetic-busy-input", attachments: [] },
		});
		expect(busy.result).toEqual({ outcome: "busy" });

		const stopped = await runtimeHost.stop({
			...base,
			requestId: "request-stop-1",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			stopRequestId: "stop-1",
			grant: grant(base, ["turn.stop"]),
		});
		expect(stopped.result).toEqual({
			outcome: "accepted",
			status: "cancelled",
		});

		const stoppedAgain = await runtimeHost.stop({
			...base,
			requestId: "request-stop-retry",
			deliveryFence: 2,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			stopRequestId: "stop-1",
			grant: grant(base, ["turn.stop"]),
		});
		expect(stoppedAgain).toEqual(stopped);
		expect(await driver.sideEffectCount()).toBe(3);

		const status = await runtimeHost.status({
			...base,
			requestId: "request-status-cancelled",
			deliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			grant: grant(base, ["session.status"]),
		});
		expect(status.status).toBe("cancelled");

		const rejected = await runtimeHost.supplement({
			...base,
			requestId: "request-supplement-rejected",
			deliveryFence: 1,
			executionDeliveryFence: 1,
			hostSessionRef: submitted.hostSessionRef,
			messageId: "message-supplement-2",
			grant: grant(base, ["turn.supplement"]),
			input: { text: "synthetic-late-supplement", attachments: [] },
		});
		expect(rejected.result).toMatchObject({
			outcome: "rejected",
			code: "RUNTIME_TURN_NOT_ACTIVE",
		});

		const observations = {
			turn: submitted.result.outcome,
			event: initialReplay.events[0]?.type,
			supplement: supplemented.result.outcome,
			busy: busy.result.outcome,
			stop: stopped.result.outcome,
			status: status.status,
			capabilities: capabilities.capabilities.supplementaryInstruction,
			rejected: rejected.result.outcome,
		};
		expect(observations).toEqual(
			Object.fromEntries(
				runtimeDriverConformanceTable.map(({ capability, expected }) => [
					capability,
					expected,
				]),
			),
		);
	});
});
