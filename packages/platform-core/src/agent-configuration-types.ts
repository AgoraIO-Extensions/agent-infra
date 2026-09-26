import type {
	AgentManagementActorContextV1,
	AgentManagementStateV1,
} from "./agent-management.js";
import type {
	PendingSecretRecordAttachmentResolverV1,
	PendingSecretRecordAttachmentsV1,
} from "./secret-record-attachments.js";

export type AgentConfigurationSourceV1 =
	| {
			readonly kind: "standard";
			readonly templateId: string;
			readonly imageDigest: string;
			readonly admissionRevision: string;
			readonly allowedEnvironmentKeys: readonly string[];
			readonly allowedSecretKeys: readonly string[];
			readonly platformManagedKeys: readonly string[];
			readonly connectionEnabled: boolean;
	  }
	| {
			readonly kind: "custom";
			readonly imageDigest: string;
			readonly admissionRevision: string;
			readonly interactionMode: "self-managed" | "platform-adapter";
			readonly identityResponsibility?: "self-managed" | "platform-managed";
			readonly connectionEnabled: boolean;
	  };

export interface AgentConfigurationSecretMetadataV1 {
	readonly secretId: string;
	readonly version: number;
	readonly isSet: true;
}

export interface AgentConfigurationModelOptionV1 {
	readonly optionId: string;
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
	readonly credential: AgentConfigurationSecretMetadataV1;
}

export interface AgentConfigurationModelV1 {
	readonly catalogRevision: string;
	readonly options: readonly AgentConfigurationModelOptionV1[];
	readonly defaultOptionId: string;
	readonly defaultReasoningLevel: string;
}

export interface AgentConfigurationRecordV2 {
	readonly schemaVersion: 2;
	readonly agentId: string;
	readonly revision: number;
	readonly source: AgentConfigurationSourceV1;
	readonly modelConfiguration: AgentConfigurationModelV1 | null;
	readonly environment: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly secrets: readonly {
		readonly name: string;
		readonly secretId: string;
		readonly version: number;
		readonly isSet: true;
	}[];
	readonly channels: readonly {
		readonly kind: "wecom_bot" | "wecom_app";
		readonly bindingReference: string;
	}[];
	readonly channelRevision: string;
}

/** Historical persisted shape; never a current policy or new write. */
export interface AgentConfigurationRecordV1
	extends Omit<AgentConfigurationRecordV2, "schemaVersion"> {
	readonly schemaVersion: 1;
	readonly actions: readonly AgentConfigurationActionV1[];
	readonly actionSetRevision: string;
}

export interface AgentConfigurationActionV1 {
	readonly providerId: string;
	readonly actionId: string;
	readonly actionVersion: string;
}

export type AgentConfigurationChannelKindV1 = "wecom_bot" | "wecom_app";

export type AgentConfigurationChannelChangeV1 =
	| {
			readonly kind: AgentConfigurationChannelKindV1;
			readonly enabled: true;
			readonly bindingReference: string;
	  }
	| {
			readonly kind: AgentConfigurationChannelKindV1;
			readonly enabled: false;
	  };

export interface AgentConfigurationModelOptionInputV1 {
	readonly optionId: string;
	readonly endpointId: string;
	readonly modelId: string;
	readonly reasoningLevels: readonly string[];
	readonly replaceCredential: boolean;
}

export type AgentConfigurationSourceSelectionV1 =
	| { readonly kind: "standard"; readonly templateId: string }
	| {
			readonly kind: "custom";
			readonly imageReference: string;
			readonly interactionMode: "self-managed";
			readonly identityResponsibility: "self-managed" | "platform-managed";
	  }
	| {
			readonly kind: "custom";
			readonly imageReference: string;
			readonly interactionMode: "platform-adapter";
	  };

export interface AgentConfigurationModelInputV1 {
	readonly options: readonly AgentConfigurationModelOptionInputV1[];
	readonly defaultOptionId: string;
	readonly defaultReasoningLevel: string;
}

