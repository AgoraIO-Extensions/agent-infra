import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { PlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import {
	createDeploymentModelCatalogAdapterV1,
	createFakeModelAccessValidatorV1,
	createFakeModelCatalogAdapterV1,
	ModelConfigurationErrorV1,
} from "@agent-infra/model-catalog";
import type { V1Pod, V1Secret, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import { catalogFixture } from "../../../packages/model-catalog/src/catalog.fixture.js";
import {
	readCodexPilotConfiguration,
	readRuntimeModelConfigurationV3,
} from "../../agent-runtime-host/src/configuration.js";
import { workloadTestPolicy } from "./kubernetes.fixture.js";
import { workloadResourceNameV1 } from "./kubernetes-runtime-adapter.js";
import { createWorkloadRuntimeV1 } from "./workload-runtime.js";
import {
	cleanupSecrets,
	fixture,
	pendingSecretRecord,
	secretCleanupStore,
	standardModelConfiguration,
} from "./workload-runtime-split.fixture.js";

describe("assembled Workload Runtime contracts", () => {
	it("rejects a Messages candidate bound to a Responses image before decrypting or probing", async () => {
		const catalog = catalogFixture();
		catalog.endpoints = catalog.endpoints.map((endpoint) => ({
			...endpoint,
			protocol: "anthropic-messages-v1",
			authentication: "bearer",
		}));
		const decrypt = vi.fn();
		const validate = vi.fn();
		const record = pendingSecretRecord({
			name: "model:primary",
			secretId: "model-secret-a",
		});
		const f = fixture(
			{
				modelCatalog: createFakeModelCatalogAdapterV1(catalog),
				modelAccess: { validate },
				decryptor: { decrypt },
			},
			{
				configuration: standardModelConfiguration(),
				secrets: cleanupSecrets(secretCleanupStore(record)),
			},
		);
		await f.tick(2);
		expect(f.state?.phase).toBe("cleaning");
		expect(f.resources.size).toBe(0);
		expect(validate).not.toHaveBeenCalled();
		expect(decrypt).not.toHaveBeenCalled();
	});

	it.each(["expired", "removed", "changed", "messages-changed"] as const)(
		"rejects a %s catalog after candidate preflight and before every activation boundary",
		async (change) => {
			const catalog = catalogFixture();
			const protocol =
				change === "messages-changed"
					? ("anthropic-messages-v1" as const)
					: ("openai-responses-v1" as const);
			catalog.endpoints = catalog.endpoints.map((endpoint) => ({
				...endpoint,
				protocol,
				...(change === "messages-changed" ? { authentication: "api-key" } : {}),
			}));
			const record = pendingSecretRecord({
				name: "model:primary",
				secretId: "model-secret-a",
			});
			const secrets = cleanupSecrets(secretCleanupStore(record));
			const f = fixture(
				{
					templateModelBindings: [
						{
							templateId: "template-a",
							imageDigest: `sha256:${"a".repeat(64)}`,
							protocol,
						},
					],
					modelCatalog: createDeploymentModelCatalogAdapterV1({
						load: async () => catalog,
					}),
					modelAccess: createFakeModelAccessValidatorV1([
						{
							endpointId: "endpoint-a",
							modelId: "model-a",
							reasoningLevels: ["medium"],
							credential: "synthetic-primary-credential",
						},
					]),
					decryptor: {
						async decrypt() {
							return {
								outcome: "decrypted",
								plaintext: new TextEncoder().encode(
									"synthetic-primary-credential",
								),
							};
						},
					},
				},
				{ configuration: standardModelConfiguration(), secrets },
			);
			await f.tick(4);
			const state = f.state;
			assert(state?.identity);
			if (change === "expired") catalog.validUntil = Date.now() - 1;
			else if (change === "removed") catalog.endpoints = [];
			else {
				assert(catalog.endpoints[0]);
				catalog.endpoints[0].baseUrl = "https://models.example.test/changed/v1";
			}
			const runtime = createWorkloadRuntimeV1(f.options);
			const input = {
				configuration: state.candidate.configuration,
				management: f.management,
				state,
				secrets,
				requestId: "request-a",
				traceId: "trace-a",
			};
			const writes = f.writes.length;
			await expect(runtime.apply(state, false, input)).rejects.toThrow(
				"MODEL_CONFIGURATION_UNAVAILABLE",
			);
			await expect(runtime.activateSecrets(state, input)).rejects.toThrow(
				"MODEL_CONFIGURATION_UNAVAILABLE",
			);
			await expect(runtime.promote(state)).rejects.toThrow(
				"MODEL_CONFIGURATION_UNAVAILABLE",
			);
			expect(f.writes.length).toBe(writes);
			const verified = {
				...state,
				verified: state.candidate,
				verifiedRevision: state.revision,
				rollback: true,
			};
			await expect(runtime.apply(verified, false, input)).resolves.toEqual(
				state.identity,
			);
		},
	);

	it.each([false, true])(
		"cleans the exact failed model config Secret when recorded identity is %s",
		async (hasIdentity) => {
			const record = pendingSecretRecord({
				name: "model:primary",
				secretId: "model-secret-a",
			});
			const secrets = cleanupSecrets(secretCleanupStore(record));
			const f = fixture(
				{
					modelCatalog: createFakeModelCatalogAdapterV1(catalogFixture()),
					modelAccess: createFakeModelAccessValidatorV1([
						{
							endpointId: "endpoint-a",
							modelId: "model-a",
							reasoningLevels: ["medium"],
							credential: "synthetic-primary-credential",
						},
					]),
					decryptor: {
						async decrypt() {
							return {
								outcome: "decrypted",
								plaintext: new TextEncoder().encode(
									"synthetic-primary-credential",
								),
							};
						},
					},
				},
				{ configuration: standardModelConfiguration(), secrets },
			);
			await f.tick(4);
			assert(f.state);
			const state = {
				...f.state,
				phase: "cleaning" as const,
				identity: hasIdentity ? f.state.identity : null,
			};
			const configSecret = [...f.resources.values()].find(
				(value) =>
					value.kind === "Secret" &&
					value.metadata?.name?.startsWith("model-config-"),
			);
			assert(configSecret?.metadata?.name);
			const unrelated = {
				...structuredClone(configSecret),
				metadata: { ...configSecret.metadata, name: "model-config-unrelated" },
			};
			f.resources.set("Secret/model-config-unrelated", unrelated);
			const runtime = createWorkloadRuntimeV1(f.options);
			const input = {
				configuration: state.candidate.configuration,
				management: f.management,
				state,
				secrets,
				requestId: "request-a",
				traceId: "trace-a",
			};
			for (let attempt = 0; attempt < 5; attempt++) {
				if (await runtime.cleanup(state, true, input)) break;
			}
			expect(f.resources.has(`Secret/${configSecret.metadata.name}`)).toBe(
				false,
			);
			expect(f.resources.get("Secret/model-config-unrelated")).toEqual(
				unrelated,
			);
		},
	);

	it.each(["codex", "claude", "acp"] as const)(
		"projects two options with the same model into isolated endpoint and credential bindings consumed by %s Runtime",
		async (driver) => {
			const runtimeAuth = {
				workerId: "worker-a",
				grantKeyId: "runtime-probe-key",
				grantIssuer: "agent-platform",
				grantPublicKey: generateKeyPairSync("ed25519")
					.publicKey.export({ type: "spki", format: "pem" })
					.toString(),
				serviceTokenSecret: { name: "runtime-transport", key: "token" },
			};
			const configuration = standardModelConfiguration();
			const model = configuration.modelConfiguration;
			assert(model);
			const first = model.options[0];
			assert(first);
			const models = {
				...model,
				options: [
					first,
					{
						...first,
						optionId: "secondary",
						endpointId: "endpoint-b",
						credential: { ...first.credential, secretId: "model-secret-b" },
					},
				],
			};
			const records = models.options.map((option) =>
				pendingSecretRecord({
					name: `model:${option.optionId}`,
					secretId: option.credential.secretId,
				}),
			);
			const profile =
				driver !== "codex"
					? ("anthropic-messages-v1" as const)
					: ("openai-responses-v1" as const);
			const catalog = catalogFixture();
			catalog.endpoints = catalog.endpoints.map((endpoint) => ({
				...endpoint,
				protocol: profile,
				...(driver !== "codex" ? { authentication: "bearer" } : {}),
			}));
			const catalogEndpoint = catalog.endpoints[0];
			assert(catalogEndpoint);
			catalog.endpoints.push({
				...catalogEndpoint,
				endpointId: "endpoint-b",
				baseUrl: "https://alternate.example.test/private/v1",
				origin: "https://alternate.example.test",
			});
			assert(records[0]);
			const resolver = createFakeModelCatalogAdapterV1(catalog);
			let unavailableOnce = true;
			const f = fixture(
				{
					policy: { ...workloadTestPolicy, runtimeAuth },
					templateModelBindings: [
						{
							templateId: "template-a",
							imageDigest: `sha256:${"a".repeat(64)}`,
							protocol: profile,
						},
					],
					modelCatalog: {
						async resolve(input, options) {
							if (unavailableOnce) {
								unavailableOnce = false;
								throw new ModelConfigurationErrorV1(true);
							}
							return resolver.resolve(input, options);
						},
					},
					modelAccess: createFakeModelAccessValidatorV1(
						models.options.map((option) => ({
							endpointId: option.endpointId,
							modelId: option.modelId,
							reasoningLevels: option.reasoningLevels,
							credential: `synthetic-${option.optionId}-credential`,
						})),
					),
					decryptor: {
						async decrypt({ encryptedRecord }) {
							const record = encryptedRecord as PlatformSecretRecordV1;
							return {
								outcome: "decrypted",
								plaintext: new TextEncoder().encode(
									`synthetic-${record.name.slice(6)}-credential`,
								),
							};
						},
					},
				},
				{
					configuration: {
						...configuration,
						modelConfiguration: models,
						environment: [
							{
								name: "OPENAI_BASE_URL",
								value: "https://owner.example.test/v1",
							},
						],
					},
					secrets: {
						bindings: records.map((record) => ({
							materialization: "current",
							record,
						})),
						store: secretCleanupStore(records[0]).store,
						async auditDecryption() {},
					},
				},
			);
			await f.tick(2);
			expect(f.state?.phase).toBe("preflight");
			expect(f.resources.size).toBe(0);
			f.resources.set("Secret/runtime-transport", {
				apiVersion: "v1",
				kind: "Secret",
				metadata: {
					name: "runtime-transport",
					namespace: workloadTestPolicy.namespace,
				},
				data: {
					token: Buffer.from("synthetic-runtime-token").toString("base64"),
				},
			} as V1Secret);
			await f.tick(3);
			expect(f.state?.phase).toBe("observing");
			const workload = await f.client.read<V1StatefulSet>(
				"StatefulSet",
				workloadResourceNameV1("agent-a"),
			);
			assert(workload?.spec?.template.spec?.containers[0]);
			const environment: NodeJS.ProcessEnv = {};
			for (const entry of workload.spec.template.spec.containers[0].env ?? []) {
				const ref = entry.valueFrom?.secretKeyRef;
				if (ref) {
					assert(ref.name);
					const secret = await f.client.read<V1Secret>("Secret", ref.name);
					const data = secret?.data?.[ref.key];
					assert(data);
					environment[entry.name] = Buffer.from(data, "base64").toString();
				} else environment[entry.name] = entry.value;
			}
			const consumed =
				driver !== "codex"
					? readRuntimeModelConfigurationV3(environment, driver)
					: readCodexPilotConfiguration(environment);
			expect(environment.AGENT_INFRA_RUNTIME_AGENT_ID).toBe(
				configuration.agentId,
			);
			expect(environment.AGENT_INFRA_RUNTIME_SERVICE_TOKEN).toBe(
				"synthetic-runtime-token",
			);
			expect(environment.AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY).toBe(
				runtimeAuth.grantPublicKey,
			);
			expect(environment.AGENT_INFRA_RUNTIME_DATA_DIR).toBe(
				"/workspace/runtime",
			);
			expect(environment.PORT).toBe("8080");
			expect(
				JSON.parse(environment.AGENT_INFRA_RUNTIME_MODEL_CONFIG ?? "")
					.schemaVersion,
			).toBe(driver !== "codex" ? 3 : 2);
			expect(consumed.modelOptions).toEqual([
				{
					modelOptionId: "primary",
					...(driver !== "codex"
						? { protocol: profile, authentication: "bearer" }
						: {}),
					endpoint: "https://models.example.test/team-a/v1",
					model: "model-a",
					reasoningLevels: ["medium"],
					credential: "synthetic-primary-credential",
				},
				{
					modelOptionId: "secondary",
					...(driver !== "codex"
						? { protocol: profile, authentication: "bearer" }
						: {}),
					endpoint: "https://alternate.example.test/private/v1",
					model: "model-a",
					reasoningLevels: ["medium"],
					credential: "synthetic-secondary-credential",
				},
			]);
			const annotations = JSON.stringify(workload.metadata?.annotations);
			for (const forbidden of [
				"models.example.test",
				"alternate.example.test",
				"synthetic-primary-credential",
				"synthetic-secondary-credential",
			])
				expect(annotations).not.toContain(forbidden);
			expect(JSON.stringify(f.state)).not.toContain(
				"synthetic-primary-credential",
			);
			const state = f.state;
			if (!state) throw new Error();
			const runtime = createWorkloadRuntimeV1(f.options);
			const reservedConfiguration = {
				...state.candidate.configuration,
				environment: [
					{ name: "AGENT_INFRA_RUNTIME_MODEL_CONFIG", value: "owner-override" },
				],
			};
			await expect(
				runtime.preflight(
					{
						configuration: reservedConfiguration,
						state: null,
						management: f.management,
						requestId: "request-a",
						traceId: "trace-a",
						secrets: {
							bindings: records.map((record) => ({
								materialization: "current",
								record,
							})),
							store: secretCleanupStore(records[0]).store,
							async auditDecryption() {},
						},
					},
					{
						...state,
						candidate: {
							...state.candidate,
							configuration: reservedConfiguration,
						},
					},
				),
			).rejects.toThrow(/^Workload preflight rejected$/);
			expect(await runtime.observe(JSON.parse(JSON.stringify(state)))).toBe(
				"healthy",
			);
			const unavailable = structuredClone(state.candidate.modelProjection) as {
				fingerprint: string;
				options: { endpoint: { available: boolean } }[];
			};
			assert(unavailable.options[0]);
			unavailable.options[0].endpoint.available = false;
			const { fingerprint: _, ...unavailableContent } = unavailable;
			unavailable.fingerprint = createHash("sha256")
				.update(JSON.stringify(unavailableContent))
				.digest("hex");
			await expect(
				runtime.observe({
					...state,
					candidate: { ...state.candidate, modelProjection: unavailable },
				}),
			).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
			for (const override of [
				{ agentId: "agent-b" },
				{ configurationRevision: 2 },
			]) {
				await expect(
					runtime.observe({
						...state,
						candidate: {
							...state.candidate,
							modelProjection: {
								...(state.candidate.modelProjection as Record<string, unknown>),
								...override,
							},
						},
					}),
				).rejects.toThrow(/^MODEL_CONFIGURATION_UNAVAILABLE$/);
			}
			const pod = [...f.resources.values()].find(
				(value) => value.kind === "Pod",
			) as V1Pod;
			const credentialEntries = pod.spec?.containers[0]?.env?.filter((entry) =>
				entry.name.startsWith("AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_"),
			);
			if (
				!credentialEntries?.[0]?.valueFrom ||
				!credentialEntries[1]?.valueFrom
			)
				throw new Error();
			credentialEntries[0].valueFrom = structuredClone(
				credentialEntries[1].valueFrom,
			);
			expect(await runtime.observe(state)).toBe("drifted");
		},
	);
});
