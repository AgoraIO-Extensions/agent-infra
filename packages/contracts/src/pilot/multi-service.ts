import { z } from "zod";

import { OpaqueIdV1Schema } from "../index.ts";

const kubernetesName = z
	.string()
	.regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
	.min(1)
	.max(63);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Platform-owned profile selected by a Service annotation. */
export const MultiServiceResourceProfileRefV1Schema = OpaqueIdV1Schema;
const cpuQuantity = z.string().regex(/^[1-9][0-9]*m?$/);
const memoryQuantity = z.string().regex(/^[1-9][0-9]*(?:Ki|Mi|Gi|Ti)$/);
const estimatedResources = z.strictObject({
	cpuMillicores: z.number().int().positive(),
	memoryMiB: z.number().int().positive(),
	storageGiB: z.number().int().positive(),
});
const resourceQuantities = z.strictObject({
	requests: z.strictObject({ cpu: cpuQuantity, memory: memoryQuantity }),
	limits: z.strictObject({ cpu: cpuQuantity, memory: memoryQuantity }),
});

/** Deployment-owned resource settings for one multi-service workload. */
export const MultiServiceResourceProfileV1Schema = z.strictObject({
	profileId: MultiServiceResourceProfileRefV1Schema,
	displayName: z.string().min(1).max(256),
	estimatedResources,
	resources: resourceQuantities,
	/** Platform storage tier for StatefulSet/PVC workloads; user PVC sizes are ignored. */
	storageSize: z
		.string()
		.regex(/^[1-9][0-9]*(Mi|Gi)$/)
		.optional(),
});
export const MultiServiceResourceProfileProjectionV1Schema =
	MultiServiceResourceProfileV1Schema.omit({ resources: true });
export const MultiServiceResourceCapV1Schema = estimatedResources;
const labelMap = z
	.record(kubernetesName, z.string().min(1).max(256))
	.optional();
const annotationKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9./_-]{0,252}$/);
const annotations = z
	.record(annotationKey, z.string().min(1).max(256))
	.optional();
const metadata = z.strictObject({
	name: kubernetesName,
	labels: labelMap,
	annotations,
});

export const MultiServiceResourceProfileAnnotationV1 =
	"agent-infra.agora.io/resource-profile" as const;
const port = z.strictObject({
	name: kubernetesName,
	port: z.number().int().min(1).max(65_535),
	targetPort: z.number().int().min(1).max(65_535),
});
const container = z.strictObject({
	name: kubernetesName,
	image: digest,
	ports: z.array(port).max(32).optional(),
	volumeMounts: z
		.array(
			z.strictObject({
				name: kubernetesName,
				mountPath: z
					.string()
					.regex(
						/^\/(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._~/-]+$/,
					)
					.max(256),
				readOnly: z.literal(true).optional(),
			}),
		)
		.max(32)
		.optional(),
	env: z
		.array(
			z.strictObject({
				name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/),
				value: z.string().max(8192),
			}),
		)
		.max(128)
		.optional(),
});
const podTemplate = z.strictObject({
	metadata: z.strictObject({ labels: z.record(kubernetesName, z.string()) }),
	spec: z.strictObject({
		containers: z.array(container).min(1).max(32),
		volumes: z
			.array(
				z.strictObject({
					name: kubernetesName,
					configMap: z.strictObject({ name: kubernetesName }),
				}),
			)
			.max(32)
			.optional(),
		restartPolicy: z.enum(["Always", "Never"]).optional(),
	}),
});
const selector = z.strictObject({
	matchLabels: z.record(kubernetesName, z.string().min(1).max(256)),
});

const deploymentSpec = z.strictObject({
	replicas: z.literal(1),
	selector,
	template: podTemplate,
});
const statefulSetSpec = deploymentSpec.extend({
	serviceName: kubernetesName,
});
const serviceSpec = z.strictObject({
	type: z.literal("ClusterIP"),
	selector: z.record(kubernetesName, z.string().min(1).max(256)),
	ports: z.array(port).min(1).max(32),
});
const configMapSpec = z.strictObject({
	data: z.record(z.string().min(1).max(256), z.string().max(65_536)),
});

/** ConfigMap data is intentionally bounded and is never a Secret transport. */
export const MultiServiceConfigMapMaxBytesV1 = 65_536;
/** Default admission bound for the number of Deployment/StatefulSet services. */
export const MultiServiceMaxWorkloadsV1 = 16;

