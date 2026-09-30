import { isDeepStrictEqual } from "node:util";
import { parseStoredKeylessRuntimeV4 } from "./agent-configuration-record.js";
import type {
	AgentConfigurationRecordV2,
	AgentDefaultModelAdmissionV1,
} from "./agent-configuration-types.js";
import type {
	ApiCredentialMetadataV1,
	ApiPrincipalV1,
} from "./api-identity.js";

type StandardSource = Extract<
	AgentConfigurationRecordV2["source"],
	{ kind: "standard" }
>;
type RuntimeV4 = NonNullable<
	AgentConfigurationRecordV2["runtimeModelConfigurationV4"]
>;

export interface AgentDefaultRelayKeySelectionV1 {
	readonly catalogRevision: string;
	readonly options: readonly {
		readonly optionId: string;
		readonly endpointId: string;
		readonly modelId: string;
		readonly reasoningLevels: readonly string[];
	}[];
	readonly defaultOptionId: string;
	readonly defaultReasoningLevel: string;
}

export interface AgentDefaultRelayKeyActorV1 {
	readonly userId: string;
	readonly accountStatus: "active" | "disabled";
	readonly principal?: ApiPrincipalV1;
	readonly identityRevision?: string;
	readonly credential?: Pick<ApiCredentialMetadataV1, "credentialId">;
}

export interface AgentDefaultRelayKeyApiAccessV1 {
	readonly credentialId: string;
	readonly identityRevision: string;
}

export function isAgentDefaultRelayKeyAuthorizedV1(input: {
	readonly actorUserId: string;
	readonly currentUser: {
		readonly userId: string;
		readonly accountStatus: "active" | "disabled";
		readonly authorizationRevision?: string;
	} | null;
	readonly isOwner: boolean;
	readonly source: AgentConfigurationRecordV2["source"];
	readonly runtime: AgentConfigurationRecordV2["runtimeModelConfigurationV4"];
	readonly api?: AgentDefaultRelayKeyApiAccessV1;
	readonly agentAuthorizationRevision: string | null;
	readonly credential?: {
		readonly principalType: string;
		readonly principalId: string;
		readonly scopes: unknown;
		readonly expiresAt: Date | null;
		readonly revokedAt: Date | null;
	} | null;
	readonly grant?: {
		readonly authorizationRevision: string;
		readonly revokedAt: Date | null;
	} | null;
}): boolean {
	if (
		input.currentUser?.userId !== input.actorUserId ||
		input.currentUser.accountStatus !== "active" ||
		!input.isOwner ||
		input.source.kind !== "standard" ||
		!input.runtime
	)
		return false;
	if (!input.api) return true;
	const { credential, grant } = input;
	return (
		input.currentUser.authorizationRevision === input.api.identityRevision &&
		credential?.principalType === "user" &&
		credential.principalId === input.actorUserId &&
		credential.revokedAt === null &&
		(credential.expiresAt === null ||
			credential.expiresAt.getTime() > Date.now()) &&
		Array.isArray(credential.scopes) &&
		credential.scopes.includes("agent:manage") &&
		input.agentAuthorizationRevision !== null &&
		grant?.authorizationRevision === input.agentAuthorizationRevision &&
		grant.revokedAt === null
	);
}

