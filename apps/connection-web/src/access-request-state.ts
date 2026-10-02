import type {
	AccessOptionsResponse,
	AccessRequestsResponse,
} from "@agent-infra/connection-contracts";

type Request = AccessRequestsResponse["requests"][number];

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
