import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Rfc3339TimestampV1Schema } from "@agent-infra/contracts";
import {
	AgentTemplateWorkerReadinessV1Schema,
	StandardTemplateRegistrationResponseV1Schema,
	StandardTemplateReleaseApplyAllRequestV2Schema,
	StandardTemplateReleaseApplyAllResponseV2Schema,
	StandardTemplateReleaseApplyRequestV1Schema,
	StandardTemplateReleaseApplyResponseV1Schema,
	standardTemplateRegistrationActions,
	TemplatePublicationIdV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	modelIdentifier,
	parseAdoptedTemplateValidationV2,
	type TemplateValidationContextV1,
	templateValidationContextV1Schema,
} from "@agent-infra/model-catalog";
import {
	type AgentConfigurationAuthorityContextV1,
	type AgentConfigurationSourceV1,
	classifyStandardTemplateUpgradeCompatibilityV1,
	createAgentConfigurationUseCaseV1,
	createTemplatePublicationServiceVerifierV1,
	fanOutStandardTemplateUpgradeV2,
	parseStandardTemplateReleaseTargetV1,
	readStandardTemplateReleaseResultV1,
	type StandardTemplateReleaseAuthorizationPortV1,
	type StandardTemplateReleaseAuthorizationV1,
	type StandardTemplateReleaseTargetV1,
	type TemplatePublicationServiceKeyV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresTemplatePublicationsV1,
	type SingleAgentReleaseRegistrationV1,
	TemplatePublicationStoreError,
} from "@agent-infra/platform-store";
import { createPlatformHealthApp } from "./app.js";
import {
	createDeploymentAdmissionsV1,
	type DeploymentAdmissionInputV1,
	readTemplateReadiness,
} from "./deployment-admissions.js";
import { createDeploymentAuthorizationAdmission } from "./deployment-authorization.js";
import { createDeploymentIdentityScope } from "./deployment-identity.js";
import {
	HttpProtocolError,
	parseIdempotencyKey,
	parseJson,
	requestMetadata,
} from "./http/common.js";
import { mapCoreError } from "./http/core-errors.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./http/identity.js";
import {
	type AutomaticTemplatePublicationInputV1,
	createAutomaticTemplatePublicationAppV1,
} from "./template-publication.js";

interface ReleaseValidation {
	readonly validationContext: TemplateValidationContextV1;
	readonly configurationRevision: string;
	readonly modelId: string;
}

export interface StandardTemplateReleaseDeploymentBindingV1 {
	/** Set by the deployment when this release uses a separately adopted candidate. */
	readonly candidate?: ReleaseValidation & {
		readonly catalogPublication: {
			readonly publicationId: string;
			readonly revision: number;
		} | null;
		readonly catalogReadinessRevision: string;
		readonly adoptedReadinessRevision: string;
	};
	readonly expiresAt?: string;
	readonly schemaVersion: 1;
	readonly revision: string;
	readonly target: StandardTemplateReleaseTargetV1;
	readonly operatorIds: readonly string[];
}

/** Publication metadata keeps the multi-architecture index separate from the runtime child. */
export interface StandardTemplateImagePublicationV1 {
	readonly indexDigest: string;
	readonly platformDigests: Readonly<
		Record<"linux/amd64" | "linux/arm64", string>
	>;
}

function assertRuntimeImagePublication(
	publication: StandardTemplateImagePublicationV1,
	platform: "linux/amd64" | "linux/arm64",
	digest: string,
) {
	if (!/^sha256:[a-f0-9]{64}$/.test(publication.indexDigest)) throw new Error();
	const selected = publication.platformDigests[platform];
	if (
		!/^sha256:[a-f0-9]{64}$/.test(selected) ||
		selected === publication.indexDigest ||
		digest !== selected
	)
		throw new Error();
	return true;
}

