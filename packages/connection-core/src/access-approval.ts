export type AccessDuration =
	| { days: number; kind: "FINITE" }
	| { kind: "PERMANENT" };

export type AccessRequestInput = {
	applicantPrincipalId: string;
	capabilityProfileId: string;
	disclaimerConfirmations: readonly {
		contentSha256: string;
		disclaimerVersionId: string;
		locale: string;
	}[];
	duration: AccessDuration;
	id: string;
	policyVersionId: string;
	presentationId: string;
	providerReleaseId: string;
	purpose: string;
};

export type ApprovalDecisionInput = {
	actorPrincipalId: string;
	approverPrincipalId: string;
	comment?: string;
	decision: "APPROVE" | "REJECT";
	expectedRequestRevision: string;
	expectedRoutingRevision: string;
	expectedStageRevision: string;
	id: string;
	requestId: string;
};

export type ApprovalDelegation = {
	delegateName: string;
	delegatePrincipalId: string;
	endsAt: string;
	id: string;
	principalId: string;
	principalName: string;
	revision: string;
	startsAt: string;
	status: "ACTIVE" | "REVOKED" | "EXPIRED";
};

export type ApprovalDelegationInput = {
	actorPrincipalId: string;
	delegatePrincipalId: string;
	endsAt: string;
	id: string;
	principalId: string;
	startsAt: string;
};

export type ApprovalRerouteInput = {
	actorPrincipalId: string;
	approvers: readonly {
		displaySnapshot: Readonly<Record<string, string | null>>;
		principalId: string;
	}[];
	expectedRequestRevision: string;
	expectedRoutingRevision: string;
	expectedStageRevision: string;
	reason: string;
	requestId: string;
};

export type AccessOption = {
	capabilityProfileId: string;
	capabilityProfileName: string;
	disclaimers: readonly {
		content: string;
		contentSha256: string;
		id: string;
		locale: string;
	}[];
	durations: readonly AccessDuration[];
	effectCeiling: "READ" | "WRITE";
	policyVersionId: string;
	presentationId: string;
	providerId: string;
	providerReleaseId: string;
	requiredScopes: readonly string[];
};

export type AccessConnectReady = {
	connectExpiresAt: string;
	providerId: string;
	providerReleaseId: string;
	requestId: string;
};

export type AccessRequestProjection = {
	capabilityProfileName: string;
	connectExpiresAt: string | null;
	createdAt: string;
	currentStageOrdinal: number | null;
	duration: AccessDuration;
	expiresAt: string;
	id: string;
	providerId: string;
	providerReleaseId: string;
	purpose: string;
	renewal: boolean;
	revision: string;
	stages: readonly {
		completedAt: string | null;
		decisions: readonly {
			actorName: string;
			approverName: string;
			comment: string | null;
			decidedAt: string;
			decision: "APPROVE" | "REJECT";
		}[];
		name: string;
		openedAt: string | null;
		ordinal: number;
		routingRevision: string;
		state: string;
		revision: string;
	}[];
	state: string;
};

export type ApprovalQueueItem = AccessRequestProjection & {
	applicantDisplayName: string;
	approverPrincipalId: string;
	currentRequestStageId: string;
};

export type ApprovalNotification = {
	archivedAt: string | null;
	businessId: string;
	businessType:
		| "CONNECTION_ACCESS_AUTHORIZATION"
		| "CONNECTION_ACCESS_REQUEST"
		| "CONNECTION_DISPATCH_FAILURE"
		| "PROVIDER_UPGRADE_TASK";
	createdAt: string;
	eventType: string;
	id: string;
	providerId: string;
	readAt: string | null;
	state: string;
};

export type ApprovalNotifications = {
	adminWorkItems: number;
	items: readonly ApprovalNotification[];
	openWorkItems: number;
	reapprovalWorkItems: number;
	unreadCount: number;
	upgradeWorkItems: number;
};

export type ConnectionWorkItem = {
	actionType: string;
	businessId: string;
	businessType:
		| "CONNECTION_ACCESS_REQUEST"
		| "CONNECTION_ACCESS_AUTHORIZATION"
		| "CONNECTION_DISPATCH_FAILURE"
		| "PROVIDER_UPGRADE_TASK";
	createdAt: string;
	dueAt: string | null;
	id: string;
	revision: string;
	status: string;
};

export type AccessAuthorizationSummary = {
	connectionId: string;
	id: string;
	ownerDisplayName: string;
	providerId: string;
	revision: string;
	state: string;
	validUntil: string | null;
};

export type ReapprovalCampaignInput = {
	actorPrincipalId: string;
	capabilityProfileId: string;
	deadlineAt: string;
	id: string;
	providerReleaseId: string;
	reason: string;
	triggerKind: "DISCLAIMER" | "POLICY" | "PROVIDER_RELEASE";
	triggerVersionId: string;
};

