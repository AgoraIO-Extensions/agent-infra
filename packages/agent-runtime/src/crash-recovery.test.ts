import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExecutionGrantCommandV1,
	ExecutionGrantV1,
	RuntimeSubmitTurnRequestV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
	openIngressVerifiedRuntimeHost,
	runtimeGrantFixture,
	runtimeGrantRequestContext,
} from "./grant-fixture.test-support.js";
import { FakeRuntimeDriver, FileRuntimeStore } from "./index.js";

const directories: string[] = [];

interface MutableStoredOperation {
	command?: unknown;
	kind: string;
	result?: unknown;
	state?: string;
}

interface MutableStoredSession {
	hostSessionRef: string;
	highestFences: Record<string, unknown>;
	operations: Record<string, MutableStoredOperation>;
	generationBarrier?: unknown;
	recovery?: unknown;
}

interface MutableStoreState {
	sessionBindings: Record<string, string>;
	sessions: Record<string, MutableStoredSession>;
}

async function directory() {
	const value = await mkdtemp(join(tmpdir(), "agent-runtime-crash-"));
	directories.push(value);
	return value;
}

type RuntimeBinding = Pick<
	RuntimeSubmitTurnRequestV1,
	| "agentId"
	| "actorId"
	| "channelId"
	| "conversationId"
	| "executionId"
	| "turnId"
	| "sessionGeneration"
	| "traceId"
>;

function signedGrant(
	binding: RuntimeBinding,
	commands: ExecutionGrantCommandV1[],
): ExecutionGrantV1 {
	return runtimeGrantFixture(binding, commands, {
		actionSetVersion: "actions-crash",
	});
}
function request(
	overrides: Partial<RuntimeBinding> = {},
): RuntimeSubmitTurnRequestV1 {
	const binding: RuntimeBinding = {
		agentId: "agent-crash",
		actorId: "actor-crash",
		channelId: "web",
		conversationId: "conversation-crash",
		executionId: "execution-crash",
		turnId: "turn-crash",
		sessionGeneration: 1,
		traceId: "trace-crash",
		...overrides,
	};
	return {
		schemaVersion: 1,
		requestId: `request-${binding.executionId}`,
		...binding,
		deliveryFence: 1,
		grant: signedGrant(binding, ["turn.submit"]),
		input: { text: "synthetic-crash-input", attachments: [] },
	};
}

function host(
	store: FileRuntimeStore,
	driver: FakeRuntimeDriver,
	hooks: {
		afterOperationPrepared?: () => void;
		afterDriverResult?: (operationId: string) => void;
	} = {},
) {
	return openIngressVerifiedRuntimeHost({
		store,
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
		...hooks,
	});
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true })),
	);
});

