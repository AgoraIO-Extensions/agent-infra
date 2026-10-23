import { generateKeyPairSync } from "node:crypto";
import type { V1StatefulSet } from "@kubernetes/client-node";
import { expect, it } from "vitest";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { validateWorkloadRuntimeAuthV1 } from "./workload-runtime-auth.js";

function fixture() {
	const api = fakeKubernetesApi();
	const { publicKey } = generateKeyPairSync("ed25519");
	const runtimeAuth = {
		workerId: "worker-a",
		grantKeyId: "grant-a",
		grantPublicKey: publicKey
			.export({ format: "pem", type: "spki" })
			.toString(),
		grantIssuer: "platform-worker",
		serviceTokenSecret: { name: "runtime-transport", key: "token" },
	};
	const adapter = createKubernetesRuntimeAdapterV1({
		client: api.client,
		policy: {
			...workloadTestPolicy,
			runtimeAuth,
		},
		probe: async () => true,
	});
	return { ...api, adapter, runtimeAuth };
}

it("injects a release-scoped native metadata Worker origin and shared token", async () => {
	const api = fakeKubernetesApi();
	const { publicKey } = generateKeyPairSync("ed25519");
	const runtimeAuth = {
		workerId: "worker-a",
		grantKeyId: "grant-a",
		grantPublicKey: publicKey
			.export({ format: "pem", type: "spki" })
			.toString(),
		grantIssuer: "platform-worker",
		serviceTokenSecret: { name: "runtime-transport", key: "token" },
		nativeMetadataWorkerOrigin:
			"http://topology-agent-infra-platform-worker-native-metadata",
	};
	const adapter = createKubernetesRuntimeAdapterV1({
		client: api.client,
		policy: { ...workloadTestPolicy, runtimeAuth },
		probe: async () => true,
	});
	const desired = workloadDesiredFixture(2, "custom-agent", "internal-only");
	await adapter.apply(desired);
	const workload = await api.client.read<V1StatefulSet>(
		"StatefulSet",
		desired.service.name,
	);
	const env = workload?.spec?.template.spec?.containers[0]?.env ?? [];
	expect(
		env.find(
			(entry) =>
				entry.name === "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN",
		),
	).toEqual({
		name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN",
		value: runtimeAuth.nativeMetadataWorkerOrigin,
	});
	expect(
		env.find(
			(entry) =>
				entry.name ===
				"AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN",
		),
	).toEqual({
		name: "AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN",
		valueFrom: {
			secretKeyRef: {
				name: "runtime-transport",
				key: "token",
				optional: false,
			},
		},
	});
});

it.each([
	"http://attacker.example",
	"http://platform-worker-native-metadata-attacker",
	"http://platform-worker-native-metadata:3005",
	"http://platform-worker-native-metadata/private",
])("rejects an unfixed native metadata Worker origin: %s", (origin) => {
	const { publicKey } = generateKeyPairSync("ed25519");
	expect(() =>
		validateWorkloadRuntimeAuthV1({
			workerId: "worker-a",
			grantKeyId: "grant-a",
			grantPublicKey: publicKey
				.export({ format: "pem", type: "spki" })
				.toString(),
			grantIssuer: "platform-worker",
			serviceTokenSecret: { name: "runtime-transport", key: "token" },
			nativeMetadataWorkerOrigin: origin,
		}),
	).toThrow();
});

it("binds custom platform-adapter authentication without a standard-template model projection", async () => {
	const { adapter, client, runtimeAuth } = fixture();
	const desired = workloadDesiredFixture(2, "custom-agent", "internal-only");
	await adapter.apply(desired);
	const workload = await client.read<V1StatefulSet>(
		"StatefulSet",
		desired.service.name,
	);
	const env = workload?.spec?.template.spec?.containers[0]?.env ?? [];
	expect(
		env.find((entry) => entry.name === "AGENT_INFRA_RUNTIME_SERVICE_TOKEN"),
	).toEqual({
		name: "AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
		valueFrom: {
			secretKeyRef: {
				name: "runtime-transport",
				key: "token",
				optional: false,
			},
		},
	});
	expect(
		env.find((entry) => entry.name === "AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY")
			?.value,
	).toBe(runtimeAuth.grantPublicKey);
	const binding = env.find(
		(entry) => entry.name === "AGENT_INFRA_RUNTIME_READINESS_BINDING",
	)?.value;
	expect(binding).toBeDefined();
	expect(JSON.parse(binding ?? "null")).toEqual({
		workerId: "worker-a",
		agentId: "custom-agent",
		workloadRevision: 2,
		fence: 2,
		imageDigest: desired.imageDigest,
	});
	expect(
		env.find((entry) => entry.name === "AGENT_INFRA_RUNTIME_DRIVER"),
	).toEqual({ name: "AGENT_INFRA_RUNTIME_DRIVER", value: "acp" });
});