export interface AgentConfigurationSecretReplacementInputV1 {
	readonly name: string;
	readonly replace: true;
}

export type AgentConfigurationAccessTargetV1 =
	| { readonly kind: "user"; readonly userId: string }
	| { readonly kind: "organization"; readonly organizationId: string }
	| { readonly kind: "application"; readonly applicationId: string };

export interface AgentConfigurationAuthorityContextV1 {
	readonly schemaVersion: 1;
	readonly users: readonly {
		readonly userId: string;
		readonly accountStatus: "active" | "disabled" | "revoked";
	}[];
	readonly organizationIds: readonly string[];
	readonly applicationIds?: readonly string[];
}

export interface AgentConfigurationAccessAuthorityV1 {
	readonly state: AgentManagementStateV1;
	readonly actorContext: AgentManagementActorContextV1;
	readonly authorityContext: AgentConfigurationAuthorityContextV1;
}

export interface InitialAgentConfigurationCommandV2 {
	readonly schemaVersion: 2;
	readonly agentId: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly coOwnerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
	readonly source: AgentConfigurationSourceSelectionV1;
	readonly modelConfiguration?: AgentConfigurationModelInputV1;
	readonly environment: readonly {
		readonly name: string;
		readonly value: string;
	}[];
	readonly secrets: readonly AgentConfigurationSecretReplacementInputV1[];
	readonly channels: readonly AgentConfigurationChannelChangeV1[];
}

export interface AdmittedInitialAgentConfigurationV1 {
	readonly schemaVersion: 1;
	readonly authorizationRevision: string;
	readonly configuration: AgentConfigurationRecordV2;
	readonly ownerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
}

export interface InitialAgentConfigurationAdmissionHandleV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly actorId: string;
	complete(): Promise<AdmittedInitialAgentConfigurationV1>;
}

export interface UpdateAgentConfigurationCommandV2 {
	readonly schemaVersion: 2;
	readonly agentId: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
	readonly changes: {
		readonly coOwnerIds?: readonly string[];
		readonly availability?: readonly AgentConfigurationAccessTargetV1[];
		readonly source?: AgentConfigurationSourceSelectionV1;
		readonly modelConfiguration?: AgentConfigurationModelInputV1;
		readonly environment?: readonly {
			readonly name: string;
			readonly value: string;
		}[];
		readonly secrets?: readonly AgentConfigurationSecretReplacementInputV1[];
		readonly channels?: readonly AgentConfigurationChannelChangeV1[];
	};
}

export interface LegacyUpdateAgentConfigurationCommandV1
	extends Omit<UpdateAgentConfigurationCommandV2, "schemaVersion" | "changes"> {
	readonly schemaVersion: 1;
	readonly changes: UpdateAgentConfigurationCommandV2["changes"] & {
		readonly actions?: readonly AgentConfigurationActionV1[];
	};
}

export interface UpgradeCustomAgentImageCommandV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly imageReference: string;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

/** An immutable, deployment-owned publication target; never an Owner update intent. */
export interface StandardTemplateReleaseTargetV1 {
	readonly schemaVersion: 1;
	readonly releaseId: string;
	readonly agentId: string;
	readonly templateId: string;
	readonly expectedConfigurationRevision: number;
	readonly expectedImageDigest: string;
	readonly targetImageDigest: string;
}

export interface ReleaseStandardTemplateCommandV1 {
	readonly schemaVersion: 1;
	readonly target: StandardTemplateReleaseTargetV1;
	readonly idempotencyKey: string;
	readonly requestId: string;
	readonly traceId: string;
}

export interface StandardTemplateReleaseAuthorizationV1 {
	readonly schemaVersion: 1;
	readonly status: "admitted";
	readonly intent: "standard_template.release_to_agent";
	readonly target: StandardTemplateReleaseTargetV1;
	readonly actorId: string;
	readonly accountStatus: "active";
	readonly isAdministrator: true;
	readonly identityRevision: string;
	readonly deploymentRevision: string;
	readonly authorizationRevision: string;
}

export interface StandardTemplateReleaseAuthorizationPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly intent: "standard_template.release_to_agent";
		readonly target: StandardTemplateReleaseTargetV1;
		readonly actorId: string;
		readonly requestId: string;
		readonly traceId: string;
	}): Promise<
		| StandardTemplateReleaseAuthorizationV1
		| { readonly schemaVersion: 1; readonly status: "rejected" }
	>;
}

export interface AgentConfigurationActorContextV1 {
	readonly schemaVersion: 1;
	readonly actorId: string;
	readonly rawRequestDigest: string;
}

export type AgentConfigurationChangedFieldV1 =
	| "source"
	| "environment"
	| "modelConfiguration"
	| "secrets"
	| "actions"
	| "channels"
	| "owners"
	| "availability";

export interface AgentConfigurationAccessPlanV1 {
	readonly schemaVersion: 1;
	readonly fragmentType: "agent_access";
	readonly agentId: string;
	readonly expectedRevision: number;
	readonly ownerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
}

export interface AgentConfigurationResultV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly revision: number;
	readonly changedFields: readonly AgentConfigurationChangedFieldV1[];
}

export interface AgentConfigurationWritePlanV1 {
	readonly schemaVersion: 1;
	readonly agentId: string;
	readonly baseRevision: number;
	readonly nextRevision: number;
	readonly expectedManagementRevision: number | null;
	readonly expectedAuthorizationRevision: string;
	readonly nextAuthorizationRevision: string;
	readonly configuration: AgentConfigurationRecordV2;
	readonly accessUpdate: AgentConfigurationAccessPlanV1 | null;
	readonly result: AgentConfigurationResultV1;
	readonly idempotency: {
		readonly key: string;
		readonly requestDigest: string;
	};
	readonly outboxIntent: {
		readonly operation: "agent.configuration.revised.v1";
		readonly payload: {
			readonly schemaVersion: 1;
			readonly agentId: string;
			readonly baseRevision: number;
			readonly configurationRevision: number;
			readonly changedFields: readonly AgentConfigurationChangedFieldV1[];
		};
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	} | null;
	readonly auditEvent: {
		readonly action: "agent.configuration.revised" | "agent.access.updated";
		readonly actorId: string;
		readonly agentId: string;
		readonly subjectType: "agent";
		readonly subjectId: string;
		readonly changedFields: readonly AgentConfigurationChangedFieldV1[];
		readonly traceId: string;
		readonly requestId: string;
		readonly occurredAt: Date;
	};
}

export interface AgentConfigurationTransactionPortV1 {
	read(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly actorId: string;
		readonly idempotencyKey: string;
		readonly requestDigest: string;
	}): Promise<
		| {
				readonly outcome: "ready";
				readonly record: {
					readonly schemaVersion: 1;
					readonly configuration: AgentConfigurationRecordV2;
					readonly authorizationRevision: string;
				};
		  }
		| { readonly outcome: "missing" }
		| {
				readonly outcome: "replayed";
				readonly result: AgentConfigurationResultV1;
		  }
		| { readonly outcome: "idempotency_conflict" }
	>;
	commit(
		plan: AgentConfigurationWritePlanV1,
		attachments?: PendingSecretRecordAttachmentsV1,
	): Promise<
		| {
				readonly outcome: "committed";
				readonly result: AgentConfigurationResultV1;
		  }
		| {
				readonly outcome: "replayed";
				readonly result: AgentConfigurationResultV1;
		  }
		| { readonly outcome: "stale" }
		| { readonly outcome: "idempotency_conflict" }
	>;
}

export interface AgentConfigurationAuthorizationAdmissionPortV1 {
	authorize(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly actorId: string;
		readonly requestId: string;
		readonly traceId: string;
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly actorId: string;
				readonly authorizationRevision: string;
				readonly accessAuthority?: AgentConfigurationAccessAuthorityV1;
				readonly authorityContext?: AgentConfigurationAuthorityContextV1;
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly actorId: string;
		  }
	>;
}

