import { createHash, generateKeyPairSync } from "node:crypto";

import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import { describe, expect, it } from "vitest";

import {
	createPendingSecretRecordAttachmentResolverV1,
	parsePendingSecretRecordAttachmentResolverV1,
} from "./secret-preparation.js";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
const encryptor = createSecretEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: "key_01",
		keys: [
			{
				schemaVersion: 1,
				keyVersion: "key_01",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				publicKeySpkiDerBase64: publicKeySpkiDer.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(publicKeySpkiDer)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active",
			},
		],
	},
});

describe("pending Secret preparation", () => {
	it("creates one redacted pending record from final Core metadata", async () => {
		const resolver = createPendingSecretRecordAttachmentResolverV1({
			encryptor,
			plaintexts: [
				{
					secretId: "secret_01",
					version: 2,
					plaintext: "plaintext-never-persisted",
				},
			],
		});
		const [record] = (await resolver.resolve({
			schemaVersion: 1,
			expected: [
				{
					schemaVersion: 1,
					ownerType: "agent-owner",
					ownerId: "owner_01",
					agentId: "agent_01",
					name: "BOT_TOKEN",
					secretId: "secret_01",
					secretVersion: 2,
					configurationRevision: 7,
					occurredAt: "2026-09-03T12:00:00.000Z",
				},
			],
		})) as unknown[];

		expect(validatePlatformSecretRecordV1(record)).toMatchObject({
			lifecycleState: "pending",
			agentId: "agent_01",
			secretId: "secret_01",
			secretVersion: 2,
			configRevision: 7,
		});
		expect(JSON.stringify(record)).not.toContain("plaintext-never-persisted");
		await expect(
			resolver.resolve({ schemaVersion: 1, expected: [] }),
		).rejects.toThrow("spent");
	});

	it("rejects attachment objects with values outside the capability", () => {
		expect(() =>
			parsePendingSecretRecordAttachmentResolverV1({
				resolve() {},
				plaintext: "must-not-cross-the-route-boundary",
			}),
		).toThrow("invalid");
	});
});
