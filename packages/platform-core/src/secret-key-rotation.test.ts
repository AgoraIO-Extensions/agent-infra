import { describe, expect, it, vi } from "vitest";

import {
	createSecretKeyRotationUseCaseV1,
	type SecretKeyRotationStorePortV1,
} from "./secret-key-rotation.js";

const command = {
	schemaVersion: 1 as const,
	rotationId: "rotation_01",
	sourceKeyVersions: ["key_01"],
	targetKeyVersion: "key_02",
	workerId: "worker_01",
	traceId: "trace_01",
};

const candidate = {
	schemaVersion: 1 as const,
	agentId: "agent_01",
	secretId: "secret_01",
	secretVersion: 2,
	configRevision: 7,
	ownerType: "agent-owner" as const,
	ownerId: "owner_01",
	name: "MODEL_API_KEY",
	lifecycleState: "active" as const,
	wrappingKeyVersion: "key_01",
	dekFingerprint: "a".repeat(64),
	encryptedRecord: { ciphertext: "boundary-sensitive" },
};

function progress(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1 as const,
		rotationId: command.rotationId,
		sourceKeyVersions: command.sourceKeyVersions,
		targetKeyVersion: command.targetKeyVersion,
		state: "rewrapping" as const,
		processedSecrets: 0,
		remainingSecrets: 1,
		updatedAt: new Date("2026-09-05T13:20:00.000Z"),
		...overrides,
	};
}

