import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { readRuntimeNativeMetadataConfigurationV1 } from "../../agent-runtime-host/src/configuration.js";
import { workloadDesiredFixture } from "./kubernetes.fixture.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { workloadNativeMetadataEnvironmentV1 } from "./workload-native-metadata-auth.js";
import {
	validateWorkloadRuntimeAuthV1,
	type WorkloadRuntimeAuthV1,
} from "./workload-runtime-auth.js";

function fixture() {
	const business = generateKeyPairSync("ed25519");
	const metadata = generateKeyPairSync("ed25519");
	const desired = workloadDesiredFixture();
	const auth: WorkloadRuntimeAuthV1 = {
		workerId: "worker-1",
		grantKeyId: "execution-key",
		grantIssuer: "execution-issuer",
		grantPublicKey: business.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		serviceTokenSecret: { name: "execution-auth", key: "token" },
		nativeMetadata: {
			issuer: "metadata-issuer",
			keyVersion: "metadata-key",
			maxActiveReads: 8,
			publicKeyDerBase64: metadata.publicKey
				.export({ type: "spki", format: "der" })
				.toString("base64"),
			workerOrigin: "http://metadata-worker.agent-infra.svc:3010",
			agents: new Map([
				[
					desired.agentId,
					{
						workerToHostTokenSecret: {
							name: "metadata-auth",
							key: "worker-to-host",
						},
						hostToWorkerTokenSecret: {
							name: "metadata-auth",
							key: "host-to-worker",
						},
					},
				],
			]),
		},
	};
	const binding = {
		templateId: "codex-template",
		imageDigest: desired.imageDigest,
		driver: "codex" as const,
		protocol: "openai-responses-v1" as const,
	};
	return { auth, desired, binding, business };
}

it("produces dedicated public configuration and exact Secret references consumed by the existing Host parser", () => {
	const { auth, desired, binding } = fixture();
	expect(() => validateWorkloadRuntimeAuthV1(auth)).not.toThrow();
	const env = workloadNativeMetadataEnvironmentV1(auth, desired, binding);
	expect(env).toHaveLength(3);
	expect(
		env
			.filter((entry) => entry.valueFrom)
			.map((entry) => entry.valueFrom?.secretKeyRef),
	).toEqual([
		{ name: "metadata-auth", key: "worker-to-host", optional: false },
		{ name: "metadata-auth", key: "host-to-worker", optional: false },
	]);
	const config = env.find(
		(entry) => entry.name === "AGENT_INFRA_RUNTIME_NATIVE_METADATA_CONFIG",
	)?.value;
	expect(config).toBeDefined();
	const parsed = readRuntimeNativeMetadataConfigurationV1({
		AGENT_INFRA_RUNTIME_NATIVE_METADATA_CONFIG: config,
		AGENT_INFRA_RUNTIME_AGENT_ID: desired.agentId,
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "synthetic-business-token",
		AGENT_INFRA_RUNTIME_METADATA_WORKER_TOKEN: "synthetic-worker-to-host",
		AGENT_INFRA_RUNTIME_METADATA_HOST_TOKEN: "synthetic-host-to-worker",
	});
	expect(parsed).toMatchObject({
		agentId: desired.agentId,
		workerId: auth.workerId,
		issuer: "metadata-issuer",
		keyVersion: "metadata-key",
	});
	expect(JSON.stringify(env)).not.toContain("synthetic-business-token");
	expect(workloadNativeMetadataEnvironmentV1(auth, desired, undefined)).toEqual(
		[],
	);
	expect(
		workloadNativeMetadataEnvironmentV1(auth, desired, {
			...binding,
			driver: "pi",
			protocol: "anthropic-messages-v1",
		}),
	).toEqual([]);
	expect(() =>
		workloadNativeMetadataEnvironmentV1(auth, desired, {
			...binding,
			imageDigest: `sha256:${"f".repeat(64)}`,
		}),
	).toThrow(WorkloadKubernetesError);
	expect(() =>
		workloadNativeMetadataEnvironmentV1(
			auth,
			{ ...desired, agentId: "unmapped-agent" },
			binding,
		),
	).toThrow(WorkloadKubernetesError);
});

it("rejects cross-purpose public keys, key versions and Secret references before renderer use", () => {
	const { auth, business } = fixture();
	const metadata = auth.nativeMetadata;
	if (!metadata) throw new Error();
	for (const value of [
		{
			...metadata,
			publicKeyDerBase64: business.publicKey
				.export({ type: "spki", format: "der" })
				.toString("base64"),
		},
		{ ...metadata, keyVersion: auth.grantKeyId },
		{
			...metadata,
			agents: new Map([
				[
					"agent-a",
					{
						workerToHostTokenSecret: auth.serviceTokenSecret,
						hostToWorkerTokenSecret: { name: "metadata-auth", key: "callback" },
					},
				],
			]),
		},
		{
			...metadata,
			agents: new Map([
				[
					"agent-a",
					{
						workerToHostTokenSecret: { name: "metadata-auth", key: "same" },
						hostToWorkerTokenSecret: { name: "metadata-auth", key: "same" },
					},
				],
			]),
		},
		{ ...metadata, workerOrigin: "http://worker.test/?token=private-canary" },
	])
		expect(() =>
			validateWorkloadRuntimeAuthV1({ ...auth, nativeMetadata: value }),
		).toThrow(WorkloadKubernetesError);
});
