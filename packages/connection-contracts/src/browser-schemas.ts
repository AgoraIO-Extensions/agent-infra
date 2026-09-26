import { z } from "zod";

const opaqueId = z.string().min(1).max(512);

export const idempotencyKeySchema = z
	.string()
	.min(8)
	.max(200)
	.regex(/^[\x21-\x7e]+$/);

export const loginRequestSchema = z.strictObject({
	password: z.string().min(1).max(1_024),
	username: z.string().trim().min(1).max(256),
});

export const issueTokenRequestSchema = z.strictObject({
	consumerId: opaqueId.optional(),
	name: z.string().trim().min(1).max(100),
});

export const oauthTransactionRequestSchema = z
	.strictObject({
		accessRequestId: opaqueId.optional(),
		sharedScopeId: opaqueId.optional(),
	})
	.refine((value) => !(value.accessRequestId && value.sharedScopeId), {
		message: "Personal and shared connection targets are mutually exclusive",
	});

export const providerCredentialRequestSchema = z.union([
	z.strictObject({
		accessRequestId: opaqueId.optional(),
		providerId: z.literal("datalego"),
	}),
	z.strictObject({
		accessRequestId: opaqueId.optional(),
		accessToken: z.string().min(1).max(8_192),
		providerId: z.enum(["bitbucket", "rehoboam"]),
	}),
	z.strictObject({
		accessRequestId: opaqueId.optional(),
		password: z.string().min(1).max(1_024),
		providerId: z.enum(["confluence", "jira", "manhattan"]),
		username: z.string().trim().min(1).max(256),
	}),
	z.strictObject({
		accessRequestId: opaqueId.optional(),
		apiToken: z.string().min(1).max(8_192),
		providerId: z.enum(["jenkins-ci", "jenkins-release"]),
		username: z.string().trim().min(1).max(256),
	}),
]);

export const providerReconnectRequestSchema = z.union([
	z.strictObject({ mode: z.literal("OAUTH") }),
	providerCredentialRequestSchema.refine((value) => !value.accessRequestId, {
		message: "Reconnect cannot consume a new Connect Permit",
	}),
]);

export const authorizationPreviewRequestSchema = z.strictObject({
	actionVersionIds: z.array(opaqueId).min(1).max(500).optional(),
	connectionId: opaqueId,
	consumerId: opaqueId,
});

export const authorizationConsentRequestSchema = z.strictObject({
	confirmationToken: opaqueId,
	previewId: opaqueId,
});

export const accessRequestSubmitSchema = z.strictObject({
	capabilityProfileId: opaqueId,
	disclaimerConfirmations: z
		.array(
			z.strictObject({
				contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
				disclaimerVersionId: opaqueId,
				locale: z.string().min(2).max(35),
			}),
		)
		.min(1)
		.max(100),
	duration: z.union([
		z.strictObject({
			days: z.number().int().min(1).max(3_650),
			kind: z.literal("FINITE"),
		}),
		z.strictObject({ kind: z.literal("PERMANENT") }),
	]),
	policyVersionId: opaqueId,
	presentationId: opaqueId,
	providerReleaseId: opaqueId,
	purpose: z.string().trim().min(1).max(2_000),
});

export const approvalDecisionRequestSchema = z.strictObject({
	approverPrincipalId: opaqueId,
	comment: z.string().trim().min(1).max(2_000).optional(),
	decision: z.enum(["APPROVE", "REJECT"]),
	expectedRequestRevision: opaqueId,
	expectedRoutingRevision: opaqueId,
	expectedStageRevision: opaqueId,
});

export const approvalRerouteRequestSchema = z.strictObject({
	approverCandidateIds: z
		.array(opaqueId)
		.min(1)
		.max(50)
		.refine((ids) => new Set(ids).size === ids.length),
	expectedRequestRevision: opaqueId,
	expectedRoutingRevision: opaqueId,
	expectedStageRevision: opaqueId,
	reason: z.string().trim().min(1).max(1_000),
});

export const approvalDelegationDraftSchema = z.strictObject({
	principalCandidateId: opaqueId,
	delegateCandidateId: opaqueId,
	startsAt: z.iso.datetime(),
	endsAt: z.iso.datetime(),
});

export const approvalDelegationRevokeSchema = z.strictObject({
	expectedRevision: opaqueId,
});

export const outboxRetrySchema = z.strictObject({
	expectedAttempts: z.number().int().min(10),
});

export const approvalAuthorizationRevokeSchema = z.strictObject({
	expectedRevision: opaqueId,
});

export const approvalPolicyPublishSchema = z.strictObject({
	materialChange: z.boolean(),
	reapprovalDeadlineAt: z.iso.datetime().optional(),
	reason: z.string().trim().min(1).max(1_000).optional(),
});

export const approvalPolicyRevokeSchema = z.strictObject({
	expectedRevision: opaqueId,
	reason: z.string().trim().min(1).max(1_000),
});

export const reapprovalCampaignDraftSchema = z.strictObject({
	capabilityProfileId: opaqueId,
	deadlineAt: z.iso.datetime(),
	providerReleaseId: opaqueId,
	reason: z.string().trim().min(1).max(1_000),
	triggerKind: z.enum(["DISCLAIMER", "POLICY", "PROVIDER_RELEASE"]),
	triggerVersionId: opaqueId,
});

export const notificationBatchSchema = z.strictObject({
	notificationIds: z
		.array(opaqueId)
		.min(1)
		.max(100)
		.refine((ids) => new Set(ids).size === ids.length),
});

export const capabilityProfileDraftSchema = z.strictObject({
	actionVersionIds: z.array(opaqueId).min(1).max(500),
	name: z.string().trim().min(1).max(120),
	providerReleaseId: opaqueId,
});

export const disclaimerDraftSchema = z.strictObject({
	content: z.string().min(1).max(100_000),
	kind: z.enum(["GLOBAL", "PROVIDER", "POLICY"]),
	locale: z.string().min(2).max(35),
	materialChange: z.boolean(),
	providerId: opaqueId.optional(),
});

export const accessPolicyDraftSchema = z.strictObject({
	allowPermanent: z.boolean(),
	capabilityProfileId: opaqueId,
	connectTtlSeconds: z.number().int().min(60).max(2_592_000),
	defaultDurationDays: z.number().int().min(1).max(3_650).optional(),
	disclaimerVersionIds: z.array(opaqueId).max(100),
	durations: z
		.array(
			z.union([
				z.strictObject({
					days: z.number().int().min(1).max(3_650),
					kind: z.literal("FINITE"),
				}),
				z.strictObject({ kind: z.literal("PERMANENT") }),
			]),
		)
		.min(1)
		.max(20),
	priority: z.number().int().min(0).max(1_000_000),
	providerReleaseId: opaqueId,
	renewalLeadSeconds: z.number().int().min(0).max(31_536_000),
	requestTtlSeconds: z.number().int().min(60).max(2_592_000),
	stages: z
		.array(
			z.strictObject({
				approverCandidateIds: z.array(opaqueId).max(50),
				name: z.string().trim().min(1).max(120),
				quorumCount: z.number().int().min(1).max(50).optional(),
				quorumType: z.enum(["ANY", "ALL", "AT_LEAST_N"]),
				timeoutSeconds: z.number().int().min(60).max(2_592_000),
			}),
		)
		.min(1)
		.max(10),
});

export const sharedScopeNameSchema = z.strictObject({
	displayName: z.string().trim().min(1).max(120),
});
