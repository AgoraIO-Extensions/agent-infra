import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("platform-core package surface", () => {
	it("separates the production Interface from deterministic test controls", async () => {
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		expect(manifest.dependencies).toBeUndefined();
		expect(manifest.exports).toEqual({
			".": {
				types: "./dist/index.d.mts",
				import: "./dist/index.mjs",
			},
			"./testing": {
				types: "./dist/testing.d.mts",
				import: "./dist/testing.mjs",
			},
		});
		expect(manifest.files).toEqual(["dist"]);

		const surface = await import(
			new URL("../dist/index.mjs", import.meta.url).href
		);
		const declarations = await readFile(
			new URL("../dist/index.d.mts", import.meta.url),
			"utf8",
		);
		expect(declarations).not.toMatch(
			/beginInitialAgentConfigurationAdmissionV1|decodeAgentConfigurationRecordV1|InitialAgentConfigurationAdmissionHandleV1/,
		);
		expect(Object.keys(surface).toSorted()).toEqual([
			"AgentConfigurationError",
			"AgentManagementError",
			"ApplicationApiCredentialErrorV1",
			"ApplicationFoundationError",
			"ApplicationMaterialGrantErrorV1",
			"ApplicationRegistrationErrorV1",
			"ApplicationRevisionError",
			"ConversationDispatchError",
			"ConversationEventError",
			"ConversationExecutionError",
			"ConversationRuntimeHostError",
			"FileAuthorityError",
			"PersonalApiCredentialErrorV1",
			"PersonalRelayKeyErrorV1",
			"PlatformAuditScopeErrorV1",
			"PlatformIdempotencyError",
			"RecentPersonalConversationsError",
			"SecretActivationError",
			"SecretKeyRotationError",
			"TaskApiAuditError",
			"WecomSetupError",
			"WorkloadPreflightRejectedErrorV1",
			"bindInputFileV1",
			"canDrainSessionSandboxComputeV1",
			"canPrepareSessionSandboxReplacementV1",
			"capturePersonalApiTaskAuthorizationBoundaryV1",
			"captureTaskApplicationAuthorizationBoundaryV1",
			"captureTaskAuthorizationBoundaryV1",
			"cleanupUnactivatedSecretCandidateV1",
			"conversationExecutionKeySubjectV1",
			"conversationExecutionSourceV1",
			"createAgentConfigurationUseCaseV1",
			"createAgentManagementV1",
			"createApplicationApiCredentialIssuerV1",
			"createApplicationFoundationUseCaseV1",
			"createApplicationMaterialGrantUseCaseV1",
			"createApplicationRegistrationUseCaseV1",
			"createApplicationRevisionUseCaseV1",
			"createConversationDispatchUseCaseV1",
			"createConversationEventUseCaseV1",
			"createConversationExecutionUseCaseV1",
			"createConversationTaskAdmissionUseCaseV1",
			"createFileAuthorityV1",
			"createFileReconciliationV1",
			"createPersonalApiAgentReadUseCaseV1",
			"createPersonalApiCredentialUseCaseV1",
			"createPersonalRelayKeyUseCaseV1",
			"createRecentPersonalConversationsUseCaseV1",
			"createSecretActivationUseCaseV1",
			"createSecretKeyRotationUseCaseV1",
			"createSessionSandboxBindingV1",
			"createTaskApiAuditV1",
			"createTaskRuntimeAuthorizationUseCaseV1",
			"createWecomAuthorizationV1",
			"createWecomChannelV1",
			"createWecomDeliveryV1",
			"createWecomReceiptAccessV1",
			"createWecomSetupActivationV1",
			"createWecomSetupV1",
			"createWorkloadReconciliationV1",
			"decideAgentRuntimePresentationV1",
			"decideConversationDispatchCapacityV1",
			"decideConversationDispatchRetryTransitionV1",
			"decideConversationTaskWaitingV1",
			"decideSessionSandboxDrainObservationV1",
			"decideSessionSandboxObservationV1",
			"immutableSecretNameV1",
			"isAdministratorAgentReadAllowedV1",
			"isAgentAccessAllowedV1",
			"isAgentOwnerV1",
			"isAgentRuntimePresentationVisibleV1",
			"isConfirmedResultFileV1",
			"isConversationGenerationBarrierConfirmedV1",
			"isPersonalApiAgentMetadataReadAllowedV1",
			"isPlatformConversationChannelCurrentV1",
			"isSessionSandboxObservationValidV1",
			"isSessionSandboxReadyV1",
			"isTaskApiChannelV1",
			"isTaskApplicationAuthorizationCurrentV1",
			"isTaskAuthorizationCurrentV1",
			"parseAgentConfigurationChangesV1",
			"parseApplicationApiCredentialCommandV1",
			"parseConversationMetadataRecoveryV1",
			"parseConversationOperationEventV2",
			"parseConversationOperationFactV2",
			"parseConversationOperationHistoryV2",
			"parseConversationPersistedEventPayloadV1",
			"parseCurrentTaskApiUseGrantV1",
			"parseCurrentTaskApplicationV1",
			"parseCurrentTaskUserV1",
			"parsePersonalApiCredentialIdV1",
			"parsePersonalApiCredentialIssuanceV1",
			"parsePersonalApiCredentialNarrowingV1",
			"parsePersonalApiCredentialRequestV1",
			"parsePersonalApiCredentialScopesV1",
			"parsePersonalApiTaskAdmissionAuthorityV1",
			"parsePlatformAuditQueryInputV1",
			"parsePlatformAuditQueryScopeV1",
			"parseSessionSandboxBindingV1",
			"parseStandardTemplateReleaseTargetV1",
			"parseTaskApiAuditInputV1",
			"parseTaskAuthorizationBoundaryV1",
			"parseTaskPrincipalV1",
			"parseWorkloadExecutionCapacityV1",
			"parseWorkloadSecretRecoveriesV1",
			"personalApiAgentMetadataGrantTypesV1",
			"personalApiCredentialIssuanceDigestV1",
			"personalApiCredentialScopesV1",
			"planConversationGenerationConfirmationV1",
			"planConversationGenerationIsolationV1",
			"planSessionSandboxManagementTransitionV1",
			"planTaskSystemControlV1",
			"platformAuditQueryActionsV1",
			"platformAuditQueryDenialReasonsV1",
			"platformAuditQueryResultsV1",
			"platformIdempotencyV1",
			"projectConversationExecutionV1",
			"projectConversationMessagesV1",
			"projectPlatformAuditQueryDenialV1",
			"projectPlatformAuditQueryRecordV1",
			"projectPlatformAuditQuerySummaryV1",
			"projectPlatformOperationAuditV1",
			"projectPlatformTaskAuditSummaryV1",
			"publicTaskStatusEventV1",
			"requireApiAuditCredentialIdentityV1",
			"requireConversationOperationSuccessorV2",
			"requirePersonalApiCredentialFutureExpiryV1",
			"requirePersonalApiCredentialNarrowingV1",
			"requirePersonalApiTaskBindingV1",
			"requirePersonalApiTaskUseAuthorizationV1",
			"requirePersonalApiUserActiveV1",
			"requirePersonalApiUserEnabledV1",
			"requirePlatformExecutionAuditBindingV1",
			"resolveCurrentPersonalApiUserV1",
			"resolveFileLimitsV1",
			"snapshotAgentConfigurationWritePlanV1",
			"snapshotAgentManagementWritePlanV1",
			"snapshotAgentRuntimePresentationExpectationV1",
			"snapshotApplicationFoundationWritePlanV1",
			"snapshotApplicationRevisionWritePlanV1",
			"taskApiSubscriptionEndAuditIdV1",
			"wecomChannelIdV1",
			"workloadManagementObservationV1",
		]);
		const testingSurface = await import(
			new URL("../dist/testing.mjs", import.meta.url).href
		);
		expect(Object.keys(testingSurface).toSorted()).toEqual([
			"FakeAgentConfigurationAdmissionsV1",
			"FakeAgentConfigurationTransactionV1",
			"FakeAgentManagementV1",
			"FakeApplicationFoundationTransactionV1",
			"FakeApplicationRevisionTransactionV1",
			"FakeConversationEventsV1",
			"FakeConversationExecutionV1",
			"FakeConversationRuntimeHostV1",
			"FakeFileStoreV1",
			"FakePlatformIdempotencyDatabaseV1",
			"FakeSecretActivationDecryptorV1",
			"FakeSecretActivationKubernetesV1",
			"applicationRevisionFailurePoints",
			"conversationCommandConformanceV1",
			"conversationConformanceAuthorityV1",
			"conversationEventConformanceV1",
		]);
		expect(
			Object.keys(new testingSurface.FakeAgentManagementV1()).toSorted(),
		).toEqual([
			"executeManagementCommand",
			"recordWorkloadObservation",
			"resolveAgentAccess",
		]);
		const managementSource = await readFile(
			new URL("./agent-management.ts", import.meta.url),
			"utf8",
		);
		expect(managementSource).not.toContain("agent-management-access-policy");
		expect(surface).not.toHaveProperty("decideAgentAccessUpdatePolicy");
		expect(
			Object.keys(surface.createApplicationFoundationUseCaseV1({})),
		).toEqual(["submit", "replayLegacyV1"]);
		expect(Object.keys(surface.createApplicationRevisionUseCaseV1({}))).toEqual(
			["revise", "replayLegacyV1"],
		);

		const pack = JSON.parse(
			execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
				cwd: packageRoot,
				encoding: "utf8",
			}),
		)[0];
		const packedFiles = pack.files.map((file: { path: string }) => file.path);
		expect(packedFiles).toEqual(
			expect.arrayContaining([
				"dist/index.d.mts",
				"dist/index.mjs",
				"dist/testing.d.mts",
				"dist/testing.mjs",
			]),
		);
		expect(
			packedFiles.some((path: string) =>
				/conformance|schema|postgres|drizzle|\.test\./.test(path),
			),
		).toBe(false);
	});
});