export interface ProductionSingleAgentTemplateReleaseInputV1
	extends Omit<DeploymentAdmissionInputV1, "currentIdentity"> {
	readonly databaseUrl: string;
	readonly identity: IdentityAdapter;
	readonly imageRepository: string;
	readonly loadAuthorityContext: () => Promise<AgentConfigurationAuthorityContextV1>;
	readonly target: StandardTemplateReleaseTargetV1;
	readonly candidate?: {
		readonly workerAuthentication?: {
			readonly currentKey: () => Promise<TemplatePublicationServiceKeyV1>;
		};
		readonly sourceCommit: string;
		readonly configurationRevision: string;
		readonly modelId: string;
		readonly loadValidation: (signal: AbortSignal) => Promise<unknown>;
	};
	/** Optional verified publication receipt used to reject multi-architecture index bindings. */
	readonly runtimeImagePublication?: {
		readonly platform: "linux/amd64" | "linux/arm64";
		readonly publication: StandardTemplateImagePublicationV1;
	};
	/** Current deployment-owned binding; reload on each admission so revocation is effective. */
	readonly loadReleaseBinding: () => Promise<StandardTemplateReleaseDeploymentBindingV1>;
	/** Optional additive V2 fan-out adapter. Each target is still applied through
	 * the existing V1 Core use case supplied by the deployment. */
	readonly templateUpgrade?: ProductionTemplateUpgradeInputV2;
	readonly automaticPublication?: AutomaticTemplatePublicationInputV1;
}

export interface StandardTemplateUpgradeDeploymentBindingV2 {
	readonly schemaVersion: 2;
	readonly revision: string;
	readonly releaseId: string;
	readonly templateId: string;
	readonly expectedImageDigest: string;
	readonly targetImageDigest: string;
	readonly operatorIds: readonly string[];
}

export interface ProductionTemplateUpgradeInputV2 {
	readonly releaseId: string;
	readonly templateId: string;
	readonly expectedImageDigest: string;
	readonly targetImageDigest: string;
	/** Runtime model configuration schema published by this target image. */
	readonly targetRuntimeSchemaVersion?: 1 | 4;
	readonly loadReleaseBinding: () => Promise<StandardTemplateUpgradeDeploymentBindingV2>;
}

/** Derive the release image from the installed template policy and the approved child digest. */
function registeredCandidate(
	input: ProductionSingleAgentTemplateReleaseInputV1,
	target: StandardTemplateReleaseTargetV1,
) {
	const candidate = input.candidate;
	if (candidate === undefined) return undefined;
	const installed = input.templates.find(
		(template) => template.templateId === target.templateId,
	);
	if (
		!installed?.modelBinding ||
		!installed.validationContext ||
		!input.runtimeImagePublication ||
		!modelIdentifier.safeParse(candidate.configurationRevision).success ||
		!modelIdentifier.safeParse(candidate.modelId).success ||
		typeof candidate.loadValidation !== "function"
	)
		throw new Error("PLATFORM_TEMPLATE_RELEASE_CONFIGURATION_INVALID");
	const validationContext = templateValidationContextV1Schema.parse({
		...installed.validationContext,
		sourceCommit: candidate.sourceCommit,
	});
	const expected: ReleaseValidation = {
		validationContext,
		configurationRevision: candidate.configurationRevision,
		modelId: candidate.modelId,
	};
	const template = {
		...installed,
		imageReference:
			installed.imageReference.split("@")[0] + "@" + target.targetImageDigest,
		imageDigest: target.targetImageDigest,
		modelBinding: {
			...installed.modelBinding,
			imageDigest: target.targetImageDigest,
		},
		validationContext,
		configurationRevision: candidate.configurationRevision,
		async loadValidation(signal: AbortSignal) {
			const record = parseAdoptedTemplateValidationV2(
				await candidate.loadValidation(signal),
				validationContext,
				Date.now(),
			);
			if (record.candidate.modelId !== expected.modelId)
				throw new Error("TEMPLATE_ADOPTION_INVALID");
			return record;
		},
	};
	return {
		template,
		expected,
		async currentRevisions() {
			if (
				installed.imageDigest !== target.expectedImageDigest &&
				installed.imageDigest !== target.targetImageDigest
			)
				return null;
			const [catalog, adopted] = await Promise.all([
				readTemplateReadiness(installed),
				readTemplateReadiness(template),
			]);
			if (
				catalog.state !== "ready" ||
				adopted.state !== "ready" ||
				!catalog.revision ||
				!adopted.revision
			)
				return null;
			return {
				catalogReadinessRevision: catalog.revision,
				adoptedReadinessRevision: adopted.revision,
			};
		},
	};
}

