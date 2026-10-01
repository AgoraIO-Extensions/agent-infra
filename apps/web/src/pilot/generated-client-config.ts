import type {
	CreateClientConfig,
	ResolvedRequestOptions,
} from "./generated-v2/client/index.js";

/** Choose one of the GET Agents alternatives after the SDK resolves auth. */
export const createClientConfig: CreateClientConfig = (config) => ({
	...config,
	async requestValidator(input) {
		const request = input as ResolvedRequestOptions;
		if (request.method === "GET" && request.url === "/api/v2/agents") {
			if (request.headers.has("Authorization")) {
				if (request.headers.has("Cookie")) {
					throw new TypeError("Select one Agent read authentication scheme");
				}
				// A browser's ambient session must not accompany a chosen Bearer.
				request.credentials = "omit";
			}
		}
		await config?.requestValidator?.(input);
	},
});
