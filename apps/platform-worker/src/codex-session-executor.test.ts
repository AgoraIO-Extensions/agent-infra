import { createHash } from "node:crypto";
import {
	CODEX_SESSION_EXECUTOR_ATTESTATION_ENV,
	CODEX_SESSION_EXECUTOR_BINDING_ENV,
	codexSessionExecutorAttestationV1,
	createCodexSessionExecutorBindingV1,
} from "@agent-infra/agent-runtime";
import type { V1Pod } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
	type CodexSessionExecutorPolicyV1,
	sessionExecutorAttestationSecretKeyV1,
	sessionExecutorBindingSecretKeyV1,
	sessionSandboxResourceCostsV1,
	validateCodexSessionExecutorPolicyV1,
	validateSessionExecutorResourceCostsV1,
} from "./codex-session-executor.js";
import { workloadTestPolicy } from "./kubernetes.fixture.js";
import {
	type SessionSandboxAllocationV1,
	sessionSandboxResourceMatchesV1,
	sessionSandboxResourcesV1,
} from "./session-workload-adapter.js";
import { sessionSandboxRuntimeInputFixture } from "./test-support/session-sandbox-v4.js";
import { workloadResourceConfigurationHashV1 } from "./workload-runtime.js";
import { projectWorkspaceSnapshotMaterializerV1 } from "./workspace-snapshot-materializer.js";

const executorPolicy: CodexSessionExecutorPolicyV1 = {
	resources: {
		requests: { cpu: "125m", memory: "64Mi" },
		limits: { cpu: "500m", memory: "256Mi" },
	},
	tmpSizeLimit: "64Mi",
};

function allocation(enabled = true): SessionSandboxAllocationV1 {
	const runtime = sessionSandboxRuntimeInputFixture({
		agentId: "agent-a",
		namespace: "workload-test",
		sandboxId: "sandbox-a",
	});
	const binding = createCodexSessionExecutorBindingV1({
		namespace: "workload-test",
		podName: "sandbox-sandbox-a",
		agentId: "agent-a",
		conversationId: "conversation-a",
		sessionGeneration: 3,
		sandboxId: "sandbox-a",
		resourceFence: 9,
		imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
	});
	return {
		schemaVersion: 1,
		agentId: binding.agentId,
		sessionId: binding.conversationId,
		sandboxId: binding.sandboxId,
		principal: { kind: "user", id: "actor-a" },
		channelId: "web",
		resourceName: binding.podName,
		workspaceScope: binding.sandboxId,
		generation: 3,
		resourceFence: 9,
		namespace: binding.namespace,
		podName: binding.podName,
		serviceName: binding.podName,
		serviceAccountName: binding.podName,
		pvcName: binding.podName,
		networkPolicyName: binding.podName,
		secretName: binding.podName,
		egress: {},
		imageDigest: binding.imageDigest,
		authorizedIngressSelector: { component: "dispatcher" },
		containerPort: 8080,
		workspaceMountPath: "/workspace",
		resources: {
			requests: { cpu: "100m", memory: "128Mi" },
			limits: { cpu: "1", memory: "1Gi" },
		},
		storageSize: "1Gi",
		env: { ORDINARY_OWNER_VALUE: "control-only" },
		...(enabled ? { codexSessionExecutor: executorPolicy } : {}),
		runtime: {
			...runtime,
			...(enabled
				? {
						sessionExecutor: {
							binding,
							attestation: codexSessionExecutorAttestationV1(
								binding,
								runtime.serviceToken,
							),
						},
					}
				: {}),
		},
		desiredState: "running",
	};
}

function observed(pod: V1Pod): V1Pod {
	return {
		...structuredClone(pod),
		metadata: { ...pod.metadata, uid: "pod-uid", resourceVersion: "1" },
	};
}

