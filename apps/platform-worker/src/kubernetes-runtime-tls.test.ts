import type { V1Pod, V1PodSpec, V1StatefulSet } from "@kubernetes/client-node";
import { expect, it, vi } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	fakeKubernetesApi,
	runtimeTlsSecretFixture,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";
import { validateRuntimeTlsSecretV1 } from "./kubernetes-runtime-tls.js";

function binding(agentId = "agent-a") {
	const desired = workloadDesiredFixture(1, agentId, "internal-only");
	return {
		agentId,
		namespace: workloadTestPolicy.namespace,
		serviceDnsNames: [
			`${desired.service.name}.${workloadTestPolicy.namespace}.svc`,
			`${desired.service.name}-probe.${workloadTestPolicy.namespace}.svc`,
		],
		serverSecretRef: { name: `${desired.service.name}-tls` },
	};
}

it("mounts the trusted Agent leaf read-only and verifies both existing Service names on one HTTPS listener", async () => {
	const api = fakeKubernetesApi();
	const probe = vi.fn(async () => true);
	const tls = binding();
	api.seed(runtimeTlsSecretFixture(tls.serverSecretRef.name));
	const adapter = createKubernetesRuntimeAdapterV1({
		client: api.client,
		policy: { ...workloadTestPolicy, runtimeTls: [tls] },
		probe,
	});
	const desired = workloadDesiredFixture(1, tls.agentId, "internal-only");
	const identity = await adapter.apply(desired);
	if (!identity || identity === "pending") throw new Error();
	const workload = await api.client.read<V1StatefulSet>(
		"StatefulSet",
		desired.service.name,
	);
	const pod = workload?.spec?.template.spec;
	const container = pod?.containers[0];
	expect(container?.readinessProbe?.httpGet).toEqual({
		path: desired.health.path,
		port: desired.service.port,
		scheme: "HTTPS",
	});
	expect(container?.ports).toEqual([
		{ name: "runtime", containerPort: desired.service.port },
	]);
	expect(container?.volumeMounts).toContainEqual({
		name: "runtime-tls",
		mountPath: "/var/run/agent-infra/runtime-tls",
		readOnly: true,
	});
	expect(pod?.volumes).toContainEqual({
		name: "runtime-tls",
		secret: {
			secretName: tls.serverSecretRef.name,
			optional: false,
			defaultMode: 0o440,
			items: [
				{ key: "tls.crt", path: "tls.crt" },
				{ key: "tls.key", path: "tls.key" },
			],
		},
	});
	expect(
		JSON.parse(
			container?.env?.find(
				(entry) => entry.name === "AGENT_INFRA_RUNTIME_TLS_BINDING",
			)?.value ?? "null",
		),
	).toEqual({
		agentId: tls.agentId,
		namespace: tls.namespace,
		serviceDnsNames: tls.serviceDnsNames,
	});
	expect(
		[...api.resources.values()].filter((entry) => entry.kind === "Service"),
	).toHaveLength(2);
	expect(await adapter.observe(desired, identity)).toBe("healthy");
	expect(probe).toHaveBeenCalledWith({
		desired,
		serviceOrigin: `https://${tls.serviceDnsNames[1]}:${desired.service.port}`,
	});
	expect(api.writes.some((entry) => entry.kind === "Secret")).toBe(false);
});

it.each([
	"missing",
	"wrong-type",
	"missing-key",
	"invalid-base64",
	"extra-key",
])(
	"rejects an invalid runtime TLS Secret before writing workload resources: %s",
	async (kind) => {
		const api = fakeKubernetesApi();
		const tls = binding();
		if (kind !== "missing") {
			const secret = runtimeTlsSecretFixture(tls.serverSecretRef.name);
			if (kind === "wrong-type") secret.type = "Opaque";
			if (kind === "missing-key") delete secret.data?.["tls.key"];
			if (kind === "invalid-base64" && secret.data)
				secret.data["tls.crt"] = "not-base64";
			if (kind === "extra-key" && secret.data)
				secret.data.extra = Buffer.from("unexpected").toString("base64");
			api.seed(secret);
		}
		const probe = vi.fn(async () => true);
		const adapter = createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: { ...workloadTestPolicy, runtimeTls: [tls] },
			probe,
		});
		const desired = workloadDesiredFixture(1, tls.agentId, "internal-only");
		await expect(adapter.apply(desired)).rejects.toMatchObject({
			code: "policy",
		});
		expect(api.writes).toHaveLength(0);

		// Loss/corruption after creation must also block readiness and promotion.
		const invalidSecret = await api.client.read(
			"Secret",
			tls.serverSecretRef.name,
		);
		api.seed(runtimeTlsSecretFixture(tls.serverSecretRef.name));
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		probe.mockClear();
		if (invalidSecret) api.seed(invalidSecret);
		else api.resources.delete(`Secret/${tls.serverSecretRef.name}`);
		const writesBeforeObservation = api.writes.length;
		expect(await adapter.observe(desired, identity)).toBe("drifted");
		await expect(adapter.promote(desired, identity)).rejects.toThrow();
		expect(probe).not.toHaveBeenCalled();
		expect(api.writes).toHaveLength(writesBeforeObservation);
	},
);

