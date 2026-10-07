import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type { V1Pod, V1StatefulSet } from "@kubernetes/client-node";
import { describe, expect, it, vi } from "vitest";
import {
	createRuntimeConnectionConsumerSnapshotV1,
	createRuntimeConnectionInstallationRevisionV1,
	runtimeConnectionConsumerAnnotation,
	runtimeConnectionConsumerFileEnvironment,
	runtimeConnectionConsumerProjectionV1,
	runtimeConnectionConsumerRevisionEnvironment,
	runtimeConnectionInstallationRevisionEnvironment,
} from "./connection-consumer-projection.js";
import {
	fakeKubernetesApi,
	workloadDesiredFixture,
	workloadTestPolicy,
} from "./kubernetes.fixture.js";
import { createKubernetesRuntimeAdapterV1 } from "./kubernetes-runtime-adapter.js";

function source() {
	const profile = {
		schemaVersion: 1 as const,
		publicOrigin: "https://connection.example.test",
		mcpPath: "/mcp",
		consumerId: "platform-consumer",
		audience: "connection-resource",
		egressProfile: { ref: "approved-egress", revision: "r1" },
	};
	return {
		profile,
		approval: {
			schemaVersion: 1,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			egressEnforced: true,
			source: { ref: "approved-deployment", revision: "r1" },
		},
	};
}

function snapshot() {
	const input = source();
	const result = createRuntimeConnectionConsumerSnapshotV1(
		input.profile,
		input.approval,
	);
	if (!result) throw new Error("Missing fixture snapshot");
	return result;
}

