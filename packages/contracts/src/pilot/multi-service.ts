import { z } from "zod";

const kubernetesName = z
	.string()
	.regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/)
	.min(1)
	.max(63);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
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
const port = z.strictObject({
	name: kubernetesName,
	port: z.number().int().min(1).max(65_535),
	targetPort: z.number().int().min(1).max(65_535),
});
const container = z.strictObject({
	name: kubernetesName,
	image: digest,
	ports: z.array(port).max(32).optional(),
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
	z.strictObject({
		apiVersion: z.literal("v1"),
		kind: z.literal("ConfigMap"),
		metadata,
		spec: configMapSpec,
	}),
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
	});

export const MultiServiceAgentSourceV1Schema = z.strictObject({
	kind: z.literal("custom"),
	interactionMode: z.literal("self-managed"),
	identityResponsibility: z.literal("self-managed"),
	manifest: z.string().min(1).max(262_144),
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
