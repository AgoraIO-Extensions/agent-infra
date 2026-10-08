import { randomUUID } from "node:crypto";
import { beginInitialAgentConfigurationAdmissionV1 } from "./agent-configuration-initial.js";
import { parseInitialCommand } from "./agent-configuration-input.js";
import type {
	AgentConfigurationAuthorizationAdmissionPortV1,
	InitialAgentConfigurationAdmissionDependenciesV1,
} from "./agent-configuration-types.js";
import type {
	AgentManagementStateV1,
	AgentManagementStatusV1,
	AgentManagementWritePlanV1,
} from "./agent-management.js";
import {
	isAgentManagementText,
	parseAgentManagementPortState,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	type ApplicationFoundationRelayKeyAttachmentV1,
	type ApplicationFoundationUseCaseDependenciesV1,
	type ApplicationFoundationWritePlanV1,
	type CommitApplicationFoundationCommand,
	parseApplicationFoundationCommandV1,
} from "./application-foundation.js";
import type { ApiPrincipalV1 } from "./audit-query.js";
import {
	type PlatformIdempotencyRequestJson,
	platformIdempotencyV1,
} from "./idempotency.js";
import { PersonalApiCredentialErrorV1 } from "./personal-api-credentials.js";
import {
	type PendingSecretRecordAttachmentResolverV1,
	type PendingSecretRecordAttachmentsV1,
	resolvePendingSecretRecordAttachmentsV1,
} from "./secret-record-attachments.js";

export type AgentApiCreationCommandV1 = Omit<
	CommitApplicationFoundationCommand,
	"agentId" | "applicationId" | "secrets" | "channels"
> & {
	readonly secrets: readonly {
		readonly name: string;
		readonly value: string;
	}[];
};
export interface AgentApiCreationResultV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly status: AgentManagementStatusV1;
	readonly revision: number;
	readonly replayed: boolean;
}
export type AgentApiCreationRowsV1 = Pick<
	ApplicationFoundationWritePlanV1,
	"agent" | "configurationRevision" | "access"
> & {
	readonly application: Omit<
		ApplicationFoundationWritePlanV1["application"],
		"status"
	> & {
		readonly status: "creating";
		readonly creationChannel: "api";
		readonly creatorPrincipalType: ApiPrincipalV1["kind"];
		readonly creatorPrincipalId: string;
		readonly managementRevision: 1;
		readonly approvalRevision: null;
		readonly desiredState: "running";
		readonly workloadRevision: 1;
		readonly fence: 1;
	};
	readonly creator: ApiPrincipalV1;
	readonly grants: { readonly manage: string; readonly use: string };
};
export interface AgentApiCreationAuthorityV1 {
	readonly principal: ApiPrincipalV1;
	readonly ownerId: string;
	readonly agentId: string;
	readonly applicationId: string;
	readonly authorizationRevision: string;
	readonly authorizationAdmission: AgentConfigurationAuthorizationAdmissionPortV1;
}
export interface AgentApiCreationPreparedV1 {
	readonly rows: AgentApiCreationRowsV1;
	readonly outboxIntent: NonNullable<
		AgentManagementWritePlanV1["outboxIntent"]
	>;
	readonly attachments?: PendingSecretRecordAttachmentsV1;
	readonly defaultRelayKey?: ApplicationFoundationRelayKeyAttachmentV1;
}
export interface AgentApiCreationTransactionV1 {
	createAgentApiTransaction(
		input: {
			readonly material: string;
			readonly command: AgentApiCreationCommandV1;
			readonly requestDigest: string;
		},
		prepare: (
			authority: AgentApiCreationAuthorityV1,
		) => Promise<AgentApiCreationPreparedV1>,
	): Promise<AgentApiCreationResultV1>;
}

export function captureAgentApiCreatePrincipalsV1(
	input: readonly ApiPrincipalV1[] = [],
): readonly ApiPrincipalV1[] {
	if (!Array.isArray(input) || input.length > 16384)
		throw new PersonalApiCredentialErrorV1("invalid_input");
	return Object.freeze(
		input.map((value) => {
			const principal = snapshotAgentManagementDataObject(value);
			if (
				Object.keys(principal).length !== 2 ||
				!["user", "application"].includes(principal.kind as string) ||
				!isAgentManagementText(principal.id)
			)
				throw new PersonalApiCredentialErrorV1("invalid_input");
			return Object.freeze({
				kind: principal.kind as ApiPrincipalV1["kind"],
				id: principal.id,
			});
		}),
	);
}
export function requireAgentApiCreatePermissionV1(
	principal: ApiPrincipalV1,
	allowed: readonly ApiPrincipalV1[],
): void {
	if (
		!allowed.some(
			(entry) => entry.kind === principal.kind && entry.id === principal.id,
		)
	)
		throw new PersonalApiCredentialErrorV1("forbidden");
}
export function agentApiCreationIdsV1(principal: ApiPrincipalV1, key: string) {
	const digest = platformIdempotencyV1.canonicalRequestDigest({
		operation: "agent.api.create.v1",
		principal: { ...principal },
		key,
	});
	return {
		agentId: `agent_api_${digest}`,
		applicationId: `application_api_${digest}`,
	};
}

