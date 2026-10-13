import { z } from "zod";
import { OpaqueIdV1Schema } from "../index.ts";
import {
	NativeMetadataProjectionV1Schema,
	NativeMetadataSelectorV1Schema,
} from "../runtime/native-metadata-v1.ts";
import { PilotProtocolErrorV1Schema } from "./errors.ts";

const response = (description: string, schema: z.ZodType) => ({
	description,
	content: { "application/json": { schema } },
});
const errors = {
	"400": response("Invalid request", PilotProtocolErrorV1Schema),
	"401": response("Authentication required", PilotProtocolErrorV1Schema),
	"403": response(
		"Authorization is no longer valid",
		PilotProtocolErrorV1Schema,
	),
	"404": response("Resource is unavailable", PilotProtocolErrorV1Schema),
	"503": response("Native metadata is unavailable", PilotProtocolErrorV1Schema),
};

export const nativeMetadataOpenApiPathsV1 = {
	"/api/v2/conversations/{conversationId}/executions/{executionId}/native-metadata":
		{
			get: {
				operationId: "readConversationNativeMetadataV1",
				security: [{ PlatformSession: [] }],
				requestParams: {
					path: z.strictObject({
						conversationId: OpaqueIdV1Schema,
						executionId: OpaqueIdV1Schema,
					}),
					query: z.strictObject({ selector: NativeMetadataSelectorV1Schema }),
				},
				responses: {
					"200": response(
						"Current authenticated native metadata projection",
						NativeMetadataProjectionV1Schema,
					),
					...errors,
				},
			},
		},
} as const;

export const nativeMetadataSchemasV1 = {
	NativeMetadataProjectionV1: NativeMetadataProjectionV1Schema,
};