const secretLikeConfigMapKey =
	/(?:^|[_.-])(?:pass(?:word)?|secret|token|api[_-]?key|private[_-]?key|credential|oauth|access[_-]?key)(?:$|[_.-])/i;
const secretLikeConfigMapValue =
	/(?:-----BEGIN [^-]*PRIVATE KEY-----|^(?:bearer|basic)\s+\S+|^(?:sk|gh[pousr]_|xox[baprs]-)[A-Za-z0-9._-]{8,}$)/i;

export function isSecretLikeConfigMapEntryV1(key: string, value: string) {
	return (
		secretLikeConfigMapKey.test(key) ||
		secretLikeConfigMapValue.test(value.trim())
	);
}

function validateConfigMapData(
	data: Record<string, string>,
	context: z.RefinementCtx,
) {
	let bytes = 0;
	for (const [key, value] of Object.entries(data)) {
		const keyBytes = new TextEncoder().encode(key).byteLength;
		const valueBytes = new TextEncoder().encode(value).byteLength;
		bytes += keyBytes + valueBytes;
		if (
			!String.prototype.isWellFormed.call(value) ||
			value.includes("\0") ||
			isSecretLikeConfigMapEntryV1(key, value)
		)
			context.addIssue({
				code: "custom",
				path: ["data", key],
				message: isSecretLikeConfigMapEntryV1(key, value)
					? "ConfigMap data must not contain Secret-like keys or values"
					: "ConfigMap data must be valid UTF-8 without NUL bytes",
			});
	}
	if (bytes > MultiServiceConfigMapMaxBytesV1)
		context.addIssue({
			code: "custom",
			path: ["data"],
			message: `ConfigMap data exceeds ${MultiServiceConfigMapMaxBytesV1} bytes`,
		});
}

const configMapResource = z
	.strictObject({
		apiVersion: z.literal("v1"),
		kind: z.literal("ConfigMap"),
		metadata,
		spec: configMapSpec,
	})
	.superRefine((resource, context) =>
		validateConfigMapData(resource.spec.data, context),
	);
const pvcSpec = z.strictObject({
	accessModes: z.array(z.literal("ReadWriteOnce")).length(1),
	resources: z.strictObject({
		requests: z.strictObject({
			storage: z.string().regex(/^[1-9][0-9]*(Mi|Gi)$/),
		}),
	}),
});
const jobSpec = z.strictObject({
	backoffLimit: z.number().int().min(0).max(5),
	/** Platform-enforced upper bound for a release migration. */
	activeDeadlineSeconds: z
		.number()
		.int()
		.min(1)
		.max(1_800)
		.optional()
		.default(1_800),
	template: podTemplate.extend({
		spec: podTemplate.shape.spec.extend({ restartPolicy: z.literal("Never") }),
	}),
});

export const MultiServiceResourceV1Schema = z.discriminatedUnion("kind", [
	z.strictObject({
		apiVersion: z.literal("apps/v1"),
		kind: z.literal("Deployment"),
		metadata,
		spec: deploymentSpec,
	}),
	z.strictObject({
		apiVersion: z.literal("apps/v1"),
		kind: z.literal("StatefulSet"),
		metadata,
		spec: statefulSetSpec,
	}),
	z.strictObject({
		apiVersion: z.literal("v1"),
		kind: z.literal("Service"),
		metadata,
		spec: serviceSpec,
	}),
	configMapResource,
	z.strictObject({
		apiVersion: z.literal("v1"),
		kind: z.literal("PersistentVolumeClaim"),
		metadata,
		spec: pvcSpec,
	}),
	z.strictObject({
		apiVersion: z.literal("batch/v1"),
		kind: z.literal("Job"),
		metadata,
		spec: jobSpec,
	}),
]);

