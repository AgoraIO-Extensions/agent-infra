import { createHash, randomUUID } from "node:crypto";
import { DeploymentConfigurationProjectionV2Schema } from "@agent-infra/contracts/pilot";
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
} from "@agent-infra/model-catalog";
import {
	type AgentConfigurationRecordV2,
	type AgentConfigurationSecretMetadataV1,
	type AgentConfigurationSourceV1,
	type AgentConfigurationUseCaseDependenciesV1,
	parseAgentConfigurationChangesV1,
} from "@agent-infra/platform-core";
import type { IdentityContext } from "./http/identity.js";

type Admissions = Pick<
	AgentConfigurationUseCaseDependenciesV1,
	"imageAdmission" | "modelAdmission" | "secretAdmission" | "channelAdmission"
>;
type StandardSource = Extract<AgentConfigurationSourceV1, { kind: "standard" }>;

export interface DeploymentAdmissionInputV1 {
	/** The fixed repository used by this deployment's Workload policy, when applicable. */
	readonly imageRepository?: string;
	/** Re-resolves the current request's authenticated identity; never a browser identity field. */
	readonly currentIdentity: (traceId: string) => Promise<IdentityContext>;
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
	> & { readonly imageReference: string; readonly displayName?: string })[];
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
}

function revision(prefix: string, value: unknown) {
	return `${prefix}-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * Read-only choices for the browser. This reads the same deployment inputs and
 * catalog snapshot used by admission; it never returns image, URL, or secret
 * material and does not become an authorization source.
 */
export function createDeploymentConfigurationProjectionV2(input: {
	readonly templates: DeploymentAdmissionInputV1["templates"];
	readonly modelCatalog: DeploymentAdmissionInputV1["modelCatalog"];
}) {
	const templates = structuredClone(input.templates);
	const loadModelCatalog = input.modelCatalog.load;
	const templateOptions = templates.map((template) => ({
		templateId: template.templateId,
		displayName: template.displayName ?? template.templateId,
		connectionEnabled: template.connectionEnabled,
		allowedEnvironmentKeys: [...template.allowedEnvironmentKeys],
		allowedSecretKeys: [...template.allowedSecretKeys],
	}));
	return async () => {
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
				: templateOptions.length > 0 || catalogStatus === "populated"
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
		});
	};
}

function repositoryOf(imageReference: string) {
	const name = imageReference.split("@")[0] ?? "";
	const separator = name.lastIndexOf(":");
	return separator > name.lastIndexOf("/") ? name.slice(0, separator) : name;
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
	try {
		if (
			!input.registry.admissionPolicyRef ||
			!modelIdentifier.safeParse(input.modelCatalog.revision).success ||
			!input.channelPolicy.revision ||
			typeof input.currentIdentity !== "function" ||
			typeof input.modelCatalog.load !== "function"
		)
			throw new Error();
		templates = structuredClone(input.templates);
		channels = structuredClone(input.channelPolicy);
		if (
			new Set(templates.map(({ templateId }) => templateId)).size !==
			templates.length
		)
			throw new Error();
		for (const template of templates) {
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
		throw new Error("PLATFORM_DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID");
	}
	const modelCatalogRevision = input.modelCatalog.revision;
	const loadModelCatalog = input.modelCatalog.load;
	const admissionPolicyRef = input.registry.admissionPolicyRef;
	const currentIdentity = input.currentIdentity;
	const imageRepository = input.imageRepository;
	async function identity(traceId: string) {
		try {
			const actor = await currentIdentity(traceId);
			if (
				actor.schemaVersion !== 1 ||
				actor.accountStatus !== "active" ||
				!actor.userId ||
				!actor.authorizationRevision
			)
				throw new Error();
			return actor;
		} catch {
			throw new Error("PLATFORM_DEPLOYMENT_IDENTITY_UNAVAILABLE");
		}
	}
	return {
		imageAdmission: {
			async admitImage(request) {
				const actor = await identity(request.traceId);
				const denied = { ...correlation(request), status: "rejected" as const };
				const selection = parseAgentConfigurationChangesV1({
					source: request.requested,
				}).source;
				if (!selection) return denied;
				const template =
					selection.kind === "standard"
						? templates.find((item) => item.templateId === selection.templateId)
						: undefined;
				if (selection.kind === "standard" && !template) return denied;
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
						subjectRef: actor.userId,
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
					if (
						!template ||
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
				await identity(request.traceId);
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
				await identity(request.traceId);
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
				const actor = await identity(request.traceId);
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
									registered.actorIds.includes(actor.userId),
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