it("does not inject platform authentication into self-managed workloads", async () => {
	const { adapter, client } = fixture();
	const desired = workloadDesiredFixture();
	await adapter.apply(desired);
	const workload = await client.read<V1StatefulSet>(
		"StatefulSet",
		desired.service.name,
	);
	expect(workload?.spec?.template.spec?.containers[0]?.env).toEqual([
		{ name: "LOG_LEVEL", value: "info" },
	]);
});

it.each([undefined, "8080", "9000"])(
	"preserves custom platform-adapter PORT configuration %s",
	async (port) => {
		const { adapter, client } = fixture();
		const desired = workloadDesiredFixture(2, "custom-agent", "internal-only");
		await adapter.apply({
			...desired,
			env: { ...desired.env, ...(port === undefined ? {} : { PORT: port }) },
		});
		const workload = await client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		const env = workload?.spec?.template.spec?.containers[0]?.env ?? [];
		expect(env.filter((entry) => entry.name === "PORT")).toEqual(
			port === undefined ? [] : [{ name: "PORT", value: port }],
		);
		expect(
			env.find((entry) => entry.name === "AGENT_INFRA_RUNTIME_SERVICE_TOKEN"),
		).toBeDefined();
	},
);

it("rejects caller-provided platform identity on a custom platform-adapter", async () => {
	const { adapter } = fixture();
	const desired = workloadDesiredFixture(2, "custom-agent", "internal-only");
	await expect(
		adapter.apply({
			...desired,
			env: { ...desired.env, AGENT_INFRA_RUNTIME_AGENT_ID: "another-agent" },
		}),
	).rejects.toMatchObject({ code: "policy" });
});

it("injects the file exchange origin and the existing runtime-auth token Secret", async () => {
	const api = fakeKubernetesApi();
	const { publicKey } = generateKeyPairSync("ed25519");
	const adapter = createKubernetesRuntimeAdapterV1({
		client: api.client,
		policy: {
			...workloadTestPolicy,
			runtimeAuth: {
				workerId: "worker-a",
				grantKeyId: "grant-a",
				grantPublicKey: publicKey
					.export({ format: "pem", type: "spki" })
					.toString(),
				grantIssuer: "platform-worker",
				serviceTokenSecret: { name: "runtime-transport", key: "token" },
				fileExchangeOrigin: "http://platform-api:3000",
			},
		},
		probe: async () => true,
	});
	const desired = workloadDesiredFixture(2, "custom-agent", "internal-only");
	await adapter.apply(desired);
	const workload = await api.client.read<V1StatefulSet>(
		"StatefulSet",
		desired.service.name,
	);
	const env = workload?.spec?.template.spec?.containers[0]?.env ?? [];
	expect(
		env.find(
			(entry) => entry.name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
		),
	).toEqual({
		name: "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
		value: "http://platform-api:3000",
	});
	expect(
		env.find(
			(entry) =>
				entry.name === "AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
		)?.valueFrom,
	).toEqual({
		secretKeyRef: {
			name: "runtime-transport",
			key: "token",
			optional: false,
		},
	});
	expect(JSON.stringify(env)).not.toContain("Bearer");
});

it("rejects a caller-provided file exchange environment pair", async () => {
	const { adapter } = fixture();
	const desired = workloadDesiredFixture(2, "custom-agent", "internal-only");
	for (const name of [
		"AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN",
		"AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN",
	]) {
		await expect(
			adapter.apply({
				...desired,
				env: { ...desired.env, [name]: "http://attacker.example" },
			}),
		).rejects.toMatchObject({ code: "policy" });
	}
});
