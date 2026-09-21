import { type FileHandle, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeHostError } from "./errors.js";
import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore, requestDigest } from "./file-runtime-store.js";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "./grant-fixture.test-support.js";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import {
	applyRuntimeAuthority,
	type RuntimeExecutionAuthority,
	validStoredExecutionAuthority,
} from "./runtime-authorization.js";
import { RuntimeHost } from "./runtime-host.js";

const directories: string[] = [];
beforeEach(() => {
	// The fixture grants use a deterministic clock; authority application also
	// performs the wall-clock expiry check before mutating durable state.
	vi.setSystemTime(fixtureNow);
});
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});
async function setup(
	options: { afterOperationPrepared?: () => void | Promise<void> } = {},
) {
	const directory = await mkdtemp(join(tmpdir(), "runtime-v3-"));
	directories.push(directory);
	const storePath = join(directory, "host.json");
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const clock = { now: fixtureNow };
	const hostOptions = {
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
		grantValidationV2: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => clock.now,
		},
		...options,
	};
	const store = await FileRuntimeStore.open(storePath);
	const host = await RuntimeHost.open({ ...hostOptions, store });
	return { directory, storePath, driver, clock, host, store, hostOptions };
}
function base<T extends string | null>(hostSessionRef: T) {
	const { input: _input, ...request } = submitV3Fixture();
	return { ...request, hostSessionRef };
}
function originalDigest(request = submitV3Fixture()) {
	return requestDigest({
		kind: "submit-turn",
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		input: request.input,
		...(request.selection ? { selection: request.selection } : {}),
	});
}
async function submit(host: RuntimeHost) {
	const request = signV3Fixture(submitV3Fixture(), "turn.submit");
	return host.submitTurnV3(request, verifyRuntimeV2Fixture(request.grant));
}

function generationCancelFixture(
	hostSessionRef: string,
	fence: number,
	operationId = "generation:conversation-fixture:1",
) {
	return {
		...base(hostSessionRef),
		operation: {
			kind: "generation" as const,
			id: operationId,
			deliveryFence: fence,
			executionDeliveryFence: fence,
		},
	};
}

function guard(hostSessionRef: string, store: FileRuntimeStore) {
	return {
		nativeSessionRef: store.nativeSessionRef(hostSessionRef) as string,
		executionId: "execution-fixture",
		runtimeOperationId: "execution-fixture",
		operationRef: "model-fact-1",
		attemptRef: "attempt-1",
		kind: "model" as const,
	};
}

