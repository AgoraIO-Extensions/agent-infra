import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { workloadRegistryFixture } from "../../apps/platform-worker/src/kubernetes.fixture.js";
import { catalogFixture } from "../../packages/model-catalog/src/catalog.fixture.js";
import {
	createDeploymentModelCatalogAdapterV1,
	createFakeModelAccessValidatorV1,
} from "../../packages/model-catalog/src/index.js";
import { decodeAgentConfigurationRecordV2 } from "../../packages/platform-core/src/agent-configuration.js";
import { createSecretEncryptorV1 } from "../../packages/secret-store/src/index.js";
import { createWorkloadSecretKeyringDecryptorV1 } from "../../packages/secret-store/src/worker.js";

const postgres = createRequire(
	new URL("../../packages/platform-store/package.json", import.meta.url),
)(
	"postgres",
) as typeof import("../../packages/platform-store/node_modules/postgres");

/** Controlled approved seed and catalog inputs; not application or Registry acceptance. */
export async function seedStandardWorkloadHostV1(
	databaseUrl: string,
	imageDigest: string,
) {
	const agentId = "selector-host-agent";
	const ownerId = "selector-host-owner";
	const secretId = "selector-host-model-credential";
	const templateId = "selector-host-pi";
	const endpointId = "selector-host-messages";
	const modelId = "selector-host-model";
	const catalogRevision = "selector-host-catalog";
	const credential = randomBytes(24).toString("hex");
	const configuration = decodeAgentConfigurationRecordV2({
		schemaVersion: 2,
		agentId,
		revision: 1,
		source: {
			kind: "standard",
			templateId,
			imageDigest,
			admissionRevision: "selector-host-admission",
			allowedEnvironmentKeys: [],
			allowedSecretKeys: [],
			platformManagedKeys: [],
			connectionEnabled: false,
		},
		modelConfiguration: {
			catalogRevision,
			options: [
				{
					optionId: "primary",
					endpointId,
					modelId,
					reasoningLevels: ["medium"],
					credential: { secretId, version: 1, isSet: true },
				},
			],
			defaultOptionId: "primary",
			defaultReasoningLevel: "medium",
		},
		environment: [],
		secrets: [],
		channels: [],
		channelRevision: "selector-host-channels",
	});
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 3072,
		publicKeyEncoding: { format: "der", type: "spki" },
		privateKeyEncoding: { format: "der", type: "pkcs8" },
	});
	const keyVersion = "selector-host-key";
	const record = createSecretEncryptorV1({
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: keyVersion,
			keys: [
				{
					schemaVersion: 1,
					keyVersion,
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: publicKey.toString("base64"),
					publicKeyFingerprint: createHash("sha256")
						.update(publicKey)
						.digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
	}).encrypt({
		schemaVersion: 1,
		agentId,
		secretId,
		ownerType: "agent-owner",
		ownerId,
		name: "model:primary",
		secretVersion: 1,
		configRevision: 1,
		plaintext: credential,
		occurredAt: new Date().toISOString(),
	});
	const sql = postgres(databaseUrl, { onnotice: () => undefined });
	try {
		await sql.begin(async (transaction) => {
			await transaction`insert into platform.agents(id, current_configuration_revision, authorization_revision) values (${agentId}, 1, 'selector-host-authorization')`;
			await transaction`insert into platform.agent_applications(id, agent_id, applicant_id, name, description, status, trace_id, request_id, submitted_at, management_revision, approval_revision, desired_state, workload_revision, fence) values ('selector-host-application', ${agentId}, ${ownerId}, 'Selector Host', 'Controlled approved seed', 'creating', 'selector-host-trace', 'selector-host-request', now(), 1, 1, 'running', 1, 1)`;
			await transaction`insert into platform.agent_configuration_revisions(agent_id, revision, source_reference, configuration, created_at) values (${agentId}, 1, ${templateId}, ${transaction.json(configuration as unknown as Parameters<typeof transaction.json>[0])}, now())`;
			await transaction`insert into platform.agent_owners(agent_id, owner_id, created_at) values (${agentId}, ${ownerId}, now())`;
			await transaction`insert into platform.secret_records(agent_id, secret_id, secret_version, configuration_revision, owner_type, owner_id, name, lifecycle_state, dek_fingerprint, wrapping_key_version, record, created_at, updated_at) values (${agentId}, ${secretId}, 1, 1, ${record.ownerType}, ${ownerId}, ${record.name}, ${record.lifecycleState}, ${record.crypto.dekFingerprint}, ${keyVersion}, ${transaction.json(record)}, ${new Date(record.createdAt)}, ${new Date(record.updatedAt)})`;
			await transaction`insert into platform.outbox_items(id, scope_type, scope_id, operation, payload, trace_id, request_id) values ('selector-host-outbox', 'agent', ${agentId}, 'agent.workload.reconcile.v1', ${transaction.json({ schemaVersion: 1, agentId, revision: 1, workloadRevision: 1, fence: 1, desiredState: "running" })}, 'selector-host-trace', 'selector-host-request')`;
		});
	} finally {
		await sql.end();
	}
	const workerOptions = {
		databaseUrl,
		templateModelBindings: [
			{
				templateId,
				imageDigest,
				driver: "pi" as const,
				protocol: "anthropic-messages-v1" as const,
			},
		],
		registry: workloadRegistryFixture({
			schemaVersion: 1,
			interactionMode: "platform-adapter",
			protocol: "acp",
			service: { port: 3003 },
			health: { path: "/healthz" },
			capabilities: {},
		}),
		admissionPolicyRef: "selector-host-policy",
		registrySubjectRef: "selector-host-subject",
		modelCatalog: createDeploymentModelCatalogAdapterV1({
			load: async () => {
				const catalog = catalogFixture();
				return {
					...catalog,
					revision: catalogRevision,
					endpoints: catalog.endpoints.map((endpoint) => ({
						...endpoint,
						endpointId,
						protocol: "anthropic-messages-v1",
						authentication: "api-key",
						allowedModels: [modelId],
					})),
				};
			},
		}),
		modelAccess: createFakeModelAccessValidatorV1([
			{ endpointId, modelId, credential, reasoningLevels: ["medium"] },
		]),
		decryptor: createWorkloadSecretKeyringDecryptorV1({
			keys: [
				{ keyVersion, privateKeyPkcs8DerBase64: privateKey.toString("base64") },
			],
		}),
	};
	return { agentId, configuration, workerOptions };
}