export const MultiServiceManifestDocumentV1Schema = z
	.strictObject({
		schemaVersion: z.literal(1),
		entryServiceName: kubernetesName,
		resources: z.array(MultiServiceResourceV1Schema).min(2).max(64),
	})
	.superRefine((value, context) => {
		const identities = new Set<string>();
		for (const [index, resource] of value.resources.entries()) {
			const identity = `${resource.apiVersion}/${resource.kind}/${resource.metadata.name}`;
			if (identities.has(identity))
				context.addIssue({
					code: "custom",
					path: ["resources", index],
					message: "resource identity must be unique",
				});
			identities.add(identity);
		}
		const services = value.resources.filter(
			(resource) => resource.kind === "Service",
		);
		const entries = services.filter(
			(resource) =>
				resource.metadata.annotations?.[MultiServiceEntryAnnotationV1] ===
				"true",
		);
		if (entries.length !== 1)
			context.addIssue({
				code: "custom",
				path: ["resources"],
				message: "exactly one Service must carry the entry annotation",
			});
		if (entries[0]?.metadata.name !== value.entryServiceName)
			context.addIssue({
				code: "custom",
				path: ["entryServiceName"],
				message: "entryServiceName must match the annotated Service",
			});
		for (const [index, resource] of value.resources.entries()) {
			const profile =
				resource.metadata.annotations?.[
					MultiServiceResourceProfileAnnotationV1
				];
			if (
				profile !== undefined &&
				!MultiServiceResourceProfileRefV1Schema.safeParse(profile).success
			)
				context.addIssue({
					code: "custom",
					path: [
						"resources",
						index,
						"metadata",
						"annotations",
						MultiServiceResourceProfileAnnotationV1,
					],
					message: "resource profile reference is invalid",
				});
		}

		const configMaps = new Set(
			value.resources
				.filter((resource) => resource.kind === "ConfigMap")
				.map((resource) => resource.metadata.name),
		);
		for (const [index, resource] of value.resources.entries()) {
			if (
				resource.kind !== "Deployment" &&
				resource.kind !== "StatefulSet" &&
				resource.kind !== "Job"
			)
				continue;
			const volumeNames = new Set<string>();
			for (const volume of resource.spec.template.spec.volumes ?? []) {
				if (volumeNames.has(volume.name))
					context.addIssue({
						code: "custom",
						path: ["resources", index, "spec", "template", "spec", "volumes"],
						message: "volume names must be unique",
					});
				volumeNames.add(volume.name);
				if (!configMaps.has(volume.configMap.name))
					context.addIssue({
						code: "custom",
						path: ["resources", index, "spec", "template", "spec", "volumes"],
						message: "volume ConfigMap must be declared in the manifest",
					});
			}
			for (const [
				containerIndex,
				container,
			] of resource.spec.template.spec.containers.entries()) {
				const mountNames = new Set<string>();
				for (const mount of container.volumeMounts ?? []) {
					if (mountNames.has(mount.name))
						context.addIssue({
							code: "custom",
							path: [
								"resources",
								index,
								"spec",
								"template",
								"spec",
								"containers",
								containerIndex,
								"volumeMounts",
							],
							message: "volume mount names must be unique per container",
						});
					mountNames.add(mount.name);
					if (!volumeNames.has(mount.name))
						context.addIssue({
							code: "custom",
							path: [
								"resources",
								index,
								"spec",
								"template",
								"spec",
								"containers",
								containerIndex,
								"volumeMounts",
							],
							message: "volume mount must reference a declared volume",
						});
				}
			}
		}
	});

/** The API projection of one admitted Service and its platform-owned profile. */
export const MultiServiceServiceProjectionV1Schema = z.strictObject({
	name: OpaqueIdV1Schema,
	resourceProfileRef: MultiServiceResourceProfileRefV1Schema,
	entry: z.boolean(),
});

export type MultiServiceServiceProjectionV1 = z.infer<
	typeof MultiServiceServiceProjectionV1Schema
>;
export type MultiServiceResourceProfileV1 = z.infer<
	typeof MultiServiceResourceProfileV1Schema
>;
export type MultiServiceResourceProfileProjectionV1 = z.infer<
	typeof MultiServiceResourceProfileProjectionV1Schema
>;
export type MultiServiceResourceCapV1 = z.infer<
	typeof MultiServiceResourceCapV1Schema
>;

export const MultiServiceAgentSourceV1Schema = z.strictObject({
	kind: z.literal("custom"),
	interactionMode: z.literal("self-managed"),
	identityResponsibility: z.literal("self-managed"),
	manifest: z.string().min(1).max(262_144),
	/** Server-derived service/profile summary; omitted on create requests. */
	services: z.array(MultiServiceServiceProjectionV1Schema).max(64).optional(),
});

