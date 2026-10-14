import { describe, expect, it } from "vitest";
import {
	AgentApplicationCreateRequestV2Schema,
	MultiServiceAdmissionErrorCodeV1Schema,
	MultiServiceAgentSourceV1Schema,
	MultiServiceEntryAnnotationV1,
	MultiServiceManifestDocumentV1Schema,
	MultiServiceResourceProfileAnnotationV1,
	MultiServiceResourceV1Schema,
} from "./index.ts";

const digest = `sha256:${"a".repeat(64)}`;
const labels = { app: "payments" };
const container = {
	name: "api",
	image: digest,
	ports: [{ name: "http", port: 8080, targetPort: 8080 }],
};
const deployment = {
	apiVersion: "apps/v1",
	kind: "Deployment",
	metadata: { name: "api", labels },
	spec: {
		replicas: 1,
		selector: { matchLabels: labels },
		template: {
			metadata: { labels },
			spec: { containers: [container] },
		},
	},
};
const service = {
	apiVersion: "v1",
	kind: "Service",
	metadata: {
		name: "api",
		labels,
		annotations: { [MultiServiceEntryAnnotationV1]: "true" },
	},
	spec: {
		type: "ClusterIP",
		selector: labels,
		ports: [{ name: "http", port: 8080, targetPort: 8080 }],
	},
};

const document = {
	schemaVersion: 1 as const,
	entryServiceName: "api",
	resources: [deployment, service],
};

describe("multi-service Agent contract seam", () => {
	it("accepts a two-service resource document with one entry Service", () => {
		expect(MultiServiceManifestDocumentV1Schema.parse(document)).toEqual(
			document,
		);
		expect(MultiServiceResourceV1Schema.parse(deployment)).toEqual(deployment);
	});

	it("uses a Service profile annotation and rejects user resource overrides", () => {
		const profiled = MultiServiceManifestDocumentV1Schema.parse({
			...document,
			resources: [
				deployment,
				{
					...service,
					metadata: {
						...service.metadata,
						annotations: {
							...service.metadata.annotations,
							[MultiServiceResourceProfileAnnotationV1]: "small",
						},
					},
				},
			],
		});
		expect(
			profiled.resources.find((resource) => resource.kind === "Service")
				?.metadata.annotations?.[MultiServiceResourceProfileAnnotationV1],
		).toBe("small");
		expect(
			MultiServiceManifestDocumentV1Schema.safeParse({
				...document,
				resources: [
					{
						...deployment,
						spec: { ...deployment.spec, resources: {} },
					},
					service,
				],
			}).success,
		).toBe(false);
	});

	it.each([
		["unsupported resource kind", { ...service, kind: "Ingress" }],
		[
			"non-digest image",
			{
				...deployment,
				spec: {
					...deployment.spec,
					template: {
						...deployment.spec.template,
						spec: {
							containers: [{ ...container, image: "registry/app:latest" }],
						},
					},
				},
			},
		],
		["unknown top-level field", { ...service, extra: "reject" }],
	])("rejects %s", (_label, value) => {
		expect(() =>
			MultiServiceManifestDocumentV1Schema.parse({
				...document,
				resources: [deployment, value],
			}),
		).toThrow();
	});

	it("requires exactly one annotated entry Service", () => {
		expect(() =>
			MultiServiceManifestDocumentV1Schema.parse({
				...document,
				resources: [
					deployment,
					{
						...service,
						metadata: { ...service.metadata, annotations: undefined },
					},
				],
			}),
		).toThrow();
		expect(() =>
			MultiServiceManifestDocumentV1Schema.parse({
				...document,
				resources: [
					deployment,
					service,
					{ ...service, metadata: { ...service.metadata, name: "api-two" } },
				],
			}),
		).toThrow();
	});

	it("rejects duplicate Kubernetes resource identities", () => {
		expect(() =>
			MultiServiceManifestDocumentV1Schema.parse({
				...document,
				resources: [deployment, service, deployment],
			}),
		).toThrow("resource identity must be unique");
	});

	it("adds a bounded self-managed source without changing standard/custom sources", () => {
		const source = MultiServiceAgentSourceV1Schema.parse({
			kind: "custom",
			interactionMode: "self-managed",
			identityResponsibility: "self-managed",
			manifest: "apiVersion: v1\nkind: Service\n",
		});
		expect(source.manifest).toContain("kind: Service");
		const request = AgentApplicationCreateRequestV2Schema.parse({
			schemaVersion: 2,
			name: "multi-service",
			description: "bounded contract fixture",
			source,
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: [],
		});
		expect(request.source).toEqual(source);
	});

	it("publishes stable multi-service admission errors", () => {
		expect(MultiServiceAdmissionErrorCodeV1Schema.options).toEqual([
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
	});
});
