import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRuntimeExecutionGrantVerifierV2,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	requestDigest,
} from "@agent-infra/agent-runtime";
import * as contracts from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
	createRuntimeProbeProtocol,
	runtimeProbeWorkerId,
} from "../../../tests/runtime-image-probe.mjs";
import { createRuntimeHostApp } from "./app.ts";

const cleanups = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-image-protocol-"));
	const keys = generateKeyPairSync("ed25519");
	const clock = { now: Date.now() };
	const protocol = createRuntimeProbeProtocol({
		contracts,
		requestDigest,
		privateKey: keys.privateKey,
		now: () => clock.now,
	});
	const verify = createRuntimeExecutionGrantVerifierV2(
		new Map([["synthetic-key", keys.publicKey]]),
	);
	const selection = {
		schemaVersion: 1,
		modelOptionId: "selected-option",
		reasoningLevel: "high",
	};
	const hosts = [];
	async function open() {
		const driver = await FakeRuntimeDriver.open(
			join(directory, "driver.json"),
			[selection],
		);
		const store = await FileRuntimeStore.open(join(directory, "host.json"));
		const host = await RuntimeHost.open({
			driver,
			store,
			grantValidation: { expectedIssuer: "synthetic-platform" },
			grantValidationV2: {
				expectedIssuer: "synthetic-platform",
				expectedWorkerId: runtimeProbeWorkerId,
				now: () => clock.now,
			},
		});
		hosts.push(host);
		const options = {
			host,
			runtimeWorkerId: runtimeProbeWorkerId,
			serviceToken: "synthetic-service-token",
			verifyGrant: () => {
				throw new Error("Legacy grants must not be used");
			},
			verifyGrantV2: verify,
		};
		const app = createRuntimeHostApp(options);
		function post(path, body, token = options.serviceToken) {
			return app.request(`/internal/runtime/v3/${path}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
		}
		async function submit(name, session, selected) {
			const lookup = protocol.binding(
				name,
				session
					? {
							conversationId: session.conversationId,
							hostSessionRef: session.hostSessionRef,
						}
					: {},
			);
			const submit = protocol.signRequest(
				{
					...lookup,
					input: { text: "synthetic-runtime-input", attachments: [] },
					...(selected ? { selection } : {}),
				},
				"turn.submit",
			);
			const response = await post("turns", submit);
			expect(response.status).toBe(200);
			const accepted = await response.json();
			expect(accepted).toMatchObject({
				schemaVersion: 3,
				result: { outcome: "accepted" },
			});
			return {
				submit,
				originalOperationDigest: protocol.originalOperationDigest(submit),
				lookup: { ...lookup, hostSessionRef: accepted.hostSessionRef },
			};
		}
		return { app, options, driver, host, post, submit };
	}
	cleanups.push(async () => {
		for (const host of hosts) await host.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { protocol, clock, open, verify, ...(await open()) };
}

it("the image probe signs command-specific V3 requests and preserves Host rejection boundaries", async () => {
	const env = await setup();
	const selected = await env.submit("selection", undefined, true);
	const claims = env.verify(selected.submit.grant).claims;
	expect(claims.allowedCommands).toEqual(["turn.submit"]);
	expect(claims.expiresAt - claims.issuedAt).toBe(30_000);
	expect(claims.workerId).toBe(runtimeProbeWorkerId);
	const replay = env.protocol.signRequest(selected.submit, "turn.submit");
	expect(replay.requestId).not.toBe(selected.submit.requestId);
	expect((await env.post("turns", replay)).status).toBe(200);
	const conflict = env.protocol.signRequest(
		{
			...selected.submit,
			selection: {
				schemaVersion: 1,
				modelOptionId: "default-option",
				reasoningLevel: "medium",
			},
		},
		"turn.submit",
	);
	const conflictResponse = await env.post("turns", conflict);
	expect(conflictResponse.status).toBe(409);
	expect((await conflictResponse.json()).code).toBe(
		"RUNTIME_OPERATION_CONFLICT",
	);
	for (const body of [
		{ ...replay, input: { text: "tampered", attachments: [] } },
		{ ...replay, requestId: "request-tampered" },
		{
			...replay,
			operation: {
				...replay.operation,
				deliveryFence: 2,
				executionDeliveryFence: 2,
			},
		},
		{
			...replay,
			grant: {
				...replay.grant,
				token: `${replay.grant.token.split(".").slice(0, 2).join(".")}.${Buffer.alloc(64).toString("base64url")}`,
			},
		},
	])
		expect((await env.post("turns", body)).status).toBe(403);
	expect((await env.post("turns", replay, "other-token")).status).toBe(401);
	for (const override of [
		{ principal: { kind: "user", id: "other-principal" } },
		{ agentId: "other-agent" },
		{ conversationId: "other-conversation" },
	]) {
		const foreign = env.protocol.signRequest(
			{
				...selected.submit,
				...override,
				hostSessionRef: selected.lookup.hostSessionRef,
			},
			"turn.submit",
		);
		expect((await env.post("turns", foreign)).status).toBe(403);
	}
	const otherWorker = createRuntimeHostApp({
		...env.options,
		runtimeWorkerId: "other-worker",
	});
	expect(
		(
			await otherWorker.request("/internal/runtime/v3/turns", {
				method: "POST",
				headers: {
					authorization: "Bearer synthetic-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(replay),
			})
		).status,
	).toBe(403);
	env.clock.now += 30_001;
	expect((await env.post("turns", replay)).status).toBe(403);
	expect(
		(
			await env.post(
				"turns",
				env.protocol.signRequest(selected.submit, "turn.submit"),
			)
		).status,
	).toBe(200);
	expect(await env.driver.sideEffectCount()).toBe(1);
});

it("the probe recovers without input, stops only its Conversation, and preserves generation isolation after restart", async () => {
	const env = await setup();
	const original = await env.submit("original");
	const independent = await env.submit("independent");
	await env.host.close();
	env.clock.now += 30_001;
	const restored = await env.open();
	const recovery = env.protocol.status(original);
	expect(recovery).not.toHaveProperty("input");
	expect(recovery).not.toHaveProperty("selection");
	expect((await restored.post("status", recovery)).status).toBe(200);
	const stop = env.protocol.signRequest(
		{
			...original.lookup,
			operation: {
				...original.lookup.operation,
				kind: "stop",
				id: "synthetic-stop",
				deliveryFence: original.lookup.operation.deliveryFence + 1,
			},
		},
		"turn.stop",
		"stop",
	);
	const stopped = await restored.post("stops", stop);
	expect(stopped.status).toBe(200);
	expect((await stopped.json()).result).toEqual({
		outcome: "accepted",
		status: "cancelled",
	});
	const independentStatus = await restored.post(
		"status",
		env.protocol.status(independent),
	);
	expect((await independentStatus.json()).status).toBe("running");
	const continuation = await restored.submit("continuation", original.lookup);
	const cancel = env.protocol.signRequest(
		{
			...continuation.lookup,
			operation: {
				...continuation.lookup.operation,
				kind: "generation",
				id: "synthetic-generation",
			},
		},
		"generation.cancel",
		"generation_isolation",
	);
	expect((await restored.post("generations/cancel", cancel)).status).toBe(200);
	async function verifyCancelled(runtime) {
		const status = await runtime.post(
			"status",
			env.protocol.status(continuation, "generation_isolation"),
		);
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({
			schemaVersion: 3,
			outcome: "found",
			status: "cancelled",
		});
		const replay = await runtime.post(
			"turns",
			env.protocol.signRequest(continuation.submit, "turn.submit"),
		);
		expect(replay.status).toBe(409);
		expect((await replay.json()).code).toBe("RUNTIME_GENERATION_CANCELLED");
	}
	await verifyCancelled(restored);
	await restored.host.close();
	env.clock.now += 30_001;
	const restarted = await env.open();
	await verifyCancelled(restarted);
	expect(await restarted.driver.sideEffectCount()).toBe(5);
});

it("the probe consumes mixed event versions and acknowledges only delivered cursors with fresh grants", async () => {
	const env = await setup();
	const submitted = await env.submit("events");
	const fact = {
		schemaVersion: 2,
		adapterEventKey: "synthetic-operation",
		executionId: submitted.lookup.executionId,
		cursor: "synthetic-operation-cursor",
		occurredAt: "2026-09-15T00:00:00Z",
		type: "operation",
		payload: {
			kind: "tool",
			operationRef: "synthetic-operation",
			attemptRef: "synthetic-attempt",
			phase: "completed",
			toolId: "exec_command",
		},
	};
	vi.spyOn(env.driver, "subscribeEvents").mockImplementation(
		async (ref, executionId, cursor) => {
			const originals = await env.driver.replayEvents(ref, executionId, cursor);
			return (async function* () {
				yield* originals;
				yield fact;
			})();
		},
	);
	const eventBase = {
		...submitted.lookup,
		consumer: "platform_worker_persistence",
	};
	const stream = env.protocol.signRequest(
		{ ...eventBase, afterCursor: null },
		"events.persist",
		"recovery",
	);
	const response = await env.post("events/stream", stream);
	expect(response.status).toBe(200);
	const frames = env.protocol.parseEvents(
		await response.text(),
		submitted.lookup.executionId,
	);
	expect(frames.map((frame) => frame.schemaVersion)).toContain(1);
	expect(frames.at(-1)).toEqual(fact);
	expect(() =>
		env.protocol.parseEvents(
			`data: ${JSON.stringify(fact)}\n`,
			"other-execution",
		),
	).toThrow();
	expect(() =>
		env.protocol.parseEvents(
			`data: ${JSON.stringify({ ...fact, rawResponse: "forbidden" })}\n`,
			submitted.lookup.executionId,
		),
	).toThrow();
	expect(
		(await env.post("events/stream", { ...stream, afterCursor: "tampered" }))
			.status,
	).toBe(403);
	const unseen = env.protocol.signRequest(
		{ ...eventBase, confirmedCursor: "not-delivered" },
		"events.ack",
		"recovery",
	);
	expect((await env.post("events/ack", unseen)).status).toBe(403);
	env.clock.now += 30_001;
	const ack = env.protocol.signRequest(
		{ ...eventBase, confirmedCursor: frames.at(-1).cursor },
		"events.ack",
		"recovery",
	);
	const acknowledged = await env.post("events/ack", ack);
	expect(acknowledged.status).toBe(200);
	expect(await acknowledged.json()).toEqual({
		schemaVersion: 3,
		executionId: submitted.lookup.executionId,
		confirmedCursor: fact.cursor,
	});
});
