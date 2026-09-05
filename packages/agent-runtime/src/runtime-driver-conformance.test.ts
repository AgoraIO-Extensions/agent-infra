import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeSubmitTurnRequestV1 } from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openCodexRuntimeDriverConformanceFixture } from "./codex-runtime-driver.test-support.js";
import type { RuntimeDriver } from "./driver.js";
import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import { FakeRuntimeDriver, FileRuntimeStore, RuntimeHost } from "./index.js";

const directories: string[] = [];
const driverClosers: (() => Promise<void>)[] = [];
const driverNames = ["Fake", "Codex"] as const;

async function directory() {
	const path = await mkdtemp(
		join(tmpdir(), "agent-runtime-driver-conformance-"),
	);
	directories.push(path);
	return path;
}

interface ConformanceDriverFixture {
	driver: RuntimeDriver;
	emitRunningEvent(): Promise<void>;
	submitWithPreStartEvent<T>(submit: () => Promise<T>): Promise<T>;
	completeStopAsCancelled(): void;
	completeStopAsCompleted(operationId: string): Promise<void>;
	createdTurnCount(): Promise<number>;
	restart(): Promise<ConformanceDriverFixture>;
	makeOperationUnknown(operationId: string): Promise<void>;
	delegatedToolWasDeniedAndRedacted(): Promise<boolean>;
}

async function openConformanceDriver(
	name: (typeof driverNames)[number],
	path: string,
	loseTurnStartResponse = false,
): Promise<ConformanceDriverFixture> {
	if (name === "Fake") {
		const driver = await FakeRuntimeDriver.open(path);
		const execute = driver.execute.bind(driver);
		let preStartEventObserved = false;
		let holdPreStartEvent = false;
		let signalPreStartEvent: (() => void) | undefined;
		let releaseDriverResult: (() => void) | undefined;
		driver.execute = async (command) => {
			const record = await execute(command);
			if (command.kind === "submit-turn") {
				preStartEventObserved = (
					await driver.replayEvents(
						record.nativeSessionRef,
						command.executionId,
					)
				).some((event) => event.type === "status");
				if (holdPreStartEvent) {
					await new Promise<void>((resolve) => {
						releaseDriverResult = resolve;
						signalPreStartEvent?.();
					});
				}
			}
			return record;
		};
		return {
			driver,
			emitRunningEvent: async () => undefined,
			submitWithPreStartEvent: async (submit) => {
				holdPreStartEvent = true;
				const preStartEvent = new Promise<void>((resolve) => {
					signalPreStartEvent = resolve;
				});
				const result = submit();
				try {
					await preStartEvent;
					if (!preStartEventObserved) {
						throw new Error("Fake Driver did not persist its pre-start event");
					}
				} finally {
					holdPreStartEvent = false;
					releaseDriverResult?.();
				}
				return result;
			},
			completeStopAsCancelled: () => undefined,
			completeStopAsCompleted: (operationId) =>
				driver.setOperationStatus(operationId, "completed"),
			createdTurnCount: () => driver.sideEffectCount(),
			restart: () => openConformanceDriver(name, path),
			makeOperationUnknown: (operationId) =>
				driver.makeOperationUnknown(operationId),
			delegatedToolWasDeniedAndRedacted: async () => false,
		};
	}
	const fixture = await openCodexRuntimeDriverConformanceFixture(
		path,
		loseTurnStartResponse,
	);
	return wrapCodexFixture(fixture);
}

function wrapCodexFixture(
	fixture: Awaited<ReturnType<typeof openCodexRuntimeDriverConformanceFixture>>,
): ConformanceDriverFixture {
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await fixture.close();
	};
	driverClosers.push(close);
	return {
		driver: fixture.driver,
		emitRunningEvent: () => fixture.emitRunningEvent(),
		submitWithPreStartEvent: (submit) =>
			fixture.submitWithPreStartEvent(submit),
		completeStopAsCancelled: () => fixture.completeStopAsCancelled(),
		completeStopAsCompleted: async () => fixture.completeStopAsCompleted(),
		createdTurnCount: async () => fixture.turnStartCount(),
		restart: async () => {
			await close();
			return wrapCodexFixture(await fixture.restart());
		},
		makeOperationUnknown: async () => undefined,
		delegatedToolWasDeniedAndRedacted: () =>
			fixture.delegatedToolWasDeniedAndRedacted(),
	};
}

