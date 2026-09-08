import {
	type ConnectionActionCallProjectionV1,
	ConnectionActionCallProjectionV1Schema,
	type ConnectionCatalogV1,
	ConnectionCatalogV1Schema,
} from "@agent-infra/contracts/pilot";

export function fakeConnectionCatalogV1(): ConnectionCatalogV1 {
	return ConnectionCatalogV1Schema.parse({
		schemaVersion: 1,
		catalogVersion: "pilot-catalog-v1",
		providers: [
			{
				providerId: "github",
				providerReleaseId: "github-pilot-release-v1",
				displayName: "GitHub",
				status: "published",
				actions: [
					{
						actionId: "github.get_current_user",
						actionVersionId: "github.get_current_user@v1",
						effect: "read",
						requiredScopes: ["read:user"],
						status: "published",
						inputSchema: { type: "object", additionalProperties: false },
						outputSchema: { type: "object" },
					},
					{
						actionId: "github.list_my_repositories",
						actionVersionId: "github.list_my_repositories@v1",
						effect: "read",
						requiredScopes: ["repo"],
						status: "published",
						inputSchema: { type: "object", additionalProperties: false },
						outputSchema: { type: "object" },
					},
					{
						actionId: "github.create_pull_request",
						actionVersionId: "github.create_pull_request@v1",
						effect: "write",
						requiredScopes: ["repo"],
						status: "published",
						inputSchema: { type: "object" },
						outputSchema: { type: "object" },
					},
				],
			},
		],
	});
}

const callBase = {
	schemaVersion: 1,
	callId: "call-pilot-1",
	actionVersionId: "github.create_pull_request@v1",
	traceId: "trace-pilot-1",
	createdAt: "2026-09-08T02:00:00Z",
	updatedAt: "2026-09-08T02:00:01Z",
} as const;

export function fakeProviderFailedCallV1(): ConnectionActionCallProjectionV1 {
	return ConnectionActionCallProjectionV1Schema.parse({
		...callBase,
		status: "provider_failed",
		error: {
			code: "PROVIDER_FAILED",
			message: "Provider rejected the Action",
			retryable: false,
			providerStatusCode: 403,
			providerRequestId: "github-request-pilot-1",
		},
	});
}

export function fakeResultPendingCallV1(): ConnectionActionCallProjectionV1 {
	return ConnectionActionCallProjectionV1Schema.parse({
		...callBase,
		status: "result_pending",
		uncertainty: {
			reason: "provider_response_lost",
			reconcileUntil: "2026-09-09T02:00:00Z",
		},
	});
}
