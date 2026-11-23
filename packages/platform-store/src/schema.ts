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
	connectionManualInstallations,
	connectionManualInstallPermits,
	connectionPrincipalPinReceipts,
	connectionPrincipalPins,
} from "./schema-connection-installation.js";
import {
	connectionAssociationGenerations,
	connectionConsumerDisables,
	connectionConsumerRegistrations,
	connectionHostSupplies,
	connectionMachineClientBindings,
	connectionManualAssociations,
} from "./schema-connection-registration.js";
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
	oidcEmployeeAccounts,
	oidcLoginTransactions,
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
import {
	operationsResourceIdentities,
	operationsResourceSnapshots,
} from "./schema-operations-resources";
import { relayKeySubjects, relayKeyVersions } from "./schema-relay-keys";
import { runtimeSafetyEvidence } from "./schema-runtime-safety-evidence";

export {
	operationsResourceIdentities,
	operationsResourceSnapshots,
} from "./schema-operations-resources";

import {
	sessionSandboxBudgets,
	sessionSandboxExecutorPromotions,
	sessionSandboxReserves,
	sessionSandboxResourceCharges,
} from "./schema-session-sandbox-reserves.js";
import { browserSessions } from "./schema-sessions";
import {
	workspaceSnapshotBindings,
	workspaceSnapshots,
	workspaceSnapshotUploadAdmissions,
	workspaceSnapshotUploadObjects,
	workspaceSnapshotUploadReservations,
} from "./schema-workspace-snapshots";

export {
	connectionInstallationAuthorizations,
	connectionInstallationCommands,
	connectionManualInstallations,
	connectionManualInstallPermits,
	connectionPrincipalPinReceipts,
	connectionPrincipalPins,
} from "./schema-connection-installation.js";
export {
	connectionAssociationGenerations,
	connectionConsumerDisables,
	connectionConsumerRegistrations,
	connectionHostSupplies,
	connectionMachineClientBindings,
	connectionManualAssociations,
} from "./schema-connection-registration.js";

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
	oidcEmployeeAccounts,
	oidcLoginTransactions,
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
export { runtimeSafetyEvidence } from "./schema-runtime-safety-evidence";
export { browserSessions } from "./schema-sessions";
export {
	skillHubAgentBindings,
	skillHubInstallations,
	skillHubProjectContents,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub";
export {
	workspaceSnapshotBindings,
	workspaceSnapshots,
	workspaceSnapshotUploadAdmissions,
	workspaceSnapshotUploadObjects,
	workspaceSnapshotUploadReservations,
} from "./schema-workspace-snapshots";

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
	connectionConsumerRegistrations,
	connectionConsumerDisables,
	connectionHostSupplies,
	connectionMachineClientBindings,
	connectionManualAssociations,
	connectionAssociationGenerations,
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
	connectionManualInstallations,
	connectionPrincipalPins,
	connectionPrincipalPinReceipts,
	connectionManualInstallPermits,
	platformUserDisables,
	ldapIdentityIds,
	oidcEmployeeAccounts,
	oidcLoginTransactions,
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
	sessionSandboxBudgets,
	sessionSandboxReserves,
	sessionSandboxResourceCharges,
	sessionSandboxExecutorPromotions,
	taskAuthorizationRecords,
	operationsResourceSnapshots,
	operationsResourceIdentities,
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
	workspaceSnapshotUploadReservations,
	workspaceSnapshotUploadObjects,
	workspaceSnapshots,
	workspaceSnapshotBindings,
	workspaceSnapshotUploadAdmissions,
	runtimeSafetyEvidence,
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
export * from "./schema-session-sandbox-reserves.js";
export { sessionSandboxAllocations } from "./schema-session-sandboxes";
