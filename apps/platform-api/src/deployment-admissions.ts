import { createHash, randomUUID } from "node:crypto";
import {
	calculateMultiServiceResourceCapacityV1,
	DeploymentConfigurationProjectionV2Schema,
	defaultMultiServiceResourceProfileV1,
	MultiServiceAgentSourceV1Schema,
	MultiServiceManifestDocumentV1Schema,
	MultiServiceMaxWorkloadsV1,
	type MultiServiceResourceCapV1,
	type MultiServiceResourceConfigurationV1,
	type MultiServiceResourceProfileV1,
	parseMultiServiceResourceConfigurationV1,
	validateMultiServiceTopologyV1,
} from "@agent-infra/contracts/pilot";
import {
	ImmutableOciDigestV1Schema,
	OciImageReferenceV1Schema,
} from "@agent-infra/contracts/workload";
import { createOciImageRegistryAdapterV1 } from "@agent-infra/image-registry";
import {
	createDeploymentModelCatalogAdapterV1,
	ModelCatalogSnapshotV1Schema,
	ModelConfigurationErrorV1,
	modelIdentifier,
	modelOperationV1,
	type StandardTemplateModelBindingV1,
	standardTemplateDefinitionsV1,
	standardTemplateReadinessV1,
	standardTemplateReasoningLevelsV1,
	validateStandardTemplateModelBindingsV1,
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
		/**
		 * ADR-0029 之前要求填写的模型画像。现在兼容读取并忽略：模型与档位由默认 Key 的
		 * `/models` 和保存时的真实请求判定，不再按镜像登记。
		 */
		readonly codexModelProfiles?: unknown;
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
	/**
	 * 多服务档位与单 Agent 总量上限由部署配置提供，必须与 Worker 的
	 * `workloadInput.policy` 保持一致；省略时使用合约默认值。
	 */
	readonly multiServiceResourceProfiles?: readonly MultiServiceResourceProfileV1[];
	readonly multiServiceResourceCap?: MultiServiceResourceCapV1;
	/**
	 * 部署是否提供平台身份入口（自有交互入口由平台校验身份，#3034）。由部署装配按是否
	 * 配置 Auth Gateway 推导，必须与 Worker 的 `platformAuthAnnotations` 一致；省略时视为
	 * 未提供，相应申请在镜像准入前失败关闭。
	 */
	readonly platformIdentityEntryAvailable?: boolean;
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

function parseMultiServiceResourceConfiguration(input: {
	readonly multiServiceResourceProfiles?: readonly MultiServiceResourceProfileV1[];
	readonly multiServiceResourceCap?: MultiServiceResourceCapV1;
}): MultiServiceResourceConfigurationV1 {
	try {
		return parseMultiServiceResourceConfigurationV1({
			profiles: input.multiServiceResourceProfiles,
			cap: input.multiServiceResourceCap,
		});
	} catch {
		throw new Error("PLATFORM_DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID");
	}
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
	const multiServiceResources = parseMultiServiceResourceConfiguration(input);
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
							// ADR-0029：标准模板的档位是平台固定集合，不取端点登记的档位。
							reasoningLevels: [...standardTemplateReasoningLevelsV1],
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
			multiServiceResourceProfiles: multiServiceResources.profiles.map(
				({ resources: _resources, ...profile }) => profile,
			),
			multiServiceResourceCap: multiServiceResources.cap,
			multiServiceResourceDefaultProfileRef:
				defaultMultiServiceResourceProfileV1.profileId,
			multiServiceResourceProfilesSource: multiServiceResources.source,
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
	return validateMultiServiceTopologyV1(manifest).ok;
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
	let multiServiceResources: MultiServiceResourceConfigurationV1;
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
			typeof input.modelCatalog.load !== "function" ||
			(input.platformIdentityEntryAvailable !== undefined &&
				typeof input.platformIdentityEntryAvailable !== "boolean")
		)
			throw new Error();
		templates = snapshotTemplates(input.templates);
		channels = structuredClone(input.channelPolicy);
		multiServiceResources = parseMultiServiceResourceConfiguration(input);
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
			if (
				!template.templateId ||
				!ImmutableOciDigestV1Schema.safeParse(template.imageDigest).success ||
				!OciImageReferenceV1Schema.safeParse(template.imageReference).success ||
				template.imageReference.split("@")[1] !== template.imageDigest ||
				(input.imageRepository !== undefined &&
					template.modelBinding?.imageRepository === undefined &&
					repositoryOf(template.imageReference) !== input.imageRepository)
			)
				throw new Error();
			if (template.modelBinding?.imageRepository !== undefined) {
				validateStandardTemplateModelBindingsV1([template.modelBinding]);
				if (
					template.modelBinding.templateId !== template.templateId ||
					template.modelBinding.imageDigest !== template.imageDigest
				)
					throw new Error();
			}
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
	const platformIdentityEntryAvailable =
		input.platformIdentityEntryAvailable === true;
	/** A standard Codex source must match one exact trusted template/image binding. */
	function hasTrustedCodexBinding(
		source: AgentConfigurationSourceV1 | undefined,
	): boolean {
		if (source?.kind !== "standard") return true;
		if (
			standardTemplateDefinitionsV1.find(
				(template) => template.templateId === source.templateId,
			)?.driver !== "codex"
		)
			return true;
		// API and browser creation perform keyless model admission before image
		// admission. The request source therefore has the template identity but
		// does not have the immutable image digest yet. Image admission below is
		// still the authority that binds the exact digest and readiness record.
		if (!source.imageDigest) {
			return templates.some(
				(item) =>
					item.templateId === source.templateId &&
					item.modelBinding?.driver === "codex",
			);
		}
		return templates.some(
			(item) =>
				item.templateId === source.templateId &&
				item.imageDigest === source.imageDigest &&
				item.modelBinding?.driver === "codex",
		);
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
				// 标准 Codex 来源必须对应一份受信的模板/镜像绑定，否则失败关闭。
				if (!hasTrustedCodexBinding(request.source)) return null;
				// 模型与档位由默认 Key 的 `/models` 和保存时真实请求判定（ADR-0029），
				// 这里只保留端点可用与部署可选的 `allowedModels` 收窄。
				const options: AgentConfigurationModelV2["options"][number][] = [];
				for (const option of request.requested.options) {
					const endpoint = snapshot.endpoints.find(
						(candidate) => candidate.endpointId === option.endpointId,
					);
					if (
						!endpoint?.available ||
						(endpoint.allowedModels !== null &&
							!endpoint.allowedModels.includes(option.modelId))
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
					// 在镜像准入等任何外部调用前完成档位与总量校验；超限返回专用原因，
					// 由 Core 映射为 MULTI_SERVICE_RESOURCE_CAP_EXCEEDED。
					const capacity = calculateMultiServiceResourceCapacityV1({
						manifest: multiServiceManifest,
						configuration: multiServiceResources,
					});
					if (!capacity.ok)
						return capacity.reason === "cap_exceeded"
							? { ...denied, reason: "multi_service_resource_cap_exceeded" }
							: denied;
					const services = multiServiceManifest.resources.filter(
						(resource) => resource.kind === "Service",
					);
					const workloads = multiServiceManifest.resources.filter(
						(resource) =>
							resource.kind === "Deployment" || resource.kind === "StatefulSet",
					);
					if (
						workloads.length < 2 ||
						workloads.length > MultiServiceMaxWorkloadsV1 ||
						services.length !== workloads.length
					)
						return denied;
					const digests = multiServiceImageDigests(multiServiceManifest);
					if (digests.length < 1) return denied;
					const canonicalManifest = JSON.stringify(multiServiceManifest);
					if (canonicalManifest.length > 262_144) return denied;
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
					const imageDigest = `sha256:${createHash("sha256")
						.update(canonicalManifest)
						.digest("hex")}`;
					return {
						...correlation(request),
						status: "admitted",
						manifestBinding: {
							requestedSha256: createHash("sha256")
								.update(selection.manifest)
								.digest("hex"),
							canonicalSha256: imageDigest.slice("sha256:".length),
						},
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
							// Persist the parsed JSON document, never the caller's YAML bytes.
							// This makes the admitted resource set immutable and ensures that
							// equivalent YAML cannot change after admission.
							manifest: canonicalManifest,
						},
					};
				}
				// 部署没有平台身份入口时，「自有交互入口 + 平台校验」不能发布对应路由：在调用
				// Registry 之前明确拒绝，不创建申请，也不进入审批队列（#3034）。
				if (
					selection.kind === "custom" &&
					selection.interactionMode === "self-managed" &&
					selection.identityResponsibility === "platform-managed" &&
					!platformIdentityEntryAvailable
				)
					return { ...denied, reason: "platform_identity_entry_unavailable" };
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
					!(
						selection.kind === "standard" &&
						template?.modelBinding?.imageRepository !== undefined
					) &&
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
					if (!hasTrustedCodexBinding(request.source)) return denied;
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
