import { createHash, generateKeyPairSync } from "node:crypto";

import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import type { PendingSecretRecordExpectationV1 } from "@agent-infra/platform-core";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import { describe, expect, it } from "vitest";

import { createDeploymentSecretPreparation } from "./deployment-secrets.js";

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const der = publicKey.export({ format: "der", type: "spki" });
const prepare = createDeploymentSecretPreparation(
	createSecretEncryptorV1({
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: "key_01",
			keys: [
				{
					schemaVersion: 1,
					keyVersion: "key_01",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: der.toString("base64"),
					publicKeyFingerprint: createHash("sha256").update(der).digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
	}),
);
const identity = {
	schemaVersion: 1 as const,
	userId: "owner_01",
	displayName: "Owner",
	accountStatus: "active" as const,
	organizationIds: ["org_01"],
	roles: ["employee" as const],
	authorizationRevision: "auth_01",
};
const metadata = {
	agentId: "agent_01",
	identity,
	requestId: "request_01",
	traceId: "trace_01",
};
const expectation: PendingSecretRecordExpectationV1 = {
	schemaVersion: 1,
	ownerType: "agent-owner",
	ownerId: identity.userId,
	agentId: metadata.agentId,
	name: "model:default",
	secretId: "secret_01",
	secretVersion: 2,
	configurationRevision: 7,
	occurredAt: "2026-09-14T00:00:00.000Z",
};

async function replacement() {
	return prepare.prepareConfigurationSecrets({
		...metadata,
		configurationRevision: 6,
		identityAuthorizationRevision: identity.authorizationRevision,
		secrets: [],
		modelCredentials: [
			{ optionId: "default", credentialValue: "sentinel-key" },
		],
	});
}

describe("deployment Secret preparation", () => {
	it("encrypts with final admitted metadata without exposing plaintext to Core", async () => {
		const prepared = await replacement();
		expect(JSON.stringify(prepared)).not.toContain("sentinel-key");
		expect(prepared.modelCredentialOptionIds).toEqual(["default"]);
		const records = (await prepared.attachment?.resolve({
			schemaVersion: 1,
			expected: [expectation],
		})) as unknown[];
		expect(validatePlatformSecretRecordV1(records[0])).toMatchObject({
			agentId: "agent_01",
			ownerId: "owner_01",
			secretVersion: 2,
			configRevision: 7,
			lifecycleState: "pending",
		});
		expect(JSON.stringify(records)).not.toContain("sentinel-key");
		await expect(
			prepared.attachment?.resolve({
				schemaVersion: 1,
				expected: [expectation],
			}),
		).rejects.toThrow("consumed");
	});

	it.each([
		{ agentId: "agent_other" },
		{ ownerId: "owner_other" },
		{ name: "UNREQUESTED_SECRET" },
	])(
		"rejects foreign attachment binding %j and consumes it",
		async (change) => {
			const { attachment } = await replacement();
			await expect(
				attachment?.resolve({
					schemaVersion: 1,
					expected: [{ ...expectation, ...change }],
				}),
			).rejects.toThrow("does not match");
			await expect(
				attachment?.resolve({ schemaVersion: 1, expected: [expectation] }),
			).rejects.toThrow("consumed");
		},
	);

	it("omits the attachment when retaining existing credentials", async () => {
		const prepared = await prepare.prepareApplicationSecrets({
			...metadata,
			applicationId: "application_01",
			secrets: [],
			modelConfiguration: {
				options: [
					{
						optionId: "default",
						endpointId: "endpoint_01",
						modelId: "model_01",
						reasoningLevels: ["medium"],
					},
				],
				defaultOptionId: "default",
				defaultReasoningLevel: "medium",
			},
		});
		expect(prepared.attachment).toBeUndefined();
		expect(prepared.modelConfiguration?.options[0]?.replaceCredential).toBe(
			false,
		);
	});
});
