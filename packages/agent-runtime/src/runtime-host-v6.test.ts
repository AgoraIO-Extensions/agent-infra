import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	RuntimeBusinessGrantClaimsV2Schema,
	RuntimeBusinessGrantClaimsV6Schema,
	RuntimeNativeCapabilityRequestV6Schema,
	RuntimePrivateRelayKeyFieldV1Schema,
	runtimeOperationDigestInputV6,
	runtimeRequestDigestV6,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { driverOperationResult } from "./driver-operation.js";
import {
	RuntimeHostError,
	RuntimeNativeCommandNotSubmittedError,
} from "./errors.js";
import {
	FakeRuntimeDriver,
	fakeNativeCommandCapabilityId,
	fakeNativeCommandDirectoryRevision,
} from "./fake-runtime-driver.js";
import {
	FileRuntimeStore,
	requestDigest as originalRequestDigest,
} from "./file-runtime-store.js";
import {
	signV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import { RuntimeHost } from "./runtime-host.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.each([
	"normal",
	"late-unsubmitted",
	"selection-rejected",
	"same-code-untyped",
	"driver-invalid",
	"lookup-uncertain",
	"existing-record",
])(
	"preserves the V6 command receipt and preflight boundary (%s, #4335)",
	async (mode) => {
		const directory = await mkdtemp(
			join(tmpdir(), "runtime-host-v6-admission-"),
		);
		const store = await FileRuntimeStore.open(join(directory, "host.json"));
		const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
		const clock = Date.now();
		const seed = await store.prepareOperation({
			authorization: RuntimeBusinessGrantClaimsV2Schema.parse({
				schemaVersion: 2,
				issuer: "platform-fixture",
				audience: "runtime_host",
				workerId: "worker-1",
				principal: { kind: "user", id: "alice" },
				channelId: "web",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "seed-execution",
				turnId: "seed-turn",
				sessionGeneration: 1,
				traceId: "seed-trace",
				hostSessionRef: null,
				issuedAt: clock,
				expiresAt: clock + 30_000,
				grantId: "seed-grant",
				operation: {
					kind: "execution",
					id: "seed-execution",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
				requestDigest: "a".repeat(64),
				purpose: "business",
				authorizationRecordId: "seed-authorization",
				allowedCommands: ["turn.submit"],
				attachments: [],
			}),
			binding: {
				principal: { kind: "user", id: "alice" },
				channelId: "web",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "seed-execution",
				turnId: "seed-turn",
				sessionGeneration: 1,
			},
			operationId: "seed-execution",
			kind: "submit-turn",
			scope: "execution:seed-execution",
			deliveryFence: 1,
			requestDigest: "seed-request-digest",
			command: (nativeSessionRef) => ({
				schemaVersion: 1,
				kind: "submit-turn",
				operationId: "seed-execution",
				agentId: "agent-1",
				conversationId: "conversation-1",
				executionId: "seed-execution",
				turnId: "seed-turn",
				sessionGeneration: 1,
				...(nativeSessionRef ? { nativeSessionRef } : {}),
				input: { text: "seed", attachments: [] },
			}),
		});
		const seedRecord = await driver.execute(seed.operation.command);
		if (seedRecord.result.outcome !== "accepted")
			throw new Error("Expected accepted seed operation");
		await store.resolveOperation(
			seed.session.hostSessionRef,
			seed.operation.operationId,
			seedRecord.result,
			seedRecord.nativeSessionRef,
		);
		const request = RuntimeNativeCapabilityRequestV6Schema.parse({
			schemaVersion: 6,
			requestId: "request-1",
			traceId: "trace-1",
			principal: { kind: "user", id: "alice" },
			executionSource: "web",
			channelId: "web",
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			turnId: "turn-1",
			sessionGeneration: 1,
			hostSessionRef: seed.session.hostSessionRef,
			operation: {
				kind: "execution",
				id: "execution-1",
				deliveryFence: 1,
				executionDeliveryFence: 1,
			},
			grant: {
				schemaVersion: 6,
				format: "runtime-execution-jws",
				token: "a.b.c",
			},
			keyBinding: {
				purpose: "personal",
				subjectId: "alice",
				ciphertextRef: "key-1",
				version: 1,
			},
			capabilityId: fakeNativeCommandCapabilityId,
			capabilityKind: "command",
			directoryRevision: fakeNativeCommandDirectoryRevision,
			parameters: "compact",
			parametersDigest: createHash("sha256").update("compact").digest("hex"),
			capabilitySourceVersion: "1",
			selection: {
				schemaVersion: 1,
				modelOptionId: "model-option-primary",
				reasoningLevel: "high",
			},
			configVersion: "configuration-1",
		});
		const requestDigest = await runtimeRequestDigestV6(request);
		const claims = RuntimeBusinessGrantClaimsV6Schema.parse({
			schemaVersion: 6,
			issuer: "platform-fixture",
			audience: "runtime_host",
			issuedAt: clock,
			expiresAt: clock + 30_000,
			grantId: "grant-1",
			workerId: "worker-1",
			principal: request.principal,
			agentId: request.agentId,
			channelId: request.channelId,
			conversationId: request.conversationId,
			executionId: request.executionId,
			turnId: request.turnId,
			sessionGeneration: request.sessionGeneration,
			traceId: request.traceId,
			hostSessionRef: request.hostSessionRef,
			executionSource: request.executionSource,
			relayKeyBinding: request.keyBinding,
			operation: request.operation,
			requestDigest,
			purpose: "business",
			authorizationRecordId: "authorization-1",
			allowedCommands: ["native-capability.invoke"],
			attachments: [],
		});
		const privateKeyField = RuntimePrivateRelayKeyFieldV1Schema.parse({
			schemaVersion: 1,
			context: {
				requestId: request.requestId,
				grantId: claims.grantId,
				requestDigest,
				traceId: request.traceId,
				principal: request.principal,
				executionSource: request.executionSource,
				channelId: request.channelId,
				agentId: request.agentId,
				conversationId: request.conversationId,
				executionId: request.executionId,
				turnId: request.turnId,
				sessionGeneration: request.sessionGeneration,
				hostSessionRef: request.hostSessionRef,
				operation: request.operation,
				keyBinding: request.keyBinding,
			},
			keyDelivery: { relayKey: "private-key-value-k1" },
		});
		const host = await RuntimeHost.open({
			store,
			driver,
			grantValidation: { expectedIssuer: "platform-fixture" },
			grantValidationV2: {
				expectedIssuer: "platform-fixture",
				expectedWorkerId: claims.workerId,
				now: () => clock,
			},
			validateGrantV6: async (_value) => ({ request, claims }),
		});
		cleanups.push(async () => {
			await host.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		});

		const originalExecute = driver.execute.bind(driver);
		if (mode !== "normal")
			vi.spyOn(driver, "execute").mockImplementation(
				async (command, context) => {
					if (mode === "late-unsubmitted") {
						if (command.kind !== "native-command")
							throw new Error("Expected native command");
						return driverOperationResult(command, command.nativeSessionRef, {
							outcome: "unknown",
							code: "RUNTIME_ACCEPTANCE_UNKNOWN",
							message: "Runtime command acceptance could not be confirmed",
						});
					}
					if (mode === "driver-invalid")
						throw new RuntimeHostError(
							"RUNTIME_DRIVER_INVALID",
							"Runtime driver returned an invalid result",
							503,
							true,
						);
					if (mode === "same-code-untyped")
						throw new RuntimeHostError(
							"RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
							"Native command execution is unavailable for this runtime",
							409,
						);
					if (mode === "existing-record")
						await originalExecute(command, context);
					throw new RuntimeNativeCommandNotSubmittedError();
				},
			);
		if (mode === "lookup-uncertain") {
			const lookup = driver.lookupOperation.bind(driver);
			let lookups = 0;
			vi.spyOn(driver, "lookupOperation").mockImplementation(
				async (command) => {
					if (++lookups > 1)
						throw new TypeError("Synthetic lookup transport failed");
					return lookup(command);
				},
			);
		}
		const delivery = { businessRequest: request, privateKeyField };
		if (
			[
				"same-code-untyped",
				"driver-invalid",
				"lookup-uncertain",
				"existing-record",
			].includes(mode)
		) {
			await expect(host.nativeCapabilityV6(delivery)).rejects.toMatchObject({
				code: "RUNTIME_DRIVER_INVALID",
				retryable: true,
			});
			const persisted = JSON.parse(
				await readFile(join(directory, "host.json"), "utf8"),
			);
			expect(
				persisted.sessions[request.hostSessionRef].operations[
					request.executionId
				],
			).not.toMatchObject({
				state: "resolved",
				result: { outcome: "rejected" },
			});
			return;
		}
		const response = await host.nativeCapabilityV6(delivery);
		if (mode === "late-unsubmitted") {
			expect(response.result.outcome).toBe("unknown");
			const refusal = {
				outcome: "rejected",
				code: "RUNTIME_NATIVE_COMMAND_NOT_SUBMITTED",
				message: "Native command was not submitted",
				retryable: false,
			} as const;
			vi.spyOn(driver, "lookupOperation").mockImplementation(
				async (command) => {
					if (command.kind !== "native-command")
						throw new Error("Expected the original native command");
					return {
						state: "found",
						record: driverOperationResult(
							command,
							command.nativeSessionRef,
							refusal,
						),
					};
				},
			);
			const query = signV3Fixture(
				{
					schemaVersion: 3,
					requestId: "recovery",
					traceId: request.traceId,
					principal: request.principal,
					agentId: request.agentId,
					channelId: request.channelId,
					conversationId: request.conversationId,
					sessionGeneration: request.sessionGeneration,
					executionId: request.executionId,
					turnId: request.turnId,
					hostSessionRef: request.hostSessionRef,
					operation: request.operation,
					originalOperationDigest: originalRequestDigest(
						runtimeOperationDigestInputV6(request),
					),
				},
				"session.status",
				{
					purpose: "control",
					reason: "recovery",
					now: clock,
					claims: { workerId: claims.workerId },
				},
			);
			const error = { code: refusal.code, httpStatus: 409, retryable: false };
			await expect(
				host.recoverStatusV3(query, verifyRuntimeV2Fixture(query.grant)),
			).rejects.toMatchObject(error);
			await expect(host.nativeCapabilityV6(delivery)).rejects.toMatchObject(
				error,
			);
			const saved = JSON.parse(
				await readFile(join(directory, "host.json"), "utf8"),
			);
			expect(
				saved.sessions[request.hostSessionRef].operations[request.executionId]
					.result.outcome,
			).toBe("unknown");
			expect(driver.execute).toHaveBeenCalledTimes(1);
			return;
		}
		if (mode === "selection-rejected") {
			expect(response).toMatchObject({
				schemaVersion: 6,
				operationId: request.executionId,
				result: {
					outcome: "rejected",
					code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
					retryable: false,
				},
			});
			expect(await host.nativeCapabilityV6(delivery)).toEqual(response);
			expect(driver.execute).toHaveBeenCalledTimes(1);
			await host.close();
			const reopened = await RuntimeHost.open({
				store,
				driver,
				grantValidation: { expectedIssuer: "platform-fixture" },
				validateGrantV6: async () => ({ request, claims }),
			});
			try {
				expect(await reopened.nativeCapabilityV6(delivery)).toEqual(response);
				expect(driver.execute).toHaveBeenCalledTimes(1);
			} finally {
				await reopened.close();
			}
			return;
		}

		expect(response).toMatchObject({
			schemaVersion: 6,
			operationId: request.executionId,
			result: { outcome: "accepted", status: "completed" },
		});
		const persisted = JSON.parse(
			await readFile(join(directory, "host.json"), "utf8"),
		) as {
			sessions: Record<
				string,
				{ operations: Record<string, { command: { schemaVersion: number } }> }
			>;
		};
		expect(
			persisted.sessions[request.hostSessionRef]?.operations[
				request.executionId
			]?.command.schemaVersion,
		).toBe(2);
	},
);
