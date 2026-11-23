import { createHash } from "node:crypto";
import {
	type TemplatePublicationBindingV1,
	TemplatePublicationBindingV1Schema,
	TemplatePublicationCommandV1Schema,
	TemplatePublicationLeaseV1Schema,
	TemplatePublicationReadyV1Schema,
	type TemplatePublicationServiceIdentityV1,
	TemplatePublicationServiceIdentityV1Schema,
} from "@agent-infra/contracts/pilot";
import {
	createAgentConfigurationUseCaseV1,
	createTemplatePublicationServiceVerifierV1,
	fanOutStandardTemplateUpgradeV2,
	TemplatePublicationAuthenticationErrorV1,
	type TemplatePublicationServiceKeyV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresTemplatePublicationsV1,
	TemplatePublicationStoreError,
} from "@agent-infra/platform-store";
import { createPlatformHealthApp } from "./app.js";
import {
	createDeploymentAdmissionsV1,
	type DeploymentAdmissionInputV1,
	readTemplateReadiness,
} from "./deployment-admissions.js";
import {
	HttpProtocolError,
	parseJson,
	requestMetadata,
} from "./http/common.js";
import {
	type IdentityAdapter,
	type IdentityContext,
	resolveIdentity,
} from "./http/identity.js";

export type AutomaticTemplatePublicationInputV1 = {
	readonly loadBinding: () => Promise<TemplatePublicationBindingV1>;
	readonly resolveAdministrator: (
		actorId: string,
	) => Promise<IdentityContext | null>;
} & (
	| {
			readonly serviceAuthentication: {
				readonly currentKey: () => Promise<TemplatePublicationServiceKeyV1>;
			};
	  }
	| {
			/** Trusted adapter verifies signatures on a cloned body and consumes the nonce exactly once. */
			readonly resolveService: (
				request: Request,
			) => Promise<TemplatePublicationServiceIdentityV1 | null>;
			readonly isServiceCurrent: (
				identity: TemplatePublicationServiceIdentityV1,
			) => Promise<boolean>;
	  }
);

