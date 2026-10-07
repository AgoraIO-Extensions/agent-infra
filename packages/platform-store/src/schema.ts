import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agents,
	platformSecretRecords,
	retiredSecretWrappingKeys,
	secretKeyRotations,
	workloadReconciliations,
} from "./schema-agents";
import {
	fileReconciliation,
	platformFileAccesses,
	platformFiles,
	wecomConnections,
	wecomReceipts,
	wecomSetupSessions,
} from "./schema-channels-files";
import {
	conversationAuditEvents,
	conversationEvents,
	conversationExecutions,
	conversationMessages,
	conversationStops,
	conversations,
} from "./schema-conversations";
import {
	agentPrincipalGrants,
	apiCredentialDeliveryGrants,
	ldapIdentityIds,
	platformApiCredentials,
	platformApplications,
	platformUserDisables,
} from "./schema-identities";
import {
	auditEvents,
	conversationGenerationTombstones,
	idempotencyRecords,
	outboxItems,
	persistedEvents,
	taskAuthorizationRecords,
	taskControlRecords,
} from "./schema-operations";
import { relayKeySubjects, relayKeyVersions } from "./schema-relay-keys";
import { browserSessions } from "./schema-sessions";
import {
	skillHubAgentBindings,
	skillHubInstallations,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub";

export {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agentOwners,
	agents,
	platformSecretRecords,
	retiredSecretWrappingKeys,
	secretKeyRotations,
	workloadReconciliations,
} from "./schema-agents";
export {
	fileReconciliation,
	platformFileAccesses,
	platformFiles,
	wecomConnections,
	wecomReceipts,
	wecomSetupSessions,
} from "./schema-channels-files";
export {
	agentAvailabilityTargetType,
	agentDesiredState,
	agentFailureCode,
	agentManagementOperation,
	agentManagementStatus,
	agentManagementSubjectType,
	agentServiceAvailability,
	auditOutcome,
	conversationExecutionStatus,
	conversationMessageStatus,
	conversationStatus,
	conversationStopStatus,
	idempotencyStatus,
	outboxStatus,
	platformSchema,
	platformStatusValues,
	secretKeyRotationState,
} from "./schema-common";
export {
	conversationAuditEvents,
	conversationEvents,
	conversationExecutions,
	conversationMessages,
	conversationStops,
	conversations,
} from "./schema-conversations";
export {
	agentPrincipalGrants,
	apiCredentialDeliveryGrants,
	ldapIdentityIds,
	platformApiCredentials,
	platformApplications,
	platformUserDisables,
} from "./schema-identities";
export {
	auditEvents,
	conversationGenerationTombstones,
	idempotencyRecords,
	outboxItems,
	persistedEvents,
	taskAuthorizationRecords,
	taskControlRecords,
} from "./schema-operations";
export { relayKeySubjects, relayKeyVersions } from "./schema-relay-keys";
export { browserSessions } from "./schema-sessions";
export {
	skillHubAgentBindings,
	skillHubInstallations,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub";

export const platformInfrastructureTables = [
	platformUserDisables,
	ldapIdentityIds,
	browserSessions,
	agentPrincipalGrants,
	apiCredentialDeliveryGrants,
	platformApiCredentials,
	platformApplications,
	relayKeySubjects,
	relayKeyVersions,
	workloadReconciliations,
	agents,
	agentApplications,
	agentConfigurationRevisions,
	platformSecretRecords,
	secretKeyRotations,
	retiredSecretWrappingKeys,
	agentOwners,
	agentAvailability,
	agentManagementHistory,
	conversations,
	conversationExecutions,
	sessionSandboxAllocations,
	taskAuthorizationRecords,
	taskControlRecords,
	conversationGenerationTombstones,
	conversationMessages,
	conversationStops,
	conversationAuditEvents,
	conversationEvents,
	outboxItems,
	auditEvents,
	idempotencyRecords,
	persistedEvents,
	wecomReceipts,
	wecomConnections,
	wecomSetupSessions,
	platformFiles,
	platformFileAccesses,
	fileReconciliation,
	skillHubSkills,
	skillHubVersions,
	skillHubInstallations,
	skillHubAgentBindings,
] as const;

import { sessionSandboxAllocations } from "./schema-session-sandboxes";

export { sessionSandboxAllocations } from "./schema-session-sandboxes";