type ConformanceHostHooks = Pick<
	Parameters<typeof RuntimeHost.open>[0],
	"afterOperationPrepared" | "afterDriverResult"
>;

async function openRawConformanceHost(
	hostPath: string,
	driver: RuntimeDriver,
	hooks: ConformanceHostHooks = {},
) {
	return RuntimeHost.open({
		store: await FileRuntimeStore.open(hostPath),
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
		...hooks,
	});
}

async function openConformanceHost(
	hostPath: string,
	driver: RuntimeDriver,
	hooks: ConformanceHostHooks = {},
) {
	return ingressVerifiedRuntimeHost(
		await openRawConformanceHost(hostPath, driver, hooks),
	);
}

function requestContext(
	request: RuntimeSubmitTurnRequestV1,
	hostSessionRef: string,
	requestId: string,
) {
	return {
		schemaVersion: 1 as const,
		requestId,
		actorId: request.actorId,
		channelId: request.channelId,
		traceId: request.traceId,
		agentId: request.agentId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		deliveryFence: 1,
		hostSessionRef,
	};
}

function submitRequest(): RuntimeSubmitTurnRequestV1 {
	const binding = {
		agentId: "agent-conformance",
		actorId: "actor-conformance",
		channelId: "web",
		conversationId: "conversation-conformance",
		executionId: "execution-conformance",
		turnId: "turn-conformance",
		sessionGeneration: 1,
		traceId: "trace-conformance",
	};
	return {
		schemaVersion: 1,
		requestId: "request-conformance",
		...binding,
		deliveryFence: 1,
		grant: runtimeGrantFixture(binding, ["turn.submit"]),
		input: { text: "synthetic-conformance", attachments: [] },
	};
}

afterEach(async () => {
	await Promise.all(driverClosers.splice(0).map((close) => close()));
	await Promise.all(
		directories.splice(0).map((path) => rm(path, { recursive: true })),
	);
});

