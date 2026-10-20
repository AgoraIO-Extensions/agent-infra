import { createHash, generateKeyPairSync } from "node:crypto";
import {
	RuntimeEventAckRequestV4Schema,
	RuntimeEventReadRequestV4Schema,
	RuntimeNativeCapabilityRequestV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	validateRuntimePrivateRelayKeyFieldV1,
} from "@agent-infra/contracts/runtime";
import { nativeCapabilityParametersDigestV1 } from "@agent-infra/platform-core";
import { createRelayKeyEncryptorV1 } from "@agent-infra/secret-store";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { describe, expect, it, vi } from "vitest";
import { createWorkerRuntimeGrantSignerV4 } from "./runtime-grant-signer-v4.js";
import { createWorkerRuntimeHostClientV4 } from "./runtime-host-client.js";
import { keySentinel, runtimeV4Harness } from "./test-support/runtime-v4.js";

function clientHarness() {
	const h = runtimeV4Harness();
	const accepted = h.accepted();
	if (!accepted) throw new Error("Missing fixture acceptance");
	const signer = createWorkerRuntimeGrantSignerV4(h.options.signing);
	const unsigned = RuntimeSubmitTurnRequestV4Schema.parse({
		schemaVersion: 4,
		requestId: "request",
		traceId: "trace",
		...accepted.scope,
		operation: {
			kind: "execution",
			id: "execution",
			deliveryFence: 2,
			executionDeliveryFence: 2,
		},
		input: { text: "original accepted input", attachments: [] },
		selection: accepted.selection,
		grant: {
			schemaVersion: 4,
			format: "runtime-execution-jws",
			token: "unsigned.unsigned.unsigned",
		},
	});
	const request = {
		...unsigned,
		grant: signer.sign(unsigned, "authorization"),
	};
	const assertCurrentAuthorization = vi.fn(async () => {});
	const options = {
		...h.target,
		fetch: h.fetcher,
		verifyGrant: signer.verify,
		executionKeys: h.executionKeys,
		decryptor: h.relayKeyDecryptor,
		selection: accepted.selection,
		assertCurrentAuthorization,
		signRecovery: signer.signRecovery,
	};
	return {
		h,
		signer,
		request,
		options,
		client: createWorkerRuntimeHostClientV4(options),
	};
}