describe("runtime Connection snapshot projection", () => {
	it("delivers the rendered file bytes to the actual merged Host receiver", async () => {
		const bytes = snapshot();
		const projection = runtimeConnectionConsumerProjectionV1(bytes);
		const revision = projection.env.find(
			(entry) => entry.name === runtimeConnectionConsumerRevisionEnvironment,
		)?.value;
		if (!revision) throw new Error("Missing revision projection");
		const file = projection.volumes[0]?.downwardAPI?.items?.[0];
		if (!file?.fieldRef || !file.path)
			throw new Error("Missing file projection");
		expect(file.fieldRef.fieldPath).toBe(
			`metadata.annotations['${runtimeConnectionConsumerAnnotation}']`,
		);
		const directory = await mkdtemp(
			join(tmpdir(), "consumer-projection-host-"),
		);
		try {
			const path = join(directory, file.path);
			await writeFile(
				path,
				projection.annotations[runtimeConnectionConsumerAnnotation] ?? "",
			);
			const consumed = await readRuntimeConnectionConsumerProfile(
				path,
				revision,
			);
			expect(consumed).toMatchObject({
				status: "available",
				profile: source().profile,
				configFingerprint: source().approval.configFingerprint,
				source: source().approval.source,
			});
			// The annotation can update while the old PodSpec assertion stays fixed.
			const changed = source();
			changed.approval.source.revision = "r2";
			await writeFile(path, JSON.stringify(changed));
			expect(
				await readRuntimeConnectionConsumerProfile(path, revision),
			).toMatchObject({
				status: "unavailable",
			});
			await writeFile(
				path,
				JSON.stringify({
					...source(),
					approval: { ...source().approval, egressEnforced: false },
				}),
			);
			expect(
				await readRuntimeConnectionConsumerProfile(path, revision),
			).toMatchObject({
				status: "unavailable",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("captures the complete approved source and keeps unconfigured delivery empty", () => {
		const input = source();
		const captured = createRuntimeConnectionConsumerSnapshotV1(
			input.profile,
			input.approval,
		);
		expect(JSON.parse(captured ?? "")).toEqual(input);
		input.profile.consumerId = "another-consumer";
		input.approval.source.revision = "r2";
		expect(JSON.parse(captured ?? "").profile.consumerId).toBe(
			"platform-consumer",
		);
		expect(
			createRuntimeConnectionConsumerSnapshotV1(undefined, undefined),
		).toBeUndefined();
		expect(runtimeConnectionConsumerProjectionV1()).toEqual({
			annotations: {},
			env: [],
			volumeMounts: [],
			volumes: [],
		});
	});
	it.each([
		[undefined, source().approval],
		[source().profile, undefined],
		[{ ...source().profile, token: "input-sentinel" }, source().approval],
		[source().profile, { ...source().approval, egressEnforced: false }],
		[
			source().profile,
			{ ...source().approval, configFingerprint: "0".repeat(64) },
		],
	])(
		"rejects unavailable or altered approval without exposing input",
		(profile, approval) => {
			expect(
				createRuntimeConnectionConsumerSnapshotV1(profile, approval),
			).toBeNull();
		},
	);
	it("rejects unknown wrapper fields and uses a bounded readonly native projection", () => {
		expect(() =>
			runtimeConnectionConsumerProjectionV1(
				JSON.stringify({ ...source(), token: "sentinel" }),
			),
		).toThrow();
		expect(() =>
			runtimeConnectionConsumerProjectionV1(" ".repeat(8193)),
		).toThrow();
		const projection = runtimeConnectionConsumerProjectionV1(snapshot());
		expect(projection.env).toEqual([
			{
				name: runtimeConnectionConsumerFileEnvironment,
				value: "/var/run/agent-infra/connection-consumer/snapshot.json",
			},
			{
				name: runtimeConnectionConsumerRevisionEnvironment,
				value: JSON.stringify([
					source().approval.configFingerprint,
					"approved-deployment",
					"r1",
				]),
			},
		]);
		expect(projection.volumeMounts[0]?.readOnly).toBe(true);
		expect(projection.volumes[0]?.downwardAPI).toEqual({
			defaultMode: 0o444,
			items: [
				{
					path: "snapshot.json",
					fieldRef: {
						apiVersion: "v1",
						fieldPath: `metadata.annotations['${runtimeConnectionConsumerAnnotation}']`,
					},
				},
			],
		});
	});
	it("projects through the actual StatefulSet adapter and validates its observed resources", async () => {
		const api = fakeKubernetesApi();
		const desired = workloadDesiredFixture();
		const data = snapshot();
		const adapter = createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: { ...workloadTestPolicy, connectionConsumerSnapshot: data },
			probe: async () => true,
		});
		const identity = await adapter.apply(desired);
		if (!identity || identity === "pending")
			throw new Error("Missing fixture workload");
		const workload = await api.client.read<V1StatefulSet>(
			"StatefulSet",
			desired.service.name,
		);
		expect(
			workload?.spec?.template.metadata?.annotations?.[
				runtimeConnectionConsumerAnnotation
			],
		).toBe(data);
		expect(workload?.spec?.template.spec?.containers[0]?.env).toContainEqual(
			runtimeConnectionConsumerProjectionV1(data).env[0],
		);
		expect(await adapter.observe(desired, identity)).toBe("healthy");
	});
	it.each(["snapshot", "mount", "file"] as const)(
		"rejects %s drift before readiness",
		async (field) => {
			const api = fakeKubernetesApi();
			const desired = workloadDesiredFixture();
			const probe = vi.fn(async () => true);
			const adapter = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: {
					...workloadTestPolicy,
					connectionConsumerSnapshot: snapshot(),
				},
				probe,
			});
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending")
				throw new Error("Missing fixture workload");
			const pod = await api.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			if (!pod?.spec || !pod.metadata) throw new Error("Missing fixture Pod");
			if (field === "snapshot")
				pod.metadata.annotations = {
					[runtimeConnectionConsumerAnnotation]: "{}",
				};
			if (field === "mount") {
				const mount = pod.spec.containers[0]?.volumeMounts?.find(
					(item) => item.name === "connection-consumer",
				);
				if (!mount) throw new Error("Missing fixture mount");
				mount.readOnly = false;
			}
			if (field === "file") {
				const variable = pod.spec.containers[0]?.env?.find(
					(item) => item.name === runtimeConnectionConsumerFileEnvironment,
				);
				if (!variable) throw new Error("Missing fixture env");
				variable.value = "/caller-chosen-file";
			}
			await api.client.replace(pod);
			probe.mockClear();
			expect(await adapter.observe(desired, identity)).not.toBe("healthy");
			expect(probe).not.toHaveBeenCalled();
		},
	);
	it("rejects an Agent environment override before creating resources", async () => {
		const api = fakeKubernetesApi();
		const desired = workloadDesiredFixture();
		const create = vi.spyOn(api.client, "create");
		const adapter = createKubernetesRuntimeAdapterV1({
			client: api.client,
			policy: { ...workloadTestPolicy, connectionConsumerSnapshot: snapshot() },
			probe: async () => true,
		});
		await expect(
			adapter.apply({
				...desired,
				env: {
					...desired.env,
					[runtimeConnectionConsumerFileEnvironment]: "/attacker",
				},
			}),
		).rejects.toThrow();
		expect(create).not.toHaveBeenCalled();
	});
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeConnectionConsumerProfile } from "../../agent-runtime-host/src/connection-consumer-profile.js";

describe("protected installation supply projection", () => {
	const selected = JSON.stringify(["private-runtime-supply", "delivery-r7"]);
	it("captures a separate immutable nonsecret source with the Host tuple format", () => {
		const input = { ref: "private-runtime-supply", revision: "delivery-r7" };
		const revision = createRuntimeConnectionInstallationRevisionV1(
			input,
			snapshot(),
		);
		input.ref = "mutated";
		expect(revision).toBe(selected);
		expect(
			runtimeConnectionConsumerProjectionV1(snapshot(), revision).env,
		).toContainEqual({
			name: runtimeConnectionInstallationRevisionEnvironment,
			value: selected,
		});
		expect(
			createRuntimeConnectionInstallationRevisionV1(undefined, snapshot()),
		).toBeUndefined();
	});
	it.each([
		null,
		{},
		{ ref: "supply" },
		{ ref: "supply", revision: "" },
		{ ref: "/outside", revision: "r1" },
		{ ref: "supply", revision: "a".repeat(129) },
		{ ref: "supply", revision: "r1", token: "input-sentinel" },
		{ ref: "supply", revision: "r1", path: "/caller" },
		{ ref: "supply", revision: 1 },
	])("keeps invalid supply selected but unavailable (%#)", (input) => {
		expect(
			createRuntimeConnectionInstallationRevisionV1(input, snapshot()),
		).toBeNull();
	});
	it.each([undefined, null])(
		"requires an approved Consumer (%#)",
		(consumer) => {
			expect(
				createRuntimeConnectionInstallationRevisionV1(
					{ ref: "supply", revision: "r1" },
					consumer,
				),
			).toBeNull();
			expect(() =>
				runtimeConnectionConsumerProjectionV1(consumer, selected),
			).toThrow();
		},
	);
	it.each([
		'["supply","r1","extra"]',
		'["supply", "r1"]',
		"[]",
		'"r1"',
		"x".repeat(513),
	])("rejects malformed captured tuples before rendering (%#)", (revision) => {
		expect(() =>
			runtimeConnectionConsumerProjectionV1(snapshot(), revision),
		).toThrow();
	});
	it.each(["ref", "revision", "missing"] as const)(
		"rejects observed Pod supply %s drift before probing",
		async (field) => {
			const api = fakeKubernetesApi();
			const desired = workloadDesiredFixture();
			const probe = vi.fn(async () => true);
			const policy = {
				...workloadTestPolicy,
				connectionConsumerSnapshot: snapshot(),
				connectionInstallationRevision: selected,
			};
			const adapter = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy,
				probe,
			});
			const identity = await adapter.apply(desired);
			if (!identity || identity === "pending")
				throw new Error("Missing fixture workload");
			const workload = await api.client.read<V1StatefulSet>(
				"StatefulSet",
				desired.service.name,
			);
			expect(workload?.spec?.template.spec?.containers[0]?.env).toContainEqual({
				name: runtimeConnectionInstallationRevisionEnvironment,
				value: selected,
			});
			expect(await adapter.observe(desired, identity)).toBe("healthy");
			const pod = await api.client.read<V1Pod>(
				"Pod",
				`${desired.service.name}-0`,
			);
			const container = pod?.spec?.containers[0];
			const variable = container?.env?.find(
				(entry) =>
					entry.name === runtimeConnectionInstallationRevisionEnvironment,
			);
			if (!pod || !container || !variable)
				throw new Error("Missing fixture selector");
			if (field === "missing")
				container.env = container.env?.filter((entry) => entry !== variable);
			else
				variable.value = JSON.stringify(
					field === "ref"
						? ["other-supply", "delivery-r7"]
						: ["private-runtime-supply", "delivery-r8"],
				);
			await api.client.replace(pod);
			probe.mockClear();
			expect(await adapter.observe(desired, identity)).not.toBe("healthy");
			expect(probe).not.toHaveBeenCalled();
			// Original control still checks identity and the retained non-delivery spec.
			const control = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: { ...policy, connectionInstallationRevision: null },
				connectionConsumerControl: true,
				probe,
			});
			expect(await control.observe(desired, identity)).toBe("healthy");
		},
	);
	it("rejects caller installation env and unavailable supply before any create", async () => {
		for (const unavailable of [false, true]) {
			const api = fakeKubernetesApi();
			const create = vi.spyOn(api.client, "create");
			const adapter = createKubernetesRuntimeAdapterV1({
				client: api.client,
				policy: {
					...workloadTestPolicy,
					connectionConsumerSnapshot: snapshot(),
					connectionInstallationRevision: unavailable ? null : selected,
				},
				probe: async () => true,
			});
			const desired = workloadDesiredFixture();
			await expect(
				adapter.apply(
					unavailable
						? desired
						: {
								...desired,
								env: {
									[runtimeConnectionInstallationRevisionEnvironment]: selected,
								},
							},
				),
			).rejects.toThrow();
			expect(create).not.toHaveBeenCalled();
		}
	});
});