describe("Secret key rotation", () => {
	it("re-encrypts one source-key record and commits a redacted audit", async () => {
		const nextCandidate = vi.fn().mockResolvedValue({
			outcome: "candidate",
			progress: progress(),
			candidate,
		});
		const commitReencryption = vi.fn().mockResolvedValue({
			outcome: "committed",
			progress: progress({
				state: "completed",
				processedSecrets: 1,
				remainingSecrets: 0,
			}),
		});
		const store = {
			nextCandidate,
			commitReencryption,
			recordRejection: vi.fn(),
			retireKey: vi.fn(),
		} satisfies SecretKeyRotationStorePortV1;
		const reencrypt = vi.fn().mockResolvedValue({
			outcome: "reencrypted",
			attemptId: "attempt_01",
			encryptedRecord: { ciphertext: "rotated-opaque" },
		});
		const useCase = createSecretKeyRotationUseCaseV1({
			store,
			crypto: {
				activeWrappingKeyVersion: "key_02",
				retiringWrappingKeyVersions: ["key_01"],
				reencrypt,
			},
		});

		await expect(useCase.rotate(command)).resolves.toMatchObject({
			schemaVersion: 1,
			outcome: "completed",
			progress: { processedSecrets: 1, remainingSecrets: 0 },
		});
		expect(reencrypt).toHaveBeenCalledWith({
			encryptedRecord: candidate.encryptedRecord,
			expectedBinding: {
				agentId: candidate.agentId,
				secretId: candidate.secretId,
				secretVersion: candidate.secretVersion,
				configRevision: candidate.configRevision,
				ownerType: candidate.ownerType,
				ownerId: candidate.ownerId,
				name: candidate.name,
				wrappingKeyVersion: candidate.wrappingKeyVersion,
				dekFingerprint: candidate.dekFingerprint,
			},
			targetKeyVersion: "key_02",
			traceId: "trace_01",
		});
		expect(commitReencryption).toHaveBeenCalledWith({
			command,
			candidate,
			encryptedRecord: { ciphertext: "rotated-opaque" },
			auditEvents: [
				expect.objectContaining({
					action: "secret.decrypt",
					outcome: "succeeded",
					details: expect.objectContaining({ operation: "decrypt" }),
				}),
				expect.objectContaining({
					traceId: "trace_01",
					action: "secret.rewrap",
					targetType: "secret",
					targetId: "secret_01",
					agentId: "agent_01",
					outcome: "succeeded",
					details: {
						wrappingKeyVersion: "key_01",
						operation: "rewrap",
						result: "succeeded",
					},
				}),
			],
			rejectedAuditEvents: [
				expect.objectContaining({
					action: "secret.decrypt",
					outcome: "succeeded",
				}),
				expect.objectContaining({
					action: "secret.rewrap",
					outcome: "rejected",
				}),
			],
		});
		expect(
			JSON.stringify(commitReencryption.mock.calls[0]?.[0]?.auditEvents),
		).not.toContain("boundary-sensitive");
	});

	it("discards a duplicate DEK fingerprint and retries with fresh material", async () => {
		const nextCandidate = vi.fn().mockResolvedValue({
			outcome: "candidate",
			progress: progress(),
			candidate,
		});
		const commitReencryption = vi
			.fn()
			.mockResolvedValueOnce({ outcome: "duplicate-fingerprint" })
			.mockResolvedValueOnce({
				outcome: "committed",
				progress: progress({
					state: "completed",
					processedSecrets: 1,
					remainingSecrets: 0,
				}),
			});
		const reencrypt = vi
			.fn()
			.mockResolvedValueOnce({
				outcome: "reencrypted",
				attemptId: "attempt_duplicate_01",
				encryptedRecord: { crypto: { dekFingerprint: "b".repeat(64) } },
			})
			.mockResolvedValueOnce({
				outcome: "reencrypted",
				attemptId: "attempt_duplicate_02",
				encryptedRecord: { crypto: { dekFingerprint: "c".repeat(64) } },
			});
		const useCase = createSecretKeyRotationUseCaseV1({
			store: {
				nextCandidate,
				commitReencryption,
				recordRejection: vi.fn(),
				retireKey: vi.fn(),
			},
			crypto: {
				activeWrappingKeyVersion: "key_02",
				retiringWrappingKeyVersions: ["key_01"],
				reencrypt,
			},
		});

		await expect(useCase.rotate(command)).resolves.toMatchObject({
			outcome: "completed",
		});
		expect(reencrypt).toHaveBeenCalledTimes(2);
		expect(commitReencryption).toHaveBeenCalledTimes(2);
		expect(commitReencryption.mock.calls[1]?.[0].encryptedRecord).toEqual({
			crypto: { dekFingerprint: "c".repeat(64) },
		});
		expect(commitReencryption.mock.calls[0]?.[0].rejectedAuditEvents).toEqual([
			expect.objectContaining({
				action: "secret.decrypt",
				outcome: "succeeded",
			}),
			expect.objectContaining({
				action: "secret.rewrap",
				outcome: "rejected",
			}),
		]);
	});

	it("audits a completed crypto attempt rejected by a stale Store fence", async () => {
		const commitReencryption = vi.fn().mockResolvedValue({ outcome: "stale" });
		const useCase = createSecretKeyRotationUseCaseV1({
			store: {
				nextCandidate: vi.fn().mockResolvedValue({
					outcome: "candidate",
					progress: progress(),
					candidate,
				}),
				commitReencryption,
				recordRejection: vi.fn(),
				retireKey: vi.fn(),
			},
			crypto: {
				activeWrappingKeyVersion: "key_02",
				retiringWrappingKeyVersions: ["key_01"],
				reencrypt: vi.fn().mockResolvedValue({
					outcome: "reencrypted",
					attemptId: "attempt_stale_01",
					encryptedRecord: { ciphertext: "rotated-opaque" },
				}),
			},
		});

		await expect(useCase.rotate(command)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "stale",
		});
		expect(commitReencryption.mock.calls[0]?.[0].rejectedAuditEvents).toEqual([
			expect.objectContaining({
				action: "secret.decrypt",
				outcome: "succeeded",
			}),
			expect.objectContaining({ action: "secret.rewrap", outcome: "rejected" }),
		]);
	});

	it.each([
		["SECRET_KEY_UNAVAILABLE", "failed"],
		["SECRET_METADATA_INVALID", "rejected"],
		["SECRET_AUTHENTICATION_FAILED", "rejected"],
	] as const)(
		"keeps the source record and audits a redacted %s failure",
		async (code, auditOutcome) => {
			const recordRejection = vi.fn().mockResolvedValue(true);
			const commitReencryption = vi.fn();
			const useCase = createSecretKeyRotationUseCaseV1({
				store: {
					nextCandidate: vi.fn().mockResolvedValue({
						outcome: "candidate",
						progress: progress(),
						candidate,
					}),
					commitReencryption,
					recordRejection,
					retireKey: vi.fn(),
				},
				crypto: {
					activeWrappingKeyVersion: "key_02",
					retiringWrappingKeyVersions: ["key_01"],
					reencrypt: vi.fn().mockResolvedValue({
						outcome: "failed",
						attemptId: "attempt_failure_01",
						code,
					}),
				},
			});

			await expect(useCase.rotate(command)).resolves.toEqual({
				schemaVersion: 1,
				outcome: "failed",
				code,
			});
			expect(commitReencryption).not.toHaveBeenCalled();
			expect(recordRejection).toHaveBeenCalledWith({
				command,
				candidate,
				auditEvents: [
					expect.objectContaining({
						action: "secret.decrypt",
						outcome: auditOutcome,
						details: expect.objectContaining({ result: auditOutcome }),
					}),
				],
				failureCode: code,
			});
			expect(JSON.stringify(recordRejection.mock.calls)).not.toContain(
				"rotated-opaque",
			);
		},
	);

	it("audits decrypt success before a re-encryption failure", async () => {
		const recordRejection = vi.fn().mockResolvedValue(true);
		const useCase = createSecretKeyRotationUseCaseV1({
			store: {
				nextCandidate: vi.fn().mockResolvedValue({
					outcome: "candidate",
					progress: progress(),
					candidate,
				}),
				commitReencryption: vi.fn(),
				recordRejection,
				retireKey: vi.fn(),
			},
			crypto: {
				activeWrappingKeyVersion: "key_02",
				retiringWrappingKeyVersions: ["key_01"],
				reencrypt: vi.fn().mockResolvedValue({
					outcome: "failed",
					attemptId: "attempt_rotation_failure_01",
					code: "SECRET_ROTATION_FAILED",
				}),
			},
		});

		await expect(useCase.rotate(command)).resolves.toMatchObject({
			outcome: "failed",
			code: "SECRET_ROTATION_FAILED",
		});
		expect(recordRejection).toHaveBeenCalledWith({
			command,
			candidate,
			failureCode: "SECRET_ROTATION_FAILED",
			auditEvents: [
				expect.objectContaining({
					action: "secret.decrypt",
					outcome: "succeeded",
				}),
				expect.objectContaining({
					action: "secret.rewrap",
					outcome: "failed",
				}),
			],
		});
	});

	it("retires a key only through the no-reference Store decision", async () => {
		const retireKey = vi
			.fn()
			.mockResolvedValueOnce("referenced")
			.mockResolvedValueOnce("retired");
		const useCase = createSecretKeyRotationUseCaseV1({
			store: {
				nextCandidate: vi.fn(),
				commitReencryption: vi.fn(),
				recordRejection: vi.fn(),
				retireKey,
			},
			crypto: {
				activeWrappingKeyVersion: "key_02",
				retiringWrappingKeyVersions: ["key_01"],
				reencrypt: vi.fn(),
			},
		});
		const retirement = {
			schemaVersion: 1 as const,
			keyVersion: "key_01",
			workerId: "worker_01",
			traceId: "trace_retire_01",
		};

		await expect(useCase.retire(retirement)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "referenced",
		});
		await expect(useCase.retire(retirement)).resolves.toEqual({
			schemaVersion: 1,
			outcome: "retired",
		});
		expect(retireKey).toHaveBeenLastCalledWith({
			command: retirement,
			activeWrappingKeyVersion: "key_02",
			retiredAuditEvent: expect.objectContaining({
				traceId: "trace_retire_01",
				action: "secret.retire-key",
				targetType: "secret_key",
				targetId: "key_01",
				agentId: null,
				outcome: "succeeded",
				details: {
					wrappingKeyVersion: "key_01",
					operation: "retire-key",
					result: "succeeded",
				},
			}),
			rejectedAuditEvent: expect.objectContaining({
				action: "secret.retire-key",
				outcome: "rejected",
				details: expect.objectContaining({ result: "rejected" }),
			}),
		});
		expect(JSON.stringify(retireKey.mock.calls)).not.toContain(
			"boundary-sensitive",
		);
	});

	it("uses only the active target key and never retires it", async () => {
		const nextCandidate = vi.fn();
		const retireKey = vi.fn().mockResolvedValue("referenced");
		const useCase = createSecretKeyRotationUseCaseV1({
			store: {
				nextCandidate,
				commitReencryption: vi.fn(),
				recordRejection: vi.fn(),
				retireKey,
			},
			crypto: {
				activeWrappingKeyVersion: "key_02",
				retiringWrappingKeyVersions: ["key_01"],
				reencrypt: vi.fn(),
			},
		});

		await expect(
			useCase.rotate({ ...command, targetKeyVersion: "key_03" }),
		).rejects.toMatchObject({ code: "invalid_input" });
		expect(nextCandidate).not.toHaveBeenCalled();
		await expect(
			createSecretKeyRotationUseCaseV1({
				store: {
					nextCandidate,
					commitReencryption: vi.fn(),
					recordRejection: vi.fn(),
					retireKey,
				},
				crypto: {
					activeWrappingKeyVersion: "key_02",
					retiringWrappingKeyVersions: [],
					reencrypt: vi.fn(),
				},
			}).rotate(command),
		).rejects.toMatchObject({ code: "invalid_input" });
		await expect(
			useCase.retire({
				schemaVersion: 1,
				keyVersion: "key_02",
				workerId: "worker_01",
				traceId: "trace_retire_active",
			}),
		).resolves.toEqual({ schemaVersion: 1, outcome: "referenced" });
		expect(retireKey).toHaveBeenCalledOnce();
	});
});