/** Read the issued Agent revision even after the next Helm request selects another target. */
export async function readCommittedTemplateModelBindingV1(
	query: Pick<
		PostgresAgentConfigurationQueryV1,
		"readCommittedTemplateReleases"
	>,
	templates: DeploymentAdmissionInputV1["templates"],
	agentId: string,
	source: AgentConfigurationSourceV1,
) {
	if (source.kind !== "standard") return null;
	const installed = templates.find(
		(entry) => entry.templateId === source.templateId,
	);
	if (!installed?.validationContext || !installed.modelBinding) return null;
	const [record] = await query.readCommittedTemplateReleases({
		agentId,
		namespace: installed.validationContext.namespace,
	});
	if (
		!record ||
		!isDeepStrictEqual(record.source, source) ||
		!isDeepStrictEqual(record.catalogBinding, installed.modelBinding) ||
		!isDeepStrictEqual(record.validationContext, {
			...installed.validationContext,
			sourceCommit: record.validationContext.sourceCommit,
		})
	)
		return null;
	const context = record.validationContext;
	const adopted = parseAdoptedTemplateValidationV2(
		record.validation,
		context,
		Date.now(),
	);
	const binding = {
		...installed.modelBinding,
		imageDigest: source.imageDigest,
	};
	const [base, candidate] = await Promise.all([
		readTemplateReadiness(installed),
		readTemplateReadiness({
			...installed,
			imageDigest: source.imageDigest,
			modelBinding: binding,
			configurationRevision: record.configurationRevision,
			validationContext: context,
			loadValidation: async () => adopted,
		}),
	]);
	return base.state === "ready" &&
		base.revision === record.catalogReadinessRevision &&
		candidate.state === "ready" &&
		candidate.revision === record.adoptedReadinessRevision &&
		adopted.candidate.modelId === record.modelId
		? binding
		: null;
}

function releasePath(target: StandardTemplateReleaseTargetV1, path = "apply") {
	return `/internal/ops/standard-template-releases/${target.releaseId}/${path}`;
}

