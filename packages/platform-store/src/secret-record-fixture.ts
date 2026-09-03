import { createHash, generateKeyPairSync } from "node:crypto";

import type { PendingSecretRecordAttachmentResolverV1 } from "@agent-infra/platform-core";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
const encryptor = createSecretEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: "key_test_01",
		keys: [
			{
				schemaVersion: 1,
				keyVersion: "key_test_01",
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

export function createSecretRecordFixtureResolver(): PendingSecretRecordAttachmentResolverV1 {
	return {
		async resolve({ expected }) {
			return expected.map((expectation) =>
				encryptor.encrypt({
					schemaVersion: 1,
					secretId: expectation.secretId,
					ownerType: expectation.ownerType,
					ownerId: expectation.ownerId,
					agentId: expectation.agentId,
					name: expectation.name,
					secretVersion: expectation.secretVersion,
					configRevision: expectation.configurationRevision,
					plaintext: `fixture:${expectation.secretId}:${expectation.secretVersion}`,
					occurredAt: expectation.occurredAt,
				}),
			);
		},
	};
}