it.each(["missing", "foreign", "owner-env", "leaf-as-env"])(
	"rejects %s TLS binding before any resource write",
	async (kind) => {
		const api = fakeKubernetesApi();
		const tls = binding(kind === "foreign" ? "another-agent" : "agent-a");
		const adapter = createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: {
				...workloadTestPolicy,
				runtimeTls: kind === "missing" ? undefined : [tls],
			},
			probe: async () => true,
		});
		const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
		if (kind === "owner-env")
			desired.env.AGENT_INFRA_RUNTIME_TLS_BINDING = JSON.stringify(tls);
		if (kind === "leaf-as-env")
			desired.secretRefs.push({
				schemaVersion: 1,
				ownerType: "agent-owner",
				ownerId: "owner-a",
				agentId: desired.agentId,
				algorithmVersion: "aes-256-gcm:v1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				wrappingKeyVersion: "test-key",
				name: tls.serverSecretRef.name,
				secretId: "secret-a",
				secretVersion: 1,
				configRevision: 1,
			});
		await expect(adapter.apply(desired)).rejects.toMatchObject({
			code: "policy",
		});
		expect(api.writes).toHaveLength(0);
		if (kind === "missing") {
			const empty = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: { ...workloadTestPolicy, runtimeTls: [] },
				probe: async () => true,
			});
			await expect(empty.apply(desired)).rejects.toMatchObject({
				code: "policy",
			});
			expect(api.writes).toHaveLength(0);
		}
	},
);

it.each([
	"namespace",
	"dns",
	"missing-probe-dns",
	"wildcard",
	"secret-path",
	"extra-field",
	"duplicate-agent",
	"shared-leaf",
	"ingress-leaf",
])("rejects malformed trusted TLS configuration: %s", (kind) => {
	const api = fakeKubernetesApi();
	const tls = binding();
	const entries = [tls];
	if (kind === "namespace") tls.namespace = "foreign";
	if (kind === "dns")
		tls.serviceDnsNames[0] = binding("foreign").serviceDnsNames[0] ?? "";
	if (kind === "missing-probe-dns") tls.serviceDnsNames.pop();
	if (kind === "wildcard") tls.serviceDnsNames[0] = `*.${tls.namespace}.svc`;
	if (kind === "secret-path") tls.serverSecretRef.name = "../tls";
	if (kind === "ingress-leaf")
		tls.serverSecretRef.name = workloadTestPolicy.tlsSecretName;
	if (kind === "extra-field") Object.assign(tls, { keyPath: "/other/key" });
	if (kind === "duplicate-agent")
		entries.push({ ...tls, serverSecretRef: { name: "another-leaf" } });
	if (kind === "shared-leaf")
		entries.push({
			...binding("foreign"),
			serverSecretRef: tls.serverSecretRef,
		});
	expect(() =>
		createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: { ...workloadTestPolicy, runtimeTls: entries },
			probe: async () => true,
		}),
	).toThrow();
	expect(api.writes).toHaveLength(0);
});