/** Separate purpose-bound authority; never used by ordinary configuration update. */
export function createDeploymentStandardTemplateReleaseAuthorizationV1(input: {
	readonly target: StandardTemplateReleaseTargetV1;
	readonly identityScope: ReturnType<typeof createDeploymentIdentityScope>;
	readonly configurationQuery: Pick<
		PostgresAgentConfigurationQueryV1,
		| "readStandardTemplateReleaseAuthority"
		| "readTemplateCatalogPosition"
		| "isAgentReleaseRegistered"
		| "hasSingleAgentReleaseRegistration"
	>;
	readonly loadReleaseBinding: ProductionSingleAgentTemplateReleaseInputV1["loadReleaseBinding"];
	readonly requestPath?:
		| "apply"
		| "apply-all"
		| "result"
		| (typeof standardTemplateRegistrationActions)[number];
	readonly candidate?: ReturnType<typeof registeredCandidate>;
}): Required<StandardTemplateReleaseAuthorizationPortV1> & {
	currentRegistration(
		approval: StandardTemplateReleaseAuthorizationV1,
	): Promise<SingleAgentReleaseRegistrationV1 | null>;
} {
	const target = parseStandardTemplateReleaseTargetV1(input.target);
	const loadBinding = input.loadReleaseBinding;
	async function readOperatorBinding(actorId: string) {
		const [candidateRevision, currentPublication] =
			input.candidate &&
			input.requestPath !== "result" &&
			input.requestPath !== "registration" &&
			input.requestPath !== "revoke-registration"
				? await Promise.all([
						input.candidate.currentRevisions(),
						input.configurationQuery.readTemplateCatalogPosition(
							target.templateId,
						),
					])
				: [undefined, undefined];
		if (candidateRevision === null) return null;
		const binding = await loadBinding();
		if (
			binding.schemaVersion !== 1 ||
			typeof binding.revision !== "string" ||
			binding.revision.length < 1 ||
			binding.revision.length > 1024 ||
			!Array.isArray(binding.operatorIds) ||
			(input.candidate !== undefined && binding.operatorIds.length !== 1) ||
			binding.operatorIds.length > 1024 ||
			binding.operatorIds.some(
				(id) => typeof id !== "string" || id.length < 1 || id.length > 1024,
			) ||
			!binding.operatorIds.includes(actorId) ||
			JSON.stringify(parseStandardTemplateReleaseTargetV1(binding.target)) !==
				JSON.stringify(target)
		)
			return null;
		let expiresAtMs: number | undefined;
		if ("expiresAt" in binding) {
			const deadline = Rfc3339TimestampV1Schema.safeParse(binding.expiresAt);
			if (!deadline.success) return null;
			expiresAtMs = Date.parse(deadline.data);
			if (!(expiresAtMs > Date.now())) return null;
		}
		if (input.candidate || binding.candidate) {
			if (!input.candidate || !binding.candidate) return null;
			const {
				catalogPublication,
				catalogReadinessRevision,
				adoptedReadinessRevision,
				...scope
			} = binding.candidate;
			if (
				!isDeepStrictEqual(scope, input.candidate.expected) ||
				(catalogPublication !== null &&
					(!catalogPublication ||
						!TemplatePublicationIdV1Schema.safeParse(
							catalogPublication.publicationId,
						).success ||
						!Number.isSafeInteger(catalogPublication.revision) ||
						catalogPublication.revision < 1)) ||
				(currentPublication !== undefined &&
					!isDeepStrictEqual(catalogPublication, currentPublication)) ||
				!/^template-[a-f0-9]{64}$/.test(catalogReadinessRevision) ||
				!/^template-[a-f0-9]{64}$/.test(adoptedReadinessRevision) ||
				(candidateRevision &&
					(candidateRevision.catalogReadinessRevision !==
						catalogReadinessRevision ||
						candidateRevision.adoptedReadinessRevision !==
							adoptedReadinessRevision))
			)
				return null;
			const revision = createHash("sha256")
				.update(
					JSON.stringify([
						binding.revision,
						catalogPublication,
						catalogReadinessRevision,
						adoptedReadinessRevision,
					]),
				)
				.digest("hex");
			const registration: SingleAgentReleaseRegistrationV1 = {
				schemaVersion: 1,
				scope: "single-agent",
				target,
				operatorId: actorId,
				deploymentRevision: revision,
				...(expiresAtMs === undefined ? {} : { expiresAtMs }),
				candidate: structuredClone(binding.candidate),
			};
			if (
				(input.requestPath === undefined ||
					input.requestPath === "apply" ||
					input.requestPath === "result") &&
				!(await input.configurationQuery.isAgentReleaseRegistered(registration))
			)
				return null;
			return { revision, expiresAtMs, registration };
		}
		if (
			await input.configurationQuery.hasSingleAgentReleaseRegistration(
				target.releaseId,
			)
		)
			return null;
		return { revision: binding.revision, expiresAtMs };
	}
	return {
		async currentRegistration(approval) {
			const bound = await readOperatorBinding(approval.actorId);
			return bound &&
				bound.revision === approval.deploymentRevision &&
				bound.expiresAtMs === approval.expiresAtMs
				? (bound.registration ?? null)
				: null;
		},
		async isDeploymentBindingCurrent(approval, traceId) {
			let actor: IdentityContext;
			try {
				actor = await input.identityScope.currentIdentity(traceId);
			} catch (error) {
				if (
					error instanceof HttpProtocolError &&
					(error.status === 401 || error.status === 403)
				)
					return false;
				throw error;
			}
			if (
				actor.userId !== approval.actorId ||
				actor.authorizationRevision !== approval.identityRevision ||
				actor.accountStatus !== "active" ||
				!actor.roles.includes("system_admin")
			)
				return false;
			const bound = await readOperatorBinding(approval.actorId);
			return (
				bound !== null &&
				bound.revision === approval.deploymentRevision &&
				bound.expiresAtMs === approval.expiresAtMs
			);
		},
		async authorize(request) {
			const rejected = {
				schemaVersion: 1 as const,
				status: "rejected" as const,
			};
			const actual = input.identityScope.currentRequest();
			if (
				request.intent !== "standard_template.release_to_agent" ||
				actual.method !== "POST" ||
				new URL(actual.url).pathname !==
					releasePath(target, input.requestPath ?? "apply") ||
				new URL(actual.url).search !== "" ||
				JSON.stringify(parseStandardTemplateReleaseTargetV1(request.target)) !==
					JSON.stringify(target)
			)
				return rejected;
			let actor: IdentityContext;
			try {
				actor = await input.identityScope.currentIdentity(request.traceId);
			} catch (error) {
				if (
					error instanceof HttpProtocolError &&
					(error.status === 401 || error.status === 403)
				)
					return rejected;
				throw error;
			}
			if (
				actor.userId !== request.actorId ||
				actor.accountStatus !== "active" ||
				!actor.roles.includes("system_admin")
			)
				return rejected;
			const binding = await readOperatorBinding(actor.userId);
			if (!binding) return rejected;
			const current =
				await input.configurationQuery.readStandardTemplateReleaseAuthority({
					agentId: target.agentId,
					templateId: target.templateId,
					...(binding.expiresAtMs === undefined
						? {}
						: { expiresAtMs: binding.expiresAtMs }),
				});
			if (current.outcome !== "found") return rejected;
			return {
				schemaVersion: 1,
				status: "admitted",
				intent: "standard_template.release_to_agent",
				target,
				actorId: actor.userId,
				accountStatus: "active",
				isAdministrator: true,
				identityRevision: actor.authorizationRevision,
				deploymentRevision: binding.revision,
				...(binding.expiresAtMs === undefined
					? {}
					: { expiresAtMs: binding.expiresAtMs }),
				authorizationRevision: current.authorizationRevision,
			};
		},
	};
}