describe("credential-free Codex Session executor", () => {
	it("leaves the default single-container layout and env unchanged", () => {
		const resources = sessionSandboxResourcesV1(allocation(false));
		const pod = resources[5];
		expect(pod.spec?.containers.map((container) => container.name)).toEqual([
			"runtime",
		]);
		expect(pod.spec?.initContainers).toBeUndefined();
		expect(pod.spec?.shareProcessNamespace).toBeUndefined();
		expect(JSON.stringify(pod)).not.toContain("session-executor");
		expect(Object.keys(resources[4].data ?? {}).sort()).toEqual([
			"model-config",
			"token",
		]);
	});

	it("separates public executor input and exact workspace mount from control credentials", () => {
		const input = allocation();
		const resources = sessionSandboxResourcesV1(input);
		const [, , , , secret, pod] = resources;
		const runtime = pod.spec?.containers[0];
		const executor = pod.spec?.containers[1];
		const init = pod.spec?.initContainers?.[0];
		const binding = input.runtime?.sessionExecutor?.binding;
		expect(pod.spec).toMatchObject({
			shareProcessNamespace: false,
			hostPID: false,
			hostIPC: false,
			hostNetwork: false,
		});
		expect(executor?.image).toBe(runtime?.image);
		expect(executor?.command).toEqual([
			"/bin/sh",
			"/app/start-runtime-host.sh",
		]);
		expect(executor?.args).toEqual(["--session-executor", "run"]);
		expect(executor?.resources).toEqual(executorPolicy.resources);
		expect(executor?.volumeMounts).toEqual([
			{
				name: "workspace",
				mountPath: binding?.workspaceRoot,
				subPath: binding?.workspaceSubPath,
			},
			{ name: "executor-tmp", mountPath: "/tmp" },
		]);
		expect(executor?.env).toEqual([
			{
				name: CODEX_SESSION_EXECUTOR_BINDING_ENV,
				value: JSON.stringify(binding),
			},
			{
				name: "AGENT_INFRA_RUNTIME_POD_UID",
				valueFrom: {
					fieldRef: { apiVersion: "v1", fieldPath: "metadata.uid" },
				},
			},
		]);
		expect(executor?.envFrom).toBeUndefined();
		expect(init?.env).toEqual([
			{
				name: CODEX_SESSION_EXECUTOR_BINDING_ENV,
				value: JSON.stringify(binding),
			},
		]);
		expect(init?.command).toEqual(["/bin/sh", "/app/start-runtime-host.sh"]);
		expect(init?.args).toEqual(["--session-executor", "init"]);
		expect(init?.volumeMounts).toEqual([
			{ name: "workspace", mountPath: "/workspace" },
		]);
		expect(runtime?.env).toEqual(
			expect.arrayContaining([
				{
					name: CODEX_SESSION_EXECUTOR_BINDING_ENV,
					valueFrom: {
						secretKeyRef: {
							name: input.secretName,
							key: sessionExecutorBindingSecretKeyV1,
							optional: false,
						},
					},
				},
				{
					name: CODEX_SESSION_EXECUTOR_ATTESTATION_ENV,
					valueFrom: {
						secretKeyRef: {
							name: input.secretName,
							key: sessionExecutorAttestationSecretKeyV1,
							optional: false,
						},
					},
				},
				{
					name: "AGENT_INFRA_RUNTIME_ISOLATION_MODE",
					value: "session-executor",
				},
			]),
		);
		expect(
			Buffer.from(
				secret.data?.[sessionExecutorBindingSecretKeyV1] ?? "",
				"base64",
			).toString(),
		).toBe(JSON.stringify(binding));
		expect(secret.data?.[sessionExecutorAttestationSecretKeyV1]).toBe(
			Buffer.from(input.runtime?.sessionExecutor?.attestation ?? "").toString(
				"base64",
			),
		);
		expect(resources[3].spec?.ports).toEqual([
			{ name: "runtime", port: 8080, targetPort: 8080 },
		]);
		expect(executor?.ports).toBeUndefined();
		expect(executor?.securityContext).toEqual(runtime?.securityContext);
		expect(pod.spec?.volumes).toContainEqual({
			name: "executor-tmp",
			emptyDir: { medium: "Memory", sizeLimit: "64Mi" },
		});
		expect(sessionSandboxResourceMatchesV1(observed(pod), pod, input)).toBe(
			true,
		);
	});

	it.each(["resourceFence", "generation", "sessionId", "imageDigest"] as const)(
		"rejects a correctly signed binding for another allocation %s",
		(key) => {
			const input = allocation();
			const changed = {
				...input,
				[key]:
					typeof input[key] === "number"
						? Number(input[key]) + 1
						: `${input[key]}-other`,
			};
			expect(() => sessionSandboxResourcesV1(changed)).toThrow();
		},
	);

	it("preserves approved read-only snapshots without exposing their transport Secret", () => {
		const input = allocation();
		const projection = projectWorkspaceSnapshotMaterializerV1(
			[
				{
					snapshotId: "snapshot-a",
					name: "repo",
					digest: `sha256:${"b".repeat(64)}`,
					sizeBytes: 128,
					objectRef: "object-a",
					signedUrl: "https://objects.example.test/archive",
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
			],
			{
				imageDigest: `registry.example.test/worker@sha256:${"c".repeat(64)}`,
				allowedOrigins: ["https://objects.example.test"],
				cacheSizeLimit: "2Gi",
				credentialSecretName: "snapshot-credentials",
				resources: {
					requests: { cpu: "100m", memory: "128Mi" },
					limits: { cpu: "1", memory: "512Mi" },
				},
			},
		);
		const selected = {
			...input,
			workspaceSnapshotProjection: projection,
			egress: {
				workspaceSnapshotEgress: [
					{
						destination: {
							namespace: "storage",
							podLabels: { app: "snapshots" },
						},
						port: 9000,
					},
				],
			},
		};
		const pod = sessionSandboxResourcesV1(selected)[5];
		const executor = pod.spec?.containers[1];
		expect(executor?.volumeMounts).toContainEqual({
			name: "workspace-snapshots",
			mountPath: "/opt/agent/workspaces/repo",
			subPath: "repo",
			readOnly: true,
		});
		expect(
			executor?.volumeMounts?.some(
				(mount) => mount.name === "workspace-snapshot-credentials",
			),
		).toBe(false);
		expect(sessionSandboxResourceMatchesV1(observed(pod), pod, selected)).toBe(
			true,
		);
	});

	it("accepts explicit Kubernetes defaults while keeping the full container contracts exact", () => {
		const input = allocation();
		const pod = sessionSandboxResourcesV1(input)[5];
		const current = observed(pod);
		if (!current.spec) throw new Error();
		Object.assign(current.spec, {
			nodeName: "scheduled-node",
			schedulerName: "default-scheduler",
			dnsPolicy: "ClusterFirst",
			terminationGracePeriodSeconds: 30,
			serviceAccount: input.serviceAccountName,
			priority: 0,
			preemptionPolicy: "PreemptLowerPriority",
			tolerations: [
				{
					key: "node.kubernetes.io/memory-pressure",
					operator: "Exists",
					effect: "NoSchedule",
				},
				{
					key: "node.kubernetes.io/not-ready",
					operator: "Exists",
					effect: "NoExecute",
					tolerationSeconds: 300,
				},
			],
		});
		for (const container of [
			...current.spec.containers,
			...(current.spec.initContainers ?? []),
		]) {
			container.terminationMessagePath = "/dev/termination-log";
			container.terminationMessagePolicy = "File";
			for (const mount of container.volumeMounts ?? [])
				Object.assign(mount, {
					readOnly: mount.readOnly ?? false,
					subPathExpr: "",
					mountPropagation: "None",
				});
		}
		expect(sessionSandboxResourceMatchesV1(current, pod, input)).toBe(true);
	});

	it.each([
		["256Mi", "1Gi"],
		["268435456", "1073741824"],
	])(
		"accepts declared control storage resources with request=%s and limit=%s",
		(request, limit) => {
			const input = allocation();
			Object.assign(input.resources.requests, { "ephemeral-storage": "256Mi" });
			Object.assign(input.resources.limits, { "ephemeral-storage": "1Gi" });
			const pod = sessionSandboxResourcesV1(input)[5];
			const current = observed(pod);
			const resources = current.spec?.containers[0]?.resources;
			if (!resources) throw new Error();
			Object.assign(resources.requests ?? {}, {
				cpu: "0.1",
				memory: "134217728",
				"ephemeral-storage": request,
			});
			Object.assign(resources.limits ?? {}, {
				cpu: "1000m",
				memory: "1024Mi",
				"ephemeral-storage": limit,
			});
			expect(sessionSandboxResourceMatchesV1(current, pod, input)).toBe(true);
		},
	);

	it.each([
		["missing request", "requests", "ephemeral-storage", undefined],
		["missing limit", "limits", "ephemeral-storage", undefined],
		["changed request", "requests", "ephemeral-storage", "128Mi"],
		["changed limit", "limits", "ephemeral-storage", "2Gi"],
		["extra request", "requests", "example.test/resource", "1"],
		["extra limit", "limits", "example.test/resource", "1"],
	] as const)(
		"rejects control storage resource drift: %s",
		(_name, level, key, value) => {
			const input = allocation();
			Object.assign(input.resources.requests, { "ephemeral-storage": "256Mi" });
			Object.assign(input.resources.limits, { "ephemeral-storage": "1Gi" });
			const pod = sessionSandboxResourcesV1(input)[5];
			const current = observed(pod);
			const values = current.spec?.containers[0]?.resources?.[level];
			if (!values) throw new Error();
			if (value === undefined) delete values[key];
			else values[key] = value;
			expect(sessionSandboxResourceMatchesV1(current, pod, input)).toBe(false);
		},
	);

	it.each([undefined, 300])(
		"accepts standard NoExecute defaults with seconds=%s for a real Session",
		(seconds) => {
			const input = allocation();
			const pod = sessionSandboxResourcesV1(input)[5];
			const current = observed(pod);
			if (!current.spec) throw new Error();
			current.spec.tolerations = [
				"node.kubernetes.io/not-ready",
				"node.kubernetes.io/unreachable",
			].map((key) => ({
				key,
				operator: "Exists",
				effect: "NoExecute",
				...(seconds === undefined ? {} : { tolerationSeconds: seconds }),
			}));
			expect(sessionSandboxResourceMatchesV1(current, pod, input)).toBe(true);
		},
	);

	it.each([
		{ tolerationSeconds: 600 },
		{ value: "" },
		{ effect: "NoSchedule" },
		{ key: "node.kubernetes.io/disk-pressure" },
	])("rejects drifted NoExecute defaults for a real Session: %j", (changed) => {
		const input = allocation();
		const pod = sessionSandboxResourcesV1(input)[5];
		const current = observed(pod);
		if (!current.spec) throw new Error();
		current.spec.tolerations = [
			{
				key: "node.kubernetes.io/not-ready",
				operator: "Exists",
				effect: "NoExecute",
				...changed,
			},
		];
		expect(sessionSandboxResourceMatchesV1(current, pod, input)).toBe(false);
	});

	it("rejects unapproved, custom, static-key and legacy mode combinations before render", () => {
		const input = allocation();
		if (!input.runtime?.sessionExecutor) throw new Error();
		for (const changed of [
			{ ...input, codexSessionExecutor: undefined },
			{ ...input, containerPort: 8068 },
			{ ...input, containerPort: 8070 },
			{ ...input, workspaceMountPath: "/other" },
			{ ...input, runtime: { ...input.runtime, sessionExecutor: undefined } },
			{
				...input,
				runtime: { ...input.runtime, codexContainerBoundaryEnabled: true },
			},
			{ ...input, runtime: { ...input.runtime, custom: { secretRefs: [] } } },
			{ ...input, runtime: { ...input.runtime, driver: "acp" as const } },
			{
				...input,
				runtime: {
					...input.runtime,
					modelConfiguration: '{"schemaVersion":3}',
				},
			},
			{
				...input,
				runtime: {
					...input.runtime,
					sessionExecutor: {
						...input.runtime.sessionExecutor,
						attestation: "a".repeat(43),
					},
				},
			},
			{ ...input, env: { CODEX_EXEC_SERVER_URL: "ws://attacker:1" } },
		])
			expect(() => sessionSandboxResourcesV1(changed)).toThrow();
	});

	const driftCases: [string, (pod: NonNullable<V1Pod["spec"]>) => void][] = [
		[
			"executor Secret env",
			(pod) => {
				pod.containers[1]?.env?.push({
					name: "TOKEN",
					valueFrom: { secretKeyRef: { name: "control-token", key: "token" } },
				});
			},
		],
		[
			"executor envFrom",
			(pod) => {
				Object.assign(pod.containers[1] ?? {}, {
					envFrom: [{ secretRef: { name: "control-token" } }],
				});
			},
		],
		[
			"executor PVC root",
			(pod) => {
				pod.containers[1]?.volumeMounts?.push({
					name: "workspace",
					mountPath: "/workspace",
				});
			},
		],
		[
			"executor args",
			(pod) => {
				Object.assign(pod.containers[1] ?? {}, { args: ["run", "--debug"] });
			},
		],
		[
			"executor command",
			(pod) => {
				Object.assign(pod.containers[1] ?? {}, {
					command: ["sh", "-c", "evil"],
				});
			},
		],
		[
			"executor workingDir",
			(pod) => {
				Object.assign(pod.containers[1] ?? {}, { workingDir: "/workspace" });
			},
		],
		[
			"executor security",
			(pod) => {
				Object.assign(pod.containers[1]?.securityContext ?? {}, {
					privileged: true,
				});
			},
		],
		[
			"executor resources",
			(pod) => {
				Object.assign(pod.containers[1]?.resources?.limits ?? {}, { cpu: "2" });
			},
		],
		[
			"executor port",
			(pod) => {
				Object.assign(pod.containers[1] ?? {}, {
					ports: [{ containerPort: 8068 }],
				});
			},
		],
		[
			"runtime command",
			(pod) => {
				Object.assign(pod.containers[0] ?? {}, { command: ["sh"] });
			},
		],
		[
			"extra container",
			(pod) => {
				pod.containers.push({ name: "malicious", image: "attacker" });
			},
		],
		[
			"counter layout",
			(pod) => {
				pod.containers.reverse();
			},
		],
		[
			"init credential mount",
			(pod) => {
				pod.initContainers?.[0]?.volumeMounts?.push({
					name: "credentials",
					mountPath: "/credentials",
				});
			},
		],
		[
			"init Secret env",
			(pod) => {
				pod.initContainers?.[0]?.env?.push({ name: "TOKEN", value: "control" });
			},
		],
		[
			"shared PID",
			(pod) => {
				pod.shareProcessNamespace = true;
			},
		],
		[
			"host PID",
			(pod) => {
				pod.hostPID = true;
			},
		],
		[
			"host IPC",
			(pod) => {
				pod.hostIPC = true;
			},
		],
		[
			"host network",
			(pod) => {
				pod.hostNetwork = true;
			},
		],
		[
			"host volume",
			(pod) => {
				pod.volumes?.push({ name: "credentials", hostPath: { path: "/" } });
			},
		],
	];
	it.each(driftCases)("rejects all-container drift: %s", (_name, mutate) => {
		const input = allocation();
		const pod = sessionSandboxResourcesV1(input)[5];
		const current = observed(pod);
		if (!current.spec) throw new Error();
		mutate(current.spec);
		expect(sessionSandboxResourceMatchesV1(current, pod, input)).toBe(false);
	});
});

describe("executor resource accounting", () => {
	it("changes the resource tuple only when the independent policy is present", () => {
		const baseline = workloadResourceConfigurationHashV1(workloadTestPolicy);
		expect(baseline).toBe(
			createHash("sha256")
				.update(
					JSON.stringify({
						resourceProfileRef: workloadTestPolicy.resourceProfileRef,
						requests: workloadTestPolicy.resources.requests,
						limits: workloadTestPolicy.resources.limits,
					}),
				)
				.digest("hex"),
		);
		const enabled = {
			...workloadTestPolicy,
			codexSessionExecutor: executorPolicy,
		};
		expect(workloadResourceConfigurationHashV1(enabled)).not.toBe(baseline);
		expect(
			workloadResourceConfigurationHashV1({
				...enabled,
				codexSessionExecutor: { ...executorPolicy, tmpSizeLimit: "65Mi" },
			}),
		).not.toBe(workloadResourceConfigurationHashV1(enabled));
	});

	it("binds the exact approved placement into the resource configuration hash", () => {
		const hash = (placement: CodexSessionExecutorPolicyV1["placement"]) =>
			workloadResourceConfigurationHashV1({
				...workloadTestPolicy,
				codexSessionExecutor: {
					...executorPolicy,
					...(placement ? { placement } : {}),
				},
			});
		const eci = hash({ architecture: "amd64" });
		expect(eci).not.toBe(hash(undefined));
		expect(eci).toBe(hash({ architecture: "amd64", runtimeClassName: "" }));
		expect(eci).not.toBe(hash({ architecture: "arm64" }));
		expect(eci).not.toBe(
			hash({ architecture: "amd64", runtimeClassName: "runv" }),
		);
		expect(hash({ architecture: "amd64", runtimeClassName: "runv" })).not.toBe(
			hash({ architecture: "amd64", runtimeClassName: "runc" }),
		);
	});

	it("charges the summed concurrent container limits and rejects missing or smaller Store costs", () => {
		const input = allocation();
		const expected = {
			cpuMillis: 1500,
			memoryBytes: 1280 * 1024 ** 2,
			storageBytes: 1024 ** 3,
		};
		expect(sessionSandboxResourceCostsV1(input)).toEqual(expected);
		const config = (resources: typeof expected) => ({
			resourceCosts: [{ resourceConfigurationHash: "tuple", resources }],
		});
		expect(() =>
			validateSessionExecutorResourceCostsV1(input, "tuple", undefined),
		).toThrow("CODEX_SESSION_EXECUTOR_RESOURCE_COST_INVALID");
		expect(() =>
			validateSessionExecutorResourceCostsV1(input, "other", config(expected)),
		).toThrow();
		for (const key of ["cpuMillis", "memoryBytes", "storageBytes"] as const)
			expect(() =>
				validateSessionExecutorResourceCostsV1(
					input,
					"tuple",
					config({ ...expected, [key]: expected[key] - 1 }),
				),
			).toThrow();
		expect(() =>
			validateSessionExecutorResourceCostsV1(input, "tuple", config(expected)),
		).not.toThrow();
	});

	it.each([
		{ ...executorPolicy, tmpSizeLimit: "0" },
		{
			...executorPolicy,
			resources: {
				...executorPolicy.resources,
				requests: { cpu: "2", memory: "64Mi" },
			},
		},
		{ ...executorPolicy, extra: "untrusted" },
	])("rejects invalid or open-ended deployment policy", (policy) => {
		expect(() => validateCodexSessionExecutorPolicyV1(policy)).toThrow();
	});
});

describe("trusted executor Pod placement", () => {
	const eciToleration = {
		key: "virtual-kubelet.io/provider",
		operator: "Equal",
		value: "alibabacloud",
		effect: "NoSchedule",
	};
	const selected = (
		placement: NonNullable<CodexSessionExecutorPolicyV1["placement"]>,
	) => ({
		...allocation(),
		codexSessionExecutor: { ...executorPolicy, placement },
	});
	it("does not add placement when the deployment leaves it unspecified", () => {
		for (const enabled of [true, false]) {
			const pod = sessionSandboxResourcesV1(allocation(enabled))[5];
			expect(pod.spec?.nodeSelector).toBeUndefined();
			expect(pod.spec?.runtimeClassName).toBeUndefined();
			expect(pod.spec?.tolerations).toBeUndefined();
		}
	});
	it.each(["amd64", "arm64"] as const)(
		"accepts the reviewed %s ECI admission tuple only with explicit approval",
		(architecture) => {
			const input = selected({ architecture });
			const pod = sessionSandboxResourcesV1(input)[5];
			const unapproved = sessionSandboxResourcesV1(allocation())[5];
			const admitted = observed(unapproved);
			Object.assign(admitted.spec ?? {}, {
				nodeSelector: {
					type: "virtual-kubelet",
					"kubernetes.io/arch": architecture,
				},
				tolerations: [eciToleration],
			});
			expect(pod.spec?.nodeSelector).toEqual({
				type: "virtual-kubelet",
				"kubernetes.io/arch": architecture,
			});
			expect(pod.spec?.tolerations).toEqual([eciToleration]);
			expect(pod.spec?.runtimeClassName).toBeUndefined();
			expect(sessionSandboxResourceMatchesV1(admitted, pod, input)).toBe(true);
			expect(
				sessionSandboxResourceMatchesV1(admitted, unapproved, allocation()),
			).toBe(false);
		},
	);
	it.each(["amd64", "arm64"] as const)(
		"renders the exact %s RuntimeClass tuple without ECI selection",
		(architecture) => {
			const input = selected({ architecture, runtimeClassName: "runv" });
			const pod = sessionSandboxResourcesV1(input)[5];
			expect(pod.spec?.runtimeClassName).toBe("runv");
			expect(pod.spec?.nodeSelector).toEqual({
				"kubernetes.io/arch": architecture,
			});
			expect(pod.spec?.tolerations).toBeUndefined();
			expect(sessionSandboxResourceMatchesV1(observed(pod), pod, input)).toBe(
				true,
			);
			const eci = observed(pod);
			Object.assign(eci.spec ?? {}, {
				nodeSelector: {
					"kubernetes.io/arch": architecture,
					type: "virtual-kubelet",
				},
				tolerations: [eciToleration],
			});
			expect(sessionSandboxResourceMatchesV1(eci, pod, input)).toBe(false);
		},
	);
	it("treats an explicit empty RuntimeClass as canonical ECI placement", () => {
		expect(
			sessionSandboxResourcesV1(
				selected({ architecture: "amd64", runtimeClassName: "" }),
			)[5],
		).toEqual(
			sessionSandboxResourcesV1(selected({ architecture: "amd64" }))[5],
		);
	});
	it.each([
		[
			"foreign architecture",
			{
				nodeSelector: {
					type: "virtual-kubelet",
					"kubernetes.io/arch": "arm64",
				},
				tolerations: [eciToleration],
			},
		],
		[
			"foreign selector",
			{
				nodeSelector: {
					type: "virtual-kubelet",
					"kubernetes.io/arch": "amd64",
					"topology.kubernetes.io/zone": "other",
				},
				tolerations: [eciToleration],
			},
		],
		[
			"foreign RuntimeClass",
			{
				runtimeClassName: "unreviewed",
				nodeSelector: {
					type: "virtual-kubelet",
					"kubernetes.io/arch": "amd64",
				},
				tolerations: [eciToleration],
			},
		],
		[
			"wildcard provider toleration",
			{
				tolerations: [
					{
						key: "virtual-kubelet.io/provider",
						operator: "Exists",
						effect: "NoSchedule",
					},
				],
			},
		],
		[
			"foreign provider toleration",
			{ tolerations: [{ ...eciToleration, value: "another-provider" }] },
		],
		[
			"extra toleration",
			{
				tolerations: [eciToleration, { key: "unreviewed", operator: "Exists" }],
			},
		],
		["missing toleration", { tolerations: [] }],
	] as const)("rejects scheduling drift: %s", (_name, change) => {
		const input = selected({ architecture: "amd64" });
		const pod = sessionSandboxResourcesV1(input)[5];
		const current = observed(pod);
		Object.assign(current.spec ?? {}, structuredClone(change));
		expect(sessionSandboxResourceMatchesV1(current, pod, input)).toBe(false);
	});
	it.each([
		{},
		{ architecture: "x86_64" },
		{ architecture: "amd64", extra: true },
		{ architecture: "amd64", runtimeClassName: "../runv" },
		{ architecture: "amd64", runtimeClassName: "A" },
		{ architecture: "amd64", runtimeClassName: "a".repeat(254) },
		{ architecture: "amd64", runtimeClassName: null },
	])("rejects invalid or open-ended placement", (placement) => {
		expect(() =>
			validateCodexSessionExecutorPolicyV1({
				...executorPolicy,
				placement,
			} as CodexSessionExecutorPolicyV1),
		).toThrow();
	});
});