describe("RuntimeHost crash-window recovery", () => {
	it("recovers a prepared operation that crashed before the Driver call", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = await host(
			await FileRuntimeStore.open(hostPath),
			driver,
			{
				afterOperationPrepared: () => {
					throw new Error("simulated process exit after durable prepare");
				},
			},
		);

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated process exit",
		);
		expect(await driver.sideEffectCount()).toBe(0);

		const restartedDriver = await FakeRuntimeDriver.open(driverPath);
		const recoveredHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: restartedDriver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		expect(await restartedDriver.sideEffectCount()).toBe(1);
		const recoveredState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(recoveredState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({ state: "resolved", result: { outcome: "accepted" } });
		const recovered = await recoveredHost.submitTurn(request());
		expect(recovered.result).toEqual({
			outcome: "accepted",
			status: "running",
		});
	});

	it("recovers the accepted result after a crash before Host persistence", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = await host(
			await FileRuntimeStore.open(hostPath),
			driver,
			{
				afterDriverResult: () => {
					throw new Error("simulated process exit after Driver acceptance");
				},
			},
		);

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated process exit",
		);
		expect(await driver.sideEffectCount()).toBe(1);

		const restartedDriver = await FakeRuntimeDriver.open(driverPath);
		const recoveredHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: restartedDriver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const recoveredState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(recoveredState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({ state: "resolved", result: { outcome: "accepted" } });
		const recovered = await recoveredHost.submitTurn(request());
		expect(recovered.result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("refreshes nonterminal accepted status during startup without command retry", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		await (
			await host(await FileRuntimeStore.open(hostPath), driver)
		).submitTurn(request());
		await driver.setOperationStatus("execution-crash", "completed");

		await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const recoveredState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(recoveredState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({
			state: "resolved",
			result: { outcome: "accepted", status: "completed" },
		});
	});

	it("persists unknown instead of repeating an unqueryable Driver side effect", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = await host(
			await FileRuntimeStore.open(hostPath),
			driver,
			{
				afterDriverResult: () => {
					throw new Error("simulated lost Driver response");
				},
			},
		);

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated lost Driver response",
		);
		await driver.makeOperationUnknown("execution-crash");

		const recoveredHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const unknownState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(unknownState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({ state: "resolved", result: { outcome: "unknown" } });
		const recovered = await recoveredHost.submitTurn(request());
		expect(recovered.result).toMatchObject({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
		});
		expect((await recoveredHost.submitTurn(request())).result).toEqual(
			recovered.result,
		);
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("keeps an unconfirmed generation cancellation prepared until recovery can prove it", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const original = request();
		const firstHost = await host(
			await FileRuntimeStore.open(hostPath),
			await FakeRuntimeDriver.open(driverPath),
		);
		const submitted = await firstHost.submitTurn(original);
		const tombstoneId = "generation-crash-unknown";
		const crashingHost = await host(
			await FileRuntimeStore.open(hostPath),
			await FakeRuntimeDriver.open(driverPath),
			{
				afterDriverResult: (operationId) => {
					if (operationId === tombstoneId) {
						throw new Error("simulated crash after generation cancellation");
					}
				},
			},
		);

		await expect(
			crashingHost.cancelGeneration({
				schemaVersion: 1,
				requestId: "request-generation-crash-unknown",
				...runtimeGrantRequestContext(original),
				agentId: original.agentId,
				conversationId: original.conversationId,
				executionId: original.executionId,
				turnId: original.turnId,
				sessionGeneration: original.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: submitted.hostSessionRef,
				tombstoneId,
				grant: signedGrant(original, ["generation.cancel"]),
			}),
		).rejects.toThrow("simulated crash after generation cancellation");
		const provenDriverState = await readFile(driverPath, "utf8");
		await (await FakeRuntimeDriver.open(driverPath)).makeOperationUnknown(
			tombstoneId,
		);

		await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const unknownState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			unknownState.sessions[submitted.hostSessionRef]?.operations[tombstoneId],
		).toMatchObject({ state: "prepared" });
		expect(unknownState.sessions[submitted.hostSessionRef]).toMatchObject({
			generationBarrier: { state: "active", tombstoneId },
		});

		await writeFile(driverPath, provenDriverState, "utf8");
		await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		const recoveredState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			recoveredState.sessions[submitted.hostSessionRef]?.operations[
				tombstoneId
			],
		).toMatchObject({
			state: "resolved",
			result: { outcome: "accepted", status: "cancelled" },
		});
		expect(recoveredState.sessions[submitted.hostSessionRef]).toMatchObject({
			generationBarrier: { state: "confirmed", tombstoneId },
		});
		expect(
			await (await FakeRuntimeDriver.open(driverPath)).sideEffectCount(),
		).toBe(2);
	});

	it("fails closed when durable Host state is corrupted", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		await writeFile(hostPath, "{incomplete", "utf8");

		await expect(FileRuntimeStore.open(hostPath)).rejects.toMatchObject({
			code: "RUNTIME_STORE_CORRUPTED",
		});
	});

	it("fails globally when the root sessions container is an array", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		await writeFile(
			hostPath,
			JSON.stringify({ schemaVersion: 1, sessions: [] }),
			"utf8",
		);

		await expect(FileRuntimeStore.open(hostPath)).rejects.toMatchObject({
			code: "RUNTIME_STORE_CORRUPTED",
		});
	});

	it("fails globally when the durable binding index is an array", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		await writeFile(
			hostPath,
			JSON.stringify({
				schemaVersion: 1,
				sessionBindings: [],
				sessions: {},
				quarantinedSessions: {},
			}),
			"utf8",
		);

		await expect(FileRuntimeStore.open(hostPath)).rejects.toMatchObject({
			code: "RUNTIME_STORE_CORRUPTED",
		});
	});

	it.each([
		[
			"highest-fence array container",
			(session: MutableStoredSession) => {
				session.highestFences = [] as unknown as Record<string, unknown>;
				session.operations = {};
			},
		],
		[
			"operations array container",
			(session: MutableStoredSession) => {
				session.highestFences = {};
				session.operations = [] as unknown as Record<
					string,
					MutableStoredOperation
				>;
			},
		],
		[
			"highest fence",
			(session: MutableStoredSession) => {
				session.highestFences = { "execution:execution-crash": "one" };
			},
		],
		[
			"generation barrier",
			(session: MutableStoredSession) => {
				session.generationBarrier = {
					generation: 0,
					tombstoneId: "",
					state: "confirmed",
				};
			},
		],
		[
			"operation kind",
			(session: MutableStoredSession) => {
				const operation = Object.values(session.operations)[0];
				if (operation) operation.kind = "untrusted-command";
			},
		],
		[
			"operation result",
			(session: MutableStoredSession) => {
				const operation = Object.values(session.operations)[0];
				if (operation) {
					operation.result = { outcome: "accepted", status: "not-a-status" };
				}
			},
		],
		[
			"persisted Driver command",
			(session: MutableStoredSession) => {
				const operation = Object.values(session.operations)[0];
				if (operation) operation.command = { kind: "submit-turn" };
			},
		],
	])(
		"fails closed on parseable nested %s corruption",
		async (_name, corrupt) => {
			const root = await directory();
			const hostPath = join(root, "host.json");
			const runtimeHost = await host(
				await FileRuntimeStore.open(hostPath),
				await FakeRuntimeDriver.open(join(root, "driver.json")),
			);
			await runtimeHost.submitTurn(request());
			const state = JSON.parse(
				await readFile(hostPath, "utf8"),
			) as MutableStoreState;
			const session = Object.values(state.sessions)[0];
			if (!session) throw new Error("expected durable Session fixture");
			corrupt(session);
			await writeFile(hostPath, JSON.stringify(state), "utf8");

			const reopened = await FileRuntimeStore.open(hostPath);
			await expect(
				Promise.resolve().then(() =>
					reopened.getSessionForQuery(session.hostSessionRef, request(), 1),
				),
			).rejects.toMatchObject({
				code: "RUNTIME_SESSION_QUARANTINED",
			});
		},
	);

	it("keeps the indexed Session and isolates an unindexed duplicate", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const runtimeHost = await host(
			await FileRuntimeStore.open(hostPath),
			await FakeRuntimeDriver.open(join(root, "driver.json")),
		);
		await runtimeHost.submitTurn(request());
		const state = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		const session = Object.values(state.sessions)[0];
		if (!session) throw new Error("expected durable Session fixture");
		state.sessions["duplicate-host-session"] = {
			...structuredClone(session),
			hostSessionRef: "duplicate-host-session",
		};
		await writeFile(hostPath, JSON.stringify(state), "utf8");

		const reopened = await FileRuntimeStore.open(hostPath);
		expect(
			reopened.getSessionForQuery(session.hostSessionRef, request(), 1),
		).toMatchObject({ hostSessionRef: session.hostSessionRef });
		await expect(
			Promise.resolve().then(() =>
				reopened.getSessionForQuery("duplicate-host-session", request(), 1),
			),
		).rejects.toMatchObject({
			code: "RUNTIME_SESSION_BINDING_MISMATCH",
		});
	});

	it("quarantines one corrupt Session while a healthy Conversation remains usable", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const runtimeHost = await host(
			await FileRuntimeStore.open(hostPath),
			driver,
		);
		const affectedRequest = request();
		const healthyRequest = request({
			conversationId: "conversation-healthy",
			executionId: "execution-healthy",
			turnId: "turn-healthy",
		});
		const affected = await runtimeHost.submitTurn(affectedRequest);
		const healthy = await runtimeHost.submitTurn(healthyRequest);
		const state = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		const affectedSession = state.sessions[affected.hostSessionRef];
		const affectedOperation = affectedSession
			? Object.values(affectedSession.operations)[0]
			: undefined;
		if (!affectedOperation) throw new Error("expected affected operation");
		affectedOperation.kind = "corrupted-operation";
		await writeFile(hostPath, JSON.stringify(state), "utf8");

		const restartedDriver = await FakeRuntimeDriver.open(driverPath);
		const recoveredHost = await openIngressVerifiedRuntimeHost({
			store: await FileRuntimeStore.open(hostPath),
			driver: restartedDriver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		});
		expect(
			await recoveredHost.status({
				schemaVersion: 1,
				requestId: "request-status-healthy",
				...runtimeGrantRequestContext(healthyRequest),
				agentId: healthyRequest.agentId,
				conversationId: healthyRequest.conversationId,
				executionId: healthyRequest.executionId,
				turnId: healthyRequest.turnId,
				sessionGeneration: healthyRequest.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: healthy.hostSessionRef,
				grant: signedGrant(healthyRequest, ["session.status"]),
			}),
		).toMatchObject({ status: "running" });
		await expect(
			recoveredHost.status({
				schemaVersion: 1,
				requestId: "request-status-affected",
				...runtimeGrantRequestContext(affectedRequest),
				agentId: affectedRequest.agentId,
				conversationId: affectedRequest.conversationId,
				executionId: affectedRequest.executionId,
				turnId: affectedRequest.turnId,
				sessionGeneration: affectedRequest.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: affected.hostSessionRef,
				grant: signedGrant(affectedRequest, ["session.status"]),
			}),
		).rejects.toMatchObject({ code: "RUNTIME_SESSION_QUARANTINED" });
		await expect(
			recoveredHost.submitTurn(
				request({
					executionId: "execution-after-quarantine",
					turnId: "turn-after-quarantine",
				}),
			),
		).rejects.toMatchObject({ code: "RUNTIME_SESSION_QUARANTINED" });
		expect(await restartedDriver.sideEffectCount()).toBe(2);
	});

	it.each(["agentId", "conversationId"] as const)(
		"uses the independent binding index when a Session %s is corrupt",
		async (field) => {
			const root = await directory();
			const hostPath = join(root, "host.json");
			const driverPath = join(root, "driver.json");
			const driver = await FakeRuntimeDriver.open(driverPath);
			const runtimeHost = await host(
				await FileRuntimeStore.open(hostPath),
				driver,
			);
			const affectedRequest = request();
			const healthyRequest = request({
				conversationId: "conversation-binding-healthy",
				executionId: "execution-binding-healthy",
				turnId: "turn-binding-healthy",
			});
			const affected = await runtimeHost.submitTurn(affectedRequest);
			const healthy = await runtimeHost.submitTurn(healthyRequest);
			const state = JSON.parse(
				await readFile(hostPath, "utf8"),
			) as MutableStoreState;
			const affectedSession = state.sessions[affected.hostSessionRef];
			if (!affectedSession) throw new Error("expected affected Session");
			Object.assign(affectedSession, { [field]: `corrupted-${field}` });
			await writeFile(hostPath, JSON.stringify(state), "utf8");

			const restartedDriver = await FakeRuntimeDriver.open(driverPath);
			const recoveredHost = await openIngressVerifiedRuntimeHost({
				store: await FileRuntimeStore.open(hostPath),
				driver: restartedDriver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			});
			await expect(
				recoveredHost.submitTurn(
					request({
						executionId: `execution-corrupt-${field}`,
						turnId: `turn-corrupt-${field}`,
					}),
				),
			).rejects.toMatchObject({ code: "RUNTIME_SESSION_QUARANTINED" });
			expect(
				await recoveredHost.status({
					schemaVersion: 1,
					requestId: `request-binding-${field}-healthy`,
					...runtimeGrantRequestContext(healthyRequest),
					agentId: healthyRequest.agentId,
					conversationId: healthyRequest.conversationId,
					executionId: healthyRequest.executionId,
					turnId: healthyRequest.turnId,
					sessionGeneration: healthyRequest.sessionGeneration,
					deliveryFence: 1,
					hostSessionRef: healthy.hostSessionRef,
					grant: signedGrant(healthyRequest, ["session.status"]),
				}),
			).toMatchObject({ status: "running" });
			expect(await restartedDriver.sideEffectCount()).toBe(2);
		},
	);

	it.each(["lookup", "status"] as const)(
		"blocks only the Session whose Driver %s recovery fails and later converges",
		async (failure) => {
			const root = await directory();
			const hostPath = join(root, "host.json");
			const driverPath = join(root, "driver.json");
			const driver = await FakeRuntimeDriver.open(driverPath);
			const runtimeHost = await host(
				await FileRuntimeStore.open(hostPath),
				driver,
			);
			const affectedRequest = request();
			const healthyRequest = request({
				conversationId: "conversation-driver-healthy",
				executionId: "execution-driver-healthy",
				turnId: "turn-driver-healthy",
			});
			const affected = await runtimeHost.submitTurn(affectedRequest);
			const healthy = await runtimeHost.submitTurn(healthyRequest);
			if (failure === "lookup") {
				await driver.failLookupFor(affectedRequest.executionId);
			} else {
				await driver.failStatusFor(affectedRequest.executionId);
			}

			const restartedDriver = await FakeRuntimeDriver.open(driverPath);
			const recoveredHost = await openIngressVerifiedRuntimeHost({
				store: await FileRuntimeStore.open(hostPath),
				driver: restartedDriver,
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			});
			expect(
				await recoveredHost.status({
					schemaVersion: 1,
					requestId: `request-driver-${failure}-healthy`,
					...runtimeGrantRequestContext(healthyRequest),
					agentId: healthyRequest.agentId,
					conversationId: healthyRequest.conversationId,
					executionId: healthyRequest.executionId,
					turnId: healthyRequest.turnId,
					sessionGeneration: healthyRequest.sessionGeneration,
					deliveryFence: 1,
					hostSessionRef: healthy.hostSessionRef,
					grant: signedGrant(healthyRequest, ["session.status"]),
				}),
			).toMatchObject({ status: "running" });
			expect(
				await recoveredHost.status({
					schemaVersion: 1,
					requestId: `request-driver-${failure}-affected`,
					...runtimeGrantRequestContext(affectedRequest),
					agentId: affectedRequest.agentId,
					conversationId: affectedRequest.conversationId,
					executionId: affectedRequest.executionId,
					turnId: affectedRequest.turnId,
					sessionGeneration: affectedRequest.sessionGeneration,
					deliveryFence: 1,
					hostSessionRef: affected.hostSessionRef,
					grant: signedGrant(affectedRequest, ["session.status"]),
				}),
			).toMatchObject({ status: "unavailable" });
			expect(
				await recoveredHost.replay({
					schemaVersion: 1,
					requestId: `request-driver-${failure}-replay`,
					...runtimeGrantRequestContext(affectedRequest),
					agentId: affectedRequest.agentId,
					conversationId: affectedRequest.conversationId,
					executionId: affectedRequest.executionId,
					turnId: affectedRequest.turnId,
					sessionGeneration: affectedRequest.sessionGeneration,
					deliveryFence: 1,
					hostSessionRef: affected.hostSessionRef,
					grant: signedGrant(affectedRequest, ["events.replay"]),
				}),
			).toMatchObject({
				events: [expect.objectContaining({ type: "status" })],
			});
			await expect(
				recoveredHost.submitTurn(
					request({
						executionId: `execution-driver-${failure}-blocked`,
						turnId: `turn-driver-${failure}-blocked`,
					}),
				),
			).rejects.toMatchObject({ code: "RUNTIME_SESSION_RECOVERY_BLOCKED" });
			await expect(
				recoveredHost.supplement({
					schemaVersion: 1,
					requestId: `request-driver-${failure}-supplement`,
					...runtimeGrantRequestContext(affectedRequest),
					agentId: affectedRequest.agentId,
					conversationId: affectedRequest.conversationId,
					executionId: affectedRequest.executionId,
					turnId: affectedRequest.turnId,
					sessionGeneration: affectedRequest.sessionGeneration,
					deliveryFence: 1,
					executionDeliveryFence: 1,
					hostSessionRef: affected.hostSessionRef,
					messageId: `message-driver-${failure}-blocked`,
					grant: signedGrant(affectedRequest, ["turn.supplement"]),
					input: { text: "synthetic-blocked-supplement", attachments: [] },
				}),
			).rejects.toMatchObject({ code: "RUNTIME_SESSION_RECOVERY_BLOCKED" });
			const tombstoneId = `generation-driver-${failure}`;
			const cancellation = await recoveredHost.cancelGeneration({
				schemaVersion: 1,
				requestId: `request-driver-${failure}-cancel`,
				...runtimeGrantRequestContext(affectedRequest),
				agentId: affectedRequest.agentId,
				conversationId: affectedRequest.conversationId,
				executionId: affectedRequest.executionId,
				turnId: affectedRequest.turnId,
				sessionGeneration: affectedRequest.sessionGeneration,
				deliveryFence: 1,
				hostSessionRef: affected.hostSessionRef,
				tombstoneId,
				grant: signedGrant(affectedRequest, ["generation.cancel"]),
			});
			expect(cancellation).toMatchObject(
				failure === "status"
					? {
							result: {
								outcome: "unknown",
								code: "RUNTIME_ACCEPTANCE_UNKNOWN",
							},
						}
					: { result: { outcome: "accepted", status: "cancelled" } },
			);
			await restartedDriver.clearRecoveryFailures();
			await openIngressVerifiedRuntimeHost({
				store: await FileRuntimeStore.open(hostPath),
				driver: await FakeRuntimeDriver.open(driverPath),
				grantValidation: {
					expectedIssuer: "agent-platform",
					now: () => "2026-08-28T10:00:00Z",
				},
			});
			const recoveredState = JSON.parse(
				await readFile(hostPath, "utf8"),
			) as MutableStoreState;
			expect(recoveredState.sessions[affected.hostSessionRef]).toMatchObject({
				generationBarrier: { state: "confirmed", tombstoneId },
			});
			expect(
				recoveredState.sessions[affected.hostSessionRef]?.recovery,
			).toBeUndefined();
			expect(await restartedDriver.sideEffectCount()).toBe(3);
		},
	);
});