/** Dedicated HTTP application. Deployment supplies actual identity and Registry adapters, not admissions. */
export function createProductionSingleAgentTemplateReleaseAppV1(
	input: ProductionSingleAgentTemplateReleaseInputV1,
) {
	let target: StandardTemplateReleaseTargetV1;
	let candidate: ReturnType<typeof registeredCandidate>;
	try {
		target = parseStandardTemplateReleaseTargetV1(input.target);
		candidate = registeredCandidate(input, target);
		if (
			!["postgres:", "postgresql:"].includes(
				new URL(input.databaseUrl).protocol,
			) ||
			typeof input.identity?.resolve !== "function" ||
			typeof input.identity?.hydrateUsers !== "function" ||
			typeof input.loadReleaseBinding !== "function" ||
			typeof input.loadAuthorityContext !== "function" ||
			(!candidate &&
				input.templates.filter(
					(template) =>
						template.templateId === target.templateId &&
						template.imageDigest === target.targetImageDigest,
				).length !== 1) ||
			(input.runtimeImagePublication !== undefined &&
				!assertRuntimeImagePublication(
					input.runtimeImagePublication.publication,
					input.runtimeImagePublication.platform,
					target.targetImageDigest,
				)) ||
			(input.templateUpgrade !== undefined &&
				(!/^[A-Za-z0-9._~-]{1,128}$/.test(input.templateUpgrade.releaseId) ||
					!input.templateUpgrade.templateId ||
					!/^sha256:[a-f0-9]{64}$/.test(
						input.templateUpgrade.expectedImageDigest,
					) ||
					!/^sha256:[a-f0-9]{64}$/.test(
						input.templateUpgrade.targetImageDigest,
					) ||
					input.templateUpgrade.expectedImageDigest ===
						input.templateUpgrade.targetImageDigest ||
					(input.templateUpgrade.targetRuntimeSchemaVersion !== undefined &&
						input.templateUpgrade.targetRuntimeSchemaVersion !== 1 &&
						input.templateUpgrade.targetRuntimeSchemaVersion !== 4) ||
					typeof input.templateUpgrade.loadReleaseBinding !== "function" ||
					input.templates.filter(
						(template) =>
							template.templateId === input.templateUpgrade?.templateId &&
							template.imageDigest === input.templateUpgrade?.targetImageDigest,
					).length !== 1))
		)
			throw new Error();
	} catch {
		throw new Error("PLATFORM_TEMPLATE_RELEASE_CONFIGURATION_INVALID");
	}
	const identity = input.identity;
	const identityScope = createDeploymentIdentityScope(identity);
	const admissions = createDeploymentAdmissionsV1({
		...input,
		currentIdentity: identityScope.currentIdentity,
	});
	const query = new PostgresAgentConfigurationQueryV1({
		databaseUrl: input.databaseUrl,
	});
	const transaction = new PostgresAgentConfigurationTransactionV1({
		databaseUrl: input.databaseUrl,
	});
	const registrations = candidate
		? new PostgresTemplatePublicationsV1({ databaseUrl: input.databaseUrl })
		: undefined;
	const releaseAuthority = {
		target,
		candidate,
		identityScope,
		configurationQuery: query,
		loadReleaseBinding: input.loadReleaseBinding,
	};
	const resultAuthorization =
		createDeploymentStandardTemplateReleaseAuthorizationV1({
			...releaseAuthority,
			requestPath: "result",
		});
	const manualAdmissions = candidate
		? createDeploymentAdmissionsV1({
				...input,
				templates: [candidate.template],
				currentIdentity: identityScope.currentIdentity,
			})
		: admissions;
	const configuration = createAgentConfigurationUseCaseV1({
		...manualAdmissions,
		transaction,
		authorizationAdmission: createDeploymentAuthorizationAdmission({
			identityScope,
			configurationQuery: query,
			loadAuthorityContext: input.loadAuthorityContext,
		}),
		standardTemplateReleaseAuthorization:
			createDeploymentStandardTemplateReleaseAuthorizationV1(releaseAuthority),
	});
	const app = createPlatformHealthApp();
	const automatic = input.automaticPublication
		? createAutomaticTemplatePublicationAppV1({
				...input,
				databaseUrl: input.databaseUrl,
				identity,
				automaticPublication: input.automaticPublication,
				templates: input.templates,
			})
		: undefined;
	if (automatic) app.route("/", automatic.app);
	app.use("*", (context, next) =>
		identityScope.requestScope(context.req.raw, next),
	);
	if (registrations && candidate && input.candidate?.workerAuthentication) {
		const worker = createTemplatePublicationServiceVerifierV1({
			currentKey: input.candidate.workerAuthentication.currentKey,
			consumeNonce: (identity) => registrations.consumeNonce(identity),
		});

		app.post(
			"/internal/ops/standard-template-releases/:releaseId/agent-worker-ready",
			async (context) => {
				const request = context.req.raw;
				const { traceId } = requestMetadata(request);
				const reject = () =>
					new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
				if (
					context.req.param("releaseId") !== target.releaseId ||
					new URL(request.url).search
				)
					throw reject();
				const identity = await worker.resolveService(request).catch(() => null);
				if (
					!identity ||
					identity.purpose !== "agent_ready" ||
					identity.publicationId !== target.releaseId ||
					identity.deploymentRef !==
						candidate.expected.validationContext.installationId
				)
					throw reject();
				const proof = (
					await parseJson(
						request,
						AgentTemplateWorkerReadinessV1Schema,
						traceId,
					)
				).value;
				const bound = await input.loadReleaseBinding();
				if (
					!bound.candidate ||
					!isDeepStrictEqual(bound.target, target) ||
					bound.operatorIds.length !== 1
				)
					throw reject();
				let validation: unknown = null;
				const base = input.templates.find(
					(entry) => entry.templateId === target.templateId,
				);
				const apiRepository = base?.imageReference.split("@")[0];

				if (proof.ready) {
					if (
						!base?.modelBinding ||
						!base.loadValidation ||
						!base.validationContext ||
						apiRepository !== proof.imageRepository ||
						!isDeepStrictEqual(
							{
								...base.modelBinding,
								imageRepository:
									base.modelBinding.imageRepository ?? apiRepository,
							},
							{
								...proof.catalogBinding,
								imageRepository:
									proof.catalogBinding.imageRepository ?? proof.imageRepository,
							},
						)
					)
						throw reject();
					const signal = AbortSignal.timeout(10_000);
					const [adopted, readiness, installed] = await Promise.all([
						candidate.template.loadValidation(signal),
						candidate.currentRevisions(),
						base.loadValidation(signal),
					]);
					if (
						!isDeepStrictEqual(
							proof.catalogValidation,
							parseAdoptedTemplateValidationV2(
								installed,
								base.validationContext,
								Date.now(),
							),
						)
					)
						throw reject();
					if (
						!isDeepStrictEqual(proof.target, target) ||
						!isDeepStrictEqual(proof.validation, adopted) ||
						!readiness ||
						bound.candidate.adoptedReadinessRevision !==
							readiness.adoptedReadinessRevision ||
						bound.candidate.catalogReadinessRevision !==
							readiness.catalogReadinessRevision
					)
						throw reject();
					validation = adopted;
				}
				if (!(await worker.isServiceCurrent(identity))) throw reject();
				const result = await registrations.confirmAgentWorkerReady(
					target,
					bound.candidate,
					bound.operatorIds[0],
					identity,
					{
						ready: proof.ready,
						validation,
						catalogBinding: base?.modelBinding,
						workerCatalogBinding: proof.ready ? proof.catalogBinding : null,
						catalogValidation: proof.ready ? proof.catalogValidation : null,
					},
				);
				if (!result) throw reject();
				if (result === "committed")
					context.header("x-template-release-committed", "true");
				return context.body(null, 204);
			},
		);
	}
	if (registrations)
		for (const action of standardTemplateRegistrationActions) {
			const auth = createDeploymentStandardTemplateReleaseAuthorizationV1({
				...releaseAuthority,
				requestPath: action,
			});
			app.post(
				`/internal/ops/standard-template-releases/:releaseId/${action}`,
				async (context) => {
					const request = context.req.raw;
					const { traceId, requestId } = requestMetadata(request);
					if (context.req.param("releaseId") !== target.releaseId)
						throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
					parseIdempotencyKey(request, traceId);
					await parseJson(
						request,
						StandardTemplateReleaseApplyRequestV1Schema,
						traceId,
					);
					const actor = await resolveIdentity(identity, request, traceId);
					const approval = await auth.authorize({
						schemaVersion: 1,
						intent: "standard_template.release_to_agent",
						target,
						actorId: actor.userId,
						traceId,
						requestId,
					});
					if (approval.status !== "admitted")
						throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
					const registration = await auth.currentRegistration(approval);
					if (!registration)
						throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
					try {
						const result = await registrations.agentRegistration(
							action,
							registration,
							() => auth.isDeploymentBindingCurrent(approval, traceId),
							{ traceId, requestId },
						);
						return context.json(
							StandardTemplateRegistrationResponseV1Schema.parse(result),
							action === "registration" ? 200 : 202,
						);
					} catch (error) {
						if (
							error instanceof TemplatePublicationStoreError &&
							error.code === "conflict"
						)
							throw new HttpProtocolError("CONFLICT", traceId);
						if (
							error instanceof TemplatePublicationStoreError &&
							error.code === "not_authorized"
						)
							throw new HttpProtocolError("RESOURCE_UNAVAILABLE", traceId);
						throw new HttpProtocolError("DEPENDENCY_UNAVAILABLE", traceId);
					}
				},
			);
		}
	for (const action of ["apply", "result"] as const) {
		app.post(
			`/internal/ops/standard-template-releases/:releaseId/${action}`,
			async (context) => {
				const request = context.req.raw;
				const metadata = requestMetadata(request);
				const actor = await resolveIdentity(
					identity,
					request,
					metadata.traceId,
				);
				if (context.req.param("releaseId") !== target.releaseId)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				if (new URL(request.url).search !== "")
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const idempotencyKey = parseIdempotencyKey(request, metadata.traceId);
				const { rawRequestDigest } = await parseJson(
					request,
					StandardTemplateReleaseApplyRequestV1Schema,
					metadata.traceId,
				);
				try {
					const command = {
						schemaVersion: 1 as const,
						target,
						idempotencyKey,
						...metadata,
					};
					const actorContext = {
						schemaVersion: 1 as const,
						actorId: actor.userId,
						rawRequestDigest,
					};
					const result =
						action === "apply"
							? await configuration.releaseStandardTemplate(
									command,
									actorContext,
								)
							: await readStandardTemplateReleaseResultV1(
									command,
									actorContext,
									{ transaction, authorization: resultAuthorization },
								);
					if (!result)
						throw new HttpProtocolError(
							"RESOURCE_UNAVAILABLE",
							metadata.traceId,
						);
					return context.json(
						StandardTemplateReleaseApplyResponseV1Schema.parse({
							schemaVersion: 1,
							agentId: result.agentId,
							configurationRevision: result.revision,
							changedFields: result.changedFields,
						}),
						action === "apply" ? 202 : 200,
					);
				} catch (error) {
					throw mapCoreError(error, metadata.traceId);
				}
			},
		);
	}
	if (input.templateUpgrade) {
		const upgrade = input.templateUpgrade;
		app.post(
			"/internal/ops/standard-template-releases/:releaseId/apply-all",
			async (context) => {
				const request = context.req.raw;
				const metadata = requestMetadata(request);
				const actor = await resolveIdentity(
					identity,
					request,
					metadata.traceId,
				);
				if (context.req.param("releaseId") !== upgrade.releaseId)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				if (new URL(request.url).search !== "")
					throw new HttpProtocolError("INVALID_REQUEST", metadata.traceId);
				const idempotencyKey = parseIdempotencyKey(request, metadata.traceId);
				const { rawRequestDigest } = await parseJson(
					request,
					StandardTemplateReleaseApplyAllRequestV2Schema,
					metadata.traceId,
				);
				const binding = await upgrade.loadReleaseBinding();
				if (
					binding.schemaVersion !== 2 ||
					binding.releaseId !== upgrade.releaseId ||
					binding.templateId !== upgrade.templateId ||
					binding.expectedImageDigest !== upgrade.expectedImageDigest ||
					binding.targetImageDigest !== upgrade.targetImageDigest ||
					typeof binding.revision !== "string" ||
					binding.revision.length < 1 ||
					binding.revision.length > 1024 ||
					!Array.isArray(binding.operatorIds) ||
					binding.operatorIds.length > 1024 ||
					binding.operatorIds.some(
						(id) => typeof id !== "string" || id.length < 1 || id.length > 1024,
					) ||
					!binding.operatorIds.includes(actor.userId) ||
					actor.accountStatus !== "active" ||
					!actor.roles.includes("system_admin")
				)
					throw new HttpProtocolError("RESOURCE_UNAVAILABLE", metadata.traceId);
				try {
					const result = await fanOutStandardTemplateUpgradeV2(
						{
							schemaVersion: 2,
							releaseId: upgrade.releaseId,
							templateId: upgrade.templateId,
							expectedImageDigest: upgrade.expectedImageDigest,
							targetImageDigest: upgrade.targetImageDigest,
							idempotencyKey,
							requestId: metadata.requestId,
							traceId: metadata.traceId,
						},
						{
							discover: (target) =>
								query.listStandardTemplateReleaseTargets(target),
						},
						(target) => ({
							apply: async (command) => {
								const targetConfiguration = createAgentConfigurationUseCaseV1({
									...admissions,
									transaction,
									authorizationAdmission:
										createDeploymentAuthorizationAdmission({
											identityScope,
											configurationQuery: query,
											loadAuthorityContext: input.loadAuthorityContext,
										}),
									standardTemplateReleaseAuthorization:
										createDeploymentStandardTemplateReleaseAuthorizationV1({
											target,
											identityScope,
											configurationQuery: query,
											loadReleaseBinding: async () => {
												const current = await upgrade.loadReleaseBinding();
												return {
													schemaVersion: 1 as const,
													revision: current.revision,
													target: {
														...target,
														releaseId: current.releaseId,
														templateId: current.templateId,
														expectedImageDigest: current.expectedImageDigest,
														targetImageDigest: current.targetImageDigest,
													},
													operatorIds: current.operatorIds,
												};
											},
											requestPath: "apply-all",
										}),
								});
								return targetConfiguration.releaseStandardTemplate(command, {
									schemaVersion: 1,
									actorId: actor.userId,
									rawRequestDigest,
								});
							},
						}),
						{
							evaluate: async ({ target, configurationRevision }) =>
								classifyStandardTemplateUpgradeCompatibilityV1({
									target,
									targetMetadata:
										upgrade.targetRuntimeSchemaVersion === undefined
											? null
											: {
													templateId: upgrade.templateId,
													targetImageDigest: upgrade.targetImageDigest,
													runtimeSchemaVersion:
														upgrade.targetRuntimeSchemaVersion,
												},
									runtimeFacts:
										await query.readStandardTemplateUpgradeRuntimeFacts({
											agentId: target.agentId,
										}),
									resultingConfigurationRevision: configurationRevision,
								}),
						},
					);
					return context.json(
						StandardTemplateReleaseApplyAllResponseV2Schema.parse(result),
						result.status === "partial" ? 207 : 202,
					);
				} catch (error) {
					throw mapCoreError(error, metadata.traceId);
				}
			},
		);
	}
	return {
		app,
		readCommittedModelBinding(
			agentId: string,
			source: AgentConfigurationSourceV1,
		) {
			return readCommittedTemplateModelBindingV1(
				query,
				input.templates,
				agentId,
				source,
			);
		},
		async close() {
			await Promise.all([
				transaction.close(),
				query.close(),
				automatic?.close(),
				registrations?.close(),
			]);
		},
	};
}