describe("V4 authenticated confidential private Key client", () => {
	it.each([
		{ kind: "command" as const, parameters: "" },
		{ kind: "skill" as const, parameters: '请汇总工作区\n"文件"\\路径 🧪' },
	])(
		"accepts the Core parameter digest for $kind through V4 validation (#2950)",
		async ({ kind, parameters }) => {
			const { h, client, signer, request } = clientHarness();
			try {
				const { input: _input, selection: _selection, ...context } = request;
				const original = h.accepted();
				if (!original) throw new Error("Missing fixture acceptance");
				h.setAccepted({
					...original,
					trustedHostSessionRef: "host",
					scope: { ...original.scope, hostSessionRef: "host" },
					selection: undefined,
				});
				const unsigned = RuntimeNativeCapabilityRequestV4Schema.parse({
					...context,
					hostSessionRef: "host",
					capabilityId: "a".repeat(64),
					capabilityKind: kind,
					directoryRevision: "b".repeat(64),
					capabilitySourceVersion: "original-version",
					parameters,
					parametersDigest: nativeCapabilityParametersDigestV1(parameters),
				});
				const signed = {
					...unsigned,
					grant: signer.sign(unsigned, "authorization"),
				};
				await expect(client.nativeCapability(signed)).resolves.toMatchObject({
					result: { outcome: "accepted", status: "running" },
				});
				expect(h.fetcher).toHaveBeenCalledTimes(1);
				expect(h.sent().url).toBe(
					"http://runtime.test/internal/runtime/v4/native-capability",
				);
				expect(h.sent().body.businessRequest.parametersDigest).toBe(
					createHash("sha256").update(parameters, "utf8").digest("hex"),
				);

				const encoded = {
					...unsigned,
					parametersDigest: createHash("sha256")
						.update(JSON.stringify(parameters))
						.digest("hex"),
				};
				await expect(
					client.nativeCapability({
						...encoded,
						grant: signer.sign(encoded, "authorization"),
					}),
				).rejects.toMatchObject({ code: "RUNTIME_REQUEST_INVALID" });
				expect(h.fetcher).toHaveBeenCalledTimes(1);
			} finally {
				h.runtime.close();
			}
		},
	);

	it.each([
		"missing",
		"principal",
		"agent",
		"generation",
		"channel",
		"key-version",
		"host",
		"selection",
		"stop",
	] as const)(
		"rejects native Skill recovery with %s acceptance before decrypting or sending a Key",
		async (changed) => {
			const { h, client, request } = clientHarness();
			try {
				const { input: _input, selection: _selection, ...context } = request;
				const skill = RuntimeNativeCapabilityRequestV4Schema.parse({
					...context,
					hostSessionRef: "host",
					capabilityId: "a".repeat(64),
					capabilityKind: "skill",
					directoryRevision: "b".repeat(64),
					capabilitySourceVersion: "original-version",
					parameters: "",
					parametersDigest: createHash("sha256").update("").digest("hex"),
				});
				const original = h.accepted();
				if (!original) throw new Error("missing acceptance fixture");
				const accepted = {
					...original,
					trustedHostSessionRef: "host",
					scope: { ...original.scope, hostSessionRef: "host" },
					selection: undefined,
				};
				if (changed === "principal")
					accepted.scope.principal = { kind: "user", id: "other-user" };
				if (changed === "agent") accepted.scope.agentId = "other-agent";
				if (changed === "generation") accepted.scope.sessionGeneration += 1;
				if (changed === "channel") accepted.scope.channelId = "other-channel";
				if (changed === "key-version") accepted.scope.keyBinding.version += 1;
				if (changed === "host") accepted.trustedHostSessionRef = "other-host";
				h.setAccepted(
					changed === "missing"
						? null
						: {
								...accepted,
								...(changed === "stop" ? { stopPending: true } : {}),
								...(changed === "selection"
									? { selection: original.selection }
									: {}),
							},
				);
				await expect(
					client.restoreExecutionKey(
						{ ...skill, capabilityKind: "skill" },
						"host",
						"A".repeat(43),
					),
				).rejects.toThrow();
				expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
				expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
				expect(h.fetcher).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);

	it("delivers the original Key through the independent recovery route", async () => {
		const { h, client, request } = clientHarness();
		try {
			const accepted = h.accepted();
			if (!accepted) throw new Error("Missing fixture acceptance");
			h.setAccepted({ ...accepted, trustedHostSessionRef: "host" });
			h.fetcher.mockResolvedValue(
				Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					operationId: "execution",
					result: "restored",
				}),
			);
			const response = await client.restoreExecutionKey(
				request,
				"host",
				"A".repeat(43),
			);
			expect(response).toMatchObject({
				schemaVersion: 4,
				hostSessionRef: "host",
				operationId: "execution",
				result: "restored",
			});
			expect(String(h.sent().url)).toContain(
				"/internal/runtime/v4/execution-key/restore",
			);
			expect(h.sent().body).toHaveProperty(
				"recoveryRequest.mode",
				"existing-accepted-only",
			);
			expect(h.sent().body).not.toHaveProperty(
				"recoveryRequest.createIfMissing",
			);
		} finally {
			h.runtime.close();
		}
	});

	it("uses the existing real cipher decryptor and zeroes its original plaintext buffer", async () => {
		const { h, options, request } = clientHarness();
		const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
		const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
		const wrappingKeyVersion = "wrapping-test";
		const encryptor = createRelayKeyEncryptorV1({
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: wrappingKeyVersion,
				keys: [
					{
						schemaVersion: 1,
						keyVersion: wrappingKeyVersion,
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: publicDer.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(publicDer)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "active",
					},
				],
			},
		});
		const decryptor = createRelayKeyWorkerDecryptorV1({
			keys: [
				{
					keyVersion: wrappingKeyVersion,
					privateKeyPkcs8DerBase64: keys.privateKey
						.export({ format: "der", type: "pkcs8" })
						.toString("base64"),
				},
			],
		});
		const encryptedRecord = encryptor.encrypt({
			purpose: "personal",
			subjectId: "user",
			keyId: "key-original",
			keyVersion: 1,
			plaintext: keySentinel,
		});
		h.executionKeys.readCiphertext.mockResolvedValue(encryptedRecord);
		let plaintext: Uint8Array | undefined;
		try {
			await createWorkerRuntimeHostClientV4({
				...options,
				decryptor: {
					decrypt: async (input) => {
						const result = await decryptor.decrypt(input);
						if (result.outcome === "decrypted") plaintext = result.plaintext;
						return result;
					},
				},
			}).submitTurn(request);
			expect(plaintext?.every((byte) => byte === 0)).toBe(true);
			expect(h.sent().body.privateKeyField.keyDelivery.relayKey).toBe(
				keySentinel,
			);
			const claims = options.verifyGrant(request.grant);
			expect(
				validateRuntimePrivateRelayKeyFieldV1(h.sent().body.privateKeyField, {
					request,
					grantId: claims.grantId,
					requestDigest: claims.requestDigest,
				}),
			).toEqual(h.sent().body.privateKeyField);
			const wrong = {
				...h.sent().body.privateKeyField,
				context: {
					...h.sent().body.privateKeyField.context,
					grantId: "other-grant",
				},
			};
			expect(() =>
				validateRuntimePrivateRelayKeyFieldV1(wrong, {
					request,
					grantId: claims.grantId,
					requestDigest: claims.requestDigest,
				}),
			).toThrow();
		} finally {
			h.runtime.close();
		}
	});

	it.each([
		"https://runtime.test",
		"http://user:password@runtime.test",
		"http://runtime.test?override=1",
		"http://runtime.test#fragment",
	])("rejects a non in-cluster plaintext origin %s", (baseUrl) => {
		const { h, options } = clientHarness();
		try {
			expect(() =>
				createWorkerRuntimeHostClientV4({ ...options, baseUrl }),
			).toThrow();
		} finally {
			h.runtime.close();
		}
	});

	it.each([
		"RELAY_KEY_UNAVAILABLE",
		"RELAY_KEY_METADATA_INVALID",
		"RELAY_KEY_AUTHENTICATION_FAILED",
	] as const)("keeps %s local and sanitized", async (code) => {
		const { h, client, request } = clientHarness();
		try {
			h.relayKeyDecryptor.decrypt.mockResolvedValue({
				outcome: "failed",
				code,
			});
			await expect(client.submitTurn(request)).rejects.toMatchObject({
				code,
				retryable: false,
			});
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it("rejects a missing original ciphertext without asking for a replacement", async () => {
		const { h, client, request } = clientHarness();
		try {
			h.executionKeys.readCiphertext.mockResolvedValue(null);
			await expect(client.submitTurn(request)).rejects.toMatchObject({
				code: "RELAY_KEY_UNAVAILABLE",
				retryable: false,
			});
			expect(h.executionKeys.readCiphertext).toHaveBeenCalledTimes(1);
			expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it("zeroes invalid UTF-8 plaintext before rejecting without dispatch", async () => {
		const { h, client, request } = clientHarness();
		const plaintext = new Uint8Array([255, 254, 253]);
		try {
			h.relayKeyDecryptor.decrypt.mockResolvedValue({
				outcome: "decrypted",
				plaintext,
			});
			await expect(client.submitTurn(request)).rejects.toMatchObject({
				code: "RUNTIME_REQUEST_INVALID",
				retryable: false,
			});
			expect([...plaintext]).toEqual([0, 0, 0]);
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it.each([
		"principal",
		"request",
		"fence",
		"selection",
		"input",
		"key-version",
	])("rejects unsigned %s replacement", async (field) => {
		const { h, client, request } = clientHarness();
		try {
			const next = structuredClone(request);
			if (field === "principal")
				next.principal = { kind: "application", id: "user" };
			if (field === "request") next.requestId = "other-request";
			if (field === "fence") next.operation.deliveryFence = 3;
			if (field === "selection") next.selection.modelOptionId = "other-option";
			if (field === "input" && "text" in next.input)
				next.input.text = "other-input";
			if (field === "key-version") next.keyBinding.version = 2;
			await expect(client.submitTurn(next)).rejects.toThrow();
			expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it.each([
		"malformed",
		"wrong operation",
		"wrong original Host",
		"oversized",
		"network failure",
	])("preserves %s as ambiguous with one send", async (outcome) => {
		const { h, client, request } = clientHarness();
		try {
			const bound = { ...request, hostSessionRef: "host" };
			bound.grant = createWorkerRuntimeGrantSignerV4(h.options.signing).sign(
				bound,
				"authorization",
			);
			const accepted = h.accepted();
			if (!accepted) throw new Error("Missing fixture acceptance");
			h.setAccepted({
				...accepted,
				scope: { ...accepted.scope, hostSessionRef: "host" },
				trustedHostSessionRef: "host",
			});
			h.fetcher.mockImplementation(async () => {
				if (outcome === "network failure") throw new Error(keySentinel);
				if (outcome === "malformed") return new Response(keySentinel);
				if (outcome === "oversized") return new Response("x".repeat(65_537));
				return Response.json({
					schemaVersion: 4,
					hostSessionRef:
						outcome === "wrong original Host" ? "other-host" : "host",
					operationId:
						outcome === "wrong operation" ? "other-operation" : "execution",
					result: { outcome: "accepted", status: "running" },
				});
			});
			const error = await client
				.submitTurn(bound)
				.catch((value) => value as Error & { retryable: boolean });
			expect(error).toMatchObject({ retryable: true });
			expect(String(error)).not.toContain(keySentinel);
			expect(h.fetcher).toHaveBeenCalledTimes(1);
		} finally {
			h.runtime.close();
		}
	});

	it("passes unknown acceptance without retries or changing the original operation", async () => {
		const { h, client, request } = clientHarness();
		try {
			h.fetcher.mockResolvedValue(
				Response.json({
					schemaVersion: 4,
					hostSessionRef: "host",
					operationId: "execution",
					result: {
						outcome: "unknown",
						code: "RUNTIME_ACCEPTANCE_UNKNOWN",
						message: "Runtime command acceptance could not be confirmed",
					},
				}),
			);
			expect(await client.submitTurn(request)).toMatchObject({
				operationId: "execution",
				result: { outcome: "unknown" },
			});
			expect(h.fetcher).toHaveBeenCalledTimes(1);
		} finally {
			h.runtime.close();
		}
	});

	it.each([
		"cross execution",
		"cross Host",
		"duplicate cursor",
		"committed cursor",
	])("rejects %s in V4 replay before returning facts", async (mismatch) => {
		const { h, signer, request, client } = clientHarness();
		try {
			const { input: _input, selection: _selection, ...context } = request;
			const read = RuntimeEventReadRequestV4Schema.parse({
				...context,
				hostSessionRef: "host",
				consumer: "platform_worker_persistence",
				afterCursor: "committed",
				grant: {
					schemaVersion: 2,
					format: "runtime-execution-jws",
					token: "unsigned.unsigned.unsigned",
				},
			});
			read.grant = await signer.signEvent(read, {
				purpose: "business",
				authorizationRecordId: "authorization",
			});
			const event = {
				schemaVersion: 2,
				adapterEventKey: "fact",
				executionId:
					mismatch === "cross execution" ? "other-execution" : "execution",
				cursor: mismatch === "committed cursor" ? "committed" : "next",
				occurredAt: "2026-10-02T00:00:00Z",
				type: "operation",
				payload: {
					kind: "tool",
					phase: "completed",
					operationRef: "tool-operation",
					attemptRef: "attempt",
					toolId: "connection-tool",
					resultRef: "result",
					connection: {
						verification: "verified",
						serviceRef: "connection",
						callRef: "call",
					},
				},
			};
			h.fetcher.mockResolvedValue(
				Response.json({
					schemaVersion: 4,
					hostSessionRef: mismatch === "cross Host" ? "other-host" : "host",
					executionId: "execution",
					events: mismatch === "duplicate cursor" ? [event, event] : [event],
				}),
			);
			await expect(client.readEvents(read)).rejects.toMatchObject({
				code: "RUNTIME_EVENT_INVALID",
				retryable: true,
			});
			expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it.each(["execution", "cursor"])(
		"rejects mismatched ACK %s",
		async (mismatch) => {
			const { h, signer, request, client } = clientHarness();
			try {
				const { input: _input, selection: _selection, ...context } = request;
				const ack = RuntimeEventAckRequestV4Schema.parse({
					...context,
					hostSessionRef: "host",
					consumer: "platform_worker_persistence",
					confirmedCursor: "committed",
					grant: {
						schemaVersion: 2,
						format: "runtime-execution-jws",
						token: "unsigned.unsigned.unsigned",
					},
				});
				ack.grant = await signer.signEvent(ack, {
					purpose: "control",
					reason: "recovery",
					controlRecordId: "control",
				});
				h.fetcher.mockResolvedValue(
					Response.json({
						schemaVersion: 4,
						executionId:
							mismatch === "execution" ? "other-execution" : "execution",
						confirmedCursor:
							mismatch === "cursor" ? "other-cursor" : "committed",
					}),
				);
				await expect(client.acknowledgeEvents(ack)).rejects.toMatchObject({
					code: "RUNTIME_RESPONSE_INVALID",
					retryable: true,
				});
				expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);
	it("aborts a decrypt wait and wipes a late plaintext result without delivering it", async () => {
		const { h, client, request } = clientHarness();
		const controller = new AbortController();
		let complete:
			| ((value: { outcome: "decrypted"; plaintext: Uint8Array }) => void)
			| undefined;
		h.relayKeyDecryptor.decrypt.mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const plaintext = new TextEncoder().encode(keySentinel);
		try {
			const pending = client.submitTurn(request, controller.signal);
			await vi.waitFor(() =>
				expect(h.relayKeyDecryptor.decrypt).toHaveBeenCalled(),
			);
			controller.abort();
			await expect(pending).rejects.toMatchObject({
				code: "RUNTIME_INTERRUPTED",
				retryable: true,
			});
			if (!complete) throw new Error("Missing decrypt completion fixture");
			complete({ outcome: "decrypted", plaintext });
			await vi.waitFor(() =>
				expect(plaintext.every((byte) => byte === 0)).toBe(true),
			);
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});
});
