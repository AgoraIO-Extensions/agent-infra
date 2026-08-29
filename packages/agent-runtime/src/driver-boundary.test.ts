import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	RuntimeDriverCommandV1,
	RuntimeDriverOperationRecordV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";

import {
	ingressVerifiedRuntimeHost,
	runtimeGrantFixture,
} from "./grant-fixture.test-support.js";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	type RuntimeDriver,
	RuntimeHost,
} from "./index.js";

const directories: string[] = [];
const binding = {
	agentId: "agent-driver-boundary",
	actorId: "actor-driver-boundary",
	channelId: "web",
	conversationId: "conversation-driver-boundary",
	executionId: "execution-driver-boundary",
	turnId: "turn-driver-boundary",
	sessionGeneration: 1,
	traceId: "trace-driver-boundary",
};

function request() {
	return {
		schemaVersion: 1 as const,
		requestId: "request-driver-boundary",
		...binding,
		deliveryFence: 1,
		grant: runtimeGrantFixture(binding, ["turn.submit"]),
		input: { text: "synthetic-driver-boundary", attachments: [] },
	};
}

async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "agent-runtime-driver-boundary-"),
	);
	directories.push(directory);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = ingressVerifiedRuntimeHost(
		await RuntimeHost.open({
			store: await FileRuntimeStore.open(join(directory, "host.json")),
			driver,
			grantValidation: {
				expectedIssuer: "agent-platform",
				now: () => "2026-08-28T10:00:00Z",
			},
		}),
	);
	return { driver, host };
}

function malformedRecord(
	command: RuntimeDriverCommandV1,
	override: Record<string, unknown>,
) {
	return {
		schemaVersion: 1,
		operationId: command.operationId,
		nativeSessionRef: "native-driver-boundary",
		result: { outcome: "busy" },
		...override,
	} as unknown as RuntimeDriverOperationRecordV1;
}

function unsafeErrorEvent() {
	return {
		schemaVersion: 1,
		adapterEventKey: "event-driver-error",
		executionId: binding.executionId,
		cursor: "cursor-driver-error",
		occurredAt: "2026-08-28T10:00:01Z",
		type: "error",
		payload: {
			code: "UPSTREAM_ERROR",
			message: "Provider returned bearer secret-value",
			retryable: false,
		},
	};
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true })),
	);
});

describe("Runtime Driver boundary", () => {
	it.each([
		[
			"wrong operation identity",
			(command: RuntimeDriverCommandV1) =>
				malformedRecord(command, { operationId: "operation-other" }),
		],
		[
			"unsanitized rejection",
			(command: RuntimeDriverCommandV1) =>
				malformedRecord(command, {
					result: {
						outcome: "rejected",
						code: "UPSTREAM_REJECTED",
						message: "Provider returned bearer secret-value",
						retryable: false,
					},
				}),
		],
	])("rejects %s in an operation record", async (_name, record) => {
		const { driver, host } = await setup();
		Object.assign(driver, {
			execute: async (command: RuntimeDriverCommandV1) => record(command),
		});
		await expect(host.submitTurn(request())).rejects.toMatchObject({
			code: "RUNTIME_DRIVER_INVALID",
		});
	});

	it.each(["status", "capabilities", "replay", "stream"] as const)(
		"rejects malformed %s output",
		async (kind) => {
			const { driver, host } = await setup();
			const submitted = await host.submitTurn(request());
			Object.assign(driver, {
				...(kind === "status"
					? { getStatus: async () => "native-secret" }
					: {}),
				...(kind === "capabilities"
					? { getCapabilities: async () => ({ rawProtocol: true }) }
					: {}),
				...(kind === "replay"
					? { replayEvents: async () => [unsafeErrorEvent()] }
					: {}),
				...(kind === "stream"
					? {
							subscribeEvents: async () =>
								(async function* () {
									yield unsafeErrorEvent();
								})(),
						}
					: {}),
			} as unknown as Partial<RuntimeDriver>);
			const { input: _input, ...submittedRequest } = request();
			const context = {
				...submittedRequest,
				requestId: `request-driver-${kind}`,
				hostSessionRef: submitted.hostSessionRef,
			};
			const operation =
				kind === "status"
					? host.status({
							...context,
							grant: runtimeGrantFixture(context, ["session.status"]),
						})
					: kind === "capabilities"
						? host.capabilities({
								...context,
								grant: runtimeGrantFixture(context, ["capabilities.read"]),
							})
						: kind === "replay"
							? host.replay({
									...context,
									grant: runtimeGrantFixture(context, ["events.replay"]),
								})
							: host
									.streamEvents({
										...context,
										grant: runtimeGrantFixture(context, ["events.replay"]),
									})
									.then((events) => events[Symbol.asyncIterator]().next());
			await expect(operation).rejects.toMatchObject({
				code: "RUNTIME_DRIVER_INVALID",
			});
		},
	);
});