export interface ConnectionAccessApprovalRepository {
	createDelegation(
		input: ApprovalDelegationInput,
	): Promise<{ delegationId: string }>;
	listDelegations(principalId: string): Promise<readonly ApprovalDelegation[]>;
	revokeDelegation(input: {
		actorPrincipalId: string;
		delegationId: string;
		expectedRevision: string;
	}): Promise<{ delegationId: string }>;
	cancelRequest(input: {
		principalId: string;
		requestId: string;
	}): Promise<void>;
	createRequest(input: AccessRequestInput): Promise<{ requestId: string }>;
	createRenewalRequest(
		input: AccessRequestInput & { authorizationId: string },
	): Promise<{ requestId: string }>;
	decide(
		input: ApprovalDecisionInput,
	): Promise<{ replayed: boolean; requestId: string }>;
	reroute(input: ApprovalRerouteInput): Promise<{ requestId: string }>;
	getRequest(
		principalId: string,
		requestId: string,
	): Promise<AccessRequestProjection>;
	listAccessOptions(principalId: string): Promise<readonly AccessOption[]>;
	prepareConnect(
		principalId: string,
		requestId: string,
	): Promise<AccessConnectReady>;
	listApprovalQueue(principalId: string): Promise<readonly ApprovalQueueItem[]>;
	listNotifications(principalId: string): Promise<ApprovalNotifications>;
	listWorkItems(principalId: string): Promise<readonly ConnectionWorkItem[]>;
	markNotification(
		principalId: string,
		notificationId: string,
		archive: boolean,
	): Promise<void>;
	markNotifications(
		principalId: string,
		notificationIds: readonly string[],
		archive: boolean,
	): Promise<void>;
	listRequests(
		principalId: string,
	): Promise<readonly AccessRequestProjection[]>;
	listRoutingBlocked(
		principalId: string,
	): Promise<
		readonly (AccessRequestProjection & { applicantDisplayName: string })[]
	>;
	listCurrentAuthorizations(
		principalId: string,
	): Promise<readonly AccessAuthorizationSummary[]>;
	revokeAuthorization(input: {
		actorPrincipalId: string;
		authorizationId: string;
		expectedRevision: string;
	}): Promise<{ authorizationId: string }>;
	createReapprovalCampaign(
		input: ReapprovalCampaignInput,
	): Promise<{ campaignId: string; affectedConnections: number }>;
}

export class ConnectionAccessApprovalService {
	constructor(
		private readonly repository: ConnectionAccessApprovalRepository,
	) {}

	createDelegation(
		principalId: string,
		input: Omit<ApprovalDelegationInput, "actorPrincipalId">,
	) {
		return this.repository.createDelegation({
			...input,
			actorPrincipalId: principalId,
		});
	}

	listDelegations(principalId: string) {
		return this.repository.listDelegations(principalId);
	}

	revokeDelegation(
		principalId: string,
		delegationId: string,
		expectedRevision: string,
	) {
		return this.repository.revokeDelegation({
			actorPrincipalId: principalId,
			delegationId,
			expectedRevision,
		});
	}

	listAccessOptions(principalId: string) {
		return this.repository.listAccessOptions(principalId);
	}

	prepareConnect(principalId: string, requestId: string) {
		return this.repository.prepareConnect(principalId, requestId);
	}

	listRequests(principalId: string) {
		return this.repository.listRequests(principalId);
	}

	getRequest(principalId: string, requestId: string) {
		return this.repository.getRequest(principalId, requestId);
	}

	cancelRequest(principalId: string, requestId: string) {
		return this.repository.cancelRequest({ principalId, requestId });
	}

	submitRequest(
		principalId: string,
		input: Omit<AccessRequestInput, "applicantPrincipalId">,
	) {
		return this.repository.createRequest({
			...input,
			applicantPrincipalId: principalId,
		});
	}

	submitRenewal(
		principalId: string,
		authorizationId: string,
		input: Omit<AccessRequestInput, "applicantPrincipalId">,
	) {
		return this.repository.createRenewalRequest({
			...input,
			applicantPrincipalId: principalId,
			authorizationId,
		});
	}

	listApprovalQueue(principalId: string) {
		return this.repository.listApprovalQueue(principalId);
	}

	listNotifications(principalId: string) {
		return this.repository.listNotifications(principalId);
	}

	listWorkItems(principalId: string) {
		return this.repository.listWorkItems(principalId);
	}

	markNotifications(
		principalId: string,
		notificationIds: readonly string[],
		archive: boolean,
	) {
		return this.repository.markNotifications(
			principalId,
			notificationIds,
			archive,
		);
	}

	markNotification(
		principalId: string,
		notificationId: string,
		archive: boolean,
	) {
		return this.repository.markNotification(
			principalId,
			notificationId,
			archive,
		);
	}

	decide(
		principalId: string,
		input: Omit<ApprovalDecisionInput, "actorPrincipalId">,
	) {
		return this.repository.decide({ ...input, actorPrincipalId: principalId });
	}

	listRoutingBlocked(principalId: string) {
		return this.repository.listRoutingBlocked(principalId);
	}

	listCurrentAuthorizations(principalId: string) {
		return this.repository.listCurrentAuthorizations(principalId);
	}

	revokeAuthorization(
		principalId: string,
		authorizationId: string,
		expectedRevision: string,
	) {
		return this.repository.revokeAuthorization({
			actorPrincipalId: principalId,
			authorizationId,
			expectedRevision,
		});
	}

	createReapprovalCampaign(
		principalId: string,
		input: Omit<ReapprovalCampaignInput, "actorPrincipalId">,
	) {
		return this.repository.createReapprovalCampaign({
			...input,
			actorPrincipalId: principalId,
		});
	}

	reroute(
		principalId: string,
		input: Omit<ApprovalRerouteInput, "actorPrincipalId">,
	) {
		return this.repository.reroute({ ...input, actorPrincipalId: principalId });
	}
}