const driftMutations: [string, (pod: V1PodSpec) => void][] = [
	[
		"default HTTP",
		(pod) => {
			delete pod.containers[0]?.readinessProbe?.httpGet?.scheme;
		},
	],
	[
		"explicit HTTP",
		(pod) => {
			const probe = pod.containers[0]?.readinessProbe?.httpGet;
			if (probe) probe.scheme = "HTTP";
		},
	],
	[
		"foreign probe host",
		(pod) => {
			const probe = pod.containers[0]?.readinessProbe?.httpGet;
			if (probe) probe.host = "foreign";
		},
	],
	[
		"writable leaf",
		(pod) => {
			const mount = pod.containers[0]?.volumeMounts?.find(
				(entry) => entry.name === "runtime-tls",
			);
			if (mount) mount.readOnly = false;
		},
	],
	[
		"key subpath",
		(pod) => {
			const mount = pod.containers[0]?.volumeMounts?.find(
				(entry) => entry.name === "runtime-tls",
			);
			if (mount) mount.subPath = "tls.key";
		},
	],
	[
		"foreign Secret",
		(pod) => {
			const secret = pod.volumes?.find(
				(entry) => entry.name === "runtime-tls",
			)?.secret;
			if (secret) secret.secretName = "foreign";
		},
	],
	[
		"optional Secret",
		(pod) => {
			const secret = pod.volumes?.find(
				(entry) => entry.name === "runtime-tls",
			)?.secret;
			if (secret) secret.optional = true;
		},
	],
	[
		"key permissions",
		(pod) => {
			const secret = pod.volumes?.find(
				(entry) => entry.name === "runtime-tls",
			)?.secret;
			if (secret) secret.defaultMode = 0o644;
		},
	],
	[
		"extra Secret key",
		(pod) => {
			pod.volumes
				?.find((entry) => entry.name === "runtime-tls")
				?.secret?.items?.push({ key: "other", path: "other" });
		},
	],
	[
		"forged binding",
		(pod) => {
			const env = pod.containers[0]?.env?.find(
				(entry) => entry.name === "AGENT_INFRA_RUNTIME_TLS_BINDING",
			);
			if (env) env.value = JSON.stringify(binding("foreign"));
		},
	],
];
it.each(driftMutations)(
	"rejects %s in both StatefulSet and live Pod before signed readiness or promotion",
	async (_name, mutate) => {
		for (const target of ["StatefulSet", "Pod"]) {
			const api = fakeKubernetesApi();
			const probe = vi.fn(async () => true);
			const adapter = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: { ...workloadTestPolicy, runtimeTls: [binding()] },
				probe,
			});
			const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
			api.seed(runtimeTlsSecretFixture(binding().serverSecretRef.name));
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			probe.mockClear();
			const key = `${target}/${desired.service.name}${target === "Pod" ? "-0" : ""}`;
			const resource = structuredClone(api.resources.get(key));
			const pod =
				target === "Pod"
					? (resource as V1Pod).spec
					: (resource as V1StatefulSet).spec?.template.spec;
			if (!resource || !pod) throw new Error();
			mutate(pod);
			api.resources.set(key, resource);
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toThrow();
			expect(probe).not.toHaveBeenCalled();
		}
	},
);

it("keeps the self-managed entry outside the Runtime TLS binding contract", async () => {
	const api = fakeKubernetesApi();
	const adapter = createKubernetesRuntimeAdapterV1({
		client: api.client,
		policy: { ...workloadTestPolicy, runtimeTls: [binding()] },
		probe: async () => true,
	});
	const desired = workloadDesiredFixture();
	const identity = await adapter.apply(desired);
	if (!identity || identity === "pending") throw new Error();
	const workload = await api.client.read<V1StatefulSet>(
		"StatefulSet",
		desired.service.name,
	);
	expect(
		workload?.spec?.template.spec?.volumes?.some(
			(entry) => entry.name === "runtime-tls",
		),
	).toBe(false);
	expect(await adapter.observe(desired, identity)).toBe("healthy");
});

it("can still disable an existing workload when its TLS binding has been withdrawn", async () => {
	const api = fakeKubernetesApi();
	const desired = workloadDesiredFixture(1, "agent-a", "internal-only");
	api.seed(runtimeTlsSecretFixture(binding().serverSecretRef.name));
	const original = createKubernetesRuntimeAdapterV1({
		client: api.client,
		policy: { ...workloadTestPolicy, runtimeTls: [binding()] },
		probe: async () => true,
	});
	await original.apply(desired);
	api.resources.delete(`Secret/${binding().serverSecretRef.name}`);
	const withdrawn = createKubernetesRuntimeAdapterV1({
		client: api.client,
		policy: workloadTestPolicy,
		probe: async () => true,
	});
	await withdrawn.closeAgent(
		desired.agentId,
		desired.workloadRevision,
		desired.fence,
	);
	const disabled = { ...desired, desiredState: "disabled", replicas: 0 };
	expect(await withdrawn.apply(disabled)).toBe("pending");
	expect(await withdrawn.apply(disabled)).toMatchObject({
		uid: expect.any(String),
	});
	expect(await api.client.read("Pod", `${desired.service.name}-0`)).toBeNull();
	expect(
		(await api.client.read<V1StatefulSet>("StatefulSet", desired.service.name))
			?.spec?.replicas,
	).toBe(0);
});