describe("Runtime Driver shared conformance", () => {
	it.each(driverNames)(
		"runs the Session, Turn, status, and capability scenario through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = await openConformanceHost(
				join(path, "host.json"),
				fixture.driver,
			);

			const request = submitRequest();
			const submitted = await host.submitTurn(request);
			expect(submitted.result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			const context = requestContext(
				request,
				submitted.hostSessionRef,
				"request-conformance-status",
			);

			expect(
				await host.status({
					...context,
					grant: runtimeGrantFixture(context, ["session.status"]),
				}),
			).toMatchObject({ status: "running" });
			const capabilities = await host.capabilities({
				...context,
				requestId: "request-conformance-capabilities",
				grant: runtimeGrantFixture(context, ["capabilities.read"]),
			});
			expect(capabilities.capabilities).toMatchObject({ modelSelection: true });
			for (const capability of Object.values(capabilities.capabilities)) {
				expect(typeof capability).toBe("boolean");
			}

			await fixture.emitRunningEvent();
			const replay = await vi.waitFor(async () => {
				const result = await host.replay({
					...context,
					requestId: "request-conformance-replay",
					grant: runtimeGrantFixture(context, ["events.replay"]),
				});
				expect(result.events).toContainEqual(
					expect.objectContaining({
						type: "status",
						payload: { status: "running" },
					}),
				);
				return result;
			});
			const cursor = replay.events.at(-1)?.cursor;
			expect(cursor).toEqual(expect.any(String));
			const controller = new AbortController();
			const stream = await host.streamEvents(
				{
					...context,
					requestId: "request-conformance-stream",
					grant: runtimeGrantFixture(context, ["events.replay"]),
				},
				controller.signal,
			);
			const iterator = stream[Symbol.asyncIterator]();
			expect(await iterator.next()).toMatchObject({
				done: false,
				value: { type: "status", payload: { status: "running" } },
			});
			controller.abort();
			await iterator.return?.();
			expect(
				(
					await host.replay({
						...context,
						requestId: "request-conformance-confirmed-replay",
						afterCursor: cursor,
						grant: runtimeGrantFixture(context, ["events.replay"]),
					})
				).events,
			).toEqual([]);

			fixture.completeStopAsCancelled();
			expect(
				await host.stop({
					...context,
					requestId: "request-conformance-stop",
					executionDeliveryFence: 1,
					stopRequestId: "stop-conformance",
					grant: runtimeGrantFixture(context, ["turn.stop"]),
				}),
			).toMatchObject({ result: { outcome: "accepted", status: "cancelled" } });
			await vi.waitFor(async () => {
				const stoppedReplay = await host.replay({
					...context,
					requestId: "request-conformance-stopped-replay",
					afterCursor: cursor,
					grant: runtimeGrantFixture(context, ["events.replay"]),
				});
				expect(stoppedReplay.events).toContainEqual(
					expect.objectContaining({
						type: "completed",
						payload: { status: "cancelled" },
					}),
				);
			});
		},
	);

	it.each(driverNames)(
		"recovers one durable Session without a second Turn through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const first = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const firstHost = await openConformanceHost(hostPath, first.driver);
			const request = submitRequest();
			const submitted = await firstHost.submitTurn(request);
			expect(await first.createdTurnCount()).toBe(1);

			const restarted = await first.restart();
			const restartedHost = await openConformanceHost(
				hostPath,
				restarted.driver,
			);
			const context = requestContext(
				request,
				submitted.hostSessionRef,
				"request-conformance-recovered-status",
			);
			expect(
				await restartedHost.status({
					...context,
					grant: runtimeGrantFixture(context, ["session.status"]),
				}),
			).toMatchObject({ status: "running" });
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"replays duplicate delivery and fence takeover without a second Turn through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = await openConformanceHost(
				join(path, "host.json"),
				fixture.driver,
			);
			const request = submitRequest();
			const accepted = await host.submitTurn(request);
			const duplicate = await host.submitTurn({
				...request,
				requestId: "request-conformance-duplicate",
			});
			const takeover = await host.submitTurn({
				...request,
				requestId: "request-conformance-takeover",
				deliveryFence: 2,
				hostSessionRef: accepted.hostSessionRef,
			});

			expect(duplicate).toEqual(accepted);
			expect(takeover).toEqual(accepted);
			expect(await fixture.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"converges competing Worker fence takeover without a second Turn through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const firstFixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			let releaseFirst: () => void = () => undefined;
			const firstReleased = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			let firstPrepared: () => void = () => undefined;
			const firstPreparedPromise = new Promise<void>((resolve) => {
				firstPrepared = resolve;
			});
			// Workers meet the single RuntimeHost process in the Agent Pod.
			const runtimeHost = await openRawConformanceHost(
				hostPath,
				firstFixture.driver,
				{
					afterOperationPrepared: async (operationId) => {
						if (operationId !== "execution-conformance") return;
						firstPrepared();
						await firstReleased;
					},
				},
			);
			const firstHost = ingressVerifiedRuntimeHost(runtimeHost);
			const secondHost = ingressVerifiedRuntimeHost(runtimeHost);
			const request = submitRequest();
			const first = firstHost.submitTurn(request);
			await firstPreparedPromise;
			const takeover = secondHost.submitTurn({
				...request,
				requestId: "request-conformance-concurrent-takeover",
				deliveryFence: 2,
			});

			releaseFirst();
			const [firstResult, takeoverResult] = await Promise.all([
				first,
				takeover,
			]);
			expect(takeoverResult).toEqual(firstResult);
			expect(await firstFixture.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"recovers a crash after durable prepare through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const crashingHost = await openConformanceHost(hostPath, fixture.driver, {
				afterOperationPrepared: () => {
					throw new Error("simulated crash after durable prepare");
				},
			});

			const request = submitRequest();
			await expect(crashingHost.submitTurn(request)).rejects.toThrow(
				"simulated crash after durable prepare",
			);
			expect(await fixture.createdTurnCount()).toBe(0);

			const restarted = await fixture.restart();
			const recoveredHost = await openConformanceHost(
				hostPath,
				restarted.driver,
			);
			expect((await recoveredHost.submitTurn(request)).result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"recovers a crash after Driver acceptance through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const crashingHost = await openConformanceHost(hostPath, fixture.driver, {
				afterDriverResult: () => {
					throw new Error("simulated crash after Driver acceptance");
				},
			});

			const request = submitRequest();
			await expect(crashingHost.submitTurn(request)).rejects.toThrow(
				"simulated crash after Driver acceptance",
			);
			expect(await fixture.createdTurnCount()).toBe(1);

			const restarted = await fixture.restart();
			const recoveredHost = await openConformanceHost(
				hostPath,
				restarted.driver,
			);
			expect((await recoveredHost.submitTurn(request)).result).toEqual({
				outcome: "accepted",
				status: "running",
			});
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"keeps an unqueryable accepted Turn unknown through %s",
		async (name) => {
			const path = await directory();
			const hostPath = join(path, "host.json");
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
				name === "Codex",
			);
			const crashingHost = await openConformanceHost(hostPath, fixture.driver, {
				afterDriverResult: () => {
					if (name === "Fake") {
						throw new Error("simulated lost Driver response");
					}
				},
			});
			const request = submitRequest();

			await expect(crashingHost.submitTurn(request)).rejects.toThrow();
			await fixture.makeOperationUnknown(request.executionId);

			const restarted = await fixture.restart();
			const recoveredHost = await openConformanceHost(
				hostPath,
				restarted.driver,
			);
			expect((await recoveredHost.submitTurn(request)).result).toMatchObject({
				outcome: "unknown",
				code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			});
			expect(await restarted.createdTurnCount()).toBe(1);
		},
	);

	it.each(driverNames)(
		"preserves a pre-start event race through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = await openConformanceHost(
				join(path, "host.json"),
				fixture.driver,
			);
			const request = submitRequest();
			const submitted = await fixture.submitWithPreStartEvent(() =>
				host.submitTurn(request),
			);
			const context = requestContext(
				request,
				submitted.hostSessionRef,
				"request-conformance-pre-start-replay",
			);
			expect(
				(
					await host.replay({
						...context,
						grant: runtimeGrantFixture(context, ["events.replay"]),
					})
				).events,
			).toContainEqual(
				expect.objectContaining({
					executionId: request.executionId,
					type: "status",
					payload: { status: "running" },
				}),
			);
		},
	);

	it.each(driverNames)(
		"preserves the actual terminal completion during a stop race through %s",
		async (name) => {
			const path = await directory();
			const fixture = await openConformanceDriver(
				name,
				join(path, "driver.json"),
			);
			const host = await openConformanceHost(
				join(path, "host.json"),
				fixture.driver,
			);
			const request = submitRequest();
			const submitted = await host.submitTurn(request);
			await fixture.completeStopAsCompleted(request.executionId);
			const context = requestContext(
				request,
				submitted.hostSessionRef,
				"request-conformance-terminal-stop",
			);
			expect(
				await host.stop({
					...context,
					executionDeliveryFence: 1,
					stopRequestId: "stop-conformance-terminal",
					grant: runtimeGrantFixture(context, ["turn.stop"]),
				}),
			).toMatchObject({ result: { outcome: "accepted", status: "completed" } });
			expect(await fixture.createdTurnCount()).toBe(1);
		},
	);
});

describe("Codex Driver boundary conformance", () => {
	it("denies a delegated Tool request without retaining its parameters", async () => {
		const path = await directory();
		const fixture = await openConformanceDriver(
			"Codex",
			join(path, "driver.json"),
		);
		expect(await fixture.delegatedToolWasDeniedAndRedacted()).toBe(true);
		expect(await fixture.driver.getCapabilities()).toMatchObject({
			connection: false,
		});
	});
});