export interface AgentDefaultRelayKeyStorePortV1 {
	current(input: {
		readonly agentId: string;
		readonly actorUserId: string;
		readonly api?: AgentDefaultRelayKeyApiAccessV1;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<{
		readonly keyVersion: number | null;
		readonly configurationRevision: number;
		readonly source: StandardSource;
		readonly runtime: RuntimeV4;
	} | null>;
	replace(input: {
		readonly agentId: string;
		readonly actorUserId: string;
		readonly api?: AgentDefaultRelayKeyApiAccessV1;
		readonly expectedVersion: number | null;
		readonly expectedConfigurationRevision: number;
		readonly keyValue: string;
		readonly traceId: string;
		readonly requestId: string;
	}): Promise<number | null>;
	recordRejected(input: {
		readonly agentId: string;
		readonly actorUserId: string | null;
		readonly traceId: string;
		readonly requestId: string;
		readonly reason: string;
		readonly outcome: "rejected" | "failed";
	}): Promise<void>;
}

export type AgentDefaultRelayKeyErrorCodeV1 =
	| "not_authorized"
	| "invalid_model"
	| "conflict"
	| "dependency_unavailable";

export class AgentDefaultRelayKeyErrorV1 extends Error {
	constructor(readonly code: AgentDefaultRelayKeyErrorCodeV1) {
		super(code);
		this.name = "AgentDefaultRelayKeyErrorV1";
	}
}

export function agentDefaultRelayKeyAuditIntentV1(
	input:
		| { readonly operation: "current" }
		| { readonly operation: "replace"; readonly result: "replaced" | "stale" }
		| {
				readonly operation: "rejected";
				readonly outcome: "rejected" | "failed";
				readonly reason: string;
		  },
): {
	readonly action:
		| "relay_key.agent_default.read"
		| "relay_key.agent_default.replaced"
		| "relay_key.agent_default.rejected";
	readonly outcome: "succeeded" | "rejected" | "failed";
	readonly reason?: string;
} {
	if (input.operation === "current")
		return { action: "relay_key.agent_default.read", outcome: "succeeded" };
	if (input.operation === "rejected")
		return {
			action: "relay_key.agent_default.rejected",
			outcome: input.outcome,
			reason: input.reason,
		};
	if (input.result === "stale")
		return {
			action: "relay_key.agent_default.rejected",
			outcome: "rejected",
			reason: "STALE_VERSION",
		};
	return { action: "relay_key.agent_default.replaced", outcome: "succeeded" };
}

function owner(actor: AgentDefaultRelayKeyActorV1): {
	readonly actorUserId: string;
	readonly api?: AgentDefaultRelayKeyApiAccessV1;
} {
	const credentialId = actor.credential?.credentialId;
	const identityRevision = actor.identityRevision;
	if (
		actor.accountStatus !== "active" ||
		(actor.principal !== undefined &&
			(actor.principal.kind !== "user" ||
				actor.principal.id !== actor.userId ||
				!credentialId ||
				!identityRevision))
	)
		throw new AgentDefaultRelayKeyErrorV1("not_authorized");
	if (actor.principal !== undefined && credentialId && identityRevision)
		return {
			actorUserId: actor.userId,
			api: { credentialId, identityRevision },
		};
	return {
		actorUserId: actor.userId,
	};
}

function state(keyVersion: number | null) {
	return {
		schemaVersion: 1 as const,
		isSet: keyVersion !== null,
		keyVersion,
	};
}

function sameModels(current: RuntimeV4, candidate: RuntimeV4): boolean {
	const comparable = (runtime: RuntimeV4) => ({
		defaultModelOptionId: runtime.defaultModelOptionId,
		defaultReasoningLevel: runtime.defaultReasoningLevel,
		modelOptions: runtime.modelOptions
			.map((option) => ({
				...option,
				reasoningLevels: [...option.reasoningLevels].sort(),
			}))
			.sort((left, right) =>
				left.modelOptionId.localeCompare(right.modelOptionId),
			),
	});
	return isDeepStrictEqual(comparable(current), comparable(candidate));
}

/** The candidate Key must still admit the Agent's current model choices. */
export function createAgentDefaultRelayKeyUseCaseV1(input: {
	readonly store: AgentDefaultRelayKeyStorePortV1;
	readonly admit: (
		request: Parameters<AgentDefaultModelAdmissionV1["admitModels"]>[0] & {
			readonly requested: AgentDefaultRelayKeySelectionV1;
			readonly candidateRelayKey: string;
		},
	) => ReturnType<AgentDefaultModelAdmissionV1["admitModels"]>;
}) {
	const { store, admit } = input;
	return {
		async current(
			actor: AgentDefaultRelayKeyActorV1,
			agentId: string,
			traceId: string,
			requestId: string,
		) {
			const current = await store.current({
				agentId,
				...owner(actor),
				traceId,
				requestId,
			});
			if (!current) throw new AgentDefaultRelayKeyErrorV1("not_authorized");
			return state(current.keyVersion);
		},
		async replace(
			actor: AgentDefaultRelayKeyActorV1,
			agentId: string,
			command: {
				readonly expectedVersion: number | null;
				readonly keyValue: string;
				readonly modelSelection: AgentDefaultRelayKeySelectionV1;
			},
			traceId: string,
			requestId: string,
		) {
			const access = owner(actor);
			const { actorUserId } = access;
			const current = await store.current({
				agentId,
				...access,
				traceId,
				requestId,
			});
			if (!current) throw new AgentDefaultRelayKeyErrorV1("not_authorized");
			if (current.keyVersion !== command.expectedVersion) {
				await store.recordRejected({
					agentId,
					actorUserId,
					traceId,
					requestId,
					reason: "STALE_VERSION",
					outcome: "rejected",
				});
				throw new AgentDefaultRelayKeyErrorV1("conflict");
			}
			let admitted: Awaited<ReturnType<typeof admit>>;
			try {
				admitted = await admit({
					agentId,
					requestId,
					traceId,
					source: current.source,
					requested: command.modelSelection,
					candidateRelayKey: command.keyValue,
				});
			} catch (error) {
				if (error instanceof AgentDefaultRelayKeyErrorV1) throw error;
				throw new AgentDefaultRelayKeyErrorV1("dependency_unavailable");
			}
			let candidate: RuntimeV4;
			try {
				candidate = parseStoredKeylessRuntimeV4(admitted.runtime);
			} catch {
				throw new AgentDefaultRelayKeyErrorV1("dependency_unavailable");
			}
			if (!sameModels(current.runtime, candidate))
				throw new AgentDefaultRelayKeyErrorV1("invalid_model");
			const keyVersion = await store.replace({
				agentId,
				...access,
				expectedVersion: command.expectedVersion,
				expectedConfigurationRevision: current.configurationRevision,
				keyValue: command.keyValue,
				traceId,
				requestId,
			});
			if (keyVersion === null)
				throw new AgentDefaultRelayKeyErrorV1("conflict");
			return state(keyVersion);
		},
		recordRejected: store.recordRejected.bind(store),
	};
}