describe("Runtime V3 durable authorization", () => {
	it.each(["user", "application"] as const)(
		"resolves the original %s for private bootstrap before native Session creation",
		async (kind) => {
			const request = signV3Fixture(
				{
					...submitV3Fixture(),
					principal: { kind, id: "original-principal" },
				},
				"turn.submit",
			);
			const reference = {
				agentId: request.agentId,
				conversationId: request.conversationId,
				sessionGeneration: request.sessionGeneration,
				executionId: request.executionId,
			};
			let observed: unknown;
			const env = await setup({
				afterOperationPrepared: async () => {
					observed = await env.host.resolveOriginalExecutionBinding(reference);
					const saved = JSON.parse(await readFile(env.storePath, "utf8"));
					expect(Object.values(saved.sessions)).toHaveLength(1);
					expect(Object.values(saved.sessions)[0]).not.toHaveProperty(
						"nativeSessionRef",
					);
				},
			});
			await expect(
				env.host.resolveOriginalExecutionBinding(reference),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			const accepted = await env.host.submitTurnV3(
				request,
				verifyRuntimeV2Fixture(request.grant),
			);
			expect(observed).toEqual({
				principal: request.principal,
				scope: reference,
			});
			const nativeSessionRef = env.store.nativeSessionRef(
				accepted.hostSessionRef,
			);
			await expect(
				env.host.resolveOriginalExecutionBinding({
					...reference,
					nativeSessionRef,
				}),
			).resolves.toEqual(observed);
			for (const patch of [
				{ executionId: "other-execution" },
				{ agentId: "other-agent" },
				{ conversationId: "other-conversation" },
				{ sessionGeneration: 2 },
				{ nativeSessionRef: "other-native-session" },
			])
				await expect(
					env.host.resolveOriginalExecutionBinding({ ...reference, ...patch }),
				).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			env.clock.now += 30_000;
			await expect(
				env.host.resolveOriginalExecutionBinding(reference),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		},
	);

	it("rejects an external action before the Driver native session ref is persisted", async () => {
		let authorized: Promise<void> | undefined;
		const env = await setup({
			afterOperationPrepared: () => {
				const pending = env.store.authorizeExternalAction(
					{
						nativeSessionRef: "native-session-created-by-driver",
						executionId: "execution-fixture",
						runtimeOperationId: "execution-fixture",
						operationRef: "model-fact-1",
						attemptRef: "attempt-1",
						kind: "model",
					},
					() => env.clock.now,
				);
				authorized = pending;
				void pending.catch(() => undefined);
			},
		});
		await submit(env.host);
		await expect(authorized).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
	});

	it("replays a resolved submit while its execution is under recovery query authority", async () => {
		const env = await setup();
		const unsigned = {
			...submitV3Fixture(),
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "model-option-primary",
				reasoningLevel: "high",
			},
		};
		const request = signV3Fixture(unsigned, "turn.submit");
		const accepted = await env.host.submitTurnV3(
			request,
			verifyRuntimeV2Fixture(request.grant),
		);
		const recovery = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(unsigned),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		await env.host.recoverStatusV3(
			recovery,
			verifyRuntimeV2Fixture(recovery.grant),
		);
		await expect(
			env.host.submitTurnV3(request, verifyRuntimeV2Fixture(request.grant)),
		).resolves.toMatchObject({
			result: { outcome: "accepted" },
			hostSessionRef: accepted.hostSessionRef,
		});
	});

	it("waits for queued revocation and never treats control authority as private bootstrap permission", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const request = base(accepted.hostSessionRef);
		const reference = {
			agentId: request.agentId,
			conversationId: request.conversationId,
			sessionGeneration: request.sessionGeneration,
			executionId: request.executionId,
		};
		const control = signV3Fixture(
			{ ...request, originalOperationDigest: originalDigest() },
			"session.status",
			{ purpose: "control" },
		);
		const revoked = env.store.authorizeRequestV3(
			verifyRuntimeV2Fixture(control.grant).claims,
		);
		await expect(
			env.host.resolveOriginalExecutionBinding(reference),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		await revoked;
		const reopened = await RuntimeHost.open({
			...env.hostOptions,
			store: await FileRuntimeStore.open(env.storePath),
		});
		await expect(
			reopened.resolveOriginalExecutionBinding(reference),
		).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
	});
	it.each([
		{ failure: "session_recovery_failed", missingReceipt: false },
		{ failure: "session_recovery_failed", missingReceipt: true },
		{ failure: "unavailable", missingReceipt: false },
	] as const)(
		"reports $failure with missingReceipt=$missingReceipt without replacing work",
		async ({ failure, missingReceipt }) => {
			const env = await setup();
			const accepted = await submit(env.host);
			const before = JSON.parse(await readFile(env.storePath, "utf8"));
			vi.spyOn(env.driver, "getStatus").mockRejectedValue(
				new RuntimeHostError(
					"PRIVATE_DRIVER_DIAGNOSTIC",
					"sensitive synthetic diagnostic",
					503,
					true,
					failure,
				),
			);
			const reopened = await RuntimeHost.open({
				...env.hostOptions,
				store: await FileRuntimeStore.open(env.storePath),
			});
			const request = signV3Fixture(
				{
					...base(missingReceipt ? null : accepted.hostSessionRef),
					originalOperationDigest: originalDigest(),
				},
				"session.status",
			);
			const recovery = reopened.recoverStatusV3(
				request,
				verifyRuntimeV2Fixture(request.grant),
			);
			if (failure === "session_recovery_failed") {
				await expect(recovery).resolves.toEqual({
					schemaVersion: 3,
					hostSessionRef: accepted.hostSessionRef,
					executionId: "execution-fixture",
					outcome: "recovery_failed",
					code: "RUNTIME_SESSION_RECOVERY_FAILED",
				});
			} else {
				await expect(recovery).rejects.toMatchObject({
					code: "RUNTIME_DRIVER_INVALID",
				});
			}
			const afterText = await readFile(env.storePath, "utf8");
			const after = JSON.parse(afterText);
			expect(after.sessions[accepted.hostSessionRef].sessionGeneration).toBe(
				before.sessions[accepted.hostSessionRef].sessionGeneration,
			);
			expect(after.sessions[accepted.hostSessionRef].operations).toEqual(
				before.sessions[accepted.hostSessionRef].operations,
			);
			expect(afterText).not.toContain("sensitive synthetic");
			expect(await env.driver.sideEffectCount()).toBe(1);
		},
	);

	it("binds a Session principal across restart and retains original operation bytes", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const before = JSON.parse(await readFile(env.storePath, "utf8"));
		const saved = before.sessions[accepted.hostSessionRef];
		expect(saved.authority).toEqual({
			principal: { kind: "user", id: "user-fixture" },
			channelId: "web",
		});
		expect(saved.operations["execution-fixture"].requestDigest).toBe(
			originalDigest(),
		);
		expect(saved.operations["execution-fixture"].command).not.toHaveProperty(
			"principal",
		);
		expect(await readFile(env.storePath, "utf8")).not.toContain(
			"runtime-execution-jws",
		);
		const reopened = await RuntimeHost.open({
			...env.hostOptions,
			store: await FileRuntimeStore.open(env.storePath),
		});
		for (const principal of [
			{ kind: "user" as const, id: "other-user" },
			{ kind: "application" as const, id: "user-fixture" },
		]) {
			const request = signV3Fixture(
				{
					...base(accepted.hostSessionRef),
					principal,
					originalOperationDigest: originalDigest(),
				},
				"session.status",
			);
			await expect(
				reopened.recoverStatusV3(
					request,
					verifyRuntimeV2Fixture(request.grant),
				),
			).rejects.toThrow();
		}
		expect(await env.driver.sideEffectCount()).toBe(1);
	});

	it("expires external-action authority and renews only the existing accepted execution", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const action = guard(accepted.hostSessionRef, env.store);
		await expect(
			env.host.authorizeExternalAction(action),
		).resolves.toBeUndefined();
		env.clock.now += 30_000;
		await expect(env.host.authorizeExternalAction(action)).rejects.toThrow();
		const renewal = signV3Fixture(
			base(accepted.hostSessionRef),
			"execution.renew",
			{ now: env.clock.now },
		);
		await expect(
			env.host.renewAuthorizationV3(
				renewal,
				verifyRuntimeV2Fixture(renewal.grant),
			),
		).resolves.toMatchObject({ expiresAt: env.clock.now + 30_000 });
		await expect(
			env.host.authorizeExternalAction(action),
		).resolves.toBeUndefined();
		const wrongFence = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				operation: {
					...base(accepted.hostSessionRef).operation,
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			},
			"execution.renew",
			{ now: env.clock.now },
		);
		await expect(
			env.host.renewAuthorizationV3(
				wrongFence,
				verifyRuntimeV2Fixture(wrongFence.grant),
			),
		).rejects.toThrow();
		const wrongRecord = signV3Fixture(
			base(accepted.hostSessionRef),
			"execution.renew",
			{
				now: env.clock.now,
				claims: { authorizationRecordId: "new-authority" },
			},
		);
		await expect(
			env.host.renewAuthorizationV3(
				wrongRecord,
				verifyRuntimeV2Fixture(wrongRecord.grant),
			),
		).rejects.toThrow();
	});

	it("persists a revocation lock and permits body-free recovery without enabling new actions", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const recovery = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{ purpose: "control" },
		);
		await expect(
			env.host.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "found", status: "running" });
		const store = await FileRuntimeStore.open(env.storePath);
		const reopened = await RuntimeHost.open({ ...env.hostOptions, store });
		await expect(
			reopened.authorizeExternalAction(guard(accepted.hostSessionRef, store)),
		).rejects.toThrow();
		const renewal = signV3Fixture(
			base(accepted.hostSessionRef),
			"execution.renew",
		);
		await expect(
			reopened.renewAuthorizationV3(
				renewal,
				verifyRuntimeV2Fixture(renewal.grant),
			),
		).rejects.toThrow();
		const weaken = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		await expect(
			reopened.recoverStatusV3(weaken, verifyRuntimeV2Fixture(weaken.grant)),
		).rejects.toThrow();
		expect(await env.driver.sideEffectCount()).toBe(1);
	});

	it("persists absence fencing with no Host reference and cannot create a native Turn", async () => {
		const env = await setup();
		const recovery = signV3Fixture(
			{ ...base(null), originalOperationDigest: originalDigest() },
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		await expect(
			env.host.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "not_found" });
		await expect(submit(env.host)).rejects.toThrow();
		expect(await env.driver.sideEffectCount()).toBe(0);
		const next = signV3Fixture(
			{
				...submitV3Fixture(),
				operation: {
					kind: "execution",
					id: "execution-fixture",
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			},
			"turn.submit",
		);
		await expect(
			env.host.submitTurnV3(next, verifyRuntimeV2Fixture(next.grant)),
		).resolves.toMatchObject({ result: { outcome: "accepted" } });
	});

	it("does not execute prepared business work at startup or through control recovery", async () => {
		const env = await setup({
			afterOperationPrepared: () => {
				throw new Error("synthetic crash");
			},
		});
		await expect(submit(env.host)).rejects.toThrow("synthetic crash");
		const reopened = await RuntimeHost.open({
			...env.hostOptions,
			afterOperationPrepared: undefined,
			store: await FileRuntimeStore.open(env.storePath),
		});
		expect(await env.driver.sideEffectCount()).toBe(0);
		const recovery = signV3Fixture(
			{ ...base(null), originalOperationDigest: originalDigest() },
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		await expect(
			reopened.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "found", status: "unknown" });
		expect(await env.driver.sideEffectCount()).toBe(0);
	});

	it("rechecks an unknown original receipt after restart without executing the Turn again", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const unavailableReceipt = vi
			.spyOn(env.driver, "lookupOperation")
			.mockResolvedValue({ state: "unknown" });
		const reopened = await RuntimeHost.open({
			...env.hostOptions,
			store: await FileRuntimeStore.open(env.storePath),
		});
		const recovery = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		await expect(
			reopened.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "found", status: "unknown" });
		unavailableReceipt.mockRestore();
		await expect(
			reopened.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "found", status: "running" });
		expect(await env.driver.sideEffectCount()).toBe(1);
	});

	it("waits for current V3 query authority before refreshing native status after restart", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const status = vi.spyOn(env.driver, "getStatus");
		const reopened = await RuntimeHost.open({
			...env.hostOptions,
			store: await FileRuntimeStore.open(env.storePath),
		});
		expect(status).not.toHaveBeenCalled();
		const original = {
			...base(accepted.hostSessionRef),
			operation: {
				...base(accepted.hostSessionRef).operation,
				deliveryFence: 3,
				executionDeliveryFence: 3,
			},
			originalOperationDigest: originalDigest(),
		};
		const recovery = signV3Fixture(original, "session.status", {
			purpose: "control",
			reason: "recovery",
		});
		await expect(
			reopened.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "found", status: "running" });
		expect(status).toHaveBeenCalledTimes(1);
		for (const invalid of [
			{
				...original,
				principal: { kind: "user" as const, id: "foreign-principal" },
			},
			{ ...original, agentId: "foreign-agent" },
			{ ...original, conversationId: "foreign-conversation" },
			{ ...original, executionId: "foreign-execution" },
			{ ...original, turnId: "foreign-turn" },
			{ ...original, sessionGeneration: 2 },
			{ ...original, originalOperationDigest: "0".repeat(64) },
			{
				...original,
				operation: {
					...original.operation,
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			},
		]) {
			const request = signV3Fixture(invalid, "session.status", {
				purpose: "control",
				reason: "recovery",
			});
			await expect(
				reopened.recoverStatusV3(
					request,
					verifyRuntimeV2Fixture(request.grant),
				),
			).rejects.toThrow();
		}
		expect(status).toHaveBeenCalledTimes(1);
		expect(await env.driver.sideEffectCount()).toBe(1);
	});

	it.each(["stop", "generation"] as const)(
		"defers prepared %s recovery at V3 startup until current control authority arrives",
		async (kind) => {
			let crash = false;
			const env = await setup({
				afterOperationPrepared: () => {
					if (crash) throw new Error("synthetic interruption crash");
				},
			});
			const accepted = await submit(env.host);
			const request = signV3Fixture(
				{
					...base(accepted.hostSessionRef),
					operation: {
						kind,
						id:
							kind === "stop"
								? "original-stop"
								: "generation:conversation-fixture:1",
						deliveryFence: 2,
						executionDeliveryFence: 1,
					},
				},
				kind === "stop" ? "turn.stop" : "generation.cancel",
				{
					purpose: "control",
					reason: kind === "stop" ? "stop" : "generation_isolation",
				},
			);
			const control = (host: RuntimeHost) =>
				kind === "stop"
					? host.stopV3(request, verifyRuntimeV2Fixture(request.grant))
					: host.cancelGenerationV3(
							request,
							verifyRuntimeV2Fixture(request.grant),
						);
			crash = true;
			await expect(control(env.host)).rejects.toThrow(
				"synthetic interruption crash",
			);
			const lookup = vi.spyOn(env.driver, "lookupOperation");
			const execute = vi.spyOn(env.driver, "execute");
			const status = vi.spyOn(env.driver, "getStatus");
			const reopened = await RuntimeHost.open({
				...env.hostOptions,
				afterOperationPrepared: undefined,
				store: await FileRuntimeStore.open(env.storePath),
			});
			expect(
				lookup.mock.calls.every(([command]) => command.kind === "submit-turn"),
			).toBe(true);
			expect(execute).not.toHaveBeenCalled();
			expect(status).not.toHaveBeenCalled();
			await expect(control(reopened)).resolves.toMatchObject({
				result: { outcome: "accepted", status: "cancelled" },
			});
			expect(await env.driver.sideEffectCount()).toBe(2);
		},
	);

	it("isolates the original generation under a higher Execution fence without recovering business work", async () => {
		const env = await setup();
		try {
			const accepted = await submit(env.host);
			const before = JSON.parse(await readFile(env.storePath, "utf8")).sessions[
				accepted.hostSessionRef
			];
			const execute = vi.spyOn(env.driver, "execute");
			const status = vi.spyOn(env.driver, "getStatus");
			const request = signV3Fixture(
				{
					...base(accepted.hostSessionRef),
					operation: {
						kind: "generation" as const,
						id: "generation:conversation-fixture:1",
						deliveryFence: 2,
						executionDeliveryFence: 2,
					},
				},
				"generation.cancel",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await expect(
				env.host.cancelGenerationV3(
					request,
					verifyRuntimeV2Fixture(request.grant),
				),
			).resolves.toMatchObject({
				operationId: "generation:conversation-fixture:1",
				result: { outcome: "accepted", status: "cancelled" },
			});
			const after = JSON.parse(await readFile(env.storePath, "utf8")).sessions[
				accepted.hostSessionRef
			];
			expect(after).toMatchObject({
				nativeSessionRef: before.nativeSessionRef,
				sessionGeneration: 1,
				highestFences: { "execution:execution-fixture": 2 },
				executionAuthorities: {
					"execution-fixture": {
						executionDeliveryFence: 2,
						stopped: true,
						expiresAt: 0,
						control: { reason: "generation_isolation" },
					},
				},
				generationBarrier: {
					tombstoneId: "generation:conversation-fixture:1",
					state: "confirmed",
				},
			});
			expect(after.operations["execution-fixture"]).toEqual({
				...before.operations["execution-fixture"],
				deliveryFence: 2,
			});
			expect(execute.mock.calls.map(([command]) => command.kind)).toEqual([
				"generation-cancel",
			]);
			expect(status).not.toHaveBeenCalled();
			await expect(
				env.host.authorizeExternalAction(
					guard(accepted.hostSessionRef, env.store),
				),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
		} finally {
			await env.host.close();
		}
	});

	it.each(["generation:conversation-fixture:1", "synthetic-generation"])(
		"retries opaque generation cancellation %s after a lost receipt and restart without repeating its effect",
		async (operationId) => {
			const env = await setup();
			let host = env.host;
			try {
				const accepted = await submit(host);
				const first = signV3Fixture(
					generationCancelFixture(accepted.hostSessionRef, 2, operationId),
					"generation.cancel",
					{ purpose: "control", reason: "generation_isolation" },
				);
				await host.cancelGenerationV3(
					first,
					verifyRuntimeV2Fixture(first.grant),
				);
				await host.close();
				host = await RuntimeHost.open({
					...env.hostOptions,
					store: await FileRuntimeStore.open(env.storePath),
				});
				const retry = signV3Fixture(
					generationCancelFixture(accepted.hostSessionRef, 3, operationId),
					"generation.cancel",
					{ purpose: "control", reason: "generation_isolation" },
				);
				await expect(
					host.cancelGenerationV3(retry, verifyRuntimeV2Fixture(retry.grant)),
				).resolves.toMatchObject({
					operationId: first.operation.id,
					result: { outcome: "accepted", status: "cancelled" },
				});
				const saved = await readFile(env.storePath, "utf8");
				const session = JSON.parse(saved).sessions[accepted.hostSessionRef];
				expect(session).toMatchObject({
					highestFences: {
						"execution:execution-fixture": 3,
						"generation:1": 3,
					},
					executionAuthorities: {
						"execution-fixture": { executionDeliveryFence: 3, stopped: true },
					},
					generationBarrier: {
						state: "confirmed",
						tombstoneId: first.operation.id,
					},
				});
				for (const invalid of [
					first,
					signV3Fixture(
						generationCancelFixture(
							accepted.hostSessionRef,
							4,
							"different-tombstone",
						),
						"generation.cancel",
						{ purpose: "control", reason: "generation_isolation" },
					),
					signV3Fixture(
						{
							...generationCancelFixture(
								accepted.hostSessionRef,
								4,
								operationId,
							),
							operation: {
								...retry.operation,
								deliveryFence: 2,
								executionDeliveryFence: 4,
							},
						},
						"generation.cancel",
						{ purpose: "control", reason: "generation_isolation" },
					),
					signV3Fixture(
						generationCancelFixture(accepted.hostSessionRef, 4, operationId),
						"generation.cancel",
						{
							purpose: "control",
							reason: "generation_isolation",
							claims: { controlRecordId: "different-tombstone-authority" },
						},
					),
				]) {
					await expect(
						host.cancelGenerationV3(
							invalid,
							verifyRuntimeV2Fixture(invalid.grant),
						),
					).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
					expect(await readFile(env.storePath, "utf8")).toBe(saved);
				}
				expect(await env.driver.sideEffectCount()).toBe(2);
			} finally {
				await host.close();
			}
		},
	);

	it("rejects foreign or non-isolation generation controls before changing the original durable authority", async () => {
		const env = await setup();
		try {
			const accepted = await submit(env.host);
			const original = generationCancelFixture(accepted.hostSessionRef, 2);
			const saved = await readFile(env.storePath, "utf8");
			const execute = vi.spyOn(env.driver, "execute");
			for (const invalid of [
				...[
					{ principal: { kind: "user" as const, id: "foreign-user" } },
					{ channelId: "foreign-channel" },
					{ agentId: "foreign-agent" },
					{ conversationId: "foreign-conversation" },
					{ executionId: "foreign-execution" },
					{ turnId: "foreign-turn" },
					{ sessionGeneration: 2 },
					{ hostSessionRef: "foreign-host" },
					{ operation: { ...original.operation, kind: "execution" as const } },
				].map((patch) =>
					signV3Fixture({ ...original, ...patch }, "generation.cancel", {
						purpose: "control",
						reason: "generation_isolation",
					}),
				),
				signV3Fixture(original, "generation.cancel", {
					purpose: "control",
					reason: "recovery",
				}),
				signV3Fixture(original, "session.status", {
					purpose: "control",
					reason: "generation_isolation",
				}),
				signV3Fixture(original, "session.status"),
				signV3Fixture(original, "generation.cancel", {
					purpose: "control",
					reason: "generation_isolation",
					claims: { workerId: "foreign-worker" },
				}),
			]) {
				await expect(
					env.host.cancelGenerationV3(
						invalid,
						verifyRuntimeV2Fixture(invalid.grant),
					),
				).rejects.toMatchObject({ httpStatus: 403 });
				expect(await readFile(env.storePath, "utf8")).toBe(saved);
			}
			expect(execute).not.toHaveBeenCalled();
		} finally {
			await env.host.close();
		}
	});

	it("does not rebind an existing tombstone to another original Execution in the same generation", async () => {
		const env = await setup();
		try {
			const accepted = await submit(env.host);
			await env.driver.setOperationStatus("execution-fixture", "completed");
			const second = signV3Fixture(
				{
					...submitV3Fixture(),
					hostSessionRef: accepted.hostSessionRef,
					executionId: "second-execution",
					turnId: "second-turn",
					operation: {
						...base(accepted.hostSessionRef).operation,
						id: "second-execution",
					},
				},
				"turn.submit",
			);
			await env.host.submitTurnV3(second, verifyRuntimeV2Fixture(second.grant));
			const first = signV3Fixture(
				generationCancelFixture(accepted.hostSessionRef, 2),
				"generation.cancel",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await env.host.cancelGenerationV3(
				first,
				verifyRuntimeV2Fixture(first.grant),
			);
			const saved = await readFile(env.storePath, "utf8");
			const rebound = signV3Fixture(
				{
					...generationCancelFixture(accepted.hostSessionRef, 3),
					executionId: second.executionId,
					turnId: second.turnId,
				},
				"generation.cancel",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await expect(
				env.host.cancelGenerationV3(
					rebound,
					verifyRuntimeV2Fixture(rebound.grant),
				),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			expect(await readFile(env.storePath, "utf8")).toBe(saved);
		} finally {
			await env.host.close();
		}
	});

	it("keeps generation authority fail closed across a crash before barrier preparation", async () => {
		const env = await setup();
		let host = env.host;
		try {
			const accepted = await submit(host);
			await env.driver.makeOperationUnknown("execution-fixture");
			await host.close();
			const recoveringStore = await FileRuntimeStore.open(env.storePath);
			host = await RuntimeHost.open({
				...env.hostOptions,
				store: recoveringStore,
			});
			const before = JSON.parse(await readFile(env.storePath, "utf8")).sessions[
				accepted.hostSessionRef
			];
			expect(before.operations["execution-fixture"].result.outcome).toBe(
				"unknown",
			);
			const driverBefore = await readFile(
				join(env.directory, "driver.json"),
				"utf8",
			);
			const execute = vi.spyOn(env.driver, "execute");
			const status = vi.spyOn(env.driver, "getStatus");
			// Fail only the next persistence boundary after the real authority commit.
			vi.spyOn(recoveringStore, "prepareOperation").mockRejectedValueOnce(
				new Error("synthetic crash before barrier preparation"),
			);
			const first = signV3Fixture(
				generationCancelFixture(accepted.hostSessionRef, 2),
				"generation.cancel",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await expect(
				host.cancelGenerationV3(first, verifyRuntimeV2Fixture(first.grant)),
			).rejects.toThrow("synthetic crash before barrier preparation");
			const interrupted = JSON.parse(await readFile(env.storePath, "utf8"))
				.sessions[accepted.hostSessionRef];
			expect(interrupted).toMatchObject({
				nativeSessionRef: before.nativeSessionRef,
				sessionGeneration: 1,
				highestFences: { "execution:execution-fixture": 2 },
				executionAuthorities: {
					"execution-fixture": {
						executionDeliveryFence: 2,
						stopped: true,
						expiresAt: 0,
						control: {
							controlRecordId: "control-fixture",
							reason: "generation_isolation",
						},
					},
				},
			});
			expect(interrupted).not.toHaveProperty("generationBarrier");
			expect(interrupted.operations).toEqual({
				"execution-fixture": {
					...before.operations["execution-fixture"],
					deliveryFence: 2,
				},
			});
			expect(await readFile(join(env.directory, "driver.json"), "utf8")).toBe(
				driverBefore,
			);
			await host.close();
			const reopenedStore = await FileRuntimeStore.open(env.storePath);
			host = await RuntimeHost.open({
				...env.hostOptions,
				store: reopenedStore,
			});
			await expect(
				host.authorizeExternalAction(
					guard(accepted.hostSessionRef, reopenedStore),
				),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			const retry = signV3Fixture(
				generationCancelFixture(accepted.hostSessionRef, 3),
				"generation.cancel",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await expect(
				host.cancelGenerationV3(retry, verifyRuntimeV2Fixture(retry.grant)),
			).resolves.toMatchObject({
				result: { outcome: "accepted", status: "cancelled" },
			});
			expect(execute.mock.calls.map(([command]) => command.kind)).toEqual([
				"generation-cancel",
			]);
			expect(status).not.toHaveBeenCalled();
		} finally {
			await host.close();
		}
	});

	it("rejects a superseded generation claim before Driver dispatch", async () => {
		const env = await setup();
		try {
			const accepted = await submit(env.host);
			const execute = vi.spyOn(env.driver, "execute");
			const [older, newer] = await Promise.allSettled(
				[2, 3].map((fence) => {
					const request = signV3Fixture(
						generationCancelFixture(accepted.hostSessionRef, fence),
						"generation.cancel",
						{ purpose: "control", reason: "generation_isolation" },
					);
					return env.host.cancelGenerationV3(
						request,
						verifyRuntimeV2Fixture(request.grant),
					);
				}),
			);
			expect(older).toMatchObject({
				status: "rejected",
				reason: { code: "RUNTIME_FENCE_STALE" },
			});
			expect(newer).toMatchObject({
				status: "fulfilled",
				value: { result: { outcome: "accepted", status: "cancelled" } },
			});
			expect(execute.mock.calls.map(([command]) => command.kind)).toEqual([
				"generation-cancel",
			]);
		} finally {
			await env.host.close();
		}
	});

	it("does not let event queries or renewal adopt a higher Execution fence", async () => {
		const env = await setup();
		try {
			const accepted = await submit(env.host);
			const original = base(accepted.hostSessionRef);
			const higher = {
				...original,
				operation: {
					...original.operation,
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			};
			const saved = await readFile(env.storePath, "utf8");
			const renewal = signV3Fixture(higher, "execution.renew");
			await expect(
				env.host.renewAuthorizationV3(
					renewal,
					verifyRuntimeV2Fixture(renewal.grant),
				),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			const query = signV3Fixture(
				{
					...higher,
					consumer: "platform_worker_persistence" as const,
					afterCursor: null,
				},
				"events.persist",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await expect(
				env.host.streamEventsV3(query, verifyRuntimeV2Fixture(query.grant)),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			const ack = signV3Fixture(
				{
					...higher,
					consumer: "platform_worker_persistence" as const,
					confirmedCursor: "cursor-1",
				},
				"events.ack",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await expect(
				env.host.acknowledgeEventsV3(ack, verifyRuntimeV2Fixture(ack.grant)),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			expect(await readFile(env.storePath, "utf8")).toBe(saved);
		} finally {
			await env.host.close();
		}
	});

	it("keeps unknown acceptance unresolved when later business retries cannot find the original receipt", async () => {
		const env = await setup();
		await submit(env.host);
		const lookup = vi
			.spyOn(env.driver, "lookupOperation")
			.mockResolvedValue({ state: "unknown" });
		const reopened = await RuntimeHost.open({
			...env.hostOptions,
			store: await FileRuntimeStore.open(env.storePath),
		});
		lookup.mockResolvedValue({ state: "missing" });
		const execute = vi.spyOn(env.driver, "execute");
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(submit(reopened)).resolves.toMatchObject({
				result: { outcome: "unknown" },
			});
		}
		expect(execute).not.toHaveBeenCalled();
		expect(await env.driver.sideEffectCount()).toBe(1);
	});

	it("does not let the first V3 caller claim legacy ownership; protected migration checks the original history", async () => {
		const env = await setup();
		const legacy = await RuntimeHost.open({
			store: env.store,
			driver: env.driver,
			grantValidation: env.hostOptions.grantValidation,
		});
		const fixture = submitV3Fixture();
		const {
			principal: _principal,
			operation: _operation,
			hostSessionRef: _ref,
			...old
		} = fixture;
		const legacyRequest = {
			...old,
			schemaVersion: 1 as const,
			actorId: fixture.principal.id,
			deliveryFence: 1,
			grant: runtimeGrantFixture({ ...old, actorId: fixture.principal.id }, [
				"turn.submit",
			]),
		};
		const accepted = await legacy.submitTurn(
			legacyRequest,
			verificationForRuntimeGrant(legacyRequest.grant),
		);
		const recovery = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(),
			},
			"session.status",
		);
		await expect(
			env.host.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).rejects.toThrow();
		const proof = {
			migrationId: "deployment-proof",
			...base(accepted.hostSessionRef),
			hostSessionRef: accepted.hostSessionRef,
			executions: [
				{
					executionId: fixture.executionId,
					turnId: fixture.turnId,
					originalOperationDigest: originalDigest(),
				},
			],
		};
		await expect(
			env.store.migrateLegacyPrincipal({
				...proof,
				executions: [
					{
						executionId: fixture.executionId,
						turnId: fixture.turnId,
						originalOperationDigest: "b".repeat(43),
					},
				],
			}),
		).rejects.toThrow();
		await env.store.migrateLegacyPrincipal(proof);
		await expect(
			env.host.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "found" });
		await expect(
			legacy.submitTurn(
				legacyRequest,
				verificationForRuntimeGrant(legacyRequest.grant),
			),
		).rejects.toThrow();
	});

	it("recovers and stops principal-only legacy work under one immutable migration control record", async () => {
		const env = await setup();
		const legacy = await RuntimeHost.open({
			store: env.store,
			driver: env.driver,
			grantValidation: env.hostOptions.grantValidation,
		});
		const fixture = submitV3Fixture();
		const {
			principal: _principal,
			operation: _operation,
			hostSessionRef: _ref,
			...old
		} = fixture;
		const request = {
			...old,
			schemaVersion: 1 as const,
			actorId: fixture.principal.id,
			deliveryFence: 1,
			grant: runtimeGrantFixture({ ...old, actorId: fixture.principal.id }, [
				"turn.submit",
			]),
		};
		const accepted = await legacy.submitTurn(
			request,
			verificationForRuntimeGrant(request.grant),
		);
		await env.store.migrateLegacyPrincipal({
			...base(accepted.hostSessionRef),
			hostSessionRef: accepted.hostSessionRef,
			migrationId: "verified-migration",
			executions: [
				{
					executionId: fixture.executionId,
					turnId: fixture.turnId,
					originalOperationDigest: originalDigest(),
				},
			],
		});
		const provenance = {
			purpose: "control" as const,
			reason: "recovery" as const,
			claims: { controlRecordId: "verified-migration" },
		};
		const recovery = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			provenance,
		);
		await expect(
			env.host.recoverStatusV3(
				recovery,
				verifyRuntimeV2Fixture(recovery.grant),
			),
		).resolves.toMatchObject({ outcome: "found", status: "running" });
		expect(await env.driver.sideEffectCount()).toBe(1);
		await expect(
			env.host.authorizeExternalAction(
				guard(accepted.hostSessionRef, env.store),
			),
		).rejects.toThrow();
		const stop = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				hostSessionRef: accepted.hostSessionRef,
				operation: {
					kind: "stop" as const,
					id: "legacy-stop",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
			},
			"turn.stop",
			provenance,
		);
		await expect(
			env.host.stopV3(stop, verifyRuntimeV2Fixture(stop.grant)),
		).resolves.toMatchObject({
			result: { outcome: "accepted", status: "cancelled" },
		});
		await expect(
			env.host.stopV3(stop, verifyRuntimeV2Fixture(stop.grant)),
		).resolves.toMatchObject({
			result: { outcome: "accepted", status: "cancelled" },
		});
		expect(await env.driver.sideEffectCount()).toBe(2);
		const saved = JSON.parse(await readFile(env.storePath, "utf8"));
		const authority =
			saved.sessions[accepted.hostSessionRef].executionAuthorities[
				fixture.executionId
			];
		expect(authority).toMatchObject({
			stopped: true,
			control: { controlRecordId: "verified-migration", reason: "recovery" },
		});
		expect(authority).not.toHaveProperty("authorizationRecordId");
	});

	it("expires an idle event stream and checks revocation again before delivery", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const request = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				hostSessionRef: accepted.hostSessionRef,
				consumer: "platform_worker_persistence" as const,
				afterCursor: null,
			},
			"events.persist",
		);
		vi.useFakeTimers();
		const stream = await env.host.streamEventsV3(
			request,
			verifyRuntimeV2Fixture(request.grant),
		);
		const iterator = stream[Symbol.asyncIterator]();
		expect((await iterator.next()).done).toBe(false);
		const pending = expect(iterator.next()).rejects.toThrow(
			"Runtime authorization expired",
		);
		env.clock.now += 30_000;
		await vi.advanceTimersByTimeAsync(30_000);
		await pending;
	});

	it("acknowledges only a delivered cursor under a fresh Worker persistence grant", async () => {
		const env = await setup();
		const order: string[] = [];
		vi.spyOn(env.store, "acknowledgeCursor").mockImplementation(
			async (...args) => {
				order.push("store");
				return FileRuntimeStore.prototype.acknowledgeCursor.apply(
					env.store,
					args,
				);
			},
		);
		(
			env.driver as typeof env.driver & {
				acknowledgeEvents: () => Promise<void>;
			}
		).acknowledgeEvents = async () => {
			order.push("driver");
		};
		const accepted = await submit(env.host);
		const eventBase = {
			...base(accepted.hostSessionRef),
			hostSessionRef: accepted.hostSessionRef,
			consumer: "platform_worker_persistence" as const,
		};
		const request = signV3Fixture(
			{ ...eventBase, afterCursor: null },
			"events.persist",
		);
		const stream = await env.host.streamEventsV3(
			request,
			verifyRuntimeV2Fixture(request.grant),
		);
		const iterator = stream[Symbol.asyncIterator]();
		const first = await iterator.next();
		if (first.done) throw new Error("missing synthetic status");
		const forged = signV3Fixture(
			{ ...eventBase, confirmedCursor: "unseen-cursor" },
			"events.ack",
		);
		await expect(
			env.host.acknowledgeEventsV3(
				forged,
				verifyRuntimeV2Fixture(forged.grant),
			),
		).rejects.toThrow();
		const ack = signV3Fixture(
			{ ...eventBase, confirmedCursor: first.value.cursor },
			"events.ack",
		);
		const supplement = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				hostSessionRef: accepted.hostSessionRef,
				operation: {
					kind: "message" as const,
					id: "message-second",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
				input: { text: "synthetic continuation", attachments: [] },
			},
			"turn.supplement",
		);
		await env.host.supplementV3(
			supplement,
			verifyRuntimeV2Fixture(supplement.grant),
		);
		const second = await iterator.next();
		if (second.done) throw new Error("missing synthetic continuation");
		await expect(
			env.host.acknowledgeEventsV3(ack, verifyRuntimeV2Fixture(ack.grant)),
		).resolves.toMatchObject({ confirmedCursor: first.value.cursor });
		expect(order.slice(0, 2)).toEqual(["store", "driver"]);
		const nextAck = signV3Fixture(
			{ ...eventBase, confirmedCursor: second.value.cursor },
			"events.ack",
		);
		await env.host.acknowledgeEventsV3(
			nextAck,
			verifyRuntimeV2Fixture(nextAck.grant),
		);
		await expect(
			env.host.acknowledgeEventsV3(ack, verifyRuntimeV2Fixture(ack.grant)),
		).resolves.toMatchObject({ confirmedCursor: first.value.cursor });
		const saved = JSON.parse(await readFile(env.storePath, "utf8"));
		expect(
			saved.sessions[accepted.hostSessionRef].executionAuthorities[
				"execution-fixture"
			].confirmedCursor,
		).toBe(second.value.cursor);
		await iterator.return(undefined);
	});
	it("persists business stop before returning and never renews stopped execution rights", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const stop = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				operation: {
					kind: "stop",
					id: "stop-fixture",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
			},
			"turn.stop",
		);
		await expect(
			env.host.stopV3(stop, verifyRuntimeV2Fixture(stop.grant)),
		).resolves.toMatchObject({
			result: { outcome: "accepted", status: "cancelled" },
		});
		const renewal = signV3Fixture(
			base(accepted.hostSessionRef),
			"execution.renew",
		);
		await expect(
			env.host.renewAuthorizationV3(
				renewal,
				verifyRuntimeV2Fixture(renewal.grant),
			),
		).rejects.toThrow();
		await expect(
			env.host.authorizeExternalAction(
				guard(accepted.hostSessionRef, env.store),
			),
		).rejects.toThrow();
	});

	it("clears a prior stop lock when applying trusted recovery authority", () => {
		const authorities: Record<string, RuntimeExecutionAuthority> = {};
		const stop = verifyRuntimeV2Fixture(
			signV3Fixture(
				{
					...base("host-fixture"),
					operation: {
						kind: "execution",
						id: "execution-fixture",
						deliveryFence: 1,
						executionDeliveryFence: 1,
					},
				},
				"session.status",
				{
					purpose: "control",
					reason: "stop",
					claims: { controlRecordId: "first-control" },
				},
			).grant,
		).claims;
		applyRuntimeAuthority(authorities, stop, "prepare");
		expect(authorities["execution-fixture"]?.stopped).toBe(true);
		const conflicting = verifyRuntimeV2Fixture(
			signV3Fixture(
				{
					...base("host-fixture"),
					operation: {
						kind: "execution",
						id: "execution-fixture",
						deliveryFence: 1,
						executionDeliveryFence: 1,
					},
				},
				"session.status",
				{
					purpose: "control",
					reason: "recovery",
					claims: { controlRecordId: "second-control" },
				},
			).grant,
		).claims;
		expect(() =>
			applyRuntimeAuthority(authorities, conflicting, "query"),
		).toThrow();

		const recovery = verifyRuntimeV2Fixture(
			signV3Fixture(
				{
					...base("host-fixture"),
					operation: {
						kind: "execution",
						id: "execution-fixture",
						deliveryFence: 2,
						executionDeliveryFence: 2,
					},
				},
				"session.status",
				{ purpose: "control", reason: "recovery" },
			).grant,
		).claims;
		applyRuntimeAuthority(authorities, recovery, "query");
		expect(authorities["execution-fixture"]).not.toHaveProperty("stopped");

		const business = verifyRuntimeV2Fixture(
			signV3Fixture(
				{
					...base("host-fixture"),
					operation: {
						kind: "execution",
						id: "execution-fixture",
						deliveryFence: 3,
						executionDeliveryFence: 3,
					},
				},
				"turn.submit",
			).grant,
		).claims;
		expect(() =>
			applyRuntimeAuthority(authorities, business, "prepare"),
		).not.toThrow();
	});

	it("does not deliver a queued event after a persisted revocation", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const request = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				consumer: "platform_worker_persistence" as const,
				afterCursor: null,
			},
			"events.persist",
		);
		const stream = await env.host.streamEventsV3(
			request,
			verifyRuntimeV2Fixture(request.grant),
		);
		const recovery = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{ purpose: "control" },
		);
		await env.host.recoverStatusV3(
			recovery,
			verifyRuntimeV2Fixture(recovery.grant),
		);
		await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow();
	});

	it("expires while a Driver subscription ignores cancellation", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const subscribe = vi
			.spyOn(env.driver, "subscribeEvents")
			.mockImplementation(() => new Promise(() => {}));
		const request = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				consumer: "platform_worker_persistence" as const,
				afterCursor: null,
			},
			"events.persist",
		);
		vi.useFakeTimers();
		const rejected = expect(
			env.host.streamEventsV3(request, verifyRuntimeV2Fixture(request.grant)),
		).rejects.toThrow("Runtime authorization expired");
		await vi.waitFor(() => expect(subscribe).toHaveBeenCalled());
		env.clock.now += 30_000;
		await vi.advanceTimersByTimeAsync(30_000);
		await rejected;
	});
	it("waits for an already queued revocation before authorizing an external action", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		const control = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{ purpose: "control" },
		);
		const pendingRevocation = env.store.authorizeRequestV3(
			verifyRuntimeV2Fixture(control.grant).claims,
		);
		await expect(
			env.host.authorizeExternalAction(
				guard(accepted.hostSessionRef, env.store),
			),
		).rejects.toThrow();
		await pendingRevocation;
	});

	it.each(["model", "tool"] as const)(
		"rejects %s authorization when its Grant expires while a durable write is pending",
		async (kind) => {
			const env = await setup();
			const accepted = await submit(env.host);
			const handle = await open(env.directory, "r");
			const prototype = Object.getPrototypeOf(handle) as FileHandle;
			await handle.close();
			const sync = prototype.sync;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const blocked = vi
				.spyOn(prototype, "sync")
				.mockImplementationOnce(async function (this: FileHandle) {
					entered.resolve();
					await release.promise;
					return sync.call(this);
				});
			const pendingWrite = env.store.resolveOperation(
				accepted.hostSessionRef,
				accepted.operationId,
				accepted.result,
			);
			try {
				await entered.promise;
				let settled = false;
				const authorization = env.host
					.authorizeExternalAction({
						...guard(accepted.hostSessionRef, env.store),
						kind,
					})
					.then(
						() => ({ decision: "allowed" }),
						(error: unknown) => ({ decision: "denied", error }),
					)
					.finally(() => {
						settled = true;
					});
				await Promise.resolve();
				expect(settled).toBe(false);
				env.clock.now += 30_000;
				release.resolve();
				await pendingWrite;
				await expect(authorization).resolves.toMatchObject({
					decision: "denied",
					error: { code: "RUNTIME_GRANT_INVALID", httpStatus: 403 },
				});
			} finally {
				release.resolve();
				await pendingWrite;
				blocked.mockRestore();
			}
		},
	);
});