export function createAutomaticTemplatePublicationAppV1(
	input: Omit<
		DeploymentAdmissionInputV1,
		"currentIdentity" | "currentApiPrincipal" | "currentPublicationSubject"
	> & {
		readonly databaseUrl: string;
		readonly identity: IdentityAdapter;
		readonly automaticPublication: AutomaticTemplatePublicationInputV1;
		readonly templates: DeploymentAdmissionInputV1["templates"];
	},
) {
	const app = createPlatformHealthApp();
	const store = new PostgresTemplatePublicationsV1(input);
	const authentication =
		"serviceAuthentication" in input.automaticPublication
			? createTemplatePublicationServiceVerifierV1({
					currentKey:
						input.automaticPublication.serviceAuthentication.currentKey,
					consumeNonce: (identity) => store.consumeNonce(identity),
				})
			: input.automaticPublication;
	const query = new PostgresAgentConfigurationQueryV1(input);
	const transaction = new PostgresAgentConfigurationTransactionV1(input);
	async function service(
		request: Request,
		purpose: TemplatePublicationServiceIdentityV1["purpose"],
		verified?: TemplatePublicationServiceIdentityV1,
	) {
		const binding = TemplatePublicationBindingV1Schema.parse(
			await input.automaticPublication.loadBinding(),
		);
		const raw = verified ?? (await authentication.resolveService(request));
		const parsed = TemplatePublicationServiceIdentityV1Schema.safeParse(raw);
		if (!parsed.success)
			throw new TemplatePublicationStoreError("not_authorized");
		const resolved = parsed.data;
		const now = Date.now();
		const params = new URL(request.url).searchParams;
		if (
			purpose === "read"
				? [...params.keys()].some((k) => k !== "cursor") ||
					params.getAll("cursor").length > 1 ||
					(params.get("cursor") !== null &&
						!/^target-[a-f0-9]{64}$/.test(params.get("cursor") ?? ""))
				: new URL(request.url).search !== ""
		)
			throw new TemplatePublicationStoreError("not_authorized");
		if (
			request.signal.aborted ||
			!(await authentication.isServiceCurrent(resolved))
		)
			throw new TemplatePublicationStoreError("not_authorized");
		if (
			resolved.purpose !== purpose ||
			resolved.publicationId !== binding.publicationId ||
			resolved.deploymentRef !== binding.deploymentRef ||
			resolved.principalRef !== binding.servicePrincipalRef ||
			Date.parse(resolved.issuedAt) > now ||
			Date.parse(resolved.expiresAt) <= now ||
			Date.parse(resolved.expiresAt) - Date.parse(resolved.issuedAt) > 60_000 ||
			Date.parse(binding.expiresAt) <= now
		)
			throw new TemplatePublicationStoreError("not_authorized");
		const original = await store.binding(binding.publicationId);
		const actor = await input.automaticPublication.resolveAdministrator(
			original.approvedBy,
		);
		if (
			!actor ||
			actor.userId !== original.approvedBy ||
			actor.accountStatus !== "active" ||
			!actor.roles.includes("system_admin") ||
			!binding.operatorIds.includes(actor.userId) ||
			JSON.stringify(original.binding) !== JSON.stringify(binding) ||
			["revoked", "superseded", "blocked"].includes(original.status)
		)
			throw new TemplatePublicationStoreError("not_authorized");
		return { binding, identity: resolved };
	}
	function failure(error: unknown): 400 | 401 | 403 | 409 | 503 {
		if (error instanceof TemplatePublicationAuthenticationErrorV1) return 403;
		if (error instanceof HttpProtocolError)
			return error.status === 401 ? 401 : error.status === 400 ? 400 : 403;
		return error instanceof TemplatePublicationStoreError
			? error.code === "conflict"
				? 409
				: error.code === "not_authorized"
					? 403
					: 503
			: 503;
	}
	app.post(
		"/internal/ops/standard-template-releases/:publicationId/prepare-automatic",
		async (context) => {
			try {
				const binding = TemplatePublicationBindingV1Schema.parse(
					await input.automaticPublication.loadBinding(),
				);
				const actor = await resolveIdentity(
					input.identity,
					context.req.raw,
					binding.publicationId,
				);
				if (
					binding.publicationId !== context.req.param("publicationId") ||
					binding.expiresAt <= new Date().toISOString() ||
					actor.accountStatus !== "active" ||
					!actor.roles.includes("system_admin") ||
					!binding.operatorIds.includes(actor.userId) ||
					new URL(context.req.url).search !== ""
				)
					return context.json(
						{ schemaVersion: 1, code: "TEMPLATE_PUBLICATION_UNAVAILABLE" },
						403,
					);
				(
					await parseJson(
						context.req.raw,
						TemplatePublicationCommandV1Schema,
						requestMetadata(context.req.raw).traceId,
					)
				).value;
				return context.json(await store.prepare(binding, actor.userId), 202);
			} catch (error) {
				return context.json(
					{ schemaVersion: 1, code: "TEMPLATE_PUBLICATION_UNAVAILABLE" },
					failure(error),
				);
			}
		},
	);
	app.post(
		"/internal/ops/standard-template-releases/:publicationId/worker-ready",
		async (context) => {
			try {
				const { binding } = await service(context.req.raw, "ready");
				const ready = (
					await parseJson(
						context.req.raw,
						TemplatePublicationReadyV1Schema,
						requestMetadata(context.req.raw).traceId,
					)
				).value;
				if (
					context.req.param("publicationId") !== binding.publicationId ||
					ready.catalogRevision !== binding.catalogRevision ||
					ready.templateId !== binding.templateId ||
					ready.targetImageDigest !== binding.targetImageDigest
				)
					throw new TemplatePublicationStoreError("not_authorized");
				return context.json(await store.ready(binding), 202);
			} catch (error) {
				return context.json(
					{ schemaVersion: 1, code: "TEMPLATE_PUBLICATION_UNAVAILABLE" },
					failure(error),
				);
			}
		},
	);
	app.post(
		"/internal/ops/standard-template-releases/:publicationId/activate-automatic",
		async (context) => {
			try {
				const { binding, identity } = await service(
					context.req.raw,
					"activate",
				);
				(
					await parseJson(
						context.req.raw,
						TemplatePublicationCommandV1Schema,
						requestMetadata(context.req.raw).traceId,
					)
				).value;
				const template = input.templates.find(
					(template) =>
						template.templateId === binding.templateId &&
						template.imageDigest === binding.targetImageDigest &&
						template.configurationRevision === binding.catalogRevision,
				);
				if (
					context.req.param("publicationId") !== binding.publicationId ||
					!template?.loadValidation ||
					template.validationContext?.installationId !== binding.deploymentRef
				)
					throw new TemplatePublicationStoreError("conflict");
				const validation = template.loadValidation;
				const readiness = await readTemplateReadiness({
					...template,
					loadValidation: async (signal) => {
						const adopted = await validation(signal);
						if (
							!adopted ||
							typeof adopted !== "object" ||
							!("schemaVersion" in adopted) ||
							adopted.schemaVersion !== 2
						)
							throw new Error("TEMPLATE_VALIDATION_NOT_ADOPTED");
						return adopted;
					},
				});
				if (
					readiness.state !== "ready" ||
					readiness.revision !== binding.validationRef
				)
					throw new TemplatePublicationStoreError("conflict");
				await service(context.req.raw, "activate", identity);
				return context.json(await store.activate(binding), 202);
			} catch (error) {
				return context.json(
					{ schemaVersion: 1, code: "TEMPLATE_PUBLICATION_UNAVAILABLE" },
					failure(error),
				);
			}
		},
	);
	app.post(
		"/internal/ops/standard-template-releases/:publicationId/run-automatic",
		async (context) => {
			try {
				const { binding, identity } = await service(context.req.raw, "run");
				if (context.req.param("publicationId") !== binding.publicationId)
					throw new TemplatePublicationStoreError("not_authorized");
				const lease = (
					await parseJson(
						context.req.raw,
						TemplatePublicationLeaseV1Schema,
						requestMetadata(context.req.raw).traceId,
					)
				).value;
				const batch = await store.batch(binding, lease);
				if (batch.length) {
					const admissions = createDeploymentAdmissionsV1({
						...input,
						currentIdentity: undefined,
						currentApiPrincipal: undefined,
						currentPublicationSubject: async () => {
							await service(context.req.raw, "run", identity);
							return `template-publication:${identity.principalRef}`;
						},
					});
					const applied = await fanOutStandardTemplateUpgradeV2(
						{
							schemaVersion: 2,
							releaseId: binding.publicationId,
							templateId: binding.templateId,
							expectedImageDigest:
								batch[0]?.target.expectedImageDigest ??
								binding.targetImageDigest,
							targetImageDigest: binding.targetImageDigest,
							idempotencyKey: `auto-${createHash("sha256").update(`${binding.publicationId}:${batch[0]?.attempt}`).digest("hex")}`,
							requestId: binding.publicationId,
							traceId: binding.publicationId,
						},
						{ discover: async () => batch.map((row) => row.target) },
						(target) => ({
							apply: async (command) => {
								const saved = batch.find(
									(row) => row.target.agentId === target.agentId,
								);
								if (!saved) throw new TemplatePublicationStoreError("conflict");
								const configuration = createAgentConfigurationUseCaseV1({
									...admissions,
									transaction,
									authorizationAdmission: {
										authorize: async (request) => ({
											schemaVersion: 1,
											status: "rejected" as const,
											agentId: request.agentId,
											actorId: request.actorId,
										}),
									},
									automaticTemplatePublicationAuthorization: {
										authorize: async () => {
											const latest = await service(
												context.req.raw,
												"run",
												identity,
											);
											const original = await store.binding(
												binding.publicationId,
											);
											const row = await store.target(
												binding.publicationId,
												target.agentId,
											);
											const authority =
												await query.readStandardTemplateReleaseAuthority({
													agentId: target.agentId,
													templateId: target.templateId,
												});
											if (
												row.targetRef !== saved.targetRef ||
												row.status !== "unknown" ||
												authority.outcome !== "found"
											)
												return { schemaVersion: 1, status: "rejected" };
											return {
												schemaVersion: 1,
												status: "admitted",
												intent: "standard_template.auto_publish",
												target,
												actorId: identity.principalRef,
												identityRevision: `${identity.issuer}:${identity.keyVersion}`,
												deploymentRevision:
													latest.binding.authorizationRevision,
												authorizationRevision: authority.authorizationRevision,
												publication: {
													schemaVersion: 1,
													publicationId: binding.publicationId,
													authorizationRevision: binding.authorizationRevision,
													batchRef: saved.batchRef,
													targetRef: saved.targetRef,
													servicePrincipalRef: identity.principalRef,
													approvedBy: original.approvedBy,
													lease,
												},
											};
										},
									},
								});
								// The per-Agent request is immutable; outbox lease metadata is not its body.
								return configuration.releaseStandardTemplate(command, {
									schemaVersion: 1,
									actorId: identity.principalRef,
									rawRequestDigest: createHash("sha256")
										.update(JSON.stringify(target))
										.digest("hex"),
								});
							},
						}),
					);
					for (const result of applied.targets)
						if (result.status === "failed") {
							const original = batch.find(
								(row) => row.target.agentId === result.agentId,
							);
							if (!original)
								throw new TemplatePublicationStoreError("conflict");
							await store.rejected(
								original.targetRef,
								result.errorCode ?? "dependency_unavailable",
								lease,
							);
						}
				}
				await service(context.req.raw, "run", identity);
				return context.json(await store.finish(binding, lease), 202);
			} catch (error) {
				return context.json(
					{ schemaVersion: 1, code: "TEMPLATE_PUBLICATION_UNAVAILABLE" },
					failure(error),
				);
			}
		},
	);
	app.get(
		"/internal/ops/standard-template-releases/:publicationId/status-automatic",
		async (context) => {
			try {
				const resolved = await authentication.resolveService(context.req.raw);
				let binding: TemplatePublicationBindingV1;
				if (resolved)
					binding = (await service(context.req.raw, "read", resolved)).binding;
				else {
					binding = TemplatePublicationBindingV1Schema.parse(
						await input.automaticPublication.loadBinding(),
					);
					const actor = await resolveIdentity(
						input.identity,
						context.req.raw,
						binding.publicationId,
					);
					const params = new URL(context.req.url).searchParams;
					if (
						actor.accountStatus !== "active" ||
						!actor.roles.includes("system_admin") ||
						!binding.operatorIds.includes(actor.userId) ||
						[...params.keys()].some((key) => key !== "cursor") ||
						params.getAll("cursor").length > 1 ||
						(params.has("cursor") &&
							!/^target-[a-f0-9]{64}$/.test(params.get("cursor") ?? ""))
					)
						throw new TemplatePublicationStoreError("not_authorized");
					const original = await store.binding(binding.publicationId);
					if (
						original.binding.templateId !== binding.templateId ||
						original.binding.deploymentRef !== binding.deploymentRef
					)
						throw new TemplatePublicationStoreError("not_authorized");
				}
				if (context.req.param("publicationId") !== binding.publicationId)
					throw new TemplatePublicationStoreError("not_authorized");
				return context.json(
					await store.read(
						binding.publicationId,
						new URL(context.req.url).searchParams.get("cursor") ?? "",
					),
					200,
				);
			} catch (error) {
				return context.json(
					{ schemaVersion: 1, code: "TEMPLATE_PUBLICATION_UNAVAILABLE" },
					failure(error),
				);
			}
		},
	);
	app.post(
		"/internal/ops/standard-template-releases/:publicationId/revoke-automatic",
		async (context) => {
			try {
				const binding = TemplatePublicationBindingV1Schema.parse(
					await input.automaticPublication.loadBinding(),
				);
				const actor = await resolveIdentity(
					input.identity,
					context.req.raw,
					binding.publicationId,
				);
				if (
					binding.publicationId !== context.req.param("publicationId") ||
					actor.accountStatus !== "active" ||
					!actor.roles.includes("system_admin") ||
					!binding.operatorIds.includes(actor.userId) ||
					new URL(context.req.url).search !== ""
				)
					throw new TemplatePublicationStoreError("not_authorized");
				(
					await parseJson(
						context.req.raw,
						TemplatePublicationCommandV1Schema,
						requestMetadata(context.req.raw).traceId,
					)
				).value;
				return context.json(await store.revoke(binding, actor.userId), 202);
			} catch (error) {
				return context.json(
					{ schemaVersion: 1, code: "TEMPLATE_PUBLICATION_UNAVAILABLE" },
					failure(error),
				);
			}
		},
	);
	return {
		app,
		close: async () => {
			await Promise.all([store.close(), query.close(), transaction.close()]);
		},
	};
}
