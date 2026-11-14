import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import {
	collectRuntimeDemandImagesV1,
	type RuntimeDemandImageContextV1,
	type RuntimeDemandImageProjectionV1,
	type RuntimeDemandImageReaderV1,
	runtimeSnapshotImageProjectionV1,
} from "./runtime-demand-images.js";
import {
	sessionSandboxIdentityAnnotationsV1,
	sessionSandboxLabelsV1,
} from "./session-workload-adapter.js";

const context: RuntimeDemandImageContextV1 = {
	platformSource: "2".repeat(40),
	runtimeAuthority: "4".repeat(40),
	planHash: "a".repeat(64),
	clusterUid: "cluster",
	namespace: "runtime",
	namespaceUid: "namespace",
	release: "release",
	helmRevision: 36,
	installationId: "installation",
	directoryBindingHash: "b".repeat(64),
	directorySnapshotHash: "c".repeat(64),
};
const main = `ghcr.io/example/runtime@sha256:${"1".repeat(64)}`;
const snapshot = `ghcr.io/example/materializer@sha256:${"2".repeat(64)}`;
function first<T>(values: readonly T[]): T {
	const value = values[0];
	assert(value);
	return value;
}

const privateText = "NEVER_OUTPUT_PRIVATE_BODY_URL_OR_CREDENTIAL";
const child = {
	sessionId: "conversation",
	sandboxId: "sandbox",
	generation: 3,
	resourceFence: 6,
};

function fixture(custom = false) {
	const configuration = {
		agentId: "agent",
		revision: 7,
		ownerIds: ["owner"],
		source: custom
			? { kind: "custom", interactionMode: "platform-adapter" }
			: { kind: "standard", templateId: "codex" },
		environment: [{ name: "PRIVATE", value: privateText }],
	};
	const value = {
		management: { revision: 29, workloadRevision: 12, desiredState: "running" },
		configuration,
		state: {
			agentId: "agent",
			revision: 12,
			fence: 6,
			verifiedRevision: 12,
			identity: { uid: "parent-uid", generation: 1 },
		},
	};
	const reader = {
		list: vi.fn<RuntimeDemandImageReaderV1["list"]>(async () => ({
			items: [{ agentId: "agent" }],
			nextAfterId: null,
		})),
		read: vi.fn(async () => structuredClone(value)),
	} satisfies RuntimeDemandImageReaderV1;
	return { value, reader };
}

async function projection(
	reader: RuntimeDemandImageReaderV1,
): Promise<RuntimeDemandImageProjectionV1> {
	const initial = await collectRuntimeDemandImagesV1(reader, {
		context,
		projections: [],
	});
	return {
		agentId: "agent",
		kind: "session",
		state: "current",
		contextHash: initial.context.contextHash,
		casHash: first(initial.rows).casHash,
		evidenceHash: "d".repeat(64),
		child,
		imageSources: [
			{
				image: main,
				role: "retained-runtime",
				sourceSha: context.runtimeAuthority,
				evidenceHash: "e".repeat(64),
			},
			{
				image: snapshot,
				role: "snapshot-materializer",
				sourceSha: context.platformSource,
				evidenceHash: "f".repeat(64),
			},
		],
		resources: [
			{ kind: "Secret", data: { password: privateText } },
			{
				kind: "Pod",
				metadata: {
					name: "sandbox-pod",
					namespace: context.namespace,
					uid: "pod-uid",
					resourceVersion: "42",
					generation: 1,
					labels: sessionSandboxLabelsV1({ agentId: "agent", ...child }),
					annotations: {
						...sessionSandboxIdentityAnnotationsV1({
							agentId: "agent",
							...child,
						}),
						"agent-infra.agora.io/fence": "6",
					},
				},
				spec: {
					containers: [
						{
							name: "runtime",
							image: main,
							env: [{ name: "PRIVATE", value: privateText }],
						},
						{
							name: "codex-session-executor",
							image: main,
							command: ["sh"],
							args: ["run", privateText],
						},
					],
					initContainers: [
						{ name: "workspace-snapshot-materializer", image: snapshot },
						{
							name: "codex-session-workspace-init",
							image: main,
							command: ["sh"],
							args: ["init"],
						},
					],
				},
			},
		],
	};
}