export const MultiServiceAdmissionErrorCodeV1Schema = z.enum([
	"MULTI_SERVICE_MANIFEST_INVALID",
	"MULTI_SERVICE_RESOURCE_KIND_UNSUPPORTED",
	"MULTI_SERVICE_RESOURCE_FIELD_UNSUPPORTED",
	"MULTI_SERVICE_IMAGE_DIGEST_REQUIRED",
	"MULTI_SERVICE_ENTRY_SERVICE_REQUIRED",
	"MULTI_SERVICE_ENTRY_SERVICE_MULTIPLE",
	"MULTI_SERVICE_MANIFEST_TOO_LARGE",
	"MULTI_SERVICE_RESOURCE_LIMIT_EXCEEDED",
	"MULTI_SERVICE_RESOURCE_CAP_EXCEEDED",
]);

export const MultiServiceEntryAnnotationV1 =
	"agent-infra.agora.io/entry" as const;

export type MultiServiceResourceV1 = z.infer<
	typeof MultiServiceResourceV1Schema
>;
export type MultiServiceManifestDocumentV1 = z.infer<
	typeof MultiServiceManifestDocumentV1Schema
>;
export type MultiServiceAgentSourceV1 = z.infer<
	typeof MultiServiceAgentSourceV1Schema
>;
export type MultiServiceAdmissionErrorCodeV1 = z.infer<
	typeof MultiServiceAdmissionErrorCodeV1Schema
>;

/**
 * 部署未配置档位时使用的默认档位。默认档位不声明 storageSize：PVC 沿用部署的全局
 * 存储策略，已有多服务 Agent 的 PVC 大小不会因本默认值改变。
 */
export const defaultMultiServiceResourceProfileV1 = {
	profileId: "default",
	displayName: "Default multi-service",
	estimatedResources: { cpuMillicores: 100, memoryMiB: 128, storageGiB: 1 },
	resources: {
		requests: { cpu: "25m", memory: "32Mi" },
		limits: { cpu: "100m", memory: "128Mi" },
	},
} as const satisfies MultiServiceResourceProfileV1;

/** 部署未配置时的单 Agent 总量上限。 */
export const defaultMultiServiceResourceCapV1 = {
	cpuMillicores: 2_000,
	memoryMiB: 4_096,
	storageGiB: 20,
} as const satisfies MultiServiceResourceCapV1;

export interface MultiServiceResourceConfigurationV1 {
	/** 默认档位在首位，其后为部署配置的档位。 */
	readonly profiles: readonly MultiServiceResourceProfileV1[];
	readonly cap: MultiServiceResourceCapV1;
	readonly source: "deployment" | "default";
}

/**
 * 解析部署方提供的档位与上限。API 与 Worker 共用同一规则：配置非法、档位 ID 重复或
 * 覆盖默认档位时抛错，由调用方转换为各自的启动期配置错误（fail closed）。
 */
export function parseMultiServiceResourceConfigurationV1(input: {
	readonly profiles?: unknown;
	readonly cap?: unknown;
}): MultiServiceResourceConfigurationV1 {
	const configured = z
		.array(MultiServiceResourceProfileV1Schema)
		.max(64)
		.parse(input.profiles ?? []);
	const ids = configured.map((profile) => profile.profileId);
	if (
		ids.includes(defaultMultiServiceResourceProfileV1.profileId) ||
		new Set(ids).size !== ids.length
	)
		throw new Error("multi-service resource profiles are invalid");
	return {
		profiles: [
			structuredClone(defaultMultiServiceResourceProfileV1),
			...configured,
		],
		cap: MultiServiceResourceCapV1Schema.parse(
			input.cap ?? defaultMultiServiceResourceCapV1,
		),
		source: configured.length > 0 ? "deployment" : "default",
	};
}

type MultiServiceManifestResourceV1 =
	MultiServiceManifestDocumentV1["resources"][number];
type MultiServiceServiceResourceV1 = Extract<
	MultiServiceManifestResourceV1,
	{ kind: "Service" }
>;
export type MultiServiceProfiledWorkloadV1 = Extract<
	MultiServiceManifestResourceV1,
	{ kind: "Deployment" | "StatefulSet" | "Job" }
>;