describe("Runtime V3 original evidence read contexts", () => {
	it("reads terminal history under fresh system authority and rejects older query passes without extending business expiry", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		await env.driver.setOperationStatus("execution-fixture", "completed");
		env.clock.now += 60_000;
		const observed: string[] = [];
		Object.assign(env.driver, {
			recoverOriginalEvidence: async (
				reference: { recoveryRequestId: string },
				read: import("./driver.js").RuntimeOriginalEvidenceReadContext,
			) => {
				expect(read.assertCurrent().principal).toEqual({
					kind: "user",
					id: "user-fixture",
				});
				await read.commit(async () => {
					read.assertCurrent();
					observed.push(reference.recoveryRequestId);
				});
			},
		});
		const query = (id: string, now = env.clock.now) =>
			signV3Fixture(
				{
					...base(accepted.hostSessionRef),
					requestId: id,
					originalOperationDigest: originalDigest(),
				},
				"session.status",
				{ purpose: "control", reason: "recovery", now },
			);
		const first = query("pass-1");
		expect(
			await env.host.recoverStatusV3(
				first,
				verifyRuntimeV2Fixture(first.grant),
			),
		).toMatchObject({ outcome: "found", status: "completed" });
		const sameTime = query("pass-2");
		await expect(
			env.host.recoverStatusV3(
				sameTime,
				verifyRuntimeV2Fixture(sameTime.grant),
			),
		).rejects.toThrow();
		env.clock.now += 1;
		const second = query("pass-2");
		await env.host.recoverStatusV3(
			second,
			verifyRuntimeV2Fixture(second.grant),
		);
		await env.host.close();
		const reopened = await RuntimeHost.open({
			...env.hostOptions,
			store: await FileRuntimeStore.open(env.storePath),
		});
		await expect(
			reopened.recoverStatusV3(first, verifyRuntimeV2Fixture(first.grant)),
		).rejects.toThrow();
		await reopened.close();
		expect(observed).toEqual(["pass-1", "pass-2"]);
		await expect(
			env.host.authorizeExternalAction(
				guard(accepted.hostSessionRef, env.store),
			),
		).rejects.toThrow();
		await env.host.close();
	});

	it("rejects a substituted recovery pass ID before any admission or durable write", async () => {
		const env = await setup();
		try {
			const accepted = await submit(env.host);
			await env.driver.setOperationStatus("execution-fixture", "completed");
			const observed: string[] = [];
			Object.assign(env.driver, {
				recoverOriginalEvidence: async (
					reference: { recoveryRequestId: string },
					read: import("./driver.js").RuntimeOriginalEvidenceReadContext,
				) => {
					await read.commit(async () => {
						observed.push(reference.recoveryRequestId);
					});
				},
			});
			const query = () =>
				signV3Fixture(
					{
						...base(accepted.hostSessionRef),
						requestId: "authorized-pass",
						originalOperationDigest: originalDigest(),
					},
					"session.status",
					{ purpose: "control", reason: "recovery", now: env.clock.now },
				);
			const first = query();
			await env.host.recoverStatusV3(
				first,
				verifyRuntimeV2Fixture(first.grant),
			);
			const before = await readFile(env.storePath, "utf8");
			env.clock.now += 1;
			const retry = query();
			await expect(
				env.host.recoverStatusV3(
					{ ...retry, requestId: "unauthorized-new-pass" },
					verifyRuntimeV2Fixture(retry.grant),
				),
			).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
			expect(observed).toEqual(["authorized-pass"]);
			expect(await readFile(env.storePath, "utf8")).toBe(before);
			await expect(
				env.host.recoverStatusV3(retry, verifyRuntimeV2Fixture(retry.grant)),
			).resolves.toMatchObject({ outcome: "found", status: "completed" });
			expect(observed).toEqual(["authorized-pass", "authorized-pass"]);
		} finally {
			await env.host.close();
		}
	});

	it("drains an entered durable commit before generation confirmation and drains an entered durable commit before confirmation", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		let entered!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let writes = 0;
		let latestRead:
			| import("./driver.js").RuntimeOriginalEvidenceReadContext
			| undefined;
		Object.assign(env.driver, {
			recoverOriginalEvidence: async (
				_reference: unknown,
				read: import("./driver.js").RuntimeOriginalEvidenceReadContext,
			) => {
				latestRead = read;
				await read.commit(async () => {
					entered();
					await released;
					writes++;
				});
			},
		});
		const query = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				requestId: "pass-1",
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		const querying = env.host.recoverStatusV3(
			query,
			verifyRuntimeV2Fixture(query.grant),
		);
		await enteredPromise;
		const cancel = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				requestId: "cancel",
				operation: {
					kind: "generation" as const,
					id: "generation:conversation-fixture:1",
					deliveryFence: 2,
					executionDeliveryFence: 1,
				},
			},
			"generation.cancel",
			{
				purpose: "control",
				reason: "generation_isolation",
				claims: { controlRecordId: "isolation-control" },
			},
		);
		let confirmed = false;
		const cancelling = env.host
			.cancelGenerationV3(cancel, verifyRuntimeV2Fixture(cancel.grant))
			.then((value) => {
				confirmed = true;
				return value;
			});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(confirmed).toBe(false);
		release();
		await Promise.allSettled([querying]);
		expect(await cancelling).toMatchObject({
			result: { outcome: "accepted", status: "cancelled" },
		});
		expect(writes).toBe(1);
		if (!latestRead) throw new Error("missing read context");
		await expect(
			latestRead.commit(async () => {
				writes++;
			}),
		).rejects.toThrow();
		const replay = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				requestId: "archive",
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{
				purpose: "control",
				reason: "generation_isolation",
				claims: { controlRecordId: "isolation-control" },
			},
		);
		await env.host.recoverStatusV3(
			replay,
			verifyRuntimeV2Fixture(replay.grant),
		);
		expect(writes).toBe(1);
		await env.host.close();
	});
	it("aborts a commit waiting behind the Host queue and never executes its write after release", async () => {
		const env = await setup();
		const accepted = await submit(env.host);
		let recovered!: () => void;
		const recoveryStarted = new Promise<void>((resolve) => {
			recovered = resolve;
		});
		let commitNow!: () => void;
		const commitReady = new Promise<void>((resolve) => {
			commitNow = resolve;
		});
		let writes = 0;
		Object.assign(env.driver, {
			recoverOriginalEvidence: async (
				_reference: unknown,
				read: import("./driver.js").RuntimeOriginalEvidenceReadContext,
			) => {
				recovered();
				await commitReady;
				await read.commit(async () => {
					writes++;
				});
			},
		});
		const request = signV3Fixture(
			{
				...base(accepted.hostSessionRef),
				requestId: "queued-pass",
				originalOperationDigest: originalDigest(),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		const controller = new AbortController();
		const querying = env.host.recoverStatusV3(
			request,
			verifyRuntimeV2Fixture(request.grant),
			controller.signal,
		);
		const settled = Promise.allSettled([querying]);
		await recoveryStarted;
		let occupied!: () => void;
		const queueOccupied = new Promise<void>((resolve) => {
			occupied = resolve;
		});
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const authorize = env.store.authorizeRequestV3.bind(env.store);
		vi.spyOn(env.store, "authorizeRequestV3").mockImplementationOnce(
			async (...args) => {
				occupied();
				await released;
				return authorize(...args);
			},
		);
		const renewal = signV3Fixture(
			base(accepted.hostSessionRef),
			"execution.renew",
		);
		const renewing = env.host.renewAuthorizationV3(
			renewal,
			verifyRuntimeV2Fixture(renewal.grant),
		);
		await queueOccupied;
		commitNow();
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort();
		expect((await settled)[0]?.status).toBe("rejected");
		release();
		await renewing;
		await env.host.close();
		expect(writes).toBe(0);
	});
	it("rejects unknown persisted execution authority fields", () => {
		const authority: RuntimeExecutionAuthority = {
			workerId: "worker",
			executionDeliveryFence: 1,
			issuedAt: fixtureNow - 1,
			expiresAt: fixtureNow + 1_000,
			deliveredCursors: [],
		};
		expect(validStoredExecutionAuthority(authority)).toBe(true);
		expect(
			validStoredExecutionAuthority({
				...authority,
				unexpected: true,
			} as RuntimeExecutionAuthority & { unexpected: boolean }),
		).toBe(false);
	});
});
