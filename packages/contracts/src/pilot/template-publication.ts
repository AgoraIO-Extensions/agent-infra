import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";

const ref = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._~:-]+$/);
export const TemplatePublicationIdV1Schema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._~-]+$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const instant = z.string().max(32).datetime();

/** Deployment-owned facts; HTTP callers cannot choose these publication targets. */
export const TemplatePublicationBindingV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	publicationId: TemplatePublicationIdV1Schema,
	deploymentRef: ref,
	catalogRevision: ref,
	templateId: ref,
	targetImageDigest: digest,
	validationRef: ref,
	servicePrincipalRef: ref,
	authorizationRevision: ref,
	expiresAt: instant,
	expectedPreviousPublicationId: ref.nullable(),
	operatorIds: z.array(OpaqueIdV1Schema).max(256),
});
export type TemplatePublicationBindingV1 = z.infer<
	typeof TemplatePublicationBindingV1Schema
>;

export const TemplatePublicationCommandV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
});
export const TemplatePublicationReadyV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	catalogRevision: ref,
	templateId: ref,
	targetImageDigest: digest,
});
export const TemplatePublicationLeaseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	itemId: z.string().min(1).max(256),
	leaseOwner: ref,
	deliveryFence: z.string().regex(/^[1-9][0-9]{0,18}$/),
});
export type TemplatePublicationLeaseV1 = z.infer<
	typeof TemplatePublicationLeaseV1Schema
>;

export const TemplatePublicationCommitV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	publicationId: TemplatePublicationIdV1Schema,
	authorizationRevision: ref,
	batchRef: ref,
	targetRef: ref,
	servicePrincipalRef: ref,
	approvedBy: OpaqueIdV1Schema,
	lease: TemplatePublicationLeaseV1Schema,
});
export type TemplatePublicationCommitV1 = z.infer<
	typeof TemplatePublicationCommitV1Schema
>;

/** Resolved only by the trusted service identity adapter, never from JSON identity fields. */
export const TemplatePublicationServiceIdentityV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	principalRef: ref,
	deploymentRef: ref,
	publicationId: TemplatePublicationIdV1Schema,
	issuer: ref,
	keyVersion: ref,
	audience: z.literal("platform.template-publication.v1"),
	purpose: z.enum(["ready", "activate", "run", "read", "agent_ready"]),
	requestRef: ref,
	issuedAt: instant,
	expiresAt: instant,
});
export type TemplatePublicationServiceIdentityV1 = z.infer<
	typeof TemplatePublicationServiceIdentityV1Schema
>;

export const TemplatePublicationStatusV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	publicationId: TemplatePublicationIdV1Schema,
	status: z.enum([
		"prepared",
		"active",
		"partial",
		"blocked",
		"completed",
		"revoked",
		"superseded",
	]),
	counts: z.strictObject({
		pending: z.number().int().nonnegative(),
		unknown: z.number().int().nonnegative(),
		applied: z.number().int().nonnegative(),
		rejected: z.number().int().nonnegative(),
	}),
	targets: z
		.array(
			z.strictObject({
				batchRef: ref,
				attempt: z.number().int().min(1).max(2147483647),
				targetRef: ref,
				agentId: z.string().min(1).max(1024),
				status: z.enum(["pending", "unknown", "applied", "rejected"]),
				configurationRevision: revision.nullable(),
				errorCode: z.string().min(1).max(128).nullable(),
			}),
		)
		.max(256),
	nextCursor: ref.nullable(),
});
export type TemplatePublicationStatusV1 = z.infer<
	typeof TemplatePublicationStatusV1Schema
>;

export const TemplatePublicationErrorV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	code: z.literal("TEMPLATE_PUBLICATION_UNAVAILABLE"),
});
export const templatePublicationOpenApiPathsV1 = {
	...Object.fromEntries(
		[
			"prepare-automatic",
			"activate-automatic",
			"revoke-automatic",
			"worker-ready",
			"run-automatic",
		].map((command) => [
			`/internal/ops/standard-template-releases/{publicationId}/${command}`,
			{
				post: {
					operationId: `templatePublicationV1_${command.replaceAll("-", "_")}`,
					summary: `Deployment-bound template publication: ${command}`,
					requestParams: { path: z.object({ publicationId: ref }) },
					requestBody: {
						required: true,
						content: {
							"application/json": {
								schema:
									command === "worker-ready"
										? TemplatePublicationReadyV1Schema
										: command === "run-automatic"
											? TemplatePublicationLeaseV1Schema
											: TemplatePublicationCommandV1Schema,
							},
						},
					},
					responses: {
						...(command === "activate-automatic"
							? {
									"409": {
										description:
											"The publication cannot activate on the current catalog.",
										headers: {
											"Retry-After": {
												description:
													"Present only while the matching prepared publication awaits Worker adoption, in seconds.",
												schema: { type: "string", enum: ["5"] },
											},
										},
										content: {
											"application/json": {
												schema: TemplatePublicationErrorV1Schema,
											},
										},
									},
								}
							: {}),
						"202": {
							description:
								"Persisted publication progress, not Workload readiness",
							content: {
								"application/json": {
									schema: TemplatePublicationStatusV1Schema,
								},
							},
						},
					},
				},
			},
		]),
	),
	"/internal/ops/standard-template-releases/{publicationId}/status-automatic": {
		get: {
			operationId: "readAutomaticTemplatePublicationV1",
			summary:
				"Read bounded publication history with current operator or service authorization",
			requestParams: {
				path: z.object({ publicationId: TemplatePublicationIdV1Schema }),
				query: z.object({
					cursor: z
						.string()
						.regex(/^target-[a-f0-9]{64}$/)
						.optional(),
				}),
			},
			responses: {
				"200": {
					description:
						"Counts cover each Agent latest attempt; targets retain bounded original attempt history",
					content: {
						"application/json": { schema: TemplatePublicationStatusV1Schema },
					},
				},
			},
		},
	},
};