describe("Runtime image-only Store collector", () => {
	it("retains every main/init/sidecar with mixed source authority and no private fields", async () => {
		const { reader } = fixture();
		const supplied = await projection(reader);
		const receipt = await collectRuntimeDemandImagesV1(reader, {
			context,
			projections: [supplied],
		});
		const refs = first(first(receipt.rows).groups).images;
		expect(
			refs.map((row) => [row.containerName, row.containerKind, row.image]),
		).toEqual([
			["runtime", "main", main],
			["codex-session-executor", "sidecar", main],
			["workspace-snapshot-materializer", "init", snapshot],
			["codex-session-workspace-init", "init", main],
		]);
		expect(first(refs.slice(2)).sourceSha).toBe(context.platformSource);
		expect(first(refs).sourceSha).toBe(context.runtimeAuthority);
		expect(first(refs).resourceIdentity).toEqual({
			uid: "pod-uid",
			resourceVersion: "42",
			generation: 1,
		});
		expect(JSON.stringify(receipt)).not.toContain(privateText);
		expect(JSON.stringify(receipt)).not.toMatch(
			/"env"|"data"|"args"|"command"/,
		);
		expect(receipt.sideEffects).toMatchObject({
			claims: 0,
			allocations: 0,
			applies: 0,
			databaseWrites: 0,
		});
		expect(receipt.globalAbsenceProven).toBe(false);
		expect(receipt.coverage.session).toBe("UNKNOWN_INVENTORY");
	});

	it("enumerates custom as well as standard across pages without claiming global image completeness", async () => {
		const standard = fixture();
		const custom = fixture(true);
		custom.value.configuration.agentId = "custom";
		custom.value.state.agentId = "custom";
		const reader: RuntimeDemandImageReaderV1 = {
			list: vi.fn(async (cursor) =>
				cursor === undefined
					? { items: [{ agentId: "agent" }], nextAfterId: "agent" }
					: { items: [{ agentId: "custom" }], nextAfterId: null },
			),
			read: async (agentId) =>
				structuredClone(agentId === "agent" ? standard.value : custom.value),
		};
		const receipt = await collectRuntimeDemandImagesV1(reader, {
			context,
			projections: [],
		});
		expect(receipt.rows.map((row) => row.sourceKind)).toEqual([
			"standard",
			"custom",
		]);
		expect(receipt.pageCount).toBe(2);
		expect(receipt.paginationComplete).toBe(true);
		expect(
			receipt.rows.every(
				(row) =>
					row.status === "PARTIAL" &&
					row.scope.every((scope) => scope.status === "UNKNOWN"),
			),
		).toBe(true);
		expect(receipt.globalAbsenceProven).toBe(false);
	});

	it("extracts real custom manifest main/init declarations without promoting them to current Sessions", async () => {
		const { reader, value } = fixture(true);
		const configuration = {
			...value.configuration,
			source: {
				...value.configuration.source,
				manifest: JSON.stringify({
					kind: "Deployment",
					metadata: { name: "custom-service" },
					spec: {
						template: {
							spec: {
								containers: [
									{
										name: "app",
										image: main,
										env: [{ name: "PRIVATE", value: privateText }],
									},
								],
								initContainers: [{ name: "materializer", image: snapshot }],
							},
						},
					},
				}),
			},
		};
		reader.read.mockResolvedValue({ ...value, configuration });
		const receipt = await collectRuntimeDemandImagesV1(reader, {
			context,
			projections: [],
		});
		expect(first(receipt.rows).declaredImages.map((row) => row.image)).toEqual([
			main,
			snapshot,
		]);
		expect(
			first(receipt.rows).declaredImages.every((row) => row.sourceSha === null),
		).toBe(true);
		expect(
			first(receipt.rows).scope.find((scope) => scope.kind === "session")
				?.status,
		).toBe("UNKNOWN");
		expect(JSON.stringify(receipt)).not.toContain(privateText);
	});

	it("keeps Store candidate/verified main refs partial when final init and sidecar projections are absent", async () => {
		const { reader, value } = fixture();
		const version = {
			configuration: {
				source: {
					kind: "standard",
					templateId: "codex",
					imageDigest: main.split("@")[1],
				},
			},
			deployment: { imageDigest: main.split("@")[1] },
			modelProjection: {
				standardTemplateBinding: {
					templateId: "codex",
					imageDigest: main.split("@")[1],
					imageRepository: "ghcr.io/example/runtime",
				},
			},
		};
		reader.read.mockResolvedValue({
			...value,
			state: { ...value.state, candidate: version, verified: version },
		} as Awaited<ReturnType<typeof reader.read>>);
		const receipt = await collectRuntimeDemandImagesV1(reader, {
			context,
			projections: [],
		});
		expect(first(receipt.rows).knownMainImages.map((row) => row.image)).toEqual(
			[main, main],
		);
		expect(
			first(receipt.rows).knownMainImages.every(
				(row) => row.completeness === "MAIN_ONLY_INIT_SIDECARS_UNKNOWN",
			),
		).toBe(true);
		expect(receipt.globalAbsenceProven).toBe(false);
	});

	it.each(["contextHash", "casHash", "evidenceHash"] as const)(
		"rejects stale or unbound %s",
		async (field) => {
			const { reader } = fixture();
			const supplied = await projection(reader);
			await expect(
				collectRuntimeDemandImagesV1(reader, {
					context,
					projections: [{ ...supplied, [field]: "invalid" }],
				}),
			).rejects.toThrow("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		},
	);

	it("marks an observed CAS change unknown, preserving known image protection", async () => {
		const { reader, value } = fixture();
		const supplied = await projection(reader);
		reader.read
			.mockReset()
			.mockResolvedValueOnce(structuredClone(value))
			.mockResolvedValueOnce({
				...value,
				management: { ...value.management, revision: 30 },
			});
		const receipt = await collectRuntimeDemandImagesV1(reader, {
			context,
			projections: [supplied],
		});
		expect(receipt.contextStable).toBe(false);
		expect(first(receipt.rows).status).toBe("UNKNOWN_CONTEXT_DRIFT");
		expect(first(first(receipt.rows).groups).images).toHaveLength(4);
		expect(
			first(receipt.rows).scope.every((scope) => scope.status === "UNKNOWN"),
		).toBe(true);
	});

	it("rejects parent Workloads and wrong child generation/fence as Session proof", async () => {
		const { reader } = fixture();
		const supplied = await projection(reader);
		for (const changed of [
			{
				...supplied,
				resources: [{ kind: "Deployment", metadata: {}, spec: {} }],
			},
			{ ...supplied, child: { ...child, generation: 4 } },
			{ ...supplied, child: { ...child, resourceFence: 7 } },
		])
			await expect(
				collectRuntimeDemandImagesV1(reader, {
					context,
					projections: [changed],
				}),
			).rejects.toThrow("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
	});

	it("rejects unapproved images, mutable tags, wrong namespace and omitted image source", async () => {
		const { reader } = fixture();
		const supplied = await projection(reader);
		await expect(
			collectRuntimeDemandImagesV1(reader, {
				context,
				projections: [{ ...supplied, imageSources: [] }],
			}),
		).rejects.toThrow();
		const template = (image: string, namespace: string) => ({
			...supplied,
			kind: "declared" as const,
			state: "future" as const,
			resources: [
				{
					kind: "Deployment",
					metadata: { name: "future", namespace },
					spec: {
						template: { spec: { containers: [{ name: "runtime", image }] } },
					},
				},
			],
		});
		for (const changed of [
			template("ghcr.io/example/runtime:latest", "runtime"),
			template(main, "foreign"),
		])
			await expect(
				collectRuntimeDemandImagesV1(reader, {
					context,
					projections: [changed],
				}),
			).rejects.toThrow("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		const receipt = await collectRuntimeDemandImagesV1(reader, {
			context,
			projections: [template(main, "runtime")],
		});
		expect(first(first(receipt.rows).groups).state).toBe("future");
		expect(
			first(receipt.rows).scope.find((scope) => scope.kind === "session")
				?.status,
		).toBe("UNKNOWN");
	});

	it("terminates cyclic and duplicate paging without an unbounded reader", async () => {
		const { reader } = fixture();
		reader.list.mockResolvedValue({
			items: [{ agentId: "agent" }],
			nextAfterId: "agent",
		});
		await expect(
			collectRuntimeDemandImagesV1(reader, { context, projections: [] }),
		).rejects.toThrow("RUNTIME_DEMAND_IMAGE_INPUT_INVALID");
		expect(reader.list).toHaveBeenCalledTimes(2);
	});

	it("uses the unsigned snapshot materializer policy only for nonempty actual bindings", () => {
		const policy = {
			imageDigest: snapshot,
			allowedOrigins: [],
			cacheSizeLimit: "1Gi",
			credentialSecretName: "reference-only",
			resources: {
				requests: { cpu: "100m", memory: "128Mi" },
				limits: { cpu: "1", memory: "256Mi" },
			},
		};
		expect(runtimeSnapshotImageProjectionV1([], policy)).toEqual([]);
		expect(
			runtimeSnapshotImageProjectionV1(
				[
					{
						snapshotId: "snapshot",
						name: "workspace",
						digest: `sha256:${"a".repeat(64)}`,
						sizeBytes: 32,
						objectRef: privateText,
					},
				],
				policy,
			),
		).toEqual([{ name: "workspace-snapshot-materializer", image: snapshot }]);
		expect(() =>
			runtimeSnapshotImageProjectionV1(
				[
					{
						snapshotId: "snapshot",
						name: "workspace",
						digest: `sha256:${"a".repeat(64)}`,
						sizeBytes: 32,
						objectRef: privateText,
					},
				],
				{ ...policy, imageDigest: "worker:latest" },
			),
		).toThrow();
	});
});
