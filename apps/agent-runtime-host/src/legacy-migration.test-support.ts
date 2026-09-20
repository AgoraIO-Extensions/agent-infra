import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	requestDigest,
} from "@agent-infra/agent-runtime";
import type {
	RuntimeLegacyPrincipalManifestV1,
	RuntimeSubmitTurnRequestV2,
} from "@agent-infra/contracts/runtime";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "../../../packages/agent-runtime/src/grant-fixture.test-support.js";
import { runtimeV2Keys } from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";

export const legacyBodySentinel = "legacy-input-must-not-appear-in-provenance";
export const migrationKeys = generateKeyPairSync("ed25519");
export const migrationBinding = {
	workerId: "worker-fixture",
	agentId: "agent-fixture",
	workloadRevision: 7,
	fence: 3,
	imageDigest: `sha256:${"a".repeat(64)}`,
};

export async function createLegacyMigrationFixture(
	directory: string,
	includePrepared = true,
) {
	const dataDirectory = join(directory, "data");
	const mountedDirectory = join(directory, "provisioned");
	await mkdir(dataDirectory, { recursive: true });
	await mkdir(mountedDirectory, { recursive: true });
	const hostPath = join(dataDirectory, "host.json");
	const store = await FileRuntimeStore.open(hostPath);
	const driver = await FakeRuntimeDriver.open(
		join(dataDirectory, "fake-driver.json"),
	);
	const legacy = await RuntimeHost.open({
		store,
		driver,
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
	});
	const request = {
		schemaVersion: 2 as const,
		requestId: "request-fixture",
		agentId: "agent-fixture",
		actorId: "user-fixture",
		channelId: "web",
		conversationId: "conversation-fixture",
		executionId: "execution-fixture",
		turnId: "turn-fixture",
		sessionGeneration: 1,
		traceId: "trace-fixture",
		deliveryFence: 1,
		input: { text: legacyBodySentinel, attachments: [] },
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "model-option-primary",
			reasoningLevel: "high",
		},
	};
	const oldRequest: RuntimeSubmitTurnRequestV2 = {
		...request,
		grant: runtimeGrantFixture(request, ["turn.submit"]),
	};
	const accepted = await legacy.submitTurnV2(
		oldRequest,
		verificationForRuntimeGrant(oldRequest.grant),
	);
	await driver.setOperationStatus(request.executionId, "completed");
	await store.resolveOperation(accepted.hostSessionRef, request.executionId, {
		outcome: "accepted",
		status: "completed",
	});
	if (includePrepared) {
		const binding = {
			agentId: request.agentId,
			conversationId: request.conversationId,
			executionId: "execution-pending",
			turnId: "turn-pending",
			sessionGeneration: 1,
		};
		await store.prepareOperation({
			requestedHostSessionRef: accepted.hostSessionRef,
			binding,
			operationId: binding.executionId,
			kind: "submit-turn",
			scope: `execution:${binding.executionId}`,
			deliveryFence: 1,
			requestDigest: requestDigest({
				...binding,
				kind: "submit-turn",
				input: request.input,
				selection: request.selection,
			}),
			command: (nativeSessionRef) => ({
				schemaVersion: 2,
				kind: "submit-turn",
				...binding,
				operationId: binding.executionId,
				nativeSessionRef,
				input: request.input,
				selection: request.selection,
			}),
		});
	}
	const before = JSON.parse(await readFile(hostPath, "utf8"));
	const manifest: RuntimeLegacyPrincipalManifestV1 = {
		schemaVersion: 1,
		issuer: "platform-fixture",
		audience: "runtime_host_legacy_principal",
		keyId: "migration-key",
		deployment: migrationBinding,
		hostSessionRef: accepted.hostSessionRef,
		conversationId: request.conversationId,
		sessionGeneration: 1,
		principal: { kind: "user", id: request.actorId },
		channelId: "web",
		executions: Object.values(
			before.sessions[accepted.hostSessionRef].operations,
		).map((value) => {
			const operation = value as {
				executionId: string;
				turnId: string;
				requestDigest: string;
			};
			return {
				executionId: operation.executionId,
				turnId: operation.turnId,
				originalOperationDigest: operation.requestDigest,
				migrationRecordId: `platform-migration-${operation.executionId}`,
				producerRevision: "controlled-old-platform-producer-v1",
				metadataDigest: "b".repeat(64),
			};
		}),
	};
	const manifestPath = join(mountedDirectory, "manifest.json");
	const publicKeyPath = join(mountedDirectory, "migration-public.pem");
	await writeFile(
		publicKeyPath,
		migrationKeys.publicKey.export({ type: "spki", format: "pem" }),
		{ mode: 0o600 },
	);
	await writeSignedLegacyManifest(manifestPath, manifest);
	const environment = {
		AGENT_INFRA_RUNTIME_DRIVER: "fake",
		AGENT_INFRA_RUNTIME_WORKER_ID: "worker-fixture",
		AGENT_INFRA_RUNTIME_AGENT_ID: "agent-fixture",
		AGENT_INFRA_RUNTIME_READINESS_BINDING: JSON.stringify(migrationBinding),
		AGENT_INFRA_RUNTIME_DATA_DIR: dataDirectory,
		AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "fixture",
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: runtimeV2Keys.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		AGENT_INFRA_RUNTIME_GRANT_ISSUER: "platform-fixture",
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "fixture-service-token",
		AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_FILE: manifestPath,
		AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_PUBLIC_KEY_FILE: publicKeyPath,
		AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_KEY_ID: "migration-key",
	};
	return {
		store,
		driver,
		hostPath,
		dataDirectory,
		manifestPath,
		publicKeyPath,
		before,
		manifest,
		environment,
	};
}

export async function writeSignedLegacyManifest(
	path: string,
	manifest: unknown,
) {
	const payload = Buffer.from(JSON.stringify(manifest));
	await writeFile(
		path,
		JSON.stringify({
			schemaVersion: 1,
			format: "runtime-legacy-principal-ed25519",
			payload: payload.toString("base64url"),
			signature: sign(null, payload, migrationKeys.privateKey).toString(
				"base64url",
			),
		}),
		{ mode: 0o600 },
	);
}
