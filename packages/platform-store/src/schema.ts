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
	fileLimitDeclarations,
	fileReconciliation,
	platformFileAccesses,
	platformFiles,
	wecomConnections,
	wecomConversationRotations,
	wecomReceiptMedia,
	wecomReceipts,
	wecomSetupSessions,
} from "./schema-channels-files";
import {
	connectionInstallationAuthorizations,
	connectionInstallationCommands,
} from "./schema-connection-installation.js";
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

export {
	connectionInstallationAuthorizations,
	connectionInstallationCommands,
} from "./schema-connection-installation.js";

import {
	skillHubAgentBindings,
	skillHubInstallations,
	skillHubProjectContents,
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
	fileLimitDeclarations,
	fileReconciliation,
	platformFileAccesses,
	platformFiles,
	wecomConnections,
	wecomConversationRotations,
	wecomReceiptMedia,
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
	skillHubProjectContents,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub";

import {
	evaluationDatasets,
	evaluationDerivedObjects,
	evaluationExperiments,
	evaluationGrants,
	evaluationPolicies,
	evaluationSampleTasks,
	evaluationScoreIntents,
	evaluationScoreReviews,
	evaluationVersions,
	taskFeedback,
} from "./schema-evaluation.js";

export const platformInfrastructureTables = [
	evaluationExperiments,
	evaluationSampleTasks,
	evaluationScoreIntents,
	evaluationScoreReviews,
	evaluationDerivedObjects,
	evaluationDatasets,
	evaluationGrants,
	evaluationPolicies,
	evaluationVersions,
	taskFeedback,
	connectionInstallationAuthorizations,
	connectionInstallationCommands,
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
	wecomReceiptMedia,
	wecomConnections,
	wecomConversationRotations,
	wecomSetupSessions,
	platformFiles,
	platformFileAccesses,
	fileLimitDeclarations,
	fileReconciliation,
	skillHubSkills,
	skillHubVersions,
	skillHubInstallations,
	skillHubAgentBindings,
	skillHubProjectContents,
] as const;

import { sessionSandboxAllocations } from "./schema-session-sandboxes";

export {
	evaluationDatasets,
	evaluationDerivedObjects,
	evaluationExperiments,
	evaluationGrants,
	evaluationPolicies,
	evaluationSampleTasks,
	evaluationScoreIntents,
	evaluationScoreReviews,
	evaluationVersions,
	taskFeedback,
} from "./schema-evaluation.js";
export { sessionSandboxAllocations } from "./schema-session-sandboxes";
