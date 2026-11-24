import { z } from "zod";

const reference = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[^\p{Cc}]+$/u);
const selector = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/);
export const ConnectionRegistrationOwnerV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	sourceNamespace: selector,
	platformAgentId: selector,
	platformOwnerId: reference,
	policyRevision: reference,
	directorySource: selector,
	wechatUserId: z
		.string()
		.min(1)
		.max(256)
		.regex(/^[^\p{Cc}]+$/u),
	email: z.email().max(320),
	ownerRevision: reference,
	expiresAt: z.number().int().positive().safe(),
});
export type ConnectionRegistrationOwnerV1 = z.infer<
	typeof ConnectionRegistrationOwnerV1Schema
>;
export const connectionRegistrationOwnerOpenApiPathsV1 = {
	"/api/internal/connection-registration/v1/owners/{sourceNamespace}/{platformAgentId}":
		{
			get: {
				operationId: "readConnectionRegistrationOwnerV1",
				summary:
					"Read the current selected Owner of an approved registration source and Agent",
				security: [{ ConnectionOwnerReader: [] }],
				requestParams: {
					path: z.strictObject({
						sourceNamespace: selector,
						platformAgentId: selector,
					}),
					query: z.strictObject({
						purpose: z.enum(["create", "read", "disable", "delete"]),
					}),
				},
				responses: {
					200: {
						description:
							"Current nonsecret facts, no-store, expires within 20 seconds",
						content: {
							"application/json": {
								schema: ConnectionRegistrationOwnerV1Schema,
							},
						},
					},
					400: { description: "Invalid selector, body or query" },
					401: {
						description:
							"Dedicated machine authentication required; Cookie and Origin rejected",
					},
					404: { description: "Source, Agent or current Owner unavailable" },
					503: { description: "Current authority unavailable" },
				},
			},
		},
};
