import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import { RuntimeIsolationEvidencePrincipalProjectionV1Schema } from "../runtime/safety-evidence-v1.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});

/**
 * Engineering Spec §18.5.1/§18.5.2: the original subject's read of one isolation observation
 * of an Execution. A missing, foreign or invalid reference answers like an invisible record.
 */
export const runtimeEvidenceOpenApiPathsV1 = {
	"/api/v2/conversations/{conversationId}/executions/{executionId}/runtime-evidence/{evidenceRef}":
		{
			get: {
				operationId: "readConversationRuntimeEvidenceV1",
				security: [{ PlatformSession: [] }],
				requestParams: {
					path: z.strictObject({
						conversationId: OpaqueIdV1Schema,
						executionId: OpaqueIdV1Schema,
						evidenceRef: z
							.string()
							.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
					}),
				},
				responses: {
					"200": response(
						"The original subject's projection of the isolation observation",
						RuntimeIsolationEvidencePrincipalProjectionV1Schema,
					),
					"400": response("Invalid request", PilotProtocolErrorV1Schema),
					"401": response(
						"Authentication required",
						PilotProtocolErrorV1Schema,
					),
					"404": response(
						"Evidence is unavailable",
						PilotProtocolErrorV1Schema,
					),
					"503": response(
						"Evidence or its required audit is unavailable",
						PilotProtocolErrorV1Schema,
					),
				},
			},
		},
} as const;

export const runtimeEvidenceSchemasV1 = {
	RuntimeIsolationEvidencePrincipalProjectionV1:
		RuntimeIsolationEvidencePrincipalProjectionV1Schema,
};