export interface AgentConfigurationImageAdmissionPortV1 {
	admitImage(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: AgentConfigurationSourceSelectionV1;
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly source: AgentConfigurationSourceV1;
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationModelAdmissionPortV1 {
	admitModels(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: AgentConfigurationModelInputV1;
		readonly current: AgentConfigurationModelV1 | null;
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly configuration: AgentConfigurationModelV1;
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationSecretAdmissionPortV1 {
	admitSecrets(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: readonly AgentConfigurationSecretReplacementInputV1[];
		readonly current: AgentConfigurationRecordV2["secrets"];
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly secrets: AgentConfigurationRecordV2["secrets"];
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationChannelAdmissionPortV1 {
	admitChannels(input: {
		readonly schemaVersion: 1;
		readonly agentId: string;
		readonly requestId: string;
		readonly traceId: string;
		readonly requested: readonly AgentConfigurationChannelChangeV1[];
		readonly current: AgentConfigurationRecordV2["channels"];
	}): Promise<
		| {
				readonly schemaVersion: 1;
				readonly status: "admitted";
				readonly agentId: string;
				readonly requestId: string;
				readonly channelRevision: string;
				readonly channels: AgentConfigurationRecordV2["channels"];
		  }
		| {
				readonly schemaVersion: 1;
				readonly status: "rejected";
				readonly agentId: string;
				readonly requestId: string;
		  }
	>;
}

export interface AgentConfigurationUseCaseV1 {
	releaseStandardTemplate(
		command: ReleaseStandardTemplateCommandV1,
		actorContext: AgentConfigurationActorContextV1,
	): Promise<AgentConfigurationResultV1>;
	update(
		command: UpdateAgentConfigurationCommandV2,
		actorContext: AgentConfigurationActorContextV1,
		attachment?: PendingSecretRecordAttachmentResolverV1,
	): Promise<AgentConfigurationResultV1>;
	replayLegacyV1(
		command: unknown,
		actorContext: AgentConfigurationActorContextV1,
	): Promise<AgentConfigurationResultV1>;

	upgradeCustomImage(
		command: UpgradeCustomAgentImageCommandV1,
		actorContext: AgentConfigurationActorContextV1,
	): Promise<AgentConfigurationResultV1>;
}

export type AgentConfigurationErrorCode =
	| "invalid_command"
	| "not_authorized"
	| "not_admitted"
	| "no_change"
	| "stale_revision"
	| "idempotency_conflict"
	| "dependency_unavailable"
	| "persistence_failed";

export class AgentConfigurationError extends Error {
	readonly code: AgentConfigurationErrorCode;

	constructor(code: AgentConfigurationErrorCode) {
		super(`Agent configuration ${code.replaceAll("_", " ")}`);
		this.name = "AgentConfigurationError";
		this.code = code;
	}
}

export interface AgentConfigurationUseCaseDependenciesV1 {
	readonly standardTemplateReleaseAuthorization?: StandardTemplateReleaseAuthorizationPortV1;
	readonly transaction: AgentConfigurationTransactionPortV1;
	readonly authorizationAdmission: AgentConfigurationAuthorizationAdmissionPortV1;
	readonly imageAdmission: AgentConfigurationImageAdmissionPortV1;
	readonly modelAdmission: AgentConfigurationModelAdmissionPortV1;
	readonly secretAdmission: AgentConfigurationSecretAdmissionPortV1;
	readonly channelAdmission: AgentConfigurationChannelAdmissionPortV1;
}

export type InitialAgentConfigurationAdmissionDependenciesV1 = Omit<
	AgentConfigurationUseCaseDependenciesV1,
	"transaction"
>;

export interface AgentConfigurationUseCaseOptionsV1 {
	readonly now?: () => Date;
}
