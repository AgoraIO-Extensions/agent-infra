import { z } from "zod";
import { IdempotencyKeyV1Schema, OpaqueIdV1Schema } from "../index.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

/** Deployment chooses the entire target; callers can only apply that release. */
export const StandardTemplateReleaseApplyRequestV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
});
export const StandardTemplateReleaseApplyResponseV1Schema = z.strictObject({
	schemaVersion: z.literal(1),
	agentId: OpaqueIdV1Schema,
	configurationRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	changedFields: z.array(z.literal("source")).length(1),
});
export const standardTemplateReleaseOpenApiPathsV1 = {
	"/internal/ops/standard-template-releases/{releaseId}/apply": {
		post: {
			operationId: "applyStandardTemplateReleaseV1",
			summary: "Apply one deployment-bound standard template release",
			description:
				"Requires current active system administrator identity and a current deployment operator binding for this exact release. The dedicated deployment handler is not mounted on the browser API. A 202 response accepts a configuration revision; it does not establish Workload readiness.",
			requestParams: {
				path: z.object({
					releaseId: z.string().regex(/^[A-Za-z0-9._~-]{1,128}$/),
				}),
				header: z.object({ "Idempotency-Key": IdempotencyKeyV1Schema }),
			},
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: StandardTemplateReleaseApplyRequestV1Schema,
					},
				},
			},
			responses: {
				"202": {
					description: "Configuration revision accepted",
					content: {
						"application/json": {
							schema: StandardTemplateReleaseApplyResponseV1Schema,
						},
					},
				},
				...Object.fromEntries(
					[400, 401, 403, 404, 409, 500, 503].map((status) => [
						String(status),
						{
							description: "Publication rejected or unavailable",
							content: {
								"application/json": { schema: PilotProtocolErrorV1Schema },
							},
						},
					]),
				),
			},
		},
	},
};