function serviceSelectsWorkload(
	service: MultiServiceServiceResourceV1,
	workload: MultiServiceProfiledWorkloadV1,
) {
	return Object.entries(service.spec.selector).every(
		([key, expected]) =>
			workload.spec.template.metadata.labels[key] === expected,
	);
}

/**
 * 解析一个工作负载引用的档位：工作负载自身 annotation 优先，其次是选中它的
 * Service 的 annotation（迁移 Job 没有 Service），都没有时使用默认档位。
 */
export function multiServiceWorkloadProfileRefV1(
	manifest: MultiServiceManifestDocumentV1,
	workload: MultiServiceProfiledWorkloadV1,
): string {
	const direct =
		workload.metadata.annotations?.[MultiServiceResourceProfileAnnotationV1];
	if (direct !== undefined) return direct;
	if (workload.kind !== "Job") {
		const service = manifest.resources.find(
			(resource): resource is MultiServiceServiceResourceV1 =>
				resource.kind === "Service" &&
				serviceSelectsWorkload(resource, workload),
		);
		const fromService =
			service?.metadata.annotations?.[MultiServiceResourceProfileAnnotationV1];
		if (fromService !== undefined) return fromService;
	}
	return defaultMultiServiceResourceProfileV1.profileId;
}

/** 每个 Service 展示其所选工作负载实际使用的档位，与准入和 Worker 注入一致。 */
export function multiServiceServiceProjectionsV1(
	manifest: MultiServiceManifestDocumentV1,
): MultiServiceServiceProjectionV1[] {
	return manifest.resources
		.filter(
			(resource): resource is MultiServiceServiceResourceV1 =>
				resource.kind === "Service",
		)
		.map((service) => {
			const workload = manifest.resources.find(
				(resource): resource is MultiServiceProfiledWorkloadV1 =>
					(resource.kind === "Deployment" || resource.kind === "StatefulSet") &&
					serviceSelectsWorkload(service, resource),
			);
			return {
				name: service.metadata.name,
				resourceProfileRef: workload
					? multiServiceWorkloadProfileRefV1(manifest, workload)
					: (service.metadata.annotations?.[
							MultiServiceResourceProfileAnnotationV1
						] ?? defaultMultiServiceResourceProfileV1.profileId),
				entry: service.metadata.name === manifest.entryServiceName,
			};
		});
}

export type MultiServiceResourceCapacityV1 =
	| {
			readonly ok: true;
			readonly total: MultiServiceResourceCapV1;
			readonly cap: MultiServiceResourceCapV1;
	  }
	| {
			readonly ok: false;
			readonly reason: "unknown_profile";
			readonly profileRef: string;
	  }
	| {
			readonly ok: false;
			readonly reason: "cap_exceeded";
			readonly total: MultiServiceResourceCapV1;
			readonly cap: MultiServiceResourceCapV1;
	  };

/** 汇总全部工作负载（含迁移 Job）的档位估算量，并与单 Agent 上限比较。副本固定为 1。 */
export function calculateMultiServiceResourceCapacityV1(input: {
	readonly manifest: MultiServiceManifestDocumentV1;
	readonly configuration: MultiServiceResourceConfigurationV1;
}): MultiServiceResourceCapacityV1 {
	const profiles = new Map(
		input.configuration.profiles.map((profile) => [profile.profileId, profile]),
	);
	const total = { cpuMillicores: 0, memoryMiB: 0, storageGiB: 0 };
	for (const resource of input.manifest.resources) {
		if (
			resource.kind !== "Deployment" &&
			resource.kind !== "StatefulSet" &&
			resource.kind !== "Job"
		)
			continue;
		const profileRef = multiServiceWorkloadProfileRefV1(
			input.manifest,
			resource,
		);
		const profile = profiles.get(profileRef);
		if (!profile) return { ok: false, reason: "unknown_profile", profileRef };
		total.cpuMillicores += profile.estimatedResources.cpuMillicores;
		total.memoryMiB += profile.estimatedResources.memoryMiB;
		total.storageGiB += profile.estimatedResources.storageGiB;
	}
	const cap = input.configuration.cap;
	if (
		total.cpuMillicores > cap.cpuMillicores ||
		total.memoryMiB > cap.memoryMiB ||
		total.storageGiB > cap.storageGiB
	)
		return { ok: false, reason: "cap_exceeded", total, cap };
	return { ok: true, total, cap };
}
