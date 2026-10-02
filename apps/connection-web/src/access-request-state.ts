import type {
	AccessOptionsResponse,
	AccessRequestsResponse,
} from "@agent-infra/connection-contracts";

type Request = AccessRequestsResponse["requests"][number];

export function latestProviderRequest(
	requests: readonly Request[],
	providerId: string | undefined,
) {
	return requests
		.filter((request) => request.providerId === providerId)
		.reduce<Request | undefined>(
			(latest, request) =>
				!latest || Date.parse(request.createdAt) > Date.parse(latest.createdAt)
					? request
					: latest,
			undefined,
		);
}

export function canConnectRequest(request: Request | null | undefined) {
	return Boolean(
		request &&
			!request.renewal &&
			request.state === "APPROVED_PENDING_CONNECTION" &&
			request.connectReadiness?.status !== "REAPPLY_REQUIRED" &&
			request.connectExpiresAt &&
			Date.parse(request.connectExpiresAt) > Date.now(),
	);
}

export function reapplicationOptions(
	request: Request | null | undefined,
	options: AccessOptionsResponse["options"],
) {
	return options.filter(
		(option) =>
			option.availableForNewConnections !== false &&
			option.providerId === request?.providerId &&
			option.providerReleaseId ===
				request?.connectReadiness?.targetProviderReleaseId,
	);
}
