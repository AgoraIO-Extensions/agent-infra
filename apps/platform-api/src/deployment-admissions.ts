import { createHash, randomUUID } from "node:crypto";
import {
	DeploymentConfigurationProjectionV2Schema,
	MultiServiceAgentSourceV1Schema,
	MultiServiceManifestDocumentV1Schema,
	MultiServiceResourceCapV1Schema,
	MultiServiceResourceProfileAnnotationV1,
	MultiServiceResourceProfileV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	ImmutableOciDigestV1Schema,
	OciImageReferenceV1Schema,
} from "@agent-infra/contracts/workload";
import { createOciImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import {
	assertCodexModelProfilesV1,
	type CodexModelProfileV1,
	createDeploymentModelCatalogAdapterV1,
	ModelCatalogSnapshotV1Schema,
	ModelConfigurationErrorV1,
	modelIdentifier,
	modelOperationV1,
	type StandardTemplateModelBindingV1,
	standardTemplateDefinitionsV1,
	standardTemplateReadinessV1,
	validateCodexModelProfilesV1,
} from "@agent-infra/model-catalog";
import {
	type AgentConfigurationModelAdmissionPortV2,
	type AgentConfigurationModelV2,
	type AgentConfigurationRecordV2,
	type AgentConfigurationSecretMetadataV1,
	type AgentConfigurationSourceV1,
	type AgentConfigurationUseCaseDependenciesV1,
	type ApiPrincipalV1,
	captureAgentApiCreatePrincipalsV1,
	parseAgentConfigurationChangesV1,
} from "@agent-infra/platform-core";
import { parseAllDocuments } from "yaml";
import type { z } from "zod";
import {
	type DeploymentDiagnosticV1,
	withDeploymentDiagnosticV1,
} from "./deployment-diagnostic.js";
import type { IdentityContext } from "./http/identity.js";

type Admissions = Pick<
	AgentConfigurationUseCaseDependenciesV1,
	"imageAdmission" | "modelAdmission" | "secretAdmission" | "channelAdmission"
> & { readonly keylessModelAdmission: AgentConfigurationModelAdmissionPortV2 };
type StandardSource = Extract<AgentConfigurationSourceV1, { kind: "standard" }>;
type Template = DeploymentAdmissionInputV1["templates"][number];
type DeploymentTemplateProjectionV2 = z.infer<
	typeof DeploymentConfigurationProjectionV2Schema
>["templates"][number];

export type MultiServiceResourceProfileV1 = z.infer<
	typeof MultiServiceResourceProfileV1Schema
>;
export type MultiServiceResourceCapV1 = z.infer<
	typeof MultiServiceResourceCapV1Schema
>;

/** Conservative defaults keep legacy manifests deployable without a bespoke profile. */
export const defaultMultiServiceResourceProfileV1 = {
	profileId: "default",
	displayName: "Default multi-service",
	estimatedResources: { cpuMillicores: 100, memoryMiB: 128, storageGiB: 1 },
	resources: {
		requests: { cpu: "25m", memory: "32Mi" },
		limits: { cpu: "100m", memory: "128Mi" },
	},
	storageSize: "1Gi",
} satisfies MultiServiceResourceProfileV1;
export const defaultMultiServiceResourceCapV1 = {
	cpuMillicores: 2_000,
	memoryMiB: 4_096,
	storageGiB: 20,
} satisfies MultiServiceResourceCapV1;

export interface DeploymentAdmissionInputV1 {
	/** The fixed repository used by this deployment's Workload policy, when applicable. */
	readonly imageRepository?: string;
	/** Re-resolves the current request's authenticated identity; never a browser identity field. */
	readonly currentIdentity?: (traceId: string) => Promise<IdentityContext>;
	/** Bound inside the authenticated creation transaction, never supplied by the request. */
	readonly currentApiPrincipal?: () => Promise<ApiPrincipalV1>;
	readonly registry: Parameters<typeof createOciImageRegistryAdapterV1>[0] & {
		readonly admissionPolicyRef: string;
	};
	readonly templates: readonly (Pick<
		StandardSource,
		| "templateId"
		| "imageDigest"
		| "allowedEnvironmentKeys"
		| "allowedSecretKeys"
		| "platformManagedKeys"
		| "connectionEnabled"
	> & {
		readonly imageReference: string;
		readonly displayName?: string;
		readonly modelBinding?: StandardTemplateModelBindingV1;
		/** Deployment-owned profiles read from the exact pinned Codex image. */
		readonly codexModelProfiles?: readonly CodexModelProfileV1[];
		readonly configurationRevision?: string;
		readonly loadValidation?: (signal: AbortSignal) => Promise<unknown>;
	})[];
	readonly modelCatalog: {
		readonly revision: string;
		readonly load: (signal: AbortSignal) => Promise<unknown>;
	};
	readonly channelPolicy: {
		readonly revision: string;
		/** A binding is registered for one Agent and explicitly authorized request actors. */
		readonly bindings: readonly (AgentConfigurationRecordV2["channels"][number] & {
			readonly agentId: string;
			readonly actorIds: readonly string[];
		})[];
	};
	/** Profiles and the aggregate cap are deployment-owned; omitted values use safe defaults. */
	readonly multiServiceResourceProfiles?: readonly MultiServiceResourceProfileV1[];
	readonly multiServiceResourceCap?: MultiServiceResourceCapV1;
}

function revision(prefix: string, value: unknown) {
	return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function snapshotTemplates(templates: readonly Template[]) {
	return templates.map(({ loadValidation, ...registration }) => ({
		...structuredClone(registration),
		...(loadValidation ? { loadValidation } : {}),
	}));
}

async function readTemplateReadiness(template: Template) {
	if (!template.loadValidation)
		return { state: "unverified" as const, revision: null };
	try {
		const signal = AbortSignal.timeout(10_000);
		const loadValidation = template.loadValidation;
		if (!loadValidation)
			return { state: "unverified" as const, revision: null };
		const validation = await modelOperationV1(signal, () =>
			loadValidation(signal),
		);
		const readiness = standardTemplateReadinessV1({
			templateId: template.templateId,
			imageDigest: template.imageDigest,
			binding: template.modelBinding,
			configurationRevision: template.configurationRevision,
			validation,
			now: Date.now(),
		});
		return readiness.state === "ready"
			? {
					...readiness,
					revision: revision("template", {
						registration: {
							templateId: template.templateId,
							imageDigest: template.imageDigest,
							modelBinding: template.modelBinding,
							codexModelProfiles: template.codexModelProfiles,
							configurationRevision: template.configurationRevision,
						},
						validation: readiness.revision,
					}),
				}
			: readiness;
	} catch {
		return { state: "unavailable" as const, revision: null };
	}
}

/**
 * Read-only choices for the browser. This reads the same deployment inputs and
 * catalog snapshot used by admission; it never returns image, URL, or secret
 * material and does not become an authorization source.
 */
export function createDeploymentConfigurationProjectionV2(input: {
	readonly templates: DeploymentAdmissionInputV1["templates"];
	readonly modelCatalog: DeploymentAdmissionInputV1["modelCatalog"];
	readonly multiServiceResourceProfiles?: readonly MultiServiceResourceProfileV1[];
	readonly multiServiceResourceCap?: MultiServiceResourceCapV1;
}) {
	const templates = snapshotTemplates(input.templates);
	const loadModelCatalog = input.modelCatalog.load;
	const configuredProfiles = input.multiServiceResourceProfiles ?? [];
	const multiServiceResourceProfiles = [
		defaultMultiServiceResourceProfileV1,
		...configuredProfiles,
	];
	const multiServiceResourceCap =
		input.multiServiceResourceCap ?? defaultMultiServiceResourceCapV1;
	return async () => {
		const templateOptions: DeploymentTemplateProjectionV2[] = await Promise.all(
			templates.map(async (template) => ({
				templateId: template.templateId,
				displayName:
					template.displayName ??
					standardTemplateDefinitionsV1.find(
						(standard) =>
							standard.driver === template.modelBinding?.driver ||
							standard.templateId === template.templateId,
					)?.displayName ??
					template.templateId,
				connectionEnabled: template.connectionEnabled,
				allowedEnvironmentKeys: [...template.allowedEnvironmentKeys],
				allowedSecretKeys: [...template.allowedSecretKeys],
				readiness: await readTemplateReadiness(template),
			})),
		);
		for (const standard of standardTemplateDefinitionsV1) {
			if (
				!templates.some(
					(template) =>
						template.modelBinding?.driver === standard.driver ||
						template.templateId === standard.templateId,
				)
			) {
				templateOptions.push({
					templateId: standard.templateId,
					displayName: standard.displayName,
					connectionEnabled: false,
					allowedEnvironmentKeys: [],
					allowedSecretKeys: [],
					readiness: { state: "unregistered" as const, revision: null },
				});
			}
		}
		let catalogStatus: "populated" | "empty" | "unavailable" | "stale";
		let catalogRevision: string | null = null;
		let endpoints: Array<{
			endpointId: string;
			displayName: string;
			models: Array<{ modelId: string; reasoningLevels: string[] }>;
		}> = [];
		const signal = AbortSignal.timeout(10_000);
		try {
			const snapshot = ModelCatalogSnapshotV1Schema.parse(
				await modelOperationV1(signal, () => loadModelCatalog(signal)),
			);
			catalogRevision = snapshot.revision;
			if (
				snapshot.revision !== input.modelCatalog.revision ||
				snapshot.validUntil <= Date.now()
			) {
				catalogStatus = "stale";
			} else {
				endpoints = snapshot.endpoints
					.filter((endpoint) => endpoint.available)
					.map((endpoint) => ({
						endpointId: endpoint.endpointId,
						displayName: endpoint.endpointId,
						models: (endpoint.allowedModels ?? []).map((modelId) => ({
							modelId,
							reasoningLevels: [...endpoint.capabilities.reasoningLevels],
						})),
					}));
				catalogStatus = endpoints.some((endpoint) => endpoint.models.length > 0)
					? "populated"
					: "empty";
			}
		} catch {
			catalogStatus = "unavailable";
		}
		const status =
			catalogStatus === "unavailable" || catalogStatus === "stale"
				? catalogStatus
				: templates.length > 0 || catalogStatus === "populated"
					? "populated"
					: "empty";
		return DeploymentConfigurationProjectionV2Schema.parse({
			schemaVersion: 2,
			status,
			templates: templateOptions,
			modelCatalog: {
				status: catalogStatus,
				revision: catalogRevision,
				endpoints,
			},
			multiServiceResourceProfiles: multiServiceResourceProfiles.map(
				({ resources: _resources, ...profile }) => profile,
			),
			multiServiceResourceCap,
			multiServiceResourceDefaultProfileRef:
				defaultMultiServiceResourceProfileV1.profileId,
			multiServiceResourceProfilesSource:
				configuredProfiles.length > 0 ? "deployment" : "default",
		});
	};
}

function repositoryOf(imageReference: string) {
	const name = imageReference.split("@")[0] ?? "";
	const separator = name.lastIndexOf(":");
	return separator > name.lastIndexOf("/") ? name.slice(0, separator) : name;
}

function parseMultiServiceManifest(input: string) {
	try {
		const documents = parseAllDocuments(input, {
			prettyErrors: false,
			maxAliasCount: 0,
		} as never);
		if (documents.length !== 1 || documents[0]?.errors.length) return null;
		return MultiServiceManifestDocumentV1Schema.parse(documents[0]?.toJSON());
	} catch {
		return null;
	}
}

function multiServiceImageDigests(
	manifest: ReturnType<typeof MultiServiceManifestDocumentV1Schema.parse>,
) {
	return [
		...new Set(
			manifest.resources.flatMap((resource) => {
				if (
					resource.kind === "Deployment" ||
					resource.kind === "StatefulSet" ||
					resource.kind === "Job"
				)
					return resource.spec.template.spec.containers.map(
						(container) => container.image,
					);
				return [];
			}),
		),
	];
}

function validMultiServiceTopology(
	manifest: ReturnType<typeof MultiServiceManifestDocumentV1Schema.parse>,
): boolean {
	const deployments = manifest.resources.filter(
		(resource) => resource.kind === "Deployment",
	);
	const services = manifest.resources.filter(
		(resource) => resource.kind === "Service",
	);
	if (
		manifest.resources.length !== 4 ||
		deployments.length !== 2 ||
		services.length !== 2 ||
		manifest.resources.some(
			(resource) =>
				resource.kind !== "Deployment" && resource.kind !== "Service",
		)
	)
		return false;
	return services.every((service) => {
		const target = deployments.find((deployment) =>
			Object.entries(service.spec.selector).every(
				([key, expected]) =>
					deployment.spec.template.metadata.labels[key] === expected,
			),
		);
		if (!target) return false;
		return service.spec.ports.every((servicePort) =>
			target.spec.template.spec.containers.some((container) =>
				container.ports?.some(
					(containerPort) =>
						containerPort.targetPort === servicePort.targetPort,
				),
			),
		);
	});
}

function multiServiceProfileRef(resource: {
	readonly metadata: {
		readonly annotations?: Readonly<Record<string, string>>;
	};
}) {
	return (
		resource.metadata.annotations?.[MultiServiceResourceProfileAnnotationV1] ??
		defaultMultiServiceResourceProfileV1.profileId
	);
}

function serviceSelectsWorkload(
	service: Extract<
		ReturnType<
			typeof MultiServiceManifestDocumentV1Schema.parse
		>["resources"][number],
		{ kind: "Service" }
	>,
	workload: Extract<
		ReturnType<
			typeof MultiServiceManifestDocumentV1Schema.parse
		>["resources"][number],
		{ kind: "Deployment" | "StatefulSet" }
	>,
) {
	return Object.entries(service.spec.selector).every(
		([key, expected]) =>
			workload.spec.template.metadata.labels[key] === expected,
	);
}

/** Resolve profile refs and sum one replica of every workload before side effects. */
export function calculateMultiServiceResourceCapacityV1(input: {
	readonly manifest: ReturnType<
		typeof MultiServiceManifestDocumentV1Schema.parse
	>;
	readonly profiles?: readonly MultiServiceResourceProfileV1[];
	readonly cap?: MultiServiceResourceCapV1;
}) {
	const profiles = [
		defaultMultiServiceResourceProfileV1,
		...(input.profiles ?? []),
	];
	const byId = new Map<string, MultiServiceResourceProfileV1>();
	for (const candidate of profiles) {
		const parsed = MultiServiceResourceProfileV1Schema.safeParse(candidate);
		if (parsed.success) byId.set(candidate.profileId, candidate);
	}
	const cap = input.cap ?? defaultMultiServiceResourceCapV1;
	let total = { cpuMillicores: 0, memoryMiB: 0, storageGiB: 0 };
	for (const resource of input.manifest.resources) {
		if (
			resource.kind !== "Deployment" &&
			resource.kind !== "StatefulSet" &&
			resource.kind !== "Job"
		)
			continue;
		const service =
			resource.kind === "Job"
				? undefined
				: (input.manifest.resources.find(
						(candidate) =>
							candidate.kind === "Service" &&
							serviceSelectsWorkload(candidate, resource),
					) ?? undefined);
		const profileRef =
			resource.metadata.annotations?.[
				MultiServiceResourceProfileAnnotationV1
			] ??
			(service ? multiServiceProfileRef(service) : undefined) ??
			defaultMultiServiceResourceProfileV1.profileId;
		const profile = byId.get(profileRef);
		if (!profile)
			return {
				ok: false as const,
				reason: "unknown_profile" as const,
				profileRef,
			};
		total = {
			cpuMillicores:
				total.cpuMillicores + profile.estimatedResources.cpuMillicores,
			memoryMiB: total.memoryMiB + profile.estimatedResources.memoryMiB,
			storageGiB: total.storageGiB + profile.estimatedResources.storageGiB,
		};
	}
	return {
		ok:
			total.cpuMillicores <= cap.cpuMillicores &&
			total.memoryMiB <= cap.memoryMiB &&
			total.storageGiB <= cap.storageGiB,
		total,
		cap,
	};
}

function replacement(
	current?: AgentConfigurationSecretMetadataV1,
): AgentConfigurationSecretMetadataV1 {
	const version = current ? current.version + 1 : 1;
	if (!Number.isSafeInteger(version) || version < 1) throw new Error();
	return { secretId: current?.secretId ?? randomUUID(), version, isSet: true };
}

function correlation(input: {
	readonly agentId: string;
	readonly requestId: string;
}) {
	return {
		schemaVersion: 1 as const,
		agentId: input.agentId,
		requestId: input.requestId,
	};
}

export function createDeploymentAdmissionsV1(
	input: DeploymentAdmissionInputV1,
): Admissions {
	let registry: ReturnType<typeof createOciImageRegistryAdapterV1>;
	let templates: DeploymentAdmissionInputV1["templates"];
	let channels: DeploymentAdmissionInputV1["channelPolicy"];
	let multiServiceResourceProfiles: readonly MultiServiceResourceProfileV1[];
	let multiServiceResourceCap: MultiServiceResourceCapV1;
	// 只记录可安全输出的原因码与模板 ID，供启动日志定位（#2382）。
	let diagnostic: DeploymentDiagnosticV1 | undefined;
	try {
		if (
			!input.registry.admissionPolicyRef ||
			!modelIdentifier.safeParse(input.modelCatalog.revision).success ||
			!input.channelPolicy.revision ||
			(typeof input.currentIdentity !== "function" &&
				typeof input.currentApiPrincipal !== "function") ||
			(input.currentIdentity !== undefined &&
				input.currentApiPrincipal !== undefined) ||
			typeof input.modelCatalog.load !== "function"
		)
			throw new Error();
		templates = snapshotTemplates(input.templates);
		channels = structuredClone(input.channelPolicy);
		multiServiceResourceProfiles = [
			defaultMultiServiceResourceProfileV1,
			...(input.multiServiceResourceProfiles ?? []),
		].map((profile) => MultiServiceResourceProfileV1Schema.parse(profile));
		if (
			new Set(multiServiceResourceProfiles.map((profile) => profile.profileId))
				.size !== multiServiceResourceProfiles.length
		)
			throw new Error();
		multiServiceResourceCap = MultiServiceResourceCapV1Schema.parse(
			input.multiServiceResourceCap ?? defaultMultiServiceResourceCapV1,
		);
		if (
			new Set(templates.map(({ templateId }) => templateId)).size !==
			templates.length
		)
			throw new Error();
		const drivers = templates.flatMap((template) =>
			template.modelBinding ? [template.modelBinding.driver] : [],
		);
		if (new Set(drivers).size !== drivers.length) throw new Error();
		for (const template of templates) {
			const standard = standardTemplateDefinitionsV1.find(
				(item) => item.templateId === template.templateId,
			);
			if (
				standard &&
				template.modelBinding &&
				standard.driver !== template.modelBinding.driver
			)
				throw new Error();
			if (template.modelBinding?.driver === "codex") {
				diagnostic = {
					reason:
						template.codexModelProfiles === undefined
							? "codex_model_profiles_missing"
							: "codex_model_profiles_invalid",
					templateId: template.templateId,
				};
				validateCodexModelProfilesV1(template.codexModelProfiles);
				diagnostic = undefined;
			} else if (template.codexModelProfiles !== undefined) {
				diagnostic = {
					reason: "codex_model_profiles_unexpected",
					templateId: template.templateId,
				};
				throw new Error();
			}
			if (
				!template.templateId ||
				!ImmutableOciDigestV1Schema.safeParse(template.imageDigest).success ||
				!OciImageReferenceV1Schema.safeParse(template.imageReference).success ||
				template.imageReference.split("@")[1] !== template.imageDigest ||
				(input.imageRepository !== undefined &&
					repositoryOf(template.imageReference) !== input.imageRepository)
			)
				throw new Error();
			for (const names of [
				template.allowedEnvironmentKeys,
				template.allowedSecretKeys,
				template.platformManagedKeys,
			]) {
				if (
					!Array.isArray(names) ||
					new Set(names).size !== names.length ||
					names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
				)
					throw new Error();
			}
			if (typeof template.connectionEnabled !== "boolean") throw new Error();
			if (
				template.displayName !== undefined &&
				(typeof template.displayName !== "string" ||
					template.displayName.length < 1 ||
					template.displayName.length > 256)
			)
				throw new Error();
		}
		if (
			new Set(
				channels.bindings.map(
					(binding) => `${binding.kind}\0${binding.bindingReference}`,
				),
			).size !== channels.bindings.length ||
			channels.bindings.some(
				(binding) =>
					!["wecom_bot", "wecom_app"].includes(binding.kind) ||
					!binding.bindingReference ||
					!binding.agentId ||
					!binding.actorIds.length ||
					binding.actorIds.some((actorId) => !actorId),
			)
		)
			throw new Error();
		registry = createOciImageRegistryAdapterV1(input.registry);
	} catch {
		const error = new Error(
			"PLATFORM_DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID",
		);
		throw diagnostic ? withDeploymentDiagnosticV1(error, diagnostic) : error;
	}
	const modelCatalogRevision = input.modelCatalog.revision;
	const loadModelCatalog = input.modelCatalog.load;
	const admissionPolicyRef = input.registry.admissionPolicyRef;
	const currentIdentity = input.currentIdentity;
	const currentApiPrincipal = input.currentApiPrincipal;
	const imageRepository = input.imageRepository;
	function codexModelProfilesFor(
		source: AgentConfigurationSourceV1 | undefined,
	): readonly CodexModelProfileV1[] | null | undefined {
		if (source?.kind !== "standard") return undefined;
		if (
			standardTemplateDefinitionsV1.find(
				(template) => template.templateId === source.templateId,
			)?.driver !== "codex"
		)
			return undefined;
		const template = templates.find(
			(item) =>
				item.templateId === source.templateId &&
				item.imageDigest === source.imageDigest,
		);
		return template?.modelBinding?.driver === "codex"
			? (template.codexModelProfiles ?? null)
			: null;
	}
	async function resolveSubjectRef(traceId: string) {
		try {
			if (currentApiPrincipal) {
				const principal = captureAgentApiCreatePrincipalsV1([
					await currentApiPrincipal(),
				])[0];
				if (!principal) throw new Error();
				return revision("api-subject", {
					kind: principal.kind,
					id: principal.id,
				});
			}
			const actor = await currentIdentity?.(traceId);
			if (
				actor?.schemaVersion !== 1 ||
				actor.accountStatus !== "active" ||
				!actor.userId ||
				/^api-subject-[a-f0-9]{64}$/.test(actor.userId) ||
				!actor.authorizationRevision
			)
				throw new Error();
			return actor.userId;
		} catch {
			throw new Error("PLATFORM_DEPLOYMENT_IDENTITY_UNAVAILABLE");
		}
	}
	const keylessModelAdmission: AgentConfigurationModelAdmissionPortV2 = {
		async admitModels(request) {
			try {
				const signal = AbortSignal.timeout(10_000);
				const snapshot = ModelCatalogSnapshotV1Schema.parse(
					await modelOperationV1(signal, () => loadModelCatalog(signal)),
				);
				if (
					snapshot.revision !== modelCatalogRevision ||
					snapshot.validUntil <= Date.now()
				)
					return null;
				const codexModelProfiles = codexModelProfilesFor(request.source);
				if (request.source?.kind === "standard" && codexModelProfiles) {
					try {
						assertCodexModelProfilesV1({
							profiles: codexModelProfiles,
							options: request.requested.options,
						});
					} catch (error) {
						if (
							error instanceof ModelConfigurationErrorV1 &&
							error.reason === "codex_model_profile_unsupported"
						)
							return {
								status: "rejected",
								reason: "codex_model_profile_unsupported",
							};
						return null;
					}
				} else if (
					request.source?.kind === "standard" &&
					codexModelProfiles === null
				) {
					return null;
				}
				const options: AgentConfigurationModelV2["options"][number][] = [];
				for (const option of request.requested.options) {
					const endpoint = snapshot.endpoints.find(
						(candidate) => candidate.endpointId === option.endpointId,
					);
					if (
						!endpoint?.available ||
						(endpoint.allowedModels !== null &&
							!endpoint.allowedModels.includes(option.modelId)) ||
						option.reasoningLevels.some(
							(level) => !endpoint.capabilities.reasoningLevels.includes(level),
						)
					)
						return null;
					options.push({
						optionId: option.optionId,
						endpointId: option.endpointId,
						modelId: option.modelId,
						reasoningLevels: [...option.reasoningLevels].toSorted(),
					});
				}
				return {
					catalogRevision: snapshot.revision,
					options,
					defaultOptionId: request.requested.defaultOptionId,
					defaultReasoningLevel: request.requested.defaultReasoningLevel,
				};
			} catch {
				return null;
			}
		},
	};
	return {
		keylessModelAdmission,
		imageAdmission: {
			async admitImage(request) {
				const subjectRef = await resolveSubjectRef(request.traceId);
				const denied = { ...correlation(request), status: "rejected" as const };
				const selection = parseAgentConfigurationChangesV1({
					source: request.requested,
				}).source;
				if (!selection) return denied;
				if ("manifest" in selection) {
					if (!MultiServiceAgentSourceV1Schema.safeParse(selection).success)
						return denied;
					const multiServiceManifest = parseMultiServiceManifest(
						selection.manifest,
					);
					if (
						!multiServiceManifest ||
						!imageRepository ||
						!validMultiServiceTopology(multiServiceManifest)
					)
						return denied;
					const capacity = calculateMultiServiceResourceCapacityV1({
						manifest: multiServiceManifest,
						profiles: multiServiceResourceProfiles,
						cap: multiServiceResourceCap,
					});
					if (!capacity.ok) return denied;
					const deployments = multiServiceManifest.resources.filter(
						(resource) => resource.kind === "Deployment",
					);
					const services = multiServiceManifest.resources.filter(
						(resource) => resource.kind === "Service",
					);
					if (deployments.length !== 2 || services.length !== 2) return denied;
					const digests = multiServiceImageDigests(multiServiceManifest);
					if (digests.length < 1) return denied;
					const admittedImages = await Promise.all(
						digests.map(async (digest) => {
							const result = await registry.admitDigest(
								{
									...correlation(request),
									traceId: request.traceId,
									subjectRef,
									imageReference: `${imageRepository}@${digest}`,
									usage: "custom-agent",
									admissionPolicyRef,
								},
								{ signal: AbortSignal.timeout(30_000) },
							);
							if (result.status !== "admitted") return null;
							return result.policyEvidence;
						}),
					);
					if (admittedImages.some((result) => result === null)) return denied;
					const canonicalManifest = JSON.stringify(multiServiceManifest);
					const imageDigest = `sha256:${createHash("sha256")
						.update(canonicalManifest)
						.digest("hex")}`;
					return {
						...correlation(request),
						status: "admitted",
						source: {
							kind: "custom",
							imageDigest,
							admissionRevision: revision("multi-service", {
								digests,
								admissions: admittedImages,
							}),
							interactionMode: "self-managed",
							identityResponsibility: "self-managed",
							connectionEnabled: false,
							manifest: selection.manifest,
						},
					};
				}
				const template =
					selection.kind === "standard"
						? templates.find((item) => item.templateId === selection.templateId)
						: undefined;
				if (selection.kind === "standard" && !template) return denied;
				const readinessRequired =
					selection.kind === "standard" &&
					standardTemplateDefinitionsV1.some(
						(standard) => standard.templateId === selection.templateId,
					);
				const readiness = template
					? await readTemplateReadiness(template)
					: undefined;
				if (
					readinessRequired &&
					(readiness?.state !== "ready" ||
						(selection.templateRevision !== undefined &&
							selection.templateRevision !== readiness.revision))
				)
					return denied;
				const imageReference =
					selection.kind === "custom"
						? selection.imageReference
						: template?.imageReference;
				if (!imageReference) return denied;
				if (
					imageRepository !== undefined &&
					repositoryOf(imageReference) !== imageRepository
				)
					return denied;
				const result = await registry.admit(
					{
						...correlation(request),
						traceId: request.traceId,
						subjectRef,
						imageReference,
						usage:
							selection.kind === "standard"
								? "standard-template"
								: "custom-agent",
						admissionPolicyRef,
					},
					{ signal: AbortSignal.timeout(30_000) },
				);
				if (result.status !== "admitted") return denied;
				const manifest = result.runtimeManifest;
				if (selection.kind === "standard") {
					if (!template) return denied;
					const currentReadiness = await readTemplateReadiness(template);
					if (
						(readinessRequired &&
							(currentReadiness.state !== "ready" ||
								currentReadiness.revision !== readiness?.revision)) ||
						result.immutableDigest !== template.imageDigest ||
						manifest.interactionMode !== "platform-adapter" ||
						(template.connectionEnabled &&
							manifest.capabilities?.connection !== true)
					)
						return denied;
					return {
						...correlation(request),
						status: "admitted",
						source: {
							kind: "standard",
							templateId: template.templateId,
							imageDigest: result.immutableDigest,
							admissionRevision: revision("image", {
								evidence: result.policyEvidence,
								template,
								readinessRevision: currentReadiness.revision,
							}),
							allowedEnvironmentKeys: [...template.allowedEnvironmentKeys],
							allowedSecretKeys: [...template.allowedSecretKeys],
							platformManagedKeys: [...template.platformManagedKeys],
							connectionEnabled: template.connectionEnabled,
						},
					};
				}
				if (manifest.interactionMode !== selection.interactionMode)
					return denied;
				return {
					...correlation(request),
					status: "admitted",
					source: {
						kind: "custom",
						imageDigest: result.immutableDigest,
						admissionRevision: revision("image", result.policyEvidence),
						interactionMode: manifest.interactionMode,
						...(selection.interactionMode === "self-managed"
							? { identityResponsibility: selection.identityResponsibility }
							: {}),
						connectionEnabled:
							manifest.interactionMode === "platform-adapter" &&
							manifest.capabilities?.connection === true,
					},
				};
			},
		},
		modelAdmission: {
			async admitModels(request) {
				await resolveSubjectRef(request.traceId);
				const denied = { ...correlation(request), status: "rejected" as const };
				const requested = parseAgentConfigurationChangesV1({
					modelConfiguration: request.requested,
				}).modelConfiguration;
				if (!requested) return denied;
				const signal = AbortSignal.timeout(10_000);
				try {
					// Resolve every option from one actual snapshot, retaining its deployment revision.
					const snapshot = structuredClone(
						await modelOperationV1(signal, () => loadModelCatalog(signal)),
					);
					const catalog = createDeploymentModelCatalogAdapterV1({
						load: async () => snapshot,
					});
					const codexModelProfiles = codexModelProfilesFor(request.source);
					if (request.source?.kind === "standard" && codexModelProfiles) {
						assertCodexModelProfilesV1({
							profiles: codexModelProfiles,
							options: request.requested.options,
						});
					} else if (
						request.source?.kind === "standard" &&
						codexModelProfiles === null
					) {
						return denied;
					}
					const options = [];
					for (const option of requested.options) {
						const endpoint = await catalog.resolve(
							{
								endpointId: option.endpointId,
								catalogRevision: modelCatalogRevision,
							},
							{ signal },
						);
						if (
							(endpoint.allowedModels !== null &&
								!endpoint.allowedModels.includes(option.modelId)) ||
							option.reasoningLevels.some(
								(level) =>
									!endpoint.capabilities.reasoningLevels.includes(level),
							)
						)
							return denied;
						const current = request.current?.options.find(
							(item) => item.optionId === option.optionId,
						)?.credential;
						const credential = option.replaceCredential
							? replacement(current)
							: current;
						if (!credential?.isSet) return denied;
						options.push({
							optionId: option.optionId,
							endpointId: option.endpointId,
							modelId: option.modelId,
							reasoningLevels: [...option.reasoningLevels],
							credential: { ...credential },
						});
					}
					return {
						...correlation(request),
						status: "admitted",
						configuration: {
							catalogRevision: modelCatalogRevision,
							options,
							defaultOptionId: requested.defaultOptionId,
							defaultReasoningLevel: requested.defaultReasoningLevel,
						},
					};
				} catch (error) {
					if (
						error instanceof ModelConfigurationErrorV1 &&
						error.reason === "codex_model_profile_unsupported"
					)
						return {
							...denied,
							reason: "codex_model_profile_unsupported",
						};
					if (error instanceof ModelConfigurationErrorV1 && !error.retryable)
						return denied;
					throw new Error("PLATFORM_DEPLOYMENT_MODEL_ADMISSION_UNAVAILABLE");
				}
			},
		},
		secretAdmission: {
			async admitSecrets(request) {
				await resolveSubjectRef(request.traceId);
				const requested =
					parseAgentConfigurationChangesV1({ secrets: request.requested })
						.secrets ?? [];
				return {
					...correlation(request),
					status: "admitted",
					secrets: requested.map(({ name }) => ({
						name,
						...replacement(request.current.find((item) => item.name === name)),
					})),
				};
			},
		},
		channelAdmission: {
			async admitChannels(request) {
				const subjectRef = await resolveSubjectRef(request.traceId);
				const requested =
					parseAgentConfigurationChangesV1({ channels: request.requested })
						.channels ?? [];
				const selected = new Map(
					request.current.map((channel) => [channel.kind, channel]),
				);
				for (const change of requested) {
					if (change.enabled)
						selected.set(change.kind, {
							kind: change.kind,
							bindingReference: change.bindingReference,
						});
					else selected.delete(change.kind);
				}
				const bindings = [...selected.values()].toSorted((left, right) =>
					left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
				);
				if (
					bindings.some(
						(binding) =>
							!channels.bindings.some(
								(registered) =>
									registered.kind === binding.kind &&
									registered.bindingReference === binding.bindingReference &&
									registered.agentId === request.agentId &&
									registered.actorIds.includes(subjectRef),
							),
					)
				)
					return { ...correlation(request), status: "rejected" };
				return {
					...correlation(request),
					status: "admitted",
					channels: bindings,
					channelRevision: revision("channels", {
						policy: channels,
						agentId: request.agentId,
						bindings,
					}),
				};
			},
		},
	};
}
