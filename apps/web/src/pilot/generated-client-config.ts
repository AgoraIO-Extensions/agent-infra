import type {
	CreateClientConfig,
	ResolvedRequestOptions,
} from "./generated-v2/client/index.js";

/** Choose one of the read authentication alternatives after the SDK resolves auth. */
export const createClientConfig: CreateClientConfig = (config) => ({
	...config,
	async requestValidator(input) {
		const request = input as ResolvedRequestOptions;
		if (
			request.method === "GET" &&
			["/api/v2/agents", "/api/v1/audit", "/api/v1/audit/{auditId}"].includes(
				request.url,
			)
		) {
			if (request.headers.has("Authorization")) {
				if (request.headers.has("Cookie")) {
					throw new TypeError("Select one read authentication scheme");
				}
				// A browser's ambient session must not accompany a chosen Bearer.
				request.credentials = "omit";
			}
		}
		await config?.requestValidator?.(input);
	},
});