it.each([
	"malformed-pem",
	"expired",
	"wrong-key",
	"wrong-dns",
	"client-only",
	"wrong-chain",
	"missing-probe-dns",
	"trailing-pem",
] as const)(
	"rejects invalid serving material before apply and after Secret replacement: %s",
	async (kind) => {
		const api = fakeKubernetesApi();
		const tls = binding();
		const leaf = await runtimeTlsFixture({
			dnsNames:
				kind === "wrong-dns"
					? ["foreign.example.test"]
					: kind === "missing-probe-dns"
						? tls.serviceDnsNames.slice(0, 1)
						: tls.serviceDnsNames,
			days: kind === "expired" ? -1 : 1,
			extendedKeyUsage: kind === "client-only" ? "clientAuth" : "serverAuth",
		});
		const other =
			kind === "wrong-key" || kind === "wrong-chain"
				? await runtimeTlsFixture({ dnsNames: tls.serviceDnsNames })
				: undefined;
		try {
			const invalid = runtimeTlsSecretFixture(tls.serverSecretRef.name);
			invalid.data = {
				"tls.crt": Buffer.from(
					kind === "malformed-pem"
						? "not a certificate"
						: kind === "wrong-chain"
							? leaf.cert + other?.ca
							: kind === "trailing-pem"
								? `${leaf.cert}unparsed material`
								: leaf.cert,
				).toString("base64"),
				"tls.key": Buffer.from(
					kind === "wrong-key" ? (other?.key ?? "") : leaf.key,
				).toString("base64"),
			};
			api.seed(invalid);
			const probe = vi.fn(async () => true);
			const adapter = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: { ...workloadTestPolicy, runtimeTls: [tls] },
				probe,
			});
			const desired = workloadDesiredFixture(1, tls.agentId, "internal-only");
			await expect(adapter.apply(desired)).rejects.toMatchObject({
				code: "policy",
			});
			expect(api.writes).toHaveLength(0);
			api.seed(runtimeTlsSecretFixture(tls.serverSecretRef.name));
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending") throw new Error();
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			probe.mockClear();
			api.seed(invalid);
			const writes = api.writes.length;
			expect(await adapter.observe(desired, identity)).toBe("drifted");
			await expect(adapter.promote(desired, identity)).rejects.toThrow();
			expect(probe).not.toHaveBeenCalled();
			expect(api.writes).toHaveLength(writes);
		} finally {
			await leaf.cleanup();
			await other?.cleanup();
		}
	},
);

it("accepts valid same-reference leaf renewal without pinning certificate bytes", async () => {
	const api = fakeKubernetesApi();
	const tls = binding();
	const original = await runtimeTlsFixture({ dnsNames: tls.serviceDnsNames });
	const renewed = await runtimeTlsFixture({
		dnsNames: tls.serviceDnsNames,
		issuerDirectory: original.directory,
	});
	try {
		const initial = runtimeTlsSecretFixture(tls.serverSecretRef.name);
		initial.data = {
			"tls.crt": Buffer.from(original.cert + original.ca).toString("base64"),
			"tls.key": Buffer.from(original.key).toString("base64"),
		};
		api.seed(initial);
		const adapter = createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: { ...workloadTestPolicy, runtimeTls: [tls] },
			probe: async () => true,
		});
		const desired = workloadDesiredFixture(1, tls.agentId, "internal-only");
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending") throw new Error();
		const secret = runtimeTlsSecretFixture(tls.serverSecretRef.name);
		secret.data = {
			"tls.crt": Buffer.from(renewed.cert + renewed.ca).toString("base64"),
			"tls.key": Buffer.from(renewed.key).toString("base64"),
		};
		api.seed(secret);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
		await expect(adapter.promote(desired, identity)).resolves.toBeUndefined();
	} finally {
		await renewed.cleanup();
		await original.cleanup();
	}
});

it("rejects an expired issuer even while its leaf remains valid", async () => {
	const tls = binding();
	const leaf = await runtimeTlsFixture({
		dnsNames: tls.serviceDnsNames,
		days: 3,
		caDays: 1,
	});
	try {
		const secret = runtimeTlsSecretFixture(tls.serverSecretRef.name);
		secret.data = {
			"tls.crt": Buffer.from(leaf.cert + leaf.ca).toString("base64"),
			"tls.key": Buffer.from(leaf.key).toString("base64"),
		};
		expect(
			validateRuntimeTlsSecretV1(
				secret,
				tls.serverSecretRef.name,
				tls.serviceDnsNames,
			),
		).toBe(true);
		const clock = vi
			.spyOn(Date, "now")
			.mockReturnValue(Date.now() + 2 * 24 * 60 * 60 * 1000);
		try {
			expect(
				validateRuntimeTlsSecretV1(
					secret,
					tls.serverSecretRef.name,
					tls.serviceDnsNames,
				),
			).toBe(false);
		} finally {
			clock.mockRestore();
		}
	} finally {
		await leaf.cleanup();
	}
});