function parseCommand(input: unknown): {
	command: AgentApiCreationCommandV1;
	digest: string;
} {
	try {
		const value = snapshotAgentManagementDataObject(input);
		const required = [
			"schemaVersion",
			"name",
			"description",
			"source",
			"coOwnerIds",
			"availability",
			"environment",
			"secrets",
			"idempotencyKey",
			"requestId",
			"traceId",
		];
		const allowed = new Set([
			...required,
			"modelConfiguration",
			"defaultRelayKey",
		]);
		if (
			required.some((key) => !Object.hasOwn(value, key)) ||
			Object.keys(value).some((key) => !allowed.has(key))
		)
			throw new Error();
		// Canonicalization also rejects accessors, proxies, unsupported values and oversized inputs.
		const {
			idempotencyKey: _key,
			requestId: _request,
			traceId: _trace,
			...business
		} = value;
		platformIdempotencyV1.canonicalRequestDigest(
			business as Record<string, PlatformIdempotencyRequestJson>,
		);
		const captured = structuredClone(
			value,
		) as unknown as AgentApiCreationCommandV1;
		if (
			!Array.isArray(captured.secrets) ||
			captured.secrets.some(
				(secret) =>
					Object.keys(secret).length !== 2 ||
					!isAgentManagementText(secret.name) ||
					!isAgentManagementText(secret.value, 65536),
			)
		)
			throw new Error();
		const parsed = parseApplicationFoundationCommandV1({
			...captured,
			agentId: "api-unbound",
			applicationId: "api-unbound",
			secrets: captured.secrets.map(({ name }) => ({ name, replace: true })),
			channels: [],
		});
		if (
			(parsed.schemaVersion === 2 &&
				(parsed.source.kind !== "custom" ||
					parsed.defaultRelayKey !== undefined ||
					parsed.modelConfiguration !== undefined)) ||
			(parsed.schemaVersion === 3 && parsed.source.kind !== "standard")
		)
			throw new Error();
		const {
			applicationId: _application,
			agentId: _agent,
			idempotencyKey: _idempotency,
			name: _name,
			description: _description,
			defaultRelayKey: _relay,
			...initial
		} = parsed;
		const normalized = parseInitialCommand({
			...initial,
			agentId: "api-unbound",
		});
		const {
			agentId: _normalizedAgent,
			channels: _channels,
			requestId: _normalizedRequest,
			traceId: _normalizedTrace,
			...configuration
		} = normalized;
		const secrets = captured.secrets.toSorted((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
		);
		const digest = platformIdempotencyV1.canonicalRequestDigest({
			...configuration,
			name: captured.name,
			description: captured.description,
			secrets,
			...(captured.defaultRelayKey
				? { defaultRelayKey: captured.defaultRelayKey }
				: {}),
		} as unknown as Record<string, PlatformIdempotencyRequestJson>);
		return { command: { ...captured, ...configuration, secrets }, digest };
	} catch {
		throw new PersonalApiCredentialErrorV1("invalid_input");
	}
}

export function createAgentApiCreationV1(dependencies: {
	readonly transaction: AgentApiCreationTransactionV1;
	readonly admissions: InitialAgentConfigurationAdmissionDependenciesV1;
	readonly defaultRelayKey?: ApplicationFoundationUseCaseDependenciesV1["defaultRelayKey"];
	readonly prepareSecrets?: (input: {
		readonly agentId: string;
		readonly ownerId: string;
		readonly secrets: AgentApiCreationCommandV1["secrets"];
	}) => Promise<PendingSecretRecordAttachmentResolverV1 | undefined>;
}) {
	return {
		async create(
			input: unknown,
			material: string,
		): Promise<AgentApiCreationResultV1> {
			const { command, digest } = parseCommand(input);
			return dependencies.transaction.createAgentApiTransaction(
				{ command, material, requestDigest: digest },
				async (authority) => {
					const {
						idempotencyKey: _key,
						name: _name,
						description: _description,
						defaultRelayKey: key,
						...initial
					} = command;
					const admission = await beginInitialAgentConfigurationAdmissionV1(
						{
							...initial,
							agentId: authority.agentId,
							secrets: command.secrets.map(({ name }) => ({
								name,
								replace: true as const,
							})),
							channels: [],
						} as Parameters<
							typeof beginInitialAgentConfigurationAdmissionV1
						>[0],
						{
							schemaVersion: 1,
							actorId: authority.principal.id,
							rawRequestDigest: digest,
						},
						{
							...dependencies.admissions,
							authorizationAdmission: authority.authorizationAdmission,
						},
						{ principal: authority.principal, ownerId: authority.ownerId },
					);
					const admitted = await admission.complete();
					let defaultRelayKey:
						| ApplicationFoundationRelayKeyAttachmentV1
						| undefined;
					if (admitted.configuration.source.kind === "standard") {
						const ports = dependencies.defaultRelayKey;
						if (!ports || !key || !admitted.configuration.modelConfiguration)
							throw new PersonalApiCredentialErrorV1("unavailable");
						const visible = await ports.candidates(key, admitted.configuration);
						if (
							admitted.configuration.modelConfiguration.options.some(
								(option) =>
									!visible.some(
										(candidate) =>
											candidate.endpointId === option.endpointId &&
											candidate.modelId === option.modelId &&
											option.reasoningLevels.every((level) =>
												candidate.reasoningLevels.includes(level),
											),
									),
							)
						)
							throw new PersonalApiCredentialErrorV1("invalid_input");
						defaultRelayKey = {
							encrypt: (binding) => ports.encrypt(binding, key),
						};
					}
					const occurredAt = new Date();
					const rows: AgentApiCreationRowsV1 = {
						agent: {
							agentId: authority.agentId,
							currentConfigurationRevision: 1,
							authorizationRevision: admitted.authorizationRevision,
							createdAt: occurredAt,
						},
						application: {
							applicationId: authority.applicationId,
							agentId: authority.agentId,
							applicantId: authority.ownerId,
							name: command.name,
							description: command.description,
							status: "creating",
							creationChannel: "api",
							creatorPrincipalType: authority.principal.kind,
							creatorPrincipalId: authority.principal.id,
							managementRevision: 1,
							approvalRevision: null,
							desiredState: "running",
							workloadRevision: 1,
							fence: 1,
							traceId: command.traceId,
							requestId: command.requestId,
							submittedAt: occurredAt,
						},
						configurationRevision: {
							agentId: authority.agentId,
							revision: 1,
							configuration: admitted.configuration,
							createdAt: occurredAt,
						},
						access: {
							agentId: authority.agentId,
							ownerIds: admitted.ownerIds,
							availability: admitted.availability,
							createdAt: occurredAt,
						},
						creator: authority.principal,
						grants: { manage: randomUUID(), use: randomUUID() },
					};
					if (command.secrets.length && !dependencies.prepareSecrets)
						throw new PersonalApiCredentialErrorV1("unavailable");
					const attachment = command.secrets.length
						? await dependencies.prepareSecrets?.({
								agentId: authority.agentId,
								ownerId: authority.ownerId,
								secrets: command.secrets,
							})
						: undefined;
					const attachments = await resolvePendingSecretRecordAttachmentsV1({
						attachment,
						configuration: admitted.configuration,
						ownerId: authority.ownerId,
						occurredAt,
					});
					return {
						rows,
						outboxIntent: {
							operation: "agent.workload.reconcile.v1",
							payload: {
								schemaVersion: 1,
								agentId: authority.agentId,
								revision: 1,
								workloadRevision: 1,
								fence: 1,
								desiredState: "running",
							},
							traceId: command.traceId,
							requestId: command.requestId,
							occurredAt,
						},
						...(attachments ? { attachments } : {}),
						...(defaultRelayKey ? { defaultRelayKey } : {}),
					};
				},
			);
		},
	};
}

/** Completion facts belong to Core; the Store supplies only current locked state. */
export function planAgentApiCreationCompletionV1(input: {
	readonly state: AgentManagementStateV1;
	readonly principal: ApiPrincipalV1;
	readonly command: Pick<AgentApiCreationCommandV1, "requestId" | "traceId">;
	readonly initial?: AgentApiCreationRowsV1;
}) {
	const state = parseAgentManagementPortState(input.state);
	if (
		state.creationChannel !== "api" ||
		(input.initial &&
			(state.agentId !== input.initial.agent.agentId ||
				state.status !== "creating" ||
				state.revision !== 1))
	)
		throw new PersonalApiCredentialErrorV1("unavailable");
	const result: AgentApiCreationResultV1 = {
		schemaVersion: 1,
		agentId: state.agentId,
		status: state.status,
		revision: state.revision,
		replayed: input.initial === undefined,
	};
	return {
		result,
		auditEvent: {
			agentId: state.agentId,
			actorType: input.principal.kind,
			actorId: input.principal.id,
			action: input.initial
				? "api.agent.create.accepted"
				: "api.agent.create.replayed",
			targetType: "agent",
			targetId: state.agentId,
			outcome: "succeeded" as const,
			traceId: input.command.traceId,
			requestId: input.command.requestId,
			occurredAt: new Date(),
			details: input.initial
				? {
						schemaVersion: 1,
						ownerId: input.initial.application.applicantId,
						initialManageRevision: input.initial.grants.manage,
						initialUseRevision: input.initial.grants.use,
					}
				: { schemaVersion: 1 },
		},
	};
}
