import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type { AgentConfigurationRecordV1 } from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";

import {
	insertPendingSecretRecordAttachments,
	PendingSecretRecordStoreError,
} from "./secret-records.ts";

const occurredAt = "2026-09-03T12:00:00.000Z";

function record(overrides: Record<string, unknown> = {}) {
	return validatePlatformSecretRecordV1({
		schemaVersion: 1,
		secretId: "secret_01",
		ownerType: "agent-owner",
		ownerId: "owner_01",
		agentId: "agent_01",
		name: "BOT_TOKEN",
		secretVersion: 2,
		configRevision: 7,
		lifecycleState: "pending",
		crypto: {
			schemaVersion: 1,
			algorithmVersion: "aes-256-gcm:v1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			wrappingKeyVersion: "key_01",
			aadBinding: {
				schemaVersion: 1,
				aadVersion: "platform-secret-aad:v1",
				secretId: "secret_01",
				ownerType: "agent-owner",
				ownerId: "owner_01",
				agentId: "agent_01",
				name: "BOT_TOKEN",
				secretVersion: 2,
				configRevision: 7,
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: "key_01",
			},
			dekFingerprint: "a".repeat(64),
			nonce: "AAAAAAAAAAAAAAAA",
			ciphertext: "YWJjZA==",
			authenticationTag: "AAAAAAAAAAAAAAAAAAAAAA==",
			wrappedDek: "A".repeat(512),
		},
		createdAt: occurredAt,
		updatedAt: occurredAt,
		...overrides,
	});
}

function attachments(encryptedRecords: unknown) {
	return {
		schemaVersion: 1 as const,
		expected: [
			{
				schemaVersion: 1 as const,
				ownerType: "agent-owner" as const,
				ownerId: "owner_01",
				agentId: "agent_01",
				name: "BOT_TOKEN",
				secretId: "secret_01",
				secretVersion: 2,
				configurationRevision: 7,
				occurredAt,
			},
		],
		encryptedRecords,
	};
}

const configuration = {
	agentId: "agent_01",
	revision: 7,
	secrets: [
		{
			name: "BOT_TOKEN",
			secretId: "secret_01",
			version: 2,
			isSet: true,
		},
	],
	modelConfiguration: null,
} as unknown as AgentConfigurationRecordV1;

function transaction() {
	const values = vi.fn().mockResolvedValue(undefined);
	const insert = vi.fn().mockReturnValue({ values });
	return { transaction: { insert } as never, insert, values };
}

describe("pending Secret record Store sidecar", () => {
	it("writes only a validated pending ciphertext record", async () => {
		const { transaction: database, insert, values } = transaction();
		await insertPendingSecretRecordAttachments(
			database,
			attachments([record()]),
			configuration,
		);

		expect(insert).toHaveBeenCalledOnce();
		expect(values).toHaveBeenCalledWith([
			expect.objectContaining({
				secretId: "secret_01",
				configurationRevision: 7,
				dekFingerprint: "a".repeat(64),
				lifecycleState: "pending",
			}),
		]);
		expect(JSON.stringify(values.mock.calls)).not.toContain("plaintext");
	});

	it("rejects mismatched or malformed attachment data before insertion", async () => {
		for (const encryptedRecords of [
			[{ ...record(), name: "OTHER_TOKEN" }],
			[{ ...record(), secretVersion: 3 }],
			new Proxy([record()], {}),
			[],
		] as const) {
			const { transaction: database, insert } = transaction();
			await expect(
				insertPendingSecretRecordAttachments(
					database,
					attachments(encryptedRecords) as never,
					configuration,
				),
			).rejects.toBeInstanceOf(PendingSecretRecordStoreError);
			expect(insert).not.toHaveBeenCalled();
		}
	});

	it("rejects a valid ciphertext record unrelated to the admitted configuration", async () => {
		const unrelated = attachments([{ ...record(), name: "OTHER_TOKEN" }]);
		const expected = unrelated.expected[0];
		if (!expected) throw new Error("Expected attachment metadata");
		unrelated.expected = [{ ...expected, name: "OTHER_TOKEN" }];
		const { transaction: database, insert } = transaction();

		await expect(
			insertPendingSecretRecordAttachments(database, unrelated, configuration),
		).rejects.toBeInstanceOf(PendingSecretRecordStoreError);
		expect(insert).not.toHaveBeenCalled();
	});
});
