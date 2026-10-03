import { generateKeyPairSync } from "node:crypto";
import type { V1StatefulSet } from "@kubernetes/client-node";
import { expect, it } from "vitest";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

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
		policy: { ...workloadTestPolicy, runtimeAuth },
		probe: async () => true,
	});
	return { ...api, adapter, runtimeAuth };
}

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
